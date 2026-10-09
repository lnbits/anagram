import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from 'nostr-tools';
import { WebSocket } from 'ws';
import { finishOnboarding } from './auth-helpers';
import {
  navigateInApp,
  openDirectChatFromIdentifier,
  updateStoredContactRelays,
} from './parity/helpers';
const relay = 'ws://127.0.0.1:7777/';
async function login(page: Page) {
  const key = generateSecretKey();
  await page.addInitScript((url) => {
    for (const name of ['relays', 'nip65_relays'])
      localStorage.setItem(name, JSON.stringify([{ url, read: true, write: true }]));
  }, relay);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  return { key, pubkey: getPublicKey(key) };
}
async function publish(event: ReturnType<typeof finalizeEvent>) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relay);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Relay timeout'));
    }, 5000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer);
        ws.close();
        msg[2] ? resolve() : reject(new Error(msg[3]));
      }
    });
  });
}
async function create(page: Page, name = 'Public lounge') {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'New public group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New public group' });
  await dialog.getByLabel('Group name', { exact: true }).fill(name);
  await dialog.getByLabel('Description', { exact: true }).fill('Everyone welcome');
  await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
  await expect(page).toHaveURL(/\/public\/naddr/);
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(name);
  const naddr = page.url().split('/public/')[1];
  const decoded = nip19.decode(naddr);
  if (decoded.type !== 'naddr') throw new Error();
  return {
    naddr,
    address: `34550:${decoded.data.pubkey}:${decoded.data.identifier}`,
    slug: decoded.data.identifier,
  };
}
test('create, share, edit and moderate public groups without rich hydration for strangers', async ({
  page,
}, info) => {
  const owner = await login(page);
  const room = await create(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy public group link' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`/join/chat.html#/public/${room.naddr}`);
  const sharedLink = await page.evaluate(() => navigator.clipboard.readText());
  await page.goto(sharedLink);
  await expect(page).toHaveURL(new RegExp(`/public/${room.naddr}$`));
  await expect(page.getByRole('button', { name: 'Attach public media' })).toBeVisible();
  const stranger = generateSecretKey(),
    pk = getPublicKey(stranger);
  let mediaRequests = 0;
  await page.route('https://public-media.example.org/**', (r) => {
    mediaRequests++;
    return r.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.getByLabel('Public message', { exact: true }).fill('**Owner formatting**');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.locator('[data-testid="public-message"] strong').filter({ hasText: 'Owner formatting' }),
  ).toBeVisible();
  const text =
    '**stranger formatting** https://public-media.example.org/picture.png <img src=x onerror=alert(1)>';
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', room.address],
        ['imeta', 'url https://public-media.example.org/hidden.png', 'm image/png'],
      ],
      content: text,
    },
    stranger,
  );
  await publish(event);
  const message = page.getByTestId('public-message').filter({ hasText: 'stranger formatting' });
  await expect(message).toBeVisible();
  await expect(message.locator('a,img,video,iframe')).toHaveCount(0);
  await expect(message).toContainText('[link removed]');
  await expect(message).not.toContainText('https://public-media.example.org');
  await message.getByTestId('message-relay-status').click();
  const relayDialog = page.locator('dialog.relay-dialog');
  await expect(relayDialog).toContainText(relay);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  expect(mediaRequests).toBe(0);
  // A foreign account cannot replace this room's policy by copying its slug.
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['d', room.slug],
          ['anagram-room', '1'],
          ['name', 'Forged group'],
          ['relay', relay],
          ['trusted', pk],
        ],
      },
      stranger,
    ),
  );
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Public lounge',
  );
  await page.getByRole('button', { name: 'Public group settings' }).click();
  let dialog = page.getByRole('dialog', { name: 'Public group settings' });
  await dialog.getByLabel('Group name', { exact: true }).fill('Renamed public group');
  await dialog.getByLabel('Picture URL').fill('https://public-media.example.org/avatar.png');
  await dialog.getByRole('button', { name: 'Save group profile' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Renamed public group',
  );
  async function add(list: 'Trusted' | 'Blocked') {
    await page.getByRole('button', { name: 'Public group settings' }).click();
    const d = page.getByRole('dialog', { name: 'Public group settings' });
    await d.getByRole('tab', { name: list, exact: true }).click();
    await d.getByRole('button', { name: `Add ${list.toLowerCase()} users` }).click();
    const picker = page.getByRole('dialog', { name: `Add ${list.toLowerCase()} users` });
    await picker.getByLabel('Search people').fill(pk);
    await picker.getByTestId('profile-search-result').click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).not.toBeVisible();
  }
  await add('Trusted');
  await expect(message.locator('img')).toHaveCount(2);
  await expect(message).not.toContainText('[link removed]');
  await expect.poll(() => mediaRequests).toBeGreaterThan(0);
  await add('Blocked');
  await expect(message).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Renamed public group',
  );
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'stranger formatting' }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('public-group-mobile.png') });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Renamed public group Public group/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Renamed public group Public group/ }).click();
  await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
  expect(owner.pubkey).toBe(
    nip19.decode(room.naddr).type === 'naddr' ? room.address.split(':')[1] : '',
  );
});

test('public renderer remains responsive', async ({ page }) => {
  page.on('pageerror', (e) => console.log(e.message));
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/node_modules/.vite/deps/svelte.js');
    const { default: Component } = await import('/src/lib/components/public/PublicMessage.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    mount(Component, {
      target,
      props: {
        trusted: true,
        event: {
          kind: 9,
          content: '**Owner formatting**',
          tags: [],
          created_at: 1,
          pubkey: 'a'.repeat(64),
        },
      },
    });
  });
  await expect(page.locator('strong').filter({ hasText: 'Owner formatting' })).toBeVisible();
});

test('owners hand over through signed successor and predecessor, with historical reading', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const alice = await a.newPage(),
    bob = await b.newPage();
  try {
    await login(alice);
    const first = await create(alice, 'Original room');
    await alice.getByLabel('Public message', { exact: true }).fill('Before the handover');
    await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.getByTestId('public-message')).toContainText('Before the handover');
    const successorOwner = await login(bob);
    await bob.getByRole('button', { name: 'Chat options' }).click();
    await bob.getByRole('button', { name: 'New public group', exact: true }).click();
    const dialog = bob.getByRole('dialog', { name: 'New public group' });
    await dialog.getByLabel('Group name', { exact: true }).fill('Successor room');
    await dialog.getByText('Continue a group from another owner', { exact: true }).click();
    await dialog.getByLabel('Previous group link').fill(first.naddr);
    await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    const successor = bob.url().split('/public/')[1];
    await alice.getByRole('button', { name: 'Public group settings' }).click();
    const settings = alice.getByRole('dialog', { name: 'Public group settings' });
    await settings.getByRole('tab', { name: 'Ownership', exact: true }).click();
    await settings.getByLabel('Successor group link').fill(successor);
    await settings.getByRole('checkbox').check();
    await settings.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(alice.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    await alice.getByRole('combobox').selectOption(first.address);
    await expect(alice.getByTestId('public-message')).toContainText('Before the handover');
    await expect(alice.getByLabel('Public message', { exact: true })).toBeDisabled();
    await alice.getByRole('combobox').selectOption('');
    await expect(alice.getByRole('button', { name: 'Attach public media' })).toBeEnabled();
    await alice.getByRole('button', { name: 'Attach public media' }).click();
    const mediaNotice = alice.getByRole('dialog', { name: 'Media sharing', exact: true });
    await expect(mediaNotice.getByRole('link')).toHaveAttribute(
      'href',
      `/chats/${successorOwner.pubkey}`,
    );
    await mediaNotice.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await alice
      .getByLabel('Public message', { exact: true })
      .fill('**Former owner is plain text**');
    await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    const message = alice
      .getByTestId('public-message')
      .filter({ hasText: 'Former owner is plain text' });
    await expect(message).toContainText('**Former owner is plain text**');
    await expect(
      message.locator('strong').filter({ hasText: 'Former owner is plain text' }),
    ).toHaveCount(0);
    await alice.reload();
    await expect(alice.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    await alice.getByRole('button', { name: 'Public group settings' }).click();
    await expect(
      alice.getByRole('dialog').getByRole('tab', { name: 'Ownership', exact: true }),
    ).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('public history uses private-group scroll gestures and leaving lives in settings', async ({
  page,
}) => {
  await login(page);
  const room = await create(page, 'History room');
  await navigateInApp(page, '/chats');
  const author = generateSecretKey();
  const now = Math.floor(Date.now() / 1000) - 1000;
  for (let n = 0; n < 110; n++)
    await publish(
      finalizeEvent(
        {
          kind: 9,
          created_at: now + n,
          tags: [['a', room.address]],
          content: `History item ${n}`,
        },
        author,
      ),
    );
  await navigateInApp(page, `/public/${room.naddr}`);
  const log = page.getByRole('log', { name: 'Public group messages' });
  await expect(log.getByTestId('public-message').last()).toContainText('History item 109');
  await expect(log.getByTestId('public-message').first()).toContainText('History item 60');
  await expect(log.getByTestId('public-message')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Leave public group', exact: true })).toHaveCount(
    0,
  );
  await log.evaluate((node) => {
    node.scrollTop = 0;
  });
  await log.hover();
  await page.mouse.wheel(0, -120);
  await expect(log.getByTestId('public-message').first()).toContainText('History item 10');
  expect(await log.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Public group settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Public group settings' });
  await expect(settings.getByRole('heading', { name: 'History room' })).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(settings).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Public group settings' }).click();
  await expect(settings).toBeVisible();
  const bounds = await settings.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await settings.getByRole('button', { name: 'Leave public group', exact: true }).click();
  await settings.getByRole('button', { name: 'Leave group', exact: true }).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('button', { name: /History room Public group/ })).toHaveCount(0);
});

test('saved public groups appear on reload while session relay reads are stalled', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Cached sidebar group');
  await navigateInApp(page, '/chats');
  const savedRoom = page.getByRole('button', { name: /Cached sidebar group Public group/ });
  await expect(savedRoom).toBeVisible();

  // Reload the chat list, not the public thread (which initializes its own cache).
  // Keep account synchronization waiting for real relay responses.
  let relayRequests = 0;
  await page.routeWebSocket(relay, (socket) => {
    socket.onMessage((message) => {
      if (JSON.parse(String(message))[0] === 'REQ') relayRequests++;
    });
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(savedRoom).toBeVisible({ timeout: 1500 });
  await expect.poll(() => relayRequests).toBeGreaterThan(0);
});

test('a stalled replica does not block opening, posting or cached re-entry', async ({ page }) => {
  await page.routeWebSocket('wss://stalled.example.org/**', () => {});
  const owner = await login(page);
  const slug = crypto.randomUUID();
  const event = finalizeEvent(
    {
      kind: 34550,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['d', slug],
        ['anagram-room', '1'],
        ['name', 'Fast room'],
        ['relay', relay],
        ['relay', 'wss://stalled.example.org/'],
      ],
    },
    owner.key,
  );
  await publish(event);
  const naddr = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: slug,
    relays: [relay, 'wss://stalled.example.org/'],
  });
  await navigateInApp(page, `/public/${naddr}`);
  await expect(page.getByLabel('Public message', { exact: true })).toBeEnabled({ timeout: 3000 });
  await page.getByLabel('Public message', { exact: true }).fill('Fast post');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('public-message')).toContainText('Fast post', { timeout: 3000 });
  await expect(page.getByLabel('Public message', { exact: true })).toHaveValue('', {
    timeout: 3000,
  });
  // Stop the room listener, then simulate a completely offline policy lookup.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await page.evaluate(async () => {
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    const runtime = useNostrStore().publicGroups;
    runtime.stopView();
  });
  await page.context().setOffline(true);
  await page.getByRole('button', { name: /Fast room Public group/ }).click();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Fast room',
    { timeout: 1500 },
  );
  await expect(page.getByTestId('public-message')).toContainText('Fast post', { timeout: 1500 });
});

test('uses cached author photos and shared media rendering for redirected Blossom uploads', async ({
  page,
}) => {
  const owner = await login(page);
  const stranger = generateSecretKey();
  const strangerKey = getPublicKey(stranger);
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  let strangerRequests = 0;
  await page.route('https://avatars.example.org/**', (route) => {
    if (route.request().url().endsWith('/stranger.png')) strangerRequests++;
    return route.fulfill({ contentType: 'image/png', body: image });
  });
  await page.evaluate(
    async ({ owner, stranger }) => {
      const { rememberPublicProfile } = await import('/src/lib/state/publicProfiles.ts');
      rememberPublicProfile(owner, {
        name: 'Owner',
        picture: 'https://avatars.example.org/owner.png',
      });
      rememberPublicProfile(stranger, {
        name: 'Stranger',
        picture: 'https://avatars.example.org/stranger.png',
      });
    },
    { owner: owner.pubkey, stranger: strangerKey },
  );
  const room = await create(page, 'Media room');
  for (const dark of [false, true]) {
    await page.evaluate((dark) => {
      document.body.classList.toggle('body--dark', dark);
      document.body.dataset.accent = 'green';
      document.body.style.setProperty('--theme-accent-light', '#3e7140');
      document.body.style.setProperty('--theme-accent-dark', '#77aa79');
    }, dark);
    const row = page.getByTestId('public-chat-item').filter({ hasText: 'Media room' });
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row.locator('strong')).toHaveCSS('color', 'rgb(255, 255, 255)');
  }

  await page.route('**/upload', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers().authorization).toMatch(/^Nostr /);
    return route.fulfill({
      status: 201,
      json: {
        url: 'https://blossom.example.org/photo.png',
        type: 'image/png',
        size: image.length,
        sha256: route.request().headers()['x-sha-256'],
      },
    });
  });
  await page.route('https://blossom.example.org/photo.png', (route) =>
    route.fulfill({
      status: 307,
      headers: { location: new URL('/pwa/icon-192.png', page.url()).href },
    }),
  );

  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'upload', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('public-message')).toHaveCount(0);
  await expect(page.getByTestId('message-composer-input')).toHaveValue(
    'https://blossom.example.org/photo.png',
  );
  await page
    .getByTestId('message-composer-input')
    .fill('A public caption\nhttps://blossom.example.org/photo.png');
  await page.getByTestId('message-send-button').click();
  const message = page.getByTestId('public-message');
  await expect(message.locator('img[src="https://avatars.example.org/owner.png"]')).toBeVisible();
  const media = message.locator('img[src="https://blossom.example.org/photo.png"]');
  await expect
    .poll(() => media.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(message.getByRole('button', { name: 'Media options', exact: true })).toBeVisible();
  await message.getByTestId('message-relay-status').click();
  const statusDialog = page.locator('dialog.relay-dialog');
  await expect(statusDialog).toContainText(relay);
  await expect(statusDialog).toContainText('published');
  await expect(statusDialog.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  await expect(message.locator('.message-text')).toContainText('A public caption');
  await media.click();
  await expect(page.getByRole('dialog', { name: 'Image attachment' })).toBeVisible();
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', room.address]],
        content: 'Stranger message',
      },
      stranger,
    ),
  );
  const untrusted = page.getByTestId('public-message').filter({ hasText: 'Stranger message' });
  await expect(untrusted).toBeVisible();
  await expect(untrusted.locator('img')).toHaveCount(0);
  expect(strangerRequests).toBe(0);
});

test('public relay failures can retry the same message through the shared dialog', async ({
  page,
}) => {
  let rejectPosts = true;
  const secondary = 'wss://replica.example.org/';
  await page.routeWebSocket(secondary, (socket) =>
    socket.onMessage((raw) => {
      const data = JSON.parse(String(raw));
      if (data[0] === 'REQ') socket.send(JSON.stringify(['EOSE', data[1]]));
      if (data[0] === 'EVENT')
        socket.send(
          JSON.stringify([
            'OK',
            data[1].id,
            !rejectPosts,
            rejectPosts ? 'blocked: test rejection' : '',
          ]),
        );
    }),
  );
  const owner = await login(page);
  const definition = finalizeEvent(
    {
      kind: 34550,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['d', 'relay-retry'],
        ['anagram-room', '1'],
        ['name', 'Relay retry room'],
        ['relay', relay],
        ['relay', secondary],
      ],
    },
    owner.key,
  );
  await publish(definition);
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: 'relay-retry',
    relays: [relay],
  });
  await navigateInApp(page, `/public/${link}`);
  const input = page.getByLabel('Public message', { exact: true });
  await expect(input).toBeEnabled();
  await input.fill('Retry this exact event');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const message = page.getByTestId('public-message').filter({ hasText: 'Retry this exact event' });
  await expect(message.locator('.bubble__status-segment--red')).toBeVisible();
  const id = await message.getAttribute('data-event-id');
  await message.getByTestId('message-relay-status').click();
  const dialog = page.locator('dialog.relay-dialog');
  await expect(dialog).toContainText(secondary);
  await expect(dialog).toContainText('blocked: test rejection');
  rejectPosts = false;
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(message.locator('.bubble__status-segment--red')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  await expect(message).toHaveAttribute('data-event-id', id!);
  await expect(page.getByTestId('public-message')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('public-message')).toHaveCount(1);
  await expect(page.getByTestId('message-relay-status')).toBeVisible();
});

test('sender names and avatars reuse the private-chat DM action on desktop and mobile', async ({
  page,
}) => {
  await login(page);
  const room = await create(page, 'Author links');
  await page.evaluate(() => {
    localStorage.setItem('ui-desktop-message-layout', 'bubbles');
    window.dispatchEvent(
      new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout: 'bubbles' } }),
    );
  });
  const sender = generateSecretKey(),
    publicKey = getPublicKey(sender);
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', room.address]],
        content: 'Open my DM',
      },
      sender,
    ),
  );
  const message = page.getByTestId('public-message').filter({ hasText: 'Open my DM' });
  await expect(message).toBeVisible();
  await message.getByTestId('thread-author-name-link').click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const dmUrl = page.url();
  await expect(
    page.locator(`[data-testid="chat-thread"][data-chat-public-key="${publicKey}"]`),
  ).toBeVisible();
  await navigateInApp(page, `/public/${room.naddr}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toBeVisible();
  await message.getByTestId('thread-author-profile-link').click();
  await expect(page).toHaveURL(dmUrl);
  await expect(
    page.locator(`[data-testid="chat-thread"][data-chat-public-key="${publicKey}"]`),
  ).toBeVisible();
});

test('keeps the next draft when a previous public post receives a delayed acknowledgement', async ({
  page,
}) => {
  let pendingAck: (() => void) | undefined;
  await page.routeWebSocket(relay, (socket) => {
    const server = socket.connectToServer();
    let pendingId = '';
    socket.onMessage((raw) => {
      const data = JSON.parse(String(raw));
      if (data[0] === 'EVENT' && data[1].kind === 9 && data[1].content === 'First draft')
        pendingId = data[1].id;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const data = JSON.parse(String(raw));
      if (data[0] === 'OK' && data[1] === pendingId) pendingAck = () => socket.send(raw);
      else socket.send(raw);
    });
  });
  await login(page);
  await create(page, 'Pending composer');
  const composer = page.getByLabel('Public message', { exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('First draft');
  await send.click();
  await expect.poll(() => Boolean(pendingAck)).toBe(true);
  await expect(send).toBeDisabled();
  await composer.fill('Next draft');
  pendingAck!();
  await expect(send).toBeEnabled();
  await expect(composer).toHaveValue('Next draft');
  await send.click();
  await expect(composer).toHaveValue('');
  await expect(page.getByTestId('public-message').filter({ hasText: 'First draft' })).toHaveCount(
    1,
  );
  await expect(page.getByTestId('public-message').filter({ hasText: 'Next draft' })).toHaveCount(1);
});

test('app relays carry public group creation, moderation and posts when preferred relays fail', async ({
  page,
}) => {
  const deadRelay = 'wss://disconnected.example.org/';
  const stalledRelay = 'wss://stalled.example.org/';
  await page.routeWebSocket(deadRelay, (socket) => {
    socket.onMessage(() => socket.close());
  });
  await page.routeWebSocket(stalledRelay, (socket) => {
    socket.onMessage(() => {});
  });
  await login(page);
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'New public group', exact: true }).click();
  const creating = page.getByRole('dialog', { name: 'New public group', exact: true });
  await creating.getByLabel('Group name', { exact: true }).fill('App relay fallback');
  await creating.getByText('Preferred relays', { exact: true }).click();
  await expect(creating.locator('.group-relays')).toContainText(relay);
  await creating.getByRole('button', { name: `Remove relay ${relay}`, exact: true }).click();
  await creating.getByLabel('Relay URL', { exact: true }).fill(deadRelay);
  await creating.getByRole('button', { name: 'Add relay', exact: true }).click();
  await creating.getByRole('button', { name: 'Create public group', exact: true }).click();
  await expect(creating).toBeHidden({ timeout: 3000 });
  await page.getByRole('button', { name: 'Public group settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Public group settings', exact: true });
  const member = getPublicKey(generateSecretKey());
  await settings.getByRole('tab', { name: 'Trusted', exact: true }).click();
  await settings.getByRole('button', { name: 'Add trusted users', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add trusted users', exact: true });
  await picker.getByLabel('Search people').fill(member);
  await picker.getByTestId('profile-search-result').click();
  await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
  await expect(picker).toBeHidden({ timeout: 3000 });
  await expect(settings).toBeHidden();
  await page.getByRole('button', { name: 'Public group settings' }).click();
  await settings.getByRole('tab', { name: 'Relays', exact: true }).click();
  await expect(settings.locator('.group-relays li')).toHaveCount(1);
  await expect(settings.locator('.group-relays')).toContainText(deadRelay);
  await settings.getByRole('button', { name: `Remove relay ${deadRelay}`, exact: true }).click();
  await settings.getByLabel('Relay URL', { exact: true }).fill(stalledRelay);
  await settings.getByRole('button', { name: 'Add relay', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settings.getByRole('button', { name: 'Save group relays', exact: true }).click();
  await expect(settings).toBeHidden({ timeout: 3000 });
  const composer = page.getByPlaceholder('Write a public message');
  await composer.fill('App relay delivery');
  await composer.press('Enter');
  await expect(composer).toHaveValue('', { timeout: 3000 });
  await page.reload();
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'App relay delivery' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Public group settings' }).click();
  await settings.getByRole('tab', { name: 'Relays', exact: true }).click();
  await expect(settings.locator('.group-relays li')).toHaveCount(1);
  await expect(settings.locator('.group-relays')).toContainText(stalledRelay);
  await settings.getByRole('tab', { name: 'Trusted', exact: true }).click();
  await expect(settings.locator('.member')).toHaveCount(1);
});

test('public chat shares layouts, sender grouping, date dividers, emoji input and safe message actions', async ({
  page,
}, info) => {
  await login(page);
  const room = await create(page, 'Shared chat UI');
  const author = generateSecretKey();
  const now = Math.floor(Date.now() / 1000);
  for (const [content, created_at] of [
    ['Yesterday', now - 86400],
    ['First today', now - 10],
    ['Second today', now - 9],
  ] as const)
    await publish(
      finalizeEvent({ kind: 9, created_at, content, tags: [['a', room.address]] }, author),
    );
  const first = page.getByTestId('public-message').filter({ hasText: 'First today' });
  const last = page.getByTestId('public-message').filter({ hasText: 'Second today' });
  const log = page.getByRole('log', { name: 'Public group messages' });
  await expect(last).toBeVisible();
  await expect(log.locator('.date-divider')).toHaveCount(2);
  await expect(first.locator('.bubble-author-name')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('ui-desktop-message-layout', 'text');
    window.dispatchEvent(
      new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout: 'text' } }),
    );
  });
  await expect(first.locator('.message-author')).toBeVisible();
  await expect(first.locator('.bubble-author-name')).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem('ui-desktop-message-layout', 'bubbles');
    window.dispatchEvent(
      new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout: 'bubbles' } }),
    );
  });
  await expect(first.locator('.bubble-author-name')).toBeVisible();
  await expect(first.locator('.bubble-avatar')).toHaveCount(0);
  await expect(last.locator('.bubble-author-name')).toHaveCount(0);
  await expect(last.locator('.bubble-avatar')).toBeVisible();
  await expect(last).toHaveClass(/sender-continuation/);
  await expect(first.locator('.message-content')).toHaveCSS('border-top-left-radius', '18px');
  await expect(last.locator('.message-content')).toHaveCSS('border-top-left-radius', '6px');
  await first.hover();
  await first.getByRole('button', { name: 'Message actions', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu.getByRole('menuitem')).toHaveCount(5);
  await expect(menu.getByRole('menuitem', { name: 'Pin message', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Reply', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'React', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Nostr info', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'info', exact: true });
  await expect(details).toContainText(getPublicKey(author));
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByLabel('Public message', { exact: true }).fill(':thumbs');
  await expect(page.getByRole('listbox', { name: 'Emoji suggestions' })).toBeVisible();
  await page.getByLabel('Public message', { exact: true }).press('Enter');
  await expect(page.getByLabel('Public message', { exact: true })).not.toHaveValue(':thumbs');
  await expect(log.getByTestId('public-message')).toHaveCount(3);
  await page.getByLabel('Public message', { exact: true }).fill('');
  await page.getByTestId('message-composer-emoji').click();
  await page.getByLabel('Search emoji').fill('thumbs up');
  await page.locator('.emoji-grid button').first().click();
  await expect(page.getByLabel('Public message', { exact: true })).not.toHaveValue('');
  await page.getByTestId('message-send-button').click();
  await expect(page.getByLabel('Public message', { exact: true })).toHaveValue('');
  await expect(log.getByTestId('public-message')).toHaveCount(4);
  await page.screenshot({ path: info.outputPath('public-shared-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await first.boundingBox();
  await first.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    isPrimary: true,
    clientX: bounds!.x + 60,
    clientY: bounds!.y + 10,
  });
  await expect(menu).toBeVisible();
  await first.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await expect(menu.getByRole('menuitem', { name: 'Copy message', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('public-shared-mobile.png') });
});

test('public chats render trusted group invitations with the shared Join chat button', async ({
  page,
}) => {
  const owner = await login(page);
  const room = await create(page, 'Invite card room');
  const link = `http://127.0.0.1:5173/public/${room.naddr}`;
  await page.getByTestId('message-composer-input').fill(`Welcome here: ${link}`);
  await page.getByRole('button', { name: 'Send message' }).click();
  const message = page.getByTestId('public-message').filter({ hasText: 'Welcome here:' });
  await expect(message.getByRole('link', { name: 'Join chat', exact: true })).toHaveClass(
    /room-link/,
  );
  await expect(message.locator('.link-preview')).toHaveCount(0);
  const outsider = generateSecretKey();
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', room.address]],
        content: `Stranger invite: ${link}`,
      },
      outsider,
    ),
  );
  const untrusted = page.getByTestId('public-message').filter({ hasText: 'Stranger invite:' });
  await expect(untrusted).toContainText('[link removed]');
  await expect(untrusted.getByRole('link')).toHaveCount(0);
});

test('public search reuses thread search and navigates cached messages on desktop and mobile', async ({
  page,
}, info) => {
  const owner = await login(page);
  const room = await create(page, 'Search lounge');
  const base = Math.floor(Date.now() / 1000) - 300;
  const events = Array.from({ length: 180 }, (_, i) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: base + i,
        tags: [['a', room.address]],
        content:
          i === 10
            ? 'Older public needle'
            : i === 40
              ? 'Newer public needle'
              : `Public filler ${i}`,
      },
      owner.key,
    ),
  );
  await page.evaluate(
    async ({ account, address, events }) => {
      const { PublicGroupData } = await import('/src/services/publicGroupData.ts');
      const db = new PublicGroupData(account);
      await db.putMany(address, events);
      await db.close();
    },
    { account: owner.pubkey, address: room.address, events },
  );
  await page.reload();
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'Public filler 179' }),
  ).toBeVisible();
  await expect(page.getByTestId('public-message').filter({ hasText: 'public needle' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Search messages', exact: true });
  const status = page.getByTestId('thread-search-status');
  const focused = page.locator('.message-row.highlighted');
  await expect(input).toBeFocused();
  await input.fill('PUBLIC needle');
  await expect(status).toHaveText('1 / 2');
  await expect(focused).toContainText('Newer public needle');
  await expect(focused).toBeInViewport();
  expect(await page.getByTestId('public-message').count()).toBeLessThanOrEqual(51);
  await page.getByRole('button', { name: 'Previous search result' }).click();
  await expect(status).toHaveText('2 / 2');
  await expect(focused).toContainText('Older public needle');
  await page.getByRole('button', { name: 'Next search result' }).click();
  await expect(status).toHaveText('1 / 2');
  await expect(focused).toContainText('Newer public needle');
  await page
    .locator('.search-results')
    .getByRole('button', { name: 'Older public needle', exact: true })
    .click();
  await expect(status).toHaveText('2 / 2');
  await expect(focused).toContainText('Older public needle');
  await input.press('Enter');
  await expect(status).toHaveText('1 / 2');
  await input.press('Shift+Enter');
  await expect(status).toHaveText('2 / 2');
  await input.fill('no match exists');
  await expect(status).toHaveText('No results');
  await expect(focused).toHaveCount(0);
  await input.fill('public needle');
  await expect(status).toHaveText('1 / 2');
  await page.screenshot({ path: info.outputPath('public-search-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.body.classList.add('body--dark'));
  await page.context().setOffline(true);
  await input.fill('older public');
  await expect(status).toHaveText('1 / 1');
  await expect(focused).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('public-search-mobile.png') });
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(focused).toHaveCount(0);
  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await input.fill('public');
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(focused).toHaveCount(0);
  await page.context().setOffline(false);
});

test('untrusted members keep the attachment button with a clickable creator explanation', async ({
  page,
}, info) => {
  const member = await login(page);
  const creator = generateSecretKey(),
    owner = getPublicKey(creator);
  const slug = `media-permission-${Date.now()}`;
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [
    ['d', slug],
    ['anagram-room', '1'],
    ['name', 'Media permissions'],
    ['relay', relay],
  ];
  await publish(
    finalizeEvent(
      { kind: 0, created_at, tags: [], content: JSON.stringify({ name: 'Group creator' }) },
      creator,
    ),
  );
  await publish(finalizeEvent({ kind: 34550, created_at, tags, content: '' }, creator));
  const link = `/public/${nip19.naddrEncode({ kind: 34550, pubkey: owner, identifier: slug, relays: [relay] })}`;
  await navigateInApp(page, link);
  const attach = page.getByRole('button', { name: 'Attach public media', exact: true });
  const input = page.getByRole('textbox', { name: 'Public message', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Media sharing', exact: true });
  await expect(attach).toBeEnabled();
  await input.fill('Keep my draft');
  let fileChoosers = 0;
  page.on('filechooser', () => fileChoosers++);
  for (const dark of [false, true]) {
    await page.setViewportSize(dark ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    await page.evaluate((dark) => document.body.classList.toggle('body--dark', dark), dark);
    await attach.click();
    await expect(dialog).toContainText('Only trusted users can post media. Ask the group creator');
    await expect(dialog.getByRole('link', { name: 'Group creator', exact: true })).toHaveAttribute(
      'href',
      `/chats/${owner}`,
    );
    await expect(dialog).toContainText('to be added to the trusted member list.');
    await expect(page.locator('.composer input[type="file"]')).toHaveCount(0);
    expect(fileChoosers).toBe(0);
    await page.screenshot({
      path: info.outputPath(`media-permission-${dark ? 'dark-mobile' : 'light-desktop'}.png`),
    });
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(input).toHaveValue('Keep my draft');
  }
  await attach.click();
  await dialog.getByRole('link', { name: 'Group creator', exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await expect(
    page.locator(`[data-testid="chat-thread"][data-chat-public-key="${owner}"]`),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: created_at + 1,
        tags: [...tags, ['trusted', member.pubkey]],
        content: '',
      },
      creator,
    ),
  );
  await navigateInApp(page, link);
  await expect(page.locator('.composer input[type="file"]')).toHaveCount(1);
  const chooser = page.waitForEvent('filechooser');
  await attach.click();
  await (await chooser).setFiles([]);
  await expect(dialog).toHaveCount(0);
  expect(fileChoosers).toBe(1);
});

test('public message actions reuse private controls and synchronize replies, edits, forwarding, reactions and deletion', async ({
  browser,
}) => {
  test.slow();
  const a = await browser.newContext(),
    b = await browser.newContext();
  const alice = await a.newPage(),
    bob = await b.newPage();
  try {
    const owner = await login(alice);
    const destination = await create(alice, 'Forward destination');
    const source = await create(alice, 'Message actions');
    await login(bob);
    await navigateInApp(bob, `/public/${source.naddr}`);
    async function send(page: Page, text: string) {
      await page.getByLabel('Public message', { exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    }
    await send(alice, 'Action original');
    const original = alice.getByTestId('public-message').filter({ hasText: 'Action original' });
    await expect(original).toBeVisible();
    const id = await original.getAttribute('data-event-id');
    const ownMessage = alice.locator(`[id="message-${id}"]`);
    const received = bob.locator(`[id="message-${id}"]`);
    await expect(received).toBeVisible();
    async function action(page: Page, row: ReturnType<Page['locator']>, name: string) {
      await row.hover();
      await row.getByRole('button', { name: 'Message actions', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    await action(bob, received, 'Reply');
    await expect(bob.locator('.composer-context')).toContainText('Action original');
    await send(bob, 'A public reply');
    const reply = alice.getByTestId('public-message').filter({ hasText: 'A public reply' });
    await expect(reply.locator('.reply-preview')).toContainText('Action original');
    await reply.locator('.reply-preview').click();
    await expect(ownMessage).toHaveClass(/highlighted/);

    await alice.getByLabel('Public message', { exact: true }).fill('My unsent draft');
    await action(alice, ownMessage, 'Edit');
    await expect(alice.locator('.composer-context')).toContainText('Editing message');
    await send(alice, 'Action edited once');
    await expect(alice.getByLabel('Public message', { exact: true })).toHaveValue(
      'My unsent draft',
    );
    await expect(ownMessage).toContainText('Action edited once');
    await expect(received).toContainText('Action edited once');
    await expect(ownMessage.getByTestId('message-edited-label')).toBeVisible();
    await action(alice, ownMessage, 'Edit');
    await send(alice, 'Action edited twice');
    await expect(received).toContainText('Action edited twice');
    await expect(reply.locator('.reply-preview')).toContainText('Action edited twice');

    await received.hover();
    await received.getByRole('button', { name: 'Message actions', exact: true }).click();
    await expect(bob.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(bob.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
    await bob.getByRole('button', { name: 'React', exact: true }).click();
    await expect(
      ownMessage.getByRole('button', { name: '👍 reaction', exact: true }),
    ).toBeVisible();
    await bob.reload();
    await expect(received.getByRole('button', { name: '👍 reaction', exact: true })).toBeVisible();
    await received.getByRole('button', { name: '👍 reaction', exact: true }).click();
    await received.getByRole('button', { name: 'Remove reaction', exact: true }).click();
    await expect(ownMessage.locator('.reactions')).toHaveCount(0);

    await action(alice, ownMessage, 'Forward');
    await alice
      .getByRole('dialog', { name: 'forward', exact: true })
      .getByTestId('forward-destination')
      .filter({ hasText: 'Forward destination' })
      .click();
    await expect(alice.getByRole('dialog', { name: 'forward', exact: true })).toHaveCount(0);
    await expect(alice).toHaveURL(new RegExp(`/public/${source.naddr}$`));
    await navigateInApp(alice, `/public/${destination.naddr}`);
    await expect(
      alice.getByTestId('public-message').filter({ hasText: 'Action edited twice' }),
    ).toBeVisible();
    await navigateInApp(alice, `/public/${source.naddr}`);

    // The same forward picker also sends public content to a normal private DM.
    await received.getByTestId('thread-author-name-link').click();
    await expect(bob).toHaveURL(/\/chats\/[^/]+$/);
    await openDirectChatFromIdentifier(bob, nip19.npubEncode(owner.pubkey), 'Public owner');
    await updateStoredContactRelays(bob, owner.pubkey, [relay]);
    await navigateInApp(bob, `/public/${source.naddr}`);
    await action(bob, received, 'Forward');
    await bob
      .getByRole('dialog', { name: 'forward', exact: true })
      .locator(
        `[data-testid="forward-destination"][data-kind="user"][data-public-key="${owner.pubkey}"]`,
      )
      .click();
    await expect(bob.getByRole('dialog', { name: 'forward', exact: true })).toHaveCount(0);
    await received.getByTestId('thread-author-name-link').click();
    await expect(
      bob.getByTestId('message-bubble').filter({ hasText: 'Action edited twice' }),
    ).toBeVisible();
    await navigateInApp(bob, `/public/${source.naddr}`);

    await action(alice, ownMessage, 'Delete');
    for (const row of [ownMessage, received]) {
      await expect(row.getByTestId('message-deleted')).toHaveText('Message deleted');
      await expect(row).not.toContainText('Action edited twice');
    }
    await expect(
      received.getByRole('button', { name: 'Message actions', exact: true }),
    ).toHaveCount(0);
    await alice.reload();
    await bob.reload();
    await expect(
      alice.getByTestId('public-message').filter({ hasText: 'A public reply' }),
    ).toBeVisible();
    await expect(
      bob.getByTestId('public-message').filter({ hasText: 'A public reply' }),
    ).toBeVisible();
    for (const page of [alice, bob]) {
      const deleted = page.locator(`[id="message-${id}"]`);
      await expect(deleted.getByTestId('message-deleted')).toHaveText('Message deleted');
      await expect(
        deleted.getByRole('button', { name: 'Message actions', exact: true }),
      ).toHaveCount(0);
      await expect(
        deleted.locator(
          '.reactions, .reply-preview, [data-testid=message-edited-label], [data-testid=message-relay-status]',
        ),
      ).toHaveCount(0);
      await expect(
        page
          .getByTestId('public-message')
          .filter({ hasText: 'A public reply' })
          .locator('.reply-preview'),
      ).toContainText('Message deleted');
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test('pasted profile identifiers resolve through shared mentions and untrusted posts redact them', async ({
  page,
}) => {
  const requestedAuthors = new Set<string>();
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      try {
        const [type, , ...filters] = JSON.parse(String(payload));
        if (type === 'REQ')
          for (const filter of filters)
            if (filter.kinds?.includes(0))
              for (const author of filter.authors ?? []) requestedAuthors.add(author);
      } catch {
        /* Ignore non-Nostr development traffic. */
      }
    }),
  );
  const owner = await login(page);
  const room = await create(page, 'Profile mention room');
  const stranger = generateSecretKey();
  const hidden = getPublicKey(generateSecretKey());
  const botKey = generateSecretKey(),
    botPubkey = getPublicKey(botKey);
  const now = Math.floor(Date.now() / 1000);
  await publish(
    finalizeEvent(
      {
        kind: 0,
        created_at: now,
        tags: [],
        content: JSON.stringify({ name: 'Dad Jokes', bot: true }),
      },
      botKey,
    ),
  );
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: now,
        tags: [['a', room.address]],
        content: `Stranger profiles: ${nip19.npubEncode(hidden)} nostr:${nip19.nprofileEncode({ pubkey: hidden })}`,
      },
      stranger,
    ),
  );
  const redacted = page.getByTestId('public-message').filter({ hasText: 'Stranger profiles:' });
  await expect(redacted).toContainText('Stranger profiles: [profile removed] [profile removed]');
  await expect(redacted.getByTestId('message-mention-link')).toHaveCount(0);

  await page
    .getByTestId('message-composer-input')
    .fill(`Owner mention: ${nip19.npubEncode(botPubkey)}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const mention = page
    .getByTestId('public-message')
    .filter({ hasText: 'Owner mention:' })
    .getByTestId('message-mention-link');
  await expect(mention).toHaveText('@Dad Jokes');
  expect(requestedAuthors.has(botPubkey)).toBe(true);
  expect(requestedAuthors.has(hidden)).toBe(false);
  await mention.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${botPubkey}$`));
  await expect(page.getByTestId('chat-thread')).toHaveAttribute('data-chat-public-key', botPubkey);
  await navigateInApp(page, `/public/${room.naddr}`);

  // The same rendering applies to trusted members, without adding new UI components.
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: now + 1,
        tags: [
          ['d', room.slug],
          ['name', 'Profile mention room'],
          ['anagram-room', '1'],
          ['relay', relay],
          ['trusted', getPublicKey(stranger)],
        ],
        content: '',
      },
      owner.key,
    ),
  );
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: now + 1,
        tags: [['a', room.address]],
        content: `Trusted mention: nostr:${nip19.npubEncode(botPubkey)}`,
      },
      stranger,
    ),
  );
  await expect(
    page
      .getByTestId('public-message')
      .filter({ hasText: 'Trusted mention:' })
      .getByTestId('message-mention-link'),
  ).toHaveText('@Dad Jokes');
});

test('failed original-message lookups do not block edited public posts or later messages', async ({
  page,
}) => {
  let failedLookups = 0;
  await page.routeWebSocket(relay, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (
        message[0] === 'REQ' &&
        message
          .slice(2)
          .some(
            (filter: { kinds?: number[]; ids?: string[] }) =>
              filter.kinds?.includes(9) && filter.ids,
          )
      ) {
        failedLookups++;
        socket.send(JSON.stringify(['CLOSED', message[1], 'error: lookup unavailable']));
      } else server.send(raw);
    });
  });
  const owner = await login(page);
  const room = await create(page, 'Optional edit recovery');
  const created_at = Math.floor(Date.now() / 1000);
  const original = finalizeEvent(
    { kind: 9, created_at, content: 'No longer on relays', tags: [['a', room.address]] },
    owner.key,
  );
  const replacement = finalizeEvent(
    {
      kind: 9,
      created_at,
      content: 'Edited welcome survives lookup failure',
      tags: [
        ['a', room.address],
        ['e', original.id, '', 'edit'],
      ],
    },
    owner.key,
  );
  await publish(replacement);
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: created_at + 1,
        content: 'Following message survives too',
        tags: [['a', room.address]],
      },
      owner.key,
    ),
  );
  for (const text of ['Edited welcome survives lookup failure', 'Following message survives too'])
    await expect(page.getByTestId('public-message').filter({ hasText: text })).toBeVisible();
  expect(failedLookups).toBeGreaterThan(0);
  await expect(
    page.getByText('Could not save public messages. Refresh to retry.', { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  for (const text of ['Edited welcome survives lookup failure', 'Following message survives too'])
    await expect(page.getByTestId('public-message').filter({ hasText: text })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`public trusted-user mention picker reuses composer controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const owner = await login(page);
    const room = await create(page, 'Mention picker room');
    const botKey = generateSecretKey();
    const bot = getPublicKey(botKey);
    const blocked = getPublicKey(generateSecretKey());
    const unnamed = getPublicKey(generateSecretKey());
    const now = Math.floor(Date.now() / 1000) + 1;
    await publish(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: 'Dad Jokes' }),
        },
        botKey,
      ),
    );
    const metadata = (trusted: string[], created_at: number) =>
      finalizeEvent(
        {
          kind: 34550,
          created_at,
          content: '',
          tags: [
            ['d', room.slug],
            ['name', 'Mention picker room'],
            ['anagram-room', '1'],
            ['relay', relay],
            ...trusted.map((key) => ['trusted', key]),
            ['blocked', blocked],
          ],
        },
        owner.key,
      );
    await publish(metadata([bot, unnamed, blocked], now));
    const input = page.getByTestId('message-composer-input');
    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });
    await input.fill('@');
    await expect(suggestions.getByRole('option')).toHaveCount(3);
    await expect(
      suggestions.getByRole('option', { name: 'Dad Jokes @DadJokes', exact: true }),
    ).toBeVisible();
    await expect(
      suggestions.getByRole('option', { name: new RegExp(unnamed.slice(0, 12)) }),
    ).toBeVisible();
    await expect(suggestions).not.toContainText(blocked.slice(0, 12));
    await input.fill('Are you here @dadj');
    await expect(suggestions.getByRole('option')).toHaveCount(1);
    await input.press('Enter');
    await expect(input).toHaveValue('Are you here @DadJokes ');
    await expect(suggestions).toHaveCount(0);
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(
      page
        .getByTestId('public-message')
        .filter({ hasText: 'Are you here' })
        .getByTestId('message-mention-link'),
    ).toHaveText('@Dad Jokes');

    // Mouse/touch selection uses the same popup; policy updates remove former trusted users.
    await input.fill('@d');
    await suggestions.getByRole('option', { name: 'Dad Jokes @DadJokes', exact: true }).click();
    await expect(input).toHaveValue('@DadJokes ');
    await input.fill('@');
    await publish(metadata([unnamed], now + 1));
    await expect(suggestions.getByRole('option')).toHaveCount(2);
    await expect(suggestions).not.toContainText('Dad Jokes');
    await input.press('Escape');
    await expect(suggestions).toHaveCount(0);
  });
}

test('public chat stays usable with a stalled replica and empty cached-policy lookups', async ({
  page,
}) => {
  const secondary = 'wss://stalled-public.example.org/';
  let emptyMetadata = false;
  let emptyLookups = 0;
  await page.routeWebSocket(secondary, (socket) => socket.onMessage(() => {}));
  await page.routeWebSocket(relay, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (emptyMetadata && frame[0] === 'REQ') {
        const filters = frame
          .slice(2)
          .filter((filter: { kinds?: number[] }) => !filter.kinds?.includes(34550));
        if (filters.length !== frame.length - 2) emptyLookups++;
        if (!filters.length) socket.send(JSON.stringify(['EOSE', frame[1]]));
        else server.send(JSON.stringify(['REQ', frame[1], ...filters]));
      } else server.send(raw);
    });
  });
  const owner = await login(page);
  const slug = `available-${owner.pubkey.slice(0, 12)}`;
  const address = `34550:${owner.pubkey}:${slug}`;
  const now = Math.floor(Date.now() / 1000);
  const messages = Array.from({ length: 55 }, (_, n) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: now - 100 + n,
        tags: [['a', address]],
        content: `Available message ${n}`,
      },
      owner.key,
    ),
  );
  for (const message of messages) await publish(message);
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: now,
        content: '',
        tags: [
          ['d', slug],
          ['name', 'Available public chat'],
          ['anagram-room', '1'],
          ['relay', relay],
          ['relay', secondary],
          ['pinned', messages[0].id],
        ],
      },
      owner.key,
    ),
  );
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: slug,
    relays: [relay],
  });
  await navigateInApp(page, `/public/${link}`);
  await expect(page.getByTestId('pinned-message')).toContainText('Available message 0', {
    timeout: 5000,
  });
  await page.getByRole('button', { name: 'Go to pinned message' }).click();
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'Available message 0' }),
  ).toBeVisible();

  emptyMetadata = true;
  await page.reload();
  const input = page.getByLabel('Public message', { exact: true });
  await expect(input).toBeEnabled({ timeout: 5000 });
  expect(emptyLookups).toBeGreaterThan(0);
  await input.fill('The healthy app relay is enough');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('', { timeout: 5000 });
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'The healthy app relay is enough' }),
  ).toBeVisible();
  await expect(page.getByText(/Public group relay checks did not complete/)).toHaveCount(0);
});

test('an edited public pin resolves and jumps after the original has disappeared', async ({
  page,
}) => {
  const secondary = 'wss://stalled-pin.example.org/';
  await page.routeWebSocket(secondary, (socket) => socket.onMessage(() => {}));
  const owner = await login(page);
  const slug = `edited-pin-${owner.pubkey.slice(0, 12)}`;
  const address = `34550:${owner.pubkey}:${slug}`;
  const now = Math.floor(Date.now() / 1000);
  const original = finalizeEvent(
    { kind: 9, created_at: now - 10, content: 'Welcome', tags: [['a', address]] },
    owner.key,
  );
  // A fresh client only receives the replacement, as with a relay honoring deletion.
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: original.created_at,
        content: 'Welcome to Anagram!',
        tags: [
          ['a', address],
          ['e', original.id, '', 'edit'],
        ],
      },
      owner.key,
    ),
  );
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: now - 5,
        content: 'Reply to the announcement',
        tags: [
          ['a', address],
          ['q', original.id, '', owner.pubkey],
        ],
      },
      owner.key,
    ),
  );
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: now,
        content: '',
        tags: [
          ['d', slug],
          ['name', 'Edited announcement'],
          ['anagram-room', '1'],
          ['relay', relay],
          ['relay', secondary],
          ['pinned', original.id],
        ],
      },
      owner.key,
    ),
  );
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: slug,
    relays: [relay],
  });
  await navigateInApp(page, `/public/${link}`);
  const card = page.getByTestId('pinned-message');
  const message = page
    .getByTestId('public-message')
    .filter({ hasText: 'Welcome to Anagram!', hasNotText: 'Reply to the announcement' });
  await expect(message).toBeVisible();
  const reply = page.getByTestId('public-message').filter({ hasText: 'Reply to the announcement' });
  await expect(reply.locator('.reply-preview')).toContainText('Welcome to Anagram!');
  await reply.locator('.reply-preview').click();
  await expect(message).toHaveClass(/highlighted/);
  await expect(card).toContainText('Welcome to Anagram!', { timeout: 5000 });
  await page.getByRole('button', { name: 'Go to pinned message' }).click();
  await expect(message).toHaveClass(/highlighted/);
  await message.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Unpin message', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(reply.locator('.reply-preview')).toContainText('Welcome to Anagram!');
  await expect(card).toContainText('Welcome to Anagram!', { timeout: 5000 });
  await page.getByRole('button', { name: 'Go to pinned message' }).click();
  await expect(message).toHaveClass(/highlighted/);
});

test('an old pin with many edits loads from a relay that never completes its lookup', async ({
  page,
}) => {
  const lookups = new Set<string>();
  let received = 0;
  await page.routeWebSocket(relay, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame[0] === 'REQ' && frame.slice(2).some((f: { ids?: string[] }) => f.ids))
        lookups.add(frame[1]);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (lookups.has(frame[1])) {
        if (frame[0] === 'EOSE') return;
        if (frame[0] === 'EVENT') received++;
      }
      socket.send(raw);
    });
  });
  const owner = await login(page);
  const slug = `pin-no-eose-${owner.pubkey.slice(0, 12)}`;
  const address = `34550:${owner.pubkey}:${slug}`;
  const now = Math.floor(Date.now() / 1000);
  const original = finalizeEvent(
    { kind: 9, created_at: now - 200, content: 'Original', tags: [['a', address]] },
    owner.key,
  );
  let previous = original;
  for (let n = 0; n < 12; n++) {
    previous = finalizeEvent(
      {
        kind: 9,
        created_at: original.created_at,
        content: `Available announcement ${n}`,
        tags: [
          ['a', address],
          ['e', previous.id, '', 'edit'],
          ['e', original.id],
        ],
      },
      owner.key,
    );
    await publish(previous);
  }
  for (let n = 0; n < 55; n++)
    await publish(
      finalizeEvent(
        { kind: 9, created_at: now - 100 + n, content: `Recent post ${n}`, tags: [['a', address]] },
        owner.key,
      ),
    );
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: now,
        content: '',
        tags: [
          ['d', slug],
          ['name', 'Pin without completion'],
          ['anagram-room', '1'],
          ['relay', relay],
          ['pinned', original.id],
        ],
      },
      owner.key,
    ),
  );
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: slug,
    relays: [relay],
  });
  await navigateInApp(page, `/public/${link}`);
  const card = page.getByTestId('pinned-message');
  await expect(card).toContainText('Available announcement', { timeout: 5000 });
  expect(received).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Go to pinned message' }).click();
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'Available announcement' }),
  ).toHaveClass(/highlighted/);
  await page.reload();
  await expect(card).toContainText('Available announcement', { timeout: 5000 });
  await expect(page.getByText(/Public group relay checks did not complete/)).toHaveCount(0);
});

test('same-second public replies follow their parent despite reverse event-id order after reload', async ({
  page,
}) => {
  const owner = await login(page);
  const room = await create(page, 'Same second replies');
  const created_at = Math.floor(Date.now() / 1000);
  // Generate a high-sorting parent and a lower-sorting reply, so timestamp/id
  // sorting alone deterministically reproduces the inverted conversation.
  let parent = finalizeEvent(
    { kind: 9, created_at, tags: [['a', room.address]], content: 'Prompt 0' },
    owner.key,
  );
  for (let i = 1; !parent.id.startsWith('f'); i++)
    parent = finalizeEvent(
      { kind: 9, created_at, tags: [['a', room.address]], content: `Prompt ${i}` },
      owner.key,
    );
  const peer = generateSecretKey();
  let reply = finalizeEvent(
    {
      kind: 9,
      created_at,
      tags: [
        ['a', room.address],
        ['q', parent.id, relay, owner.pubkey],
      ],
      content: 'Fast reply 0',
    },
    peer,
  );
  for (let i = 1; reply.id >= parent.id; i++)
    reply = finalizeEvent(
      {
        kind: 9,
        created_at,
        tags: [
          ['a', room.address],
          ['q', parent.id, relay, owner.pubkey],
        ],
        content: `Fast reply ${i}`,
      },
      peer,
    );
  await publish(parent);
  await publish(reply);
  const rows = page.getByTestId('public-message');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('.message-text')).toHaveText(parent.content);
  await expect(rows.last().locator('.message-text')).toHaveText(reply.content);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('.message-text')).toHaveText(parent.content);
  await expect(rows.last().locator('.message-text')).toHaveText(reply.content);
});
