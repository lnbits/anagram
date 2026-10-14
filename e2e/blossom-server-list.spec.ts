import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools';
import { WebSocket } from 'ws';
import { bootstrapUser, disposeUsers, E2E_RELAY_URL, TEST_ACCOUNTS } from './parity/helpers';

const DEFAULT_SERVER = 'https://blossom.nostr.build';
const PUBLISHED_SERVER = 'https://published.example.org';
const SECOND_PUBLISHED_SERVER = 'https://second.example.org';
const UPDATED_SERVER = 'https://updated.example.org';

// The app never publishes a server list itself, so the test publishes one the way another
// client would: a signed kind 10063 event with one "server" tag per Blossom server.
async function publishServerList(
  privateKey: string,
  servers: string[],
  createdAt: number,
): Promise<void> {
  const socket = new WebSocket(E2E_RELAY_URL);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const event = finalizeEvent(
    {
      kind: 10063,
      created_at: createdAt,
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

function uploadServer(page: Page) {
  return page.evaluate(async () => {
    const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
    return useNostrStore().getBlossomServerUrl();
  });
}

test('uses the Blossom server list published to relays, with the saved setting and default as fallbacks', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.blossomServerList);
  try {
    const { page } = user;
    await page.getByRole('button', { name: 'settings', exact: true }).click();
    await page.getByTestId('settings-media-data-storage-item').click();
    const serverInput = page.getByTestId('settings-blossom-server-input');
    const sourceNote = page.getByTestId('settings-blossom-server-source');

    // No list published: the built-in default, and no claim about a published list.
    await expect(serverInput).toHaveValue(DEFAULT_SERVER);
    await expect(sourceNote).toHaveCount(0);

    // A list published while the app is running is picked up without a reload. Relays keep
    // only the newest replaceable event, so each list in this test is dated later than the one
    // before it, the way a second client publishing a replacement would date it.
    const publishedAt = Math.floor(Date.now() / 1000);
    await publishServerList(
      user.account.privateKey,
      [PUBLISHED_SERVER, SECOND_PUBLISHED_SERVER],
      publishedAt,
    );
    await expect.poll(() => uploadServer(page), { timeout: 15_000 }).toBe(PUBLISHED_SERVER);

    await publishServerList(user.account.privateKey, [UPDATED_SERVER], publishedAt + 60);
    await expect.poll(() => uploadServer(page), { timeout: 15_000 }).toBe(UPDATED_SERVER);
    await page.reload();
    await expect(serverInput).toBeEnabled();
    await expect(serverInput).toHaveValue(UPDATED_SERVER);
    await expect(sourceNote).toBeVisible();

    // A saved choice still wins over the published list, and restoring the default
    // hands the decision back to the list.
    await serverInput.fill('https://saved.example.com');
    await page.getByTestId('settings-blossom-save').click();
    await expect
      .poll(() => uploadServer(page), { timeout: 15_000 })
      .toBe('https://saved.example.com');
    await expect(sourceNote).toHaveCount(0);

    await page.getByTestId('settings-blossom-restore-default').click();
    await expect.poll(() => uploadServer(page), { timeout: 15_000 }).toBe(UPDATED_SERVER);
    await expect(serverInput).toHaveValue(UPDATED_SERVER);
    await expect(sourceNote).toBeVisible();
  } finally {
    await disposeUsers(user);
  }
});
