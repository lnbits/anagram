import { test, expect } from '@playwright/test';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  verifyEvent,
  nip19,
  nip44,
  nip59,
  type Event,
  type Filter,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
import { MESSAGE_HYDRATION_VERSION } from '../src/lib/nostr/hydrationVersion';

test('restores incoming history using account inbox and encrypted private-storage relays, including AUTH, reconnect and history rechecks', async ({
  page,
}) => {
  // Configured relay has only our sent copy. Two others accept connections but
  // never answer DM queries. Our NIP-65 outbox advertises the actual DM inbox.
  const servers = Array.from(
    { length: 6 },
    () => new WebSocketServer({ host: '127.0.0.1', port: 0 }),
  );
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const urls = servers.map(
    (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
  const key = generateSecretKey(),
    peerKey = generateSecretKey();
  const own = getPublicKey(key),
    peer = getPublicKey(peerKey),
    now = Math.floor(Date.now() / 1000);
  const events: Event[][] = servers.map(() => []);
  const live = new Map<WebSocket, Map<string, Filter[]>>();
  const authRetries: string[] = [];
  let authSuccesses = 0;
  function wrap(sender: Uint8Array, text: string, days: number) {
    const rumor = nip59.createRumor(
      {
        kind: 14,
        content: text,
        created_at: now - days * 86400,
        tags: [['p', getPublicKey(sender) === own ? peer : own]],
      },
      sender,
    );
    const seal = nip59.createSeal(rumor, sender, own),
      ephemeral = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        created_at: rumor.created_at - 3600,
        tags: [['p', own]],
        content: nip44.v2.encrypt(
          JSON.stringify(seal),
          nip44.v2.utils.getConversationKey(ephemeral, own),
        ),
      },
      ephemeral,
    );
  }
  events[0].push(wrap(key, 'My sent copy', 40));
  for (const [signer, name] of [
    [key, 'Account'],
    [peerKey, 'Incoming peer'],
  ] as const)
    events[0].push(
      finalizeEvent(
        { kind: 0, created_at: now, content: JSON.stringify({ name }), tags: [] },
        signer,
      ),
    );
  events[0].push(
    finalizeEvent(
      { kind: 10002, created_at: now, content: '', tags: [['r', urls[3], 'write']] },
      key,
    ),
  );
  events[3].push(
    finalizeEvent({ kind: 10050, created_at: now, content: '', tags: [['relay', urls[4]]] }, key),
  );
  events[3].push(
    finalizeEvent(
      {
        kind: 10013,
        created_at: now,
        tags: [],
        content: nip44.v2.encrypt(
          JSON.stringify([['relay', urls[5]]]),
          nip44.v2.utils.getConversationKey(key, own),
        ),
      },
      key,
    ),
  );
  for (let index = 0; index < 12; index++)
    events[index % 2 ? 5 : 4].push(wrap(peerKey, `Restored incoming ${index}`, 40 + index * 8));
  servers.forEach((server, relay) =>
    server.on('connection', (socket) => {
      const subscriptions = new Map<string, Filter[]>(),
        rejected = new Set<string>();
      let authenticated = false,
        challenged = false;
      live.set(socket, subscriptions);
      socket.on('close', () => live.delete(socket));
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'AUTH') {
          const valid =
            verifyEvent(id) &&
            id.kind === 22242 &&
            id.pubkey === own &&
            id.tags.some((tag: string[]) => tag[0] === 'challenge' && tag[1] === 'inbox-challenge');
          setTimeout(() => {
            if (socket.readyState !== 1) return;
            authenticated = valid;
            if (valid) authSuccesses++;
            socket.send(JSON.stringify(['OK', id.id, valid, '']));
          }, 100);
          return;
        }
        if (verb === 'CLOSE') {
          subscriptions.delete(id);
          return;
        }
        if (verb === 'EVENT') {
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ') return;
        const dm = filters.some((filter: Filter) => filter.kinds?.includes(1059));
        if (dm && (relay === 1 || relay === 2)) return;
        if (dm && relay === 4 && !authenticated) {
          rejected.add(id);
          socket.send(JSON.stringify(['CLOSED', id, 'auth-required: authenticate first']));
          if (!challenged) {
            challenged = true;
            socket.send(JSON.stringify(['AUTH', 'inbox-challenge']));
          }
          return;
        }
        if (rejected.has(id)) authRetries.push(id);
        subscriptions.set(id, filters);
        for (const filter of filters)
          for (const event of events[relay]
            .filter((event) => matchFilters([filter], event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, Math.min(filter.limit ?? Infinity, 2)))
            socket.send(JSON.stringify(['EVENT', id, event]));
        socket.send(JSON.stringify(['EOSE', id]));
      });
    }),
  );
  const consoleOutput: string[] = [],
    wire: string[] = [];
  page.on('console', (message) => consoleOutput.push(message.text()));
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => wire.push(String(payload))),
  );
  try {
    await page.addInitScript(
      ({ urls, own, now, version }) => {
        const entries = JSON.stringify(
          urls.slice(0, 3).map((url) => ({ url, read: true, write: true })),
        );
        localStorage.setItem('relays', entries);
        localStorage.setItem('nip65_relays', entries);
        // A previously empty/partial relay snapshot is not proof that historical
        // incoming events can never appear there later. Keep the current version.
        const coverageKey = `nostr-history-coverage:${own}`;
        if (!localStorage.getItem(coverageKey))
          localStorage.setItem(
            coverageKey,
            JSON.stringify(
              Object.fromEntries(
                urls.map((url) => [
                  `time-v${version}:${own}:${url}`,
                  [
                    {
                      since: new Date(0).toISOString(),
                      until: new Date((now - 3 * 86400) * 1000).toISOString(),
                    },
                  ],
                ]),
              ),
            ),
          );
      },
      { urls, own, now, version: MESSAGE_HYDRATION_VERSION },
    );
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    const countIncoming = () =>
      page.evaluate(
        async ({ peer }) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          return (await chatDataService.listLatestMessages(peer, 40)).rows.filter(
            (row) => row.author_public_key === peer,
          ).length;
        },
        { peer },
      );
    await expect.poll(countIncoming, { timeout: 45000 }).toBe(12);
    expect(authSuccesses).toBeGreaterThan(0);
    expect(authRetries.length).toBeGreaterThan(0);
    await page.goto(`/chats/${peer}`);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Restored incoming' }),
    ).toHaveCount(12);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'My sent copy' }),
    ).toBeVisible();
    // A reply arriving AFTER history has completed must use the repaired live subscription.
    const incoming = wrap(peerKey, 'Live reply after authentication', 0);
    events[4].push(incoming);
    for (const socket of servers[4].clients)
      for (const [id, filters] of live.get(socket) ?? [])
        if (matchFilters(filters, incoming)) socket.send(JSON.stringify(['EVENT', id, incoming]));
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Live reply after authentication' }),
    ).toBeVisible();
    // A later socket loss must recreate the live REQ on this relay even though
    // the other relay transports remain connected.
    for (const socket of servers[4].clients) socket.terminate();
    await expect
      .poll(
        () =>
          [...servers[4].clients].some((socket) =>
            [...(live.get(socket)?.values() ?? [])].some((filters) =>
              filters.some((filter) => filter.kinds?.includes(1059) && filter.until === undefined),
            ),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    const reconnectedReply = wrap(peerKey, 'Live reply after reconnect', 0);
    events[4].push(reconnectedReply);
    for (const socket of servers[4].clients)
      for (const [id, filters] of live.get(socket) ?? [])
        if (matchFilters(filters, reconnectedReply))
          socket.send(JSON.stringify(['EVENT', id, reconnectedReply]));
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Live reply after reconnect' }),
    ).toBeVisible();
    // Simulate old history restored to a relay after its prior EOSE, without live delivery.
    events[5].push(wrap(peerKey, 'Historical reply replicated later', 180));
    events[3] = events[3].filter((event) => event.kind !== 10013); // Reload must also use the encrypted IndexedDB relay cache.
    await page.reload();
    await expect.poll(countIncoming, { timeout: 45000 }).toBe(15);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Historical reply replicated later' }),
    ).toBeVisible();
    for (const secret of [nip19.nsecEncode(key), Buffer.from(key).toString('hex')]) {
      expect(consoleOutput.some((entry) => entry.includes(secret))).toBe(false);
      expect(wire.some((entry) => entry.includes(secret))).toBe(false);
    }
  } finally {
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
