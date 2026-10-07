import { finishOnboarding } from './auth-helpers';
import { test, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
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

test('sidebar fills before history finishes and reload resumes past undecryptable envelopes without a duration setting', async ({
  page,
}) => {
  const key = generateSecretKey(),
    own = getPublicKey(key);
  const now = Math.floor(Date.now() / 1000);
  const events: Event[] = [
    finalizeEvent(
      { kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'History account' }) },
      key,
    ),
  ];
  const incomingEvents: Event[] = [];
  const peers = new Map<number, string>();
  const peerKeys = new Map<number, Uint8Array>();
  for (const days of [3, 80, 1100]) {
    const peerKey = generateSecretKey();
    const peer = getPublicKey(peerKey);
    events.push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: `Hydrated peer ${days}`,
            picture: `http://127.0.0.1:5173/test-avatar-${days}.svg`,
          }),
        },
        peerKey,
      ),
    );
    peers.set(days, peer);
    peerKeys.set(days, peerKey);
    const rumor = nip59.createRumor(
      {
        kind: 14,
        created_at: now - days * 86400,
        tags: [['p', peer]],
        content: `Sidebar history ${days} days`,
      },
      key,
    );
    const seal = nip59.createSeal(rumor, key, own);
    const ephemeral = generateSecretKey();
    events.push(
      finalizeEvent(
        {
          kind: 1059,
          created_at: rumor.created_at,
          tags: [['p', own]],
          content: nip44.v2.encrypt(
            JSON.stringify(seal),
            nip44.v2.utils.getConversationKey(ephemeral, own),
          ),
        },
        ephemeral,
      ),
    );
  }
  // Restore both sides of each conversation, including older replies that arrive
  // after a newer self-copy has already created and accepted the thread.
  for (const [days, peer] of peers) {
    const peerKey = peerKeys.get(days)!;
    const rumor = nip59.createRumor(
      {
        kind: 14,
        created_at: now - days * 86400 - 30,
        tags: [['p', own]],
        content: `Incoming reply ${days} days`,
      },
      peerKey,
    );
    // Original clients accept authenticated rumors with absent or stale derived IDs.
    if (days === 80) delete (rumor as Partial<typeof rumor>).id;
    if (days === 1100) rumor.id = 'f'.repeat(64);
    const seal = nip59.createSeal(rumor, peerKey, own);
    const ephemeral = generateSecretKey();
    incomingEvents.push(
      finalizeEvent(
        {
          kind: 1059,
          created_at: rumor.created_at,
          tags: [['p', own]],
          content: nip44.v2.encrypt(
            JSON.stringify(seal),
            nip44.v2.utils.getConversationKey(ephemeral, own),
          ),
        },
        ephemeral,
      ),
    );
  }
  // Real relays can return fewer envelopes than the requested page size. Every
  // reply must be fetched, including ones older than the already displayed self-copy.
  for (const [days] of peers) {
    const peerKey = peerKeys.get(days)!;
    for (let index = 0; index < 12; index++) {
      const at = now - days * 86400 - 60 - index * 60;
      const rumor = nip59.createRumor(
        {
          kind: 14,
          created_at: at,
          tags: [['p', own]],
          content: `Historical reply ${days}/${index}`,
        },
        peerKey,
      );
      const seal = nip59.createSeal(rumor, peerKey, own);
      const ephemeral = generateSecretKey();
      incomingEvents.push(
        finalizeEvent(
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
        ),
      );
    }
  }
  // A valid outer signature with unusable ciphertext must not block the older DMs.
  events.push(
    finalizeEvent(
      {
        kind: 1059,
        created_at: now - 3 * 86400 + 1,
        tags: [['p', own]],
        content: 'undecryptable ciphertext',
      },
      generateSecretKey(),
    ),
  );
  const peerServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => peerServer.once('listening', resolve));
  const peerRelay = `ws://127.0.0.1:${(peerServer.address() as { port: number }).port}/`;
  // Incoming envelopes are delivered to the account's advertised DM inbox.
  events.push(
    finalizeEvent({ kind: 10050, created_at: now, tags: [['relay', peerRelay]], content: '' }, key),
  );
  for (const key of peerKeys.values())
    events.push(
      finalizeEvent({ kind: 10002, created_at: now, tags: [['r', peerRelay]], content: '' }, key),
    );
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing relay address');
  const relay = `ws://127.0.0.1:${address.port}/`;
  let holdOlderHistory = true;
  const olderQueries: Filter[] = [];
  const peerQueries: Array<{ filters: Filter[]; matches: number }> = [];
  for (const [host, relayEvents] of [
    [server, events],
    [peerServer, incomingEvents],
  ] as const)
    host.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') {
          relayEvents.push(id);
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ') return;
        if (host === peerServer)
          peerQueries.push({
            filters,
            matches: relayEvents.filter((e) => matchFilters(filters, e)).length,
          });
        const older = filters.some(
          (filter: Filter) =>
            filter.kinds?.includes(1059) &&
            filter.until !== undefined &&
            filter.until < now - 7 * 86400,
        );
        if (older) {
          olderQueries.push(...filters);
          if (holdOlderHistory) return;
        }
        const seen = new Set<string>();
        for (const filter of filters)
          for (const event of relayEvents
            .filter((event) => matchFilters([filter], event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(
              0,
              Math.min(filter.limit ?? relayEvents.length, host === peerServer ? 4 : Infinity),
            )) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            socket.send(JSON.stringify(['EVENT', id, event]));
          }
        socket.send(JSON.stringify(['EOSE', id]));
      }),
    );
  try {
    await page.addInitScript((url) => {
      const entries = JSON.stringify([{ url, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }, relay);
    await page.route('**/test-avatar-*.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
      }),
    );
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeEnabled();
    await page.getByTestId('auth-onboarding-relays-next-button').click();
    await expect(page.getByTestId('auth-onboarding-continue-button')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByText('Restore message history', { exact: true })).toHaveCount(0);
    await page.getByTestId('auth-onboarding-continue-button').click();
    const skip = page.getByTestId('auth-notifications-skip');
    await expect(skip.or(page.getByRole('navigation', { name: 'Main navigation' }))).toBeVisible();
    if (await skip.isVisible()) await skip.click();
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Sidebar history 3 days' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Sidebar history 3 days' }),
    ).toContainText('Hydrated peer 3');
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Sidebar history 3 days' }).locator('img'),
    ).toHaveAttribute('src', /test-avatar-3/);
    await expect.poll(() => olderQueries.length).toBeGreaterThan(0);
    await expect(page.getByTestId('history-sync-status')).toBeVisible();
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Sidebar history 1100 days' }),
    ).toHaveCount(0);
    // The regular startup checkpoint is already complete while history is ongoing.
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('nostr-startup-checkpoint') ?? '{}').status,
        ),
      )
      .toBe('complete');
    // Replay a previously rejected ciphertext from the durable inbox, even if
    // the relay no longer has that envelope. No cache deletion should be needed.
    const pending = incomingEvents.find((event) => event.created_at === now - 80 * 86400 - 30)!;
    incomingEvents.splice(incomingEvents.indexOf(pending), 1);
    await page.evaluate(
      async ({ account, event, relayUrl }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('anagram-hydration-inbox', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('inbox', 'readwrite');
          tx.objectStore('inbox').put({
            account,
            id: event.id,
            event,
            priority: 1,
            queuedAt: Date.now(),
            throttle: 0,
            relayUrls: [relayUrl],
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { account: own, event: pending, relayUrl: peerRelay },
    );
    await expect
      .poll(() =>
        peerQueries.some(({ filters }) => filters.some((filter) => filter.kinds?.includes(1059))),
      )
      .toBe(true);
    const beforeReload = olderQueries.length;
    holdOlderHistory = false;
    await page.reload();
    await expect.poll(() => olderQueries.length, { timeout: 30000 }).toBeGreaterThan(beforeReload);
    for (const days of [3, 80, 1100])
      await expect(
        page.getByTestId('chat-item').filter({ hasText: `Sidebar history ${days} days` }),
      ).toBeVisible();
    for (const [days, peer] of peers) {
      await page.goto(`/chats/${peer}`);
      for (let index = 0; index < 12; index++)
        await expect(
          page.getByText(`Historical reply ${days}/${index}`, { exact: true }),
        ).toBeVisible();

      await expect(
        page.getByTestId('message-bubble').filter({ hasText: `Sidebar history ${days} days` }),
      ).toBeVisible();
      await expect(
        page.getByTestId('message-bubble').filter({ hasText: `Incoming reply ${days} days` }),
      ).toBeVisible();
    }
  } finally {
    for (const host of [server, peerServer]) for (const socket of host.clients) socket.terminate();
    await Promise.all(
      [server, peerServer].map(
        (host) => new Promise<void>((resolve) => host.close(() => resolve())),
      ),
    );
  }
});

test('healthy history survives AUTH rejection and recovered history survives a dropped page', async ({
  page,
}) => {
  const key = generateSecretKey(),
    own = getPublicKey(key);
  const now = Math.floor(Date.now() / 1000);
  const makeMessage = (content: string, days = 40) => {
    const rumor = nip59.createRumor(
      {
        kind: 14,
        created_at: now - days * 86400,
        tags: [['p', getPublicKey(generateSecretKey())]],
        content,
      },
      key,
    );
    const seal = nip59.createSeal(rumor, key, own),
      ephemeral = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        created_at: rumor.created_at,
        tags: [['p', own]],
        content: nip44.v2.encrypt(
          JSON.stringify(seal),
          nip44.v2.utils.getConversationKey(ephemeral, own),
        ),
      },
      ephemeral,
    );
  };
  const good = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const bad = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await Promise.all(
    [good, bad].map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const url = (server: WebSocketServer) =>
    `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const goodUrl = url(good),
    badUrl = url(bad);
  const goodEvents = [
    makeMessage('Healthy relay history arrived'),
    finalizeEvent(
      {
        kind: 10050,
        created_at: now,
        content: '',
        tags: [
          ['relay', badUrl],
          ['relay', goodUrl],
        ],
      },
      key,
    ),
  ];
  const badEvents = [
    makeMessage('Recovered authenticated relay history arrived'),
    makeMessage('Older message after dropped page arrived', 41),
  ];
  let droppedPage = false;
  let allowAuth = false,
    denied = 0,
    accepted = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const server of [good, bad])
    server.on('connection', (socket) => {
      let authenticated = server === good;
      const challenge = crypto.randomUUID();
      if (server === bad) socket.send(JSON.stringify(['AUTH', challenge]));
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'AUTH') {
          authenticated =
            allowAuth &&
            verifyEvent(id) &&
            id.kind === 22242 &&
            id.pubkey === own &&
            id.tags.some((tag: string[]) => tag[0] === 'challenge' && tag[1] === challenge) &&
            id.tags.some((tag: string[]) => tag[0] === 'relay' && tag[1] === badUrl);
          if (authenticated) accepted++;
          else denied++;
          socket.send(
            JSON.stringify([
              'OK',
              id.id,
              authenticated,
              authenticated ? '' : 'restricted: try later',
            ]),
          );
        } else if (verb === 'EVENT') socket.send(JSON.stringify(['OK', id.id, true, '']));
        else if (verb === 'REQ') {
          if (!authenticated) {
            socket.send(JSON.stringify(['CLOSED', id, 'auth-required: authenticate first']));
            return;
          }
          const events = server === good ? goodEvents : badEvents;
          if (
            server === bad &&
            !droppedPage &&
            filters.some(
              (filter: Filter) => (filter.limit ?? 0) > 1 && matchFilters([filter], badEvents[0]),
            )
          ) {
            // Deliver one envelope, then lose the socket before EOSE. Recovery
            // must replay the unchanged window and still find the older envelope.
            droppedPage = true;
            socket.send(JSON.stringify(['EVENT', id, badEvents[0]]), () => socket.terminate());
            return;
          }

          for (const filter of filters)
            for (const event of events
              .filter((event) => matchFilters([filter], event))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, filter.limit ?? events.length))
              socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }
      });
    });
  try {
    await page.addInitScript((url) => {
      const entries = JSON.stringify([{ url, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }, goodUrl);
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Healthy relay history arrived' }),
    ).toBeVisible({ timeout: 30000 });
    await expect.poll(() => denied).toBeGreaterThan(0);
    expect(accepted).toBe(0);
    expect(pageErrors).toEqual([]);
    allowAuth = true;
    await expect(
      page
        .getByTestId('chat-item')
        .filter({ hasText: 'Recovered authenticated relay history arrived' }),
    ).toBeVisible({ timeout: 45000 });
    await expect(
      page.getByTestId('chat-item').filter({ hasText: 'Older message after dropped page arrived' }),
    ).toBeVisible({ timeout: 45000 });
    // Completed startup details intentionally remain available in the sidebar.
    // Check actual history completion rather than expecting that control to disappear.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useNostrStore } = await import('/src/stores/nostrStore.ts');
          return useNostrStore().startupSteps.find((step) => step.id === 'message-history-restore')
            ?.status;
        }),
      )
      .toBe('success');
    expect(droppedPage).toBe(true);
    expect(accepted).toBeGreaterThan(1);
    expect(pageErrors).toEqual([]);
  } finally {
    for (const server of [good, bad]) for (const socket of server.clients) socket.terminate();
    await Promise.all(
      [good, bad].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
});
