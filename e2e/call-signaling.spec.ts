import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
import { createTestRelay } from '../scripts/test-relay.mjs';
import { once } from 'node:events';

test.use({
  permissions: ['microphone', 'camera'],
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test('call invite reaches a delayed recipient relay despite unrelated relay acknowledgements and failures', async ({
  browser,
  page: caller,
  baseURL,
}) => {
  // Delay the actual WebSocket upgrade, so the publisher sees CONNECTING.
  // Playwright routeWebSocket alone opens the browser socket immediately.
  const senderRelay = createTestRelay(0),
    receiverRelay = createTestRelay(0);
  await Promise.all([once(senderRelay, 'listening'), once(receiverRelay, 'listening')]);
  const senderPort = senderRelay.address().port,
    receiverPort = receiverRelay.address().port;
  const senderUrl = `ws://127.0.0.1:${senderPort}/`;
  const receiverUrl = `ws://127.0.0.1:${receiverPort}/`;
  const sockets = new Set<Socket>();
  const upgrades: Array<() => void> = [];
  let released = false;
  const proxy = createServer();
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (request, socket: Socket, head) => {
    socket.pause();
    const upgrade = () => {
      if (socket.destroyed) return;
      const upstream = connect(receiverPort, '127.0.0.1', () => {
        const headers: string[] = [];
        for (let i = 0; i < request.rawHeaders.length; i += 2)
          headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
        upstream.write(
          `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
      sockets.add(upstream);
      upstream.on('close', () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      socket.on('error', () => upstream.destroy());
    };
    if (released) upgrade();
    else upgrades.push(upgrade);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  const delayedRelay = `ws://127.0.0.1:${address.port}/`;
  const other = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const recipient = await other.newPage();
  const alice = generateSecretKey(),
    bob = generateSecretKey();

  async function login(page: Page, key: Uint8Array, relay: string) {
    // This regression exercises real encrypted Nostr signaling, not Iroh media.
    // Stub endpoint preparation to keep it independent of public media relays.
    await page.route('**/iroh/anagram_iroh_calls.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `export default async function() {}
        export class CallEndpoint {
          static async create_with_relays(relays) {
            return { online: async () => {}, id: () => '${'d'.repeat(64)}',
              relay_url: () => relays[0], close: async () => {} };
          }
        }`,
      }),
    );
    await page.addInitScript((home) => {
      const relays = JSON.stringify(
        [home, 'ws://127.0.0.1:65533/', 'ws://127.0.0.1:65534/'].map((url) => ({
          url,
          read: true,
          write: true,
        })),
      );
      localStorage.setItem('relays', relays);
      localStorage.setItem('nip65_relays', relays);
    }, relay);
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(baseURL!);
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
  }
  async function contact(page: Page, pubkey: string, relay: string) {
    await page.evaluate(
      async ({ pubkey, relay }) => {
        const { contactsService } = await import('/src/services/contactsService.ts');
        await contactsService.createContact({
          public_key: pubkey,
          name: 'Call peer',
          type: 'user',
          meta: { private_contact_list_member: true },
          relays: [{ url: relay, read: true, write: true }],
        });
      },
      { pubkey, relay },
    );
  }
  let recipientPublishes = 0;
  caller.on('websocket', (socket) => {
    if (socket.url() === delayedRelay)
      socket.on('framesent', ({ payload }) => {
        const [verb, event] = JSON.parse(String(payload));
        if (
          verb === 'EVENT' &&
          event.kind === 1059 &&
          event.tags.some((tag: string[]) => tag[0] === 'p' && tag[1] === getPublicKey(bob))
        )
          recipientPublishes++;
      });
  });
  try {
    await login(caller, alice, senderUrl);
    await login(recipient, bob, receiverUrl);
    await contact(recipient, getPublicKey(alice), senderUrl);
    // Create this last so background contact discovery cannot preconnect the route.
    await contact(caller, getPublicKey(bob), delayedRelay);
    await caller.evaluate(async (peer) => {
      const { useCallStore } = await import('/src/stores/callStore.ts');
      await useCallStore().start(peer, 'audio');
    }, getPublicKey(bob));
    expect(recipientPublishes).toBe(0);
    // The first send has completed using the sender's own relay. Only now let
    // the recipient route finish connecting, without changing its URL.
    released = true;
    upgrades.splice(0).forEach((upgrade) => upgrade());
    await expect(recipient.getByTestId('call-accept')).toBeVisible({ timeout: 15_000 });
    expect(recipientPublishes).toBeGreaterThan(0);
    await expect
      .poll(() =>
        caller.evaluate(async () => {
          const { useCallStore } = await import('/src/stores/callStore.ts');
          return useCallStore().session?.peerConfirmed;
        }),
      )
      .toBe(true);
    await caller.getByTestId('call-hangup').click();
    await expect(recipient.getByTestId('call-accept')).toBeHidden();
  } finally {
    await other.close();
    upgrades.length = 0;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    for (const relay of [senderRelay, receiverRelay]) {
      for (const client of relay.clients) client.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }
});
