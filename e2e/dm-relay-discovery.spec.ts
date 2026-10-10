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
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

for (const cachedProfile of [false, true])
  test(`account inbox restores replies without searching contact relays (capped snapshot) (cached profile: ${cachedProfile})`, async ({
    page,
  }) => {
    const servers = [0, 1, 2].map(() => new WebSocketServer({ host: '127.0.0.1', port: 0 }));
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
    );
    const urls = servers.map(
      (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
    );
    const ownKey = generateSecretKey(),
      peerKey = generateSecretKey();
    const own = getPublicKey(ownKey),
      peer = getPublicKey(peerKey);
    const now = Math.floor(Date.now() / 1000);
    const events: Event[][] = [[], [], []];
    const queries: Array<{ relay: number; filters: Filter[] }> = [];
    function wrap(key: Uint8Array, content: string, at: number, tags: string[][]): Event {
      const rumor = nip59.createRumor({ kind: 14, content, created_at: at, tags }, key);
      const seal = nip59.createSeal(rumor, key, own);
      const ephemeral = generateSecretKey();
      return finalizeEvent(
        {
          kind: 1059,
          created_at: at - 3600,
          tags: [['p', own]],
          content: nip44.v2.encrypt(
            JSON.stringify(seal),
            nip44.v2.utils.getConversationKey(ephemeral, own),
          ),
        },
        ephemeral,
      );
    }
    const outgoing = nip59.createRumor(
      { kind: 14, content: 'My cached message', tags: [['p', peer]], created_at: now - 40 * 86400 },
      ownKey,
    );
    events[0].push(wrap(ownKey, outgoing.content, outgoing.created_at, outgoing.tags));
    events[0].push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: 'Reply sender',
            picture: 'https://profiles.test/peer.png',
          }),
        },
        peerKey,
      ),
    );
    events[0].push(
      finalizeEvent(
        { kind: 10002, created_at: now - 100, tags: [['r', urls[2], 'write']], content: '' },
        peerKey,
      ),
    );
    events[0].push(
      finalizeEvent(
        { kind: 10050, created_at: now - 200, tags: [['relay', urls[2]]], content: '' },
        peerKey,
      ),
    );
    events[0].push(
      finalizeEvent(
        { kind: 10050, created_at: now, tags: [['relay', urls[1]]], content: '' },
        ownKey,
      ),
    );
    for (let index = 0; index < 12; index++)
      events[1].push(
        wrap(peerKey, `Incoming reply ${index}`, now - (40 + index * 8) * 86400 + 60, [
          ['p', own],
          ['e', outgoing.id, '', 'reply'],
        ]),
      );
    servers.forEach((server, relay) =>
      server.on('connection', (socket) =>
        socket.on('message', (data) => {
          const [verb, id, ...filters] = JSON.parse(String(data));
          if (verb === 'EVENT') {
            socket.send(JSON.stringify(['OK', id.id, true, '']));
            return;
          }
          if (verb !== 'REQ') return;
          queries.push({ relay, filters });
          for (const filter of filters)
            for (const event of events[relay]
              .filter((event) => matchFilters([filter], event))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, Math.min(filter.limit ?? 1, 2)))
              socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }),
      ),
    );
    try {
      await page.route('https://profiles.test/**', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
        }),
      );
      await page.addInitScript((url) => {
        const entries = JSON.stringify([{ url, read: true, write: true }]);
        localStorage.setItem('relays', entries);
        localStorage.setItem('nip65_relays', entries);
      }, urls[0]);
      await page.goto('/');
      if (cachedProfile)
        await page.evaluate(
          async ({ peer, now }) => {
            const { contactsService } = await import('/src/services/contactsService.ts');
            await contactsService.createContact({
              public_key: peer,
              name: 'Reply sender',
              relays: [],
              meta: {
                name: 'Reply sender',
                picture: 'https://profiles.test/peer.png',
                profile_event_created_at: now,
              },
            });
          },
          { peer, now },
        );
      await page.getByTestId('auth-open-login-button').click();
      await page.getByTestId('auth-open-key-button').click();
      await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
      await page.getByTestId('auth-login-button').click();
      await finishOnboarding(page);
      // History discovery must also work for chats the user has not opened yet.
      await expect
        .poll(
          () =>
            page.evaluate(async (peer) => {
              const { chatDataService } = await import('/src/services/chatDataService.ts');
              return (await chatDataService.listLatestMessages(peer, 30)).rows.filter(
                (row) => row.author_public_key === peer,
              ).length;
            }, peer),
          { timeout: 30000 },
        )
        .toBe(12);
      // A relay gains a historical reply after the background scan passed this
      // period. Opening the thread must re-query it without a reload/cache reset.
      events[1].push(
        wrap(peerKey, 'Reply recovered by opening thread', outgoing.created_at + 120, [['p', own]]),
      );
      const beforeOpen = queries.length;
      await page.getByTestId('chat-item').filter({ hasText: 'Reply sender' }).click();
      await expect(
        page.getByTestId('message-bubble').filter({ hasText: 'Reply recovered by opening thread' }),
      ).toBeVisible({ timeout: 10000 });
      expect(
        queries
          .slice(beforeOpen)
          .some(
            ({ relay, filters }) =>
              relay === 1 &&
              filters.some(
                (filter) =>
                  filter.kinds?.includes(1059) &&
                  filter['#p']?.includes(own) &&
                  !filter.authors &&
                  filter.since !== undefined &&
                  filter.since <= outgoing.created_at - 3600 &&
                  filter.until !== undefined &&
                  filter.until >= outgoing.created_at,
              ),
          ),
      ).toBe(true);

      await expect(
        page
          .locator(`[data-testid="message-bubble"][data-author-public-key="${own}"]`)
          .filter({ hasText: 'My cached message' }),
      ).toBeVisible();
      await expect(
        page.getByTestId('message-bubble').filter({ hasText: 'Incoming reply' }),
      ).toHaveCount(12, { timeout: 30000 });
      for (let index = 0; index < 12; index++)
        await expect(
          page
            .getByTestId('message-bubble')
            .filter({ hasText: `Incoming reply ${index}` })
            .first(),
        ).toHaveAttribute('data-author-public-key', peer);
      expect(
        queries.some(
          ({ relay, filters }) =>
            relay === 1 &&
            filters.some(
              (filter) =>
                filter.kinds?.includes(1059) &&
                filter['#p']?.includes(own) &&
                filter.until !== undefined,
            ),
        ),
      ).toBe(true);
      expect(
        queries.some(
          ({ relay, filters }) =>
            relay === 2 && filters.some((filter) => filter.kinds?.includes(1059)),
        ),
      ).toBe(false);
      await page.reload();
      await expect(
        page.getByTestId('message-bubble').filter({ hasText: 'Incoming reply' }),
      ).toHaveCount(12);
    } catch (error) {
      await test
        .info()
        .attach('relay-queries', {
          body: JSON.stringify(queries),
          contentType: 'application/json',
        });
      throw error;
    } finally {
      for (const server of servers) {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
