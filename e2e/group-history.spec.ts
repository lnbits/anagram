import { test, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  nip44,
  nip59,
  type Event,
  type Filter,
  type UnsignedEvent,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

// Match original Anagram: signed 1014 rumor signature in the seal's
// invitation_proof tag; group messages are addressed to the epoch, not identity.
function wrap(rumor: UnsignedEvent, sender: Uint8Array, recipient: string, proof?: string): Event {
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: rumor.created_at - 600,
      tags: proof ? [['invitation_proof', proof]] : [],
      content: nip44.v2.encrypt(
        JSON.stringify(rumor),
        nip44.v2.utils.getConversationKey(sender, recipient),
      ),
    },
    sender,
  );
  const ephemeral = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: rumor.created_at - 3600,
      tags: [['p', recipient]],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(ephemeral, recipient),
      ),
    },
    ephemeral,
  );
}

test('original-format groups recover all epochs and both authors across discovered and fallback relays', async ({
  page,
}) => {
  const servers = Array.from(
    { length: 4 },
    () => new WebSocketServer({ host: '127.0.0.1', port: 0 }),
  );
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const urls = servers.map(
    (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
  const events: Event[][] = servers.map(() => []);
  const key = generateSecretKey(),
    own = getPublicKey(key);
  const peer = generateSecretKey();
  const now = Math.floor(Date.now() / 1000);
  const currentKeys = new Map<string, Uint8Array>();
  const groups: Array<{
    publicKey: string;
    name: string;
    messages: Array<{ text: string; author: string }>;
  }> = [];
  for (let groupIndex = 0; groupIndex < 2; groupIndex++) {
    const identity = generateSecretKey(),
      publicKey = getPublicKey(identity);
    const name = `Original restored group ${groupIndex}`;
    const messages: Array<{ text: string; author: string }> = [];
    groups.push({ publicKey, name, messages });
    // Only the third configured relay knows the group's identity and custom inbox.
    events[2].push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name,
            group: true,
            about: 'Original group metadata',
            picture: 'https://profiles.test/group.png',
          }),
        },
        identity,
      ),
    );
    events[2].push(
      finalizeEvent(
        { kind: 10050, created_at: now, tags: [['relay', urls[3]]], content: '' },
        identity,
      ),
    );
    for (const [epoch, days] of [
      [21, 40],
      [20, 400],
    ] as const) {
      const epochKey = generateSecretKey(),
        epochPubkey = getPublicKey(epochKey);
      const at = now - days * 86400;
      if (epoch === 21) {
        currentKeys.set(publicKey, epochKey);
        events[3].push(
          finalizeEvent(
            {
              kind: 30000,
              created_at: at,
              tags: [['d', 'roster']],
              content: nip44.v2.encrypt(
                JSON.stringify([
                  ['p', own],
                  ['p', getPublicKey(peer)],
                ]),
                nip44.v2.utils.getConversationKey(identity, epochPubkey),
              ),
            },
            identity,
          ),
        );
      }
      const ticket = finalizeEvent(
        {
          kind: 1014,
          created_at: at - 86400,
          tags: [
            ['p', own],
            ['epoch', String(epoch)],
          ],
          content: Buffer.from(epochKey).toString('hex'),
        },
        identity,
      );
      const { sig, ...rumor } = ticket;
      events[0].push(wrap(rumor, identity, own, sig));
      for (let index = 0; index < 8; index++) {
        const sender = index % 2 ? peer : key;
        const text = `${name} epoch ${epoch} message ${index}`;
        messages.push({ text, author: getPublicKey(sender) });
        const message = nip59.createRumor(
          { kind: 14, created_at: at + index * 60, tags: [['p', epochPubkey]], content: text },
          sender,
        );
        // Latest routing must not exclude archives on a configured fallback relay.
        events[index < 4 ? 2 : 3].push(wrap(message, sender, epochPubkey));
      }
    }
  }
  for (const [sender, name] of [
    [key, 'Owner'],
    [peer, 'Other member'],
  ] as const)
    events[2].push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name,
            picture: `https://profiles.test/${getPublicKey(sender)}.png`,
          }),
        },
        sender,
      ),
    );
  let holdHistory = true;
  const heldHistory: Array<() => void> = [];
  const published: Array<{ relay: number; event: Event }> = [];
  const queries: Array<{ relay: number; filters: Filter[] }> = [];
  servers.forEach((server, relay) =>
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') {
          published.push({ relay, event: id });
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ') return;
        queries.push({ relay, filters });
        const respond = () => {
          if (socket.readyState !== 1) return;
          for (const filter of filters)
            for (const event of events[relay]
              .filter((event) => matchFilters([filter], event))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(
                0,
                Math.min(filter.limit ?? Infinity, filter.kinds?.includes(1059) ? 2 : Infinity),
              ))
              socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        };
        if (
          holdHistory &&
          relay === 3 &&
          filters.some((filter: Filter) => filter.kinds?.includes(1059))
        )
          heldHistory.push(respond);
        else respond();
      }),
    ),
  );
  try {
    await page.route('https://profiles.test/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
      }),
    );
    await page.addInitScript(
      (urls) => {
        const entries = JSON.stringify(urls.map((url) => ({ url, read: true, write: true })));
        localStorage.setItem('relays', entries);
        localStorage.setItem('nip65_relays', entries);
      },
      urls.slice(0, 3),
    );
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: /Message requests/ }).click();
    for (const group of groups) {
      const item = page.getByTestId('chat-item').filter({ hasText: group.name });
      await expect(item).toBeVisible({ timeout: 30000 });
      await expect(item.locator('img')).toHaveAttribute('src', 'https://profiles.test/group.png');
      await item.click();
      if (holdHistory) {
        // Keep the same frontend open as the delayed relay starts delivering history.
        // No route reload or manual refresh may be needed to render these arrivals.
        await expect.poll(() => heldHistory.length).toBeGreaterThan(0);
        const delayedText = group.messages[4].text;
        await page.evaluate(async (text) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const original = chatDataService.createMessage;
          let release!: () => void;
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          (window as unknown as { releaseHistoryWrite: () => void }).releaseHistoryWrite = () => {
            chatDataService.createMessage = original;
            release();
          };
          chatDataService.createMessage = async function (input) {
            if (input.message === text) await barrier;
            return original.call(this, input);
          };
        }, delayedText);
        holdHistory = false;
        heldHistory.splice(0).forEach((respond) => respond());
        // Verified content must render even while its durable write is held open.
        await expect(
          page.getByTestId('message-bubble').filter({ hasText: delayedText }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            async ({ publicKey, text }) => {
              const { chatDataService } = await import('/src/services/chatDataService.ts');
              return (await chatDataService.listLatestMessages(publicKey, 50)).rows.some(
                (row) => row.message === text,
              );
            },
            { publicKey: group.publicKey, text: delayedText },
          ),
        ).toBe(false);
        await page.evaluate(() => {
          const fixture = window as unknown as { releaseHistoryWrite?: () => void };
          fixture.releaseHistoryWrite!();
          delete fixture.releaseHistoryWrite;
        });
      }
      await expect(page.locator('.thread-header .avatar img')).toHaveAttribute(
        'src',
        'https://profiles.test/group.png',
      );
      for (const message of group.messages) {
        const bubble = page
          .getByTestId('message-bubble')
          .filter({ has: page.getByText(message.text, { exact: true }) });
        await expect(bubble).toBeVisible({ timeout: 30000 });
        await expect(bubble).toHaveAttribute('data-chat-public-key', group.publicKey);
        await expect(bubble).toHaveAttribute('data-author-public-key', message.author);
        await expect(bubble.locator('.message-author img')).toHaveAttribute(
          'src',
          `https://profiles.test/${message.author}.png`,
        );
      }
      await expect(
        page
          .getByTestId('message-bubble')
          .filter({ hasText: groups.find((other) => other !== group)!.name }),
      ).toHaveCount(0);
    }
    expect(
      queries.some(
        (query) =>
          query.relay === 3 && query.filters.some((filter) => filter.kinds?.includes(1059)),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Contact profile', exact: true }).click();
    await page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(page.getByTestId('group-details')).toContainText('Other member');
    await page.getByRole('tab', { name: 'Epochs', exact: true }).click();
    await expect(page.getByTestId('group-details').locator('.epoch')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const accept = page.getByRole('button', { name: 'Accept', exact: true });
    if (await accept.isVisible()) await accept.click();
    await page.getByTestId('message-composer-input').fill('Reply to restored original group');
    await page.getByTestId('message-send-button').click();
    const epochKey = currentKeys.get(groups[1].publicKey)!;
    await expect
      .poll(() =>
        published.some(
          ({ relay, event }) =>
            relay === 3 &&
            event.kind === 1059 &&
            event.tags.some((tag) => tag[0] === 'p' && tag[1] === getPublicKey(epochKey)),
        ),
      )
      .toBe(true);
    const outgoing = published.find(
      ({ relay, event }) =>
        relay === 3 &&
        event.kind === 1059 &&
        event.tags.some((tag) => tag[0] === 'p' && tag[1] === getPublicKey(epochKey)),
    )!;
    expect(nip59.unwrapEvent(outgoing.event, epochKey)).toMatchObject({
      pubkey: own,
      content: 'Reply to restored original group',
    });
    await page.reload();
    for (const message of groups[1].messages)
      await expect(
        page.getByTestId('chat-thread').getByText(message.text, { exact: true }),
      ).toBeVisible();
    await expect(page.getByTestId('history-sync-status')).toBeHidden({ timeout: 30000 });
    // Emulate the previous release's damaged cache without wiping messages or
    // contacts: old completion receipts, covered history, and a lost epoch key.
    await page.route('**/cache-repair-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Cache fixture</title>',
      }),
    );
    await page.goto('/cache-repair-fixture');
    await page.evaluate(
      async ({ account, groupKeys }) => {
        const open = (name: string) =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const db = await open('chat-data-indexeddb-v2');
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['chats', 'messages'], 'readwrite');
          for (const key of groupKeys) {
            const get = tx.objectStore('chats').get(key);
            get.onsuccess = () => {
              const chat = get.result;
              chat.meta.group_epoch_keys = chat.meta.group_epoch_keys.filter(
                (entry: { epoch_number: number }) => entry.epoch_number === 21,
              );
              tx.objectStore('chats').put(chat);
            };
          }
          const cursor = tx.objectStore('messages').openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (item.value.message.includes('epoch 20 message')) item.delete();
            item.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        const journal = await open('anagram-hydration-inbox');
        await new Promise<void>((resolve, reject) => {
          const tx = journal.transaction('processed', 'readwrite');
          const cursor = tx.objectStore('processed').openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            item.update({ account: item.value.account, id: item.value.id });
            item.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        journal.close();
        const coverageKey = `nostr-history-coverage:${account}`;
        const coverage = JSON.parse(localStorage.getItem(coverageKey) ?? '{}');
        localStorage.setItem(
          coverageKey,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(coverage).map(([key, value]) => [
                key.replace(/^time-v[0-9]+:/, 'time-v2:'),
                value,
              ]),
            ),
          ),
        );
      },
      { account: own, groupKeys: groups.map((group) => group.publicKey) },
    );
    for (const group of groups) {
      await page.goto(`/chats/${group.publicKey}`);
      for (const message of group.messages)
        await expect(
          page.getByTestId('chat-thread').getByText(message.text, { exact: true }),
        ).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('message-bubble')).toHaveCount(
        group.messages.length + 2 + (group === groups[1] ? 1 : 0),
      );
    }
  } catch (error) {
    await test.info().attach('group-recovery-diagnostics', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          rosterQueries: queries.filter((query) =>
            query.filters.some((filter) => filter.kinds?.includes(30000)),
          ),
          summaries: await page
            .evaluate(async () => {
              const { contactsService } = await import('/src/services/contactsService.ts');
              const { chatDataService } = await import('/src/services/chatDataService.ts');
              return {
                contacts: (await contactsService.listContacts())
                  .filter((contact) => contact.type === 'group')
                  .map((contact) => ({
                    publicKey: contact.public_key,
                    type: contact.type,
                    relays: contact.relays,
                    members: contact.meta.group_members?.length,
                  })),
                chats: (await chatDataService.listChats())
                  .filter((chat) => chat.type === 'group')
                  .map((chat) => ({
                    publicKey: chat.public_key,
                    epochs: (chat.meta.group_epoch_keys as Array<{ epoch_number: number }>).map(
                      (epoch) => epoch.epoch_number,
                    ),
                  })),
              };
            })
            .catch(() => null),
        },
        null,
        2,
      ),
    });
    throw error;
  } finally {
    for (const server of servers) for (const socket of server.clients) socket.terminate();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
});
