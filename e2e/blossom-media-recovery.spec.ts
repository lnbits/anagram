import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools';
import { WebSocket } from 'ws';
import {
  bootstrapUser,
  disposeUsers,
  E2E_RELAY_URL,
  establishAcceptedDirectChat,
  refreshSession,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from './parity/helpers';

const DEAD_HOST = 'https://dead.example.org';
const LYING_HOST = 'https://lying.example.org';
const GOOD_HOST = 'https://good.example.org';
const IMAGE_BYTES = Buffer.from('blossom media recovery fixture bytes');

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Another client publishing its Blossom server list, which is where a client looks when one
// of that author's media links stops working (NIP-B7 / BUD-03).
async function publishServerList(privateKey: string, servers: string[]): Promise<void> {
  const socket = new WebSocket(E2E_RELAY_URL);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const event = finalizeEvent(
    {
      kind: 10063,
      created_at: Math.floor(Date.now() / 1000),
      tags: servers.map((server) => ['server', server]),
      content: '',
    },
    Uint8Array.from(Buffer.from(privateKey, 'hex')),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay accepted no server list')), 10_000);
    socket.on('message', (data) => {
      const [verb, id] = JSON.parse(data.toString()) as [string, string];
      if (verb === 'OK' && id === event.id) {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.send(JSON.stringify(['EVENT', event]));
  });
  socket.close();
}

test('a dead media link is recovered from the servers the author published', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mediaRecoveryAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mediaRecoveryBob);
  const hash = sha256Hex(IMAGE_BYTES);
  const deadUrl = `${DEAD_HOST}/${hash}.png`;
  const missingUrl = `${DEAD_HOST}/${sha256Hex(Buffer.from('never uploaded anywhere'))}.png`;
  const requested: string[] = [];
  try {
    // The stored link is gone; the author's list offers a server that lies about the hash
    // first, then one that really holds the file.
    await bob.page.route(`${DEAD_HOST}/**`, (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 404, body: '' });
    });
    await bob.page.route(`${LYING_HOST}/**`, (route) => {
      requested.push(route.request().url());
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
        body: Buffer.from('not the bytes that were asked for'),
      });
    });
    await bob.page.route(`${GOOD_HOST}/**`, (route) => {
      requested.push(route.request().url());
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
        body: IMAGE_BYTES,
      });
    });

    await establishAcceptedDirectChat(alice, bob);
    await publishServerList(alice.account.privateKey, [LYING_HOST, GOOD_HOST]);
    await sendMessage(alice.page, 'This picture lost its server');
    await sendMessage(alice.page, 'This one is gone for good');
    await bob.page.evaluate(
      async ({ chatId, recoveredUrl, missingMediaUrl, hash, missingHash, size }) =>
        window
          .__appE2E__!.setStoredMessageAttachments({
            chatId,
            messageText: 'This picture lost its server',
            attachments: [
              {
                type: 'media',
                url: recoveredUrl,
                mimeType: 'image/png',
                size,
                sha256: hash,
                name: 'recovered.png',
              },
            ],
          })
          .then(() =>
            window.__appE2E__!.setStoredMessageAttachments({
              chatId,
              messageText: 'This one is gone for good',
              attachments: [
                {
                  type: 'media',
                  url: missingMediaUrl,
                  mimeType: 'image/png',
                  size,
                  sha256: missingHash,
                  name: 'missing.png',
                },
              ],
            }),
          ),
      {
        chatId: alice.session.publicKey,
        recoveredUrl: deadUrl,
        missingMediaUrl: missingUrl,
        hash,
        missingHash: sha256Hex(Buffer.from('never uploaded anywhere')),
        size: IMAGE_BYTES.length,
      },
    );
    await refreshSession(bob.page, alice.session.publicKey);

    const recoveredMessage = threadMessage(bob.page, 'This picture lost its server');
    const loadMedia = recoveredMessage.getByRole('button', { name: 'Load media', exact: true });
    if (await loadMedia.count()) await loadMedia.click();

    // The recovered bytes are shown, and they came from the author's second server: the
    // first one answered with the wrong content and was rejected.
    await expect(recoveredMessage.locator('img')).toHaveAttribute('src', /^blob:/u, {
      timeout: 20_000,
    });
    expect(requested).toContain(`${LYING_HOST}/${hash}.png`);
    expect(requested).toContain(`${GOOD_HOST}/${hash}.png`);
    expect(requested.indexOf(`${LYING_HOST}/${hash}.png`)).toBeLessThan(
      requested.indexOf(`${GOOD_HOST}/${hash}.png`),
    );

    // Nothing on the author's servers has this file, so the dead link stays as it was.
    const missingMessage = threadMessage(bob.page, 'This one is gone for good');
    const loadMissingMedia = missingMessage.getByRole('button', {
      name: 'Load media',
      exact: true,
    });
    if (await loadMissingMedia.count()) await loadMissingMedia.click();
    await expect(missingMessage.locator('img')).toHaveAttribute('src', missingUrl);
    await expect
      .poll(() => requested.filter((url) => url.startsWith(`${GOOD_HOST}/`)).length, {
        timeout: 10_000,
      })
      .toBe(1);
  } finally {
    await disposeUsers(alice, bob);
  }
});
