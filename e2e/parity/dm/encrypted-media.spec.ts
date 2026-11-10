import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import {
  type BootstrappedUser,
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  getDeveloperDiagnosticsSnapshot,
  navigateInApp,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  waitForThreadMessage,
} from '../helpers';

const BLOSSOM_ORIGIN = 'https://blossom.e2e.test';
const BACKUP_ORIGIN = 'https://backup-blossom.e2e.test';
// The regular Blossom server, used only for media the user chose to send without encryption.
const PLAIN_ORIGIN = 'https://plain-blossom.e2e.test';
const SECRET_METADATA = 'SECRET-METADATA-E2E-GPS';

interface StoredBlob {
  body: Buffer;
  contentType: string;
  declaredSha256: string;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

// A real, decodable 3x2 PNG that also carries a text chunk with "private" metadata.
function buildPngWithMetadata(): Buffer {
  const width = 3;
  const height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      rows[rowStart + 1 + x * 3] = 0x00;
      rows[rowStart + 2 + x * 3] = 0xa6;
      rows[rowStart + 3 + x * 3] = 0x7e;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from(`Comment\u0000${SECRET_METADATA}`, 'latin1')),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// A real, playable mono 16-bit PCM WAV (440 Hz tone).
function buildWavTone(seconds = 1, sampleRate = 8000): Buffer {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((index / sampleRate) * 440 * 2 * Math.PI) * 8000;
    data.writeInt16LE(Math.round(value), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256',
  'Cache-Control': 'no-store',
};

// In-memory Blossom servers shared by both browsers. They record exactly what was uploaded.
function createFakeBlossom() {
  const blobs = new Map<string, StoredBlob & { origin: string }>();
  const downloads: string[] = [];
  // Every upload request body, including the ones answered with an error.
  const uploadAttempts: { origin: string; body: Buffer; contentType: string }[] = [];
  const failingOrigins = new Set<string>();
  // Servers that refuse encrypted (application/octet-stream) uploads, as blossom.nostr.build does.
  const rejectingEncrypted = new Set<string>();

  async function handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    if (request.method() === 'PUT' && url.pathname === '/upload') {
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const headers = await request.allHeaders();
      uploadAttempts.push({ origin: url.origin, body, contentType: headers['content-type'] ?? '' });
      if (failingOrigins.has(url.origin)) {
        await route.fulfill({ status: 503, headers: CORS_HEADERS, body: 'unavailable' });
        return;
      }
      if (
        rejectingEncrypted.has(url.origin) &&
        headers['content-type'] === 'application/octet-stream'
      ) {
        await route.fulfill({ status: 415, headers: CORS_HEADERS, body: 'File type not allowed' });
        return;
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      blobs.set(sha256, {
        origin: url.origin,
        body,
        contentType: headers['content-type'] ?? '',
        declaredSha256: headers['x-sha-256'] ?? '',
      });
      await route.fulfill({
        status: 201,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${url.origin}/${sha256}`,
          sha256,
          size: body.length,
          type: headers['content-type'] ?? 'application/octet-stream',
          uploaded: Math.floor(Date.now() / 1000),
        }),
      });
      return;
    }

    const sha256 = url.pathname.slice(1);
    const blob = request.method() === 'GET' ? blobs.get(sha256) : undefined;
    if (!blob) {
      await route.fulfill({ status: 404, headers: CORS_HEADERS, body: '' });
      return;
    }

    downloads.push(request.url());
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': blob.contentType || 'application/octet-stream' },
      body: blob.body,
    });
  }

  return {
    blobs,
    downloads,
    uploadAttempts,
    failingOrigins,
    rejectingEncrypted,
    async install(context: BrowserContext): Promise<void> {
      await context.route(`${BLOSSOM_ORIGIN}/**`, handle);
      await context.route(`${BACKUP_ORIGIN}/**`, handle);
      await context.route(`${PLAIN_ORIGIN}/**`, handle);
    },
  };
}

async function waitForSessionReady(user: BootstrappedUser) {
  await expect
    .poll(
      async () =>
        !(await getDeveloperDiagnosticsSnapshot(user.page)).session.isRestoringStartupState,
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function openMediaSettings(page: Page) {
  await navigateInApp(page, '/settings/media-data-storage');
  await expect(page.getByTestId('settings-private-media-server-input')).toBeVisible();
}

async function useEncryptedMediaServer(user: BootstrappedUser, serverUrl: string) {
  await waitForSessionReady(user);
  await openMediaSettings(user.page);
  const serverInput = user.page.getByTestId('settings-private-media-server-input');
  await serverInput.fill(serverUrl);
  await user.page.getByTestId('settings-private-media-save').click();
  await expect(user.page.getByText('Encrypted media server saved.', { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await expect(serverInput).toHaveValue(serverUrl);
}

async function useRegularServer(user: BootstrappedUser, serverUrl: string) {
  await openMediaSettings(user.page);
  const serverInput = user.page.getByTestId('settings-blossom-server-input');
  await serverInput.fill(serverUrl);
  await user.page.getByTestId('settings-blossom-save').click();
  await expect(user.page.getByText('Blossom server saved.', { exact: true })).toBeVisible({
    timeout: 12_000,
  });
}

type MediaFile = { name: string; mimeType: string; buffer: Buffer };

async function pickMedia(page: Page, file: MediaFile) {
  await page.getByTestId('message-composer-menu').click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.attachment-menu').getByRole('button', { name: 'Photo or Video' }).click();
  await (await fileChooserPromise).setFiles(file);
}

// Picks a file through the composer and confirms the encrypted upload.
async function sendPrivateMedia(page: Page, file: MediaFile) {
  await pickMedia(page, file);
  await expect(page.getByText(/end-to-end encrypted on your device/u)).toBeVisible();
  await page.getByTestId('composer-media-upload-confirm').click();
}

async function readDecryptedBytes(element: Locator) {
  return element.evaluate(async (node: HTMLImageElement | HTMLMediaElement) => {
    const blob = await (await fetch(node.src)).blob();
    return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
}

async function expectRenderedImage(page: Page) {
  const image = page.getByTestId('message-encrypted-image').last().locator('img');
  await expect(image).toHaveAttribute('src', /^blob:/u, { timeout: 30_000 });
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(3);
  return image;
}

async function expectUsablePlayer(page: Page, testId: string) {
  const player = page.getByTestId(testId).last();
  await expect(player).toHaveAttribute('src', /^blob:/u, { timeout: 30_000 });
  await expect(player).toHaveAttribute('controls', '');
  await expect
    .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  const box = await player.boundingBox();
  // The player must be wide enough to show its native controls.
  expect(box?.width ?? 0).toBeGreaterThan(200);
  expect(box?.height ?? 0).toBeGreaterThan(20);
  return player;
}

test('private images are encrypted before upload and decrypted by the recipient', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedImageAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedImageBob);
  const blossom = createFakeBlossom();

  try {
    await blossom.install(alice.context);
    await blossom.install(bob.context);
    await establishAcceptedDirectChat(alice, bob);
    await useEncryptedMediaServer(alice, BLOSSOM_ORIGIN);
    await navigateToChat(alice.page, bob.session.publicKey);

    const png = buildPngWithMetadata();
    await sendPrivateMedia(alice.page, { name: 'holiday.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(1);

    // What the server received: ciphertext only, declared as an opaque blob.
    const [[storedSha256, stored]] = [...blossom.blobs.entries()];
    const ciphertextUrl = `${BLOSSOM_ORIGIN}/${storedSha256}`;
    expect(stored.contentType).toBe('application/octet-stream');
    expect(stored.declaredSha256).toBe(storedSha256);
    expect(stored.body.length).toBe(png.length + 16);
    expect(stored.body.includes(png.subarray(0, 8))).toBe(false);
    expect(stored.body.includes(Buffer.from('IHDR'))).toBe(false);
    expect(stored.body.includes(Buffer.from(SECRET_METADATA))).toBe(false);
    expect(stored.body.includes(Buffer.from('holiday'))).toBe(false);

    // The sender renders the image from a decrypted blob URL. The ciphertext URL is never shown
    // as text, used as an image source, or offered as a link.
    await expectRenderedImage(alice.page);
    await expect(alice.page.locator(`img[src="${ciphertextUrl}"]`)).toHaveCount(0);
    await expect(
      alice.page.getByTestId('message-url-link').filter({ hasText: BLOSSOM_ORIGIN }),
    ).toHaveCount(0);
    const aliceBubble = alice.page
      .getByTestId('message-bubble')
      .filter({ has: alice.page.getByTestId('message-encrypted-image') })
      .last();
    await expect(aliceBubble.getByRole('button', { name: 'Media options' })).toHaveCount(0);

    // The event view never shows the decryption key or nonce.
    await aliceBubble.hover();
    // Bubble padding opens the message menu without hitting the decrypted image.
    await aliceBubble.locator('.message-content').click({ position: { x: 5, y: 5 } });
    // A kind 15 file message has no text to edit; the own-message menu still offers Delete.
    const menu = alice.page.getByTestId('message-context-menu');
    await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
    await alice.page.getByRole('menuitem', { name: 'Nostr info', exact: true }).click();
    await alice.page.getByText('Event JSON', { exact: true }).click();
    const eventJson = JSON.parse(await alice.page.locator('.event-json').innerText()) as {
      kind: number;
      content: string;
      tags: string[][];
    };
    expect(eventJson.kind).toBe(15);
    expect(eventJson.content).toBe(ciphertextUrl);
    expect(eventJson.tags).toContainEqual(['decryption-key', '[redacted]']);
    expect(eventJson.tags).toContainEqual(['decryption-nonce', '[redacted]']);
    expect(eventJson.tags).toContainEqual(['x', storedSha256]);
    await alice.page.getByRole('button', { name: 'Close dialog' }).click();

    // The recipient has not trusted the sender: nothing is downloaded until they load media.
    blossom.downloads.length = 0;
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(
      bob.page.locator(
        `[data-testid="chat-item"][data-chat-public-key="${alice.session.publicKey}"]`,
      ),
    ).toContainText('Picture');
    const loadMedia = bob.page.getByRole('button', { name: 'Load media', exact: true }).last();
    await expect(loadMedia).toBeVisible({ timeout: 30_000 });
    await expect(
      bob.page.getByTestId('message-url-link').filter({ hasText: BLOSSOM_ORIGIN }),
    ).toHaveCount(0);
    expect(blossom.downloads).toHaveLength(0);
    await loadMedia.click();
    const bobImage = await expectRenderedImage(bob.page);
    expect(blossom.downloads.every((url) => url === ciphertextUrl)).toBe(true);

    // The recipient gets back exactly the original image; its metadata travelled encrypted.
    const decrypted = await readDecryptedBytes(bobImage);
    expect(decrypted.type).toBe('image/png');
    expect(Buffer.from(decrypted.bytes).equals(png)).toBe(true);

    // The viewer shows the decrypted image without an "Open original" link to the ciphertext
    // and saves the verified plaintext.
    await bob.page.getByTestId('message-encrypted-image').last().click();
    const viewer = bob.page.getByRole('dialog', { name: 'Image attachment' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Open original' })).toHaveCount(0);
    await expect(viewer.locator('img')).toHaveAttribute('src', /^blob:/u);
    const downloaded = bob.page.waitForEvent('download');
    await viewer.getByRole('button', { name: 'Download image', exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('image.png');
    const { readFile } = await import('node:fs/promises');
    expect((await readFile((await download.path())!)).equals(png)).toBe(true);
    await bob.page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    // A blob that no longer matches the message hash is never rendered.
    stored.body[0] ^= 0xff;
    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await bob.page.getByRole('button', { name: 'Load media', exact: true }).last().click();
    await expect(bob.page.getByTestId('message-encrypted-image-failed').last()).toBeVisible({
      timeout: 30_000,
    });
    await expect(bob.page.getByTestId('message-encrypted-image')).toHaveCount(0);
    stored.body[0] ^= 0xff;

    // Own images far from the viewport are not downloaded until the thread scrolls near them.
    const fillerTexts = Array.from(
      { length: 20 },
      (_, index) => `lazy-filler-${index}\nline two\nline three\nline four`,
    );
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, fillerTexts);
    await reloadAndWaitForApp(alice.page);
    blossom.downloads.length = 0;
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, 'lazy-filler-19');
    const pendingImage = alice.page.getByTestId('message-encrypted-image-pending').first();
    await expect(pendingImage).toBeAttached();
    expect(blossom.downloads).toHaveLength(0);
    await pendingImage.scrollIntoViewIfNeeded();
    await expectRenderedImage(alice.page);
    expect(blossom.downloads.length).toBeGreaterThan(0);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('private audio and video decrypt locally, and failed uploads only retry ciphertext', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedAvAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedAvBob);
  const blossom = createFakeBlossom();

  try {
    await blossom.install(alice.context);
    await blossom.install(bob.context);
    await establishAcceptedDirectChat(alice, bob);
    await useEncryptedMediaServer(alice, BLOSSOM_ORIGIN);
    await navigateToChat(alice.page, bob.session.publicKey);

    // Audio.
    const wav = buildWavTone();
    await sendPrivateMedia(alice.page, { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav });
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(1);
    const audioUpload = blossom.uploadAttempts.at(-1);
    expect(audioUpload?.contentType).toBe('application/octet-stream');
    expect(audioUpload?.body.length).toBe(wav.length + 16);
    expect(audioUpload?.body.includes(Buffer.from('RIFF'))).toBe(false);
    expect(audioUpload?.body.includes(Buffer.from('WAVE'))).toBe(false);

    // Own media decrypts on its own once visible and shows a real, playable native player.
    const aliceAudio = await expectUsablePlayer(alice.page, 'message-encrypted-audio');
    const decryptedAudio = await readDecryptedBytes(aliceAudio);
    expect(decryptedAudio.type).toBe('audio/wav');
    expect(Buffer.from(decryptedAudio.bytes).equals(wav)).toBe(true);
    await aliceAudio.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(() => aliceAudio.evaluate((element: HTMLMediaElement) => element.currentTime))
      .toBeGreaterThan(0);
    await aliceAudio.evaluate((element: HTMLMediaElement) => element.pause());

    // Video.
    // A short VP8 clip recorded from a canvas with MediaRecorder.
    const webm = readFileSync('e2e/fixtures/vp8-clip.webm');
    await sendPrivateMedia(alice.page, { name: 'clip.webm', mimeType: 'video/webm', buffer: webm });
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(2);
    const videoUpload = blossom.uploadAttempts.at(-1);
    expect(videoUpload?.contentType).toBe('application/octet-stream');
    expect(videoUpload?.body.subarray(0, 4).equals(webm.subarray(0, 4))).toBe(false);
    await expectUsablePlayer(alice.page, 'message-encrypted-video');

    // The recipient has not trusted the sender: nothing is downloaded until they load media.
    blossom.downloads.length = 0;
    await navigateToChat(bob.page, alice.session.publicKey);
    const loadMedia = bob.page.getByRole('button', { name: 'Load media', exact: true });
    await expect(loadMedia).toHaveCount(2, { timeout: 30_000 });
    await expect(bob.page.getByTestId('message-encrypted-media')).toHaveCount(0);
    expect(blossom.downloads).toHaveLength(0);
    await loadMedia.first().click();
    const bobAudio = await expectUsablePlayer(bob.page, 'message-encrypted-audio');
    expect(Buffer.from((await readDecryptedBytes(bobAudio)).bytes).equals(wav)).toBe(true);
    await loadMedia.first().click();
    const bobVideo = await expectUsablePlayer(bob.page, 'message-encrypted-video');
    await bobVideo.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(() => bobVideo.evaluate((element: HTMLMediaElement) => element.paused))
      .toBe(false);
    await bobVideo.evaluate((element: HTMLMediaElement) => element.pause());

    // A failure names its cause and offers Retry, Change server, Send without encryption and
    // Cancel; a retry re-sends the identical ciphertext and nothing is uploaded as plaintext.
    blossom.failingOrigins.add(BLOSSOM_ORIGIN);
    const attemptsBeforeFailure = blossom.uploadAttempts.length;
    await sendPrivateMedia(alice.page, {
      name: 'tone-again.wav',
      mimeType: 'audio/wav',
      buffer: wav,
    });
    await expect(alice.page.getByTestId('composer-media-upload-retry')).toBeVisible({
      timeout: 30_000,
    });
    await expect(alice.page.getByTestId('composer-media-upload-change-server')).toBeVisible();
    await expect(alice.page.getByTestId('composer-media-upload-cancel')).toBeVisible();
    await expect(alice.page.getByTestId('composer-media-upload-unencrypted')).toBeVisible();
    await expect(alice.page.getByTestId('composer-media-upload-error')).toHaveText(
      'blossom.e2e.test could not store the file (HTTP 503). The server said: unavailable',
    );
    const failedAttempt = blossom.uploadAttempts.at(-1);
    expect(blossom.uploadAttempts.length).toBe(attemptsBeforeFailure + 1);
    expect(failedAttempt?.contentType).toBe('application/octet-stream');
    expect(failedAttempt?.body.includes(Buffer.from('RIFF'))).toBe(false);

    blossom.failingOrigins.delete(BLOSSOM_ORIGIN);
    await alice.page.getByTestId('composer-media-upload-retry').click();
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(3);
    expect(blossom.uploadAttempts.at(-1)?.body.equals(failedAttempt!.body)).toBe(true);
    await expect(alice.page.getByRole('dialog', { name: 'upload' })).toBeHidden();

    // Cancel drops the failed upload without sending anything.
    blossom.failingOrigins.add(BLOSSOM_ORIGIN);
    await sendPrivateMedia(alice.page, {
      name: 'tone-cancel.wav',
      mimeType: 'audio/wav',
      buffer: buildWavTone(2),
    });
    await expect(alice.page.getByTestId('composer-media-upload-retry')).toBeVisible({
      timeout: 30_000,
    });
    const attemptsBeforeCancel = blossom.uploadAttempts.length;
    const cancelledAttempt = blossom.uploadAttempts.at(-1)!;
    await alice.page.getByTestId('composer-media-upload-cancel').click();
    await expect(alice.page.getByRole('dialog', { name: 'upload' })).toBeHidden();
    expect(blossom.uploadAttempts.length).toBe(attemptsBeforeCancel);
    await expect(alice.page.getByTestId('message-encrypted-media')).toHaveCount(3);

    // Change server retries the same ciphertext on another server and saves that server only
    // after the kind 15 message has been sent.
    await sendPrivateMedia(alice.page, {
      name: 'tone-moved.wav',
      mimeType: 'audio/wav',
      buffer: buildWavTone(3),
    });
    await expect(alice.page.getByTestId('composer-media-upload-change-server')).toBeVisible({
      timeout: 30_000,
    });
    const movedAttempt = blossom.uploadAttempts.at(-1);
    await alice.page.getByTestId('composer-media-upload-change-server').click();
    await alice.page.getByTestId('composer-media-upload-server-input').fill(BACKUP_ORIGIN);
    await alice.page.getByTestId('composer-media-upload-use-server').click();
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(4);
    const backupAttempt = blossom.uploadAttempts.at(-1);
    expect(backupAttempt?.origin).toBe(BACKUP_ORIGIN);
    expect(backupAttempt?.body.equals(movedAttempt!.body)).toBe(true);
    await expect(alice.page.getByTestId('message-encrypted-media')).toHaveCount(4);
    // The bubble renders optimistically; the dialog closes only once the message is sent and
    // the server has been saved.
    await expect(alice.page.getByRole('dialog', { name: 'upload' })).toBeHidden({
      timeout: 30_000,
    });
    blossom.failingOrigins.delete(BLOSSOM_ORIGIN);
    await openMediaSettings(alice.page);
    await expect(alice.page.getByTestId('settings-private-media-server-input')).toHaveValue(
      BACKUP_ORIGIN,
      { timeout: 12_000 },
    );

    // iPhone video (H.264 QuickTime) is encrypted too and plays from the decrypted blob.
    const mov = readFileSync('e2e/fixtures/h264-clip.mov');
    await navigateToChat(alice.page, bob.session.publicKey);
    await sendPrivateMedia(alice.page, {
      name: 'clip.mov',
      mimeType: 'video/quicktime',
      buffer: mov,
    });
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(5);
    expect(blossom.uploadAttempts.at(-1)?.body.includes(mov.subarray(4, 12))).toBe(false);
    await expect(alice.page.getByTestId('message-encrypted-video')).toHaveCount(2, {
      timeout: 30_000,
    });
    const movPlayer = alice.page.getByTestId('message-encrypted-video').last();
    expect((await readDecryptedBytes(movPlayer)).type).toBe('video/quicktime');
    await expect
      .poll(() => movPlayer.evaluate((element: HTMLMediaElement) => element.videoWidth))
      .toBe(64);

    expect(
      blossom.uploadAttempts.every((attempt) => attempt.contentType === 'application/octet-stream'),
    ).toBe(true);

    // Later uploads have finished by now, so a delayed upload of the cancelled file would show here.
    expect(
      blossom.uploadAttempts.filter((attempt) => attempt.body.equals(cancelledAttempt.body)),
    ).toHaveLength(1);

    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: [/503/u, /unavailable/u],
    });
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('private media is sent without encryption only after the user chooses it', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedFallbackAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedFallbackBob);
  const blossom = createFakeBlossom();
  const png = buildPngWithMetadata();
  const heic = {
    name: 'photo.heic',
    mimeType: 'image/heic',
    buffer: Buffer.from('not encryptable'),
  };
  const plaintextUploads = () =>
    blossom.uploadAttempts.filter(({ origin }) => origin === PLAIN_ORIGIN);
  const warning = alice.page.getByTestId('composer-media-plaintext-warning');
  const dialog = alice.page.getByRole('dialog', { name: 'upload' });

  try {
    await blossom.install(alice.context);
    await blossom.install(bob.context);
    await establishAcceptedDirectChat(alice, bob);
    await useEncryptedMediaServer(alice, BLOSSOM_ORIGIN);
    await useRegularServer(alice, PLAIN_ORIGIN);
    await navigateToChat(alice.page, bob.session.publicKey);
    blossom.rejectingEncrypted.add(BLOSSOM_ORIGIN);
    const bubbles = alice.page.getByTestId('message-bubble');
    const bubblesBefore = await bubbles.count();

    // The encrypted upload is refused for its content type, and that is what the card says.
    await sendPrivateMedia(alice.page, { name: 'plain.png', mimeType: 'image/png', buffer: png });
    await expect(alice.page.getByTestId('composer-media-upload-error')).toHaveText(
      'blossom.e2e.test does not accept encrypted files. The server said: File type not allowed',
      { timeout: 30_000 },
    );
    await expect(alice.page.getByTestId('composer-media-upload-retry')).toBeVisible();
    await expect(alice.page.getByTestId('composer-media-upload-change-server')).toBeVisible();
    expect(plaintextUploads()).toHaveLength(0);

    // Choosing plaintext explains the privacy impact first; cancelling uploads nothing.
    await alice.page.getByTestId('composer-media-upload-unencrypted').click();
    await expect(warning).toHaveText(
      'The message remains end-to-end encrypted through NIP-17, but the media file itself will be uploaded without encryption. The Blossom server operator and anyone with access to the file URL may be able to view the file.',
    );
    await expect(dialog).toContainText('plain-blossom.e2e.test');
    expect(plaintextUploads()).toHaveLength(0);
    await alice.page.getByTestId('composer-media-upload-cancel').click();
    await expect(dialog).toBeHidden();
    expect(plaintextUploads()).toHaveLength(0);
    await expect(bubbles).toHaveCount(bubblesBefore);

    // Confirming uploads the original file to the regular server and sends kind 14 + imeta.
    await sendPrivateMedia(alice.page, { name: 'plain.png', mimeType: 'image/png', buffer: png });
    await alice.page.getByTestId('composer-media-upload-unencrypted').click({ timeout: 30_000 });
    await alice.page.getByTestId('composer-media-plaintext-dont-ask').check();
    await alice.page.getByTestId('composer-media-plaintext-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(plaintextUploads()).toHaveLength(1);
    expect(plaintextUploads()[0].contentType).toBe('image/png');
    expect(plaintextUploads()[0].body.equals(png)).toBe(true);
    const plainUrl = `${PLAIN_ORIGIN}/${createHash('sha256').update(png).digest('hex')}`;
    const bubble = alice.page.getByTestId('message-bubble').last();
    await expect(bubble.locator(`img[src="${plainUrl}"]`)).toBeVisible({ timeout: 30_000 });
    await bubble.locator('.message-content').click({ position: { x: 5, y: 5 } });
    await alice.page.getByRole('menuitem', { name: 'Nostr info', exact: true }).click();
    await alice.page.getByText('Event JSON', { exact: true }).click();
    const eventJson = JSON.parse(await alice.page.locator('.event-json').innerText()) as {
      kind: number;
      tags: string[][];
    };
    expect(eventJson.kind).toBe(14);
    expect(eventJson.tags.some(([name]) => name === 'imeta')).toBe(true);
    expect(eventJson.tags.some(([name]) => name.startsWith('decryption'))).toBe(false);
    await alice.page.getByRole('button', { name: 'Close dialog' }).click();

    // The recipient reads it like any existing unencrypted attachment.
    await navigateToChat(bob.page, alice.session.publicKey);
    await bob.page.getByRole('button', { name: 'Load media', exact: true }).last().click({
      timeout: 30_000,
    });
    await expect(bob.page.locator(`img[src="${plainUrl}"]`)).toBeVisible({ timeout: 30_000 });

    // "Don't ask again" never chooses plaintext by itself: the next upload is encrypted, and
    // its failure waits for the user.
    const encryptedAttempts = blossom.uploadAttempts.length;
    await sendPrivateMedia(alice.page, { name: 'again.png', mimeType: 'image/png', buffer: png });
    await expect(alice.page.getByTestId('composer-media-upload-unencrypted')).toBeVisible({
      timeout: 30_000,
    });
    expect(blossom.uploadAttempts.at(-1)?.contentType).toBe('application/octet-stream');
    expect(blossom.uploadAttempts.length).toBe(encryptedAttempts + 1);
    expect(plaintextUploads()).toHaveLength(1);
    await alice.page.getByTestId('composer-media-upload-cancel').click();

    // A file that cannot be encrypted is offered without encryption, and nothing is uploaded
    // until the user chooses it. With "don't ask again" set, that choice uploads straight away.
    const attemptsBeforeHeic = blossom.uploadAttempts.length;
    await pickMedia(alice.page, heic);
    await expect(alice.page.getByTestId('composer-media-upload-error')).toHaveText(
      'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.',
    );
    await expect(alice.page.getByTestId('composer-media-upload-retry')).toHaveCount(0);
    await expect(alice.page.getByTestId('composer-media-upload-change-server')).toHaveCount(0);
    expect(blossom.uploadAttempts.length).toBe(attemptsBeforeHeic);
    await alice.page.getByTestId('composer-media-upload-unencrypted').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(warning).toHaveCount(0);
    expect(plaintextUploads()).toHaveLength(2);
    expect(plaintextUploads()[1].contentType).toBe('image/heic');

    // Settings resets the preference, so the confirmation is shown again.
    await openMediaSettings(alice.page);
    const askToggle = alice.page.getByTestId('settings-plaintext-media-ask-toggle');
    await expect(askToggle).not.toBeChecked();
    await askToggle.check();
    await expect(askToggle).toBeChecked();
    await navigateToChat(alice.page, bob.session.publicKey);
    await pickMedia(alice.page, heic);
    await alice.page.getByTestId('composer-media-upload-unencrypted').click();
    await expect(warning).toBeVisible();
    await alice.page.getByTestId('composer-media-upload-cancel').click();
    expect(plaintextUploads()).toHaveLength(2);
    // A confirmed upload afterwards is the sync point: a delayed upload of the cancelled file
    // would make it the fourth.
    await pickMedia(alice.page, heic);
    await alice.page.getByTestId('composer-media-upload-unencrypted').click();
    await alice.page.getByTestId('composer-media-plaintext-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(plaintextUploads()).toHaveLength(3);

    await expectNoUnexpectedBrowserErrors([alice, bob], { allowPatterns: [/415/u] });
  } finally {
    await disposeUsers(alice, bob);
  }
});
