import { expect, test, type Page } from '@playwright/test';
import { bootstrapUser, navigateToChat, disposeUsers, TEST_ACCOUNTS } from './parity/helpers';

const server = 'https://images.example.org';
const image = {
  name: 'avatar.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
};
// A Blossom server for encrypted private media: it stores what it receives and serves it back,
// so the client can only show the image if it decrypts what it uploaded.
async function uploads(page: Page, account: string) {
  const bodies: Buffer[] = [];
  const contentTypes: string[] = [];
  let hold: Promise<void> | undefined;
  let release = () => {};
  await page.route(`${server}/**`, async (route) => {
    if (route.request().method() !== 'PUT') {
      const number = Number(new URL(route.request().url()).pathname.slice(1));
      const body = bodies[number - 1];
      await route.fulfill(
        body
          ? { contentType: 'application/octet-stream', body }
          : { status: 404, body: 'Not found' },
      );
      return;
    }
    expect(route.request().url()).toBe(`${server}/upload`);
    const headers = route.request().headers();
    const auth = JSON.parse(
      Buffer.from(headers.authorization.slice('Nostr '.length), 'base64').toString(),
    );
    expect(auth.kind).toBe(24242);
    expect(auth.pubkey).toBe(account);
    const body = route.request().postDataBuffer()!;
    bodies.push(body);
    contentTypes.push(headers['content-type']);
    const number = bodies.length;
    await hold;
    await route.fulfill({
      status: 201,
      json: {
        url: `${server}/${number}`,
        sha256: headers['x-sha-256'],
        size: body.length,
        type: 'application/octet-stream',
      },
    });
  });
  await page.evaluate(async (server) => {
    const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
    await useNostrStore().savePrivateMediaBlossomServerUrl(server);
  }, server);
  return {
    count: () => bodies.length,
    bodies,
    contentTypes,
    hold: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
      hold = undefined;
    },
  };
}
// Private media is encrypted and sent as its own NIP-17 kind 15 message, which has no caption:
// the composer text stays in the draft and is sent separately.
test('private upload can be cancelled, sends encrypted kind 15 media, and keeps the caption draft', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.composerUpload);
  try {
    const { page } = user;
    await navigateToChat(page, user.session.publicKey);
    const input = page.getByTestId('message-composer-input');
    const rows = page.getByTestId('message-bubble');
    const upload = await uploads(page, user.session.publicKey);
    await input.fill('My caption');
    upload.hold();
    await page.locator('input[type="file"]').setInputFiles(image);
    const dialog = page.getByRole('dialog', { name: 'upload', exact: true });
    await expect(dialog).toContainText(image.name);
    await expect(dialog).toContainText('Text in the composer is not included');
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect.poll(upload.count).toBe(1);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    upload.release();
    await expect(input).toHaveValue('My caption');
    await expect(rows).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles(image);
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The cancelled upload was released before this one started; a late send would add a row.
    await expect(rows).toHaveCount(1);
    await expect(rows.getByTestId('message-encrypted-image')).toBeVisible({ timeout: 30_000 });
    await expect(rows).not.toContainText('My caption');
    expect(upload.count()).toBe(2);
    expect(upload.contentTypes).toEqual(['application/octet-stream', 'application/octet-stream']);
    for (const body of upload.bodies) expect(body.includes(image.buffer)).toBe(false);
    await expect(input).toHaveValue('My caption');
    await input.fill('My finished caption');
    await page.getByTestId('message-send-button').click();
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toContainText('My finished caption');
    await expect(input).toHaveValue('');
  } finally {
    await disposeUsers(user);
  }
});
