import { test, expect } from '@playwright/test';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  nip59,
  type Event,
  type Filter,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

test('late kind-0 names and pictures render before persistence and survive a cached reload', async ({
  page,
}) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const relay = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const ownKey = generateSecretKey(),
    peerKey = generateSecretKey();
  const own = getPublicKey(ownKey),
    peer = getPublicKey(peerKey);
  const now = Math.floor(Date.now() / 1000);
  const ownPicture = 'https://profiles.test/own.png',
    peerPicture = 'https://profiles.test/peer.png';
  const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
  const events: Event[] = [
    nip59.wrapEvent(
      nip59.createRumor(
        { kind: 14, content: 'My outgoing history', tags: [['p', peer]], created_at: now - 100 },
        ownKey,
      ),
      ownKey,
      own,
    ),
    nip59.wrapEvent(
      nip59.createRumor(
        { kind: 14, content: 'Their incoming history', tags: [['p', own]], created_at: now - 90 },
        peerKey,
      ),
      peerKey,
      own,
    ),
  ];
  let offline = false;
  const publish = (event: Event) => {
    events.push(event);
    for (const [socket, requests] of subscriptions)
      for (const [id, filters] of requests)
        if (socket.readyState === 1 && matchFilters(filters, event))
          socket.send(JSON.stringify(['EVENT', id, event]));
  };
  server.on('connection', (socket) => {
    const requests = new Map<string, Filter[]>();
    subscriptions.set(socket, requests);
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (data) => {
      const [verb, id, ...filters] = JSON.parse(String(data));
      if (verb === 'CLOSE') {
        requests.delete(id);
        return;
      }
      if (verb === 'EVENT') {
        socket.send(JSON.stringify(['OK', id.id, true, '']));
        return;
      }
      if (verb !== 'REQ') return;
      requests.set(id, filters);
      if (offline) return;
      for (const event of events.filter((event) => matchFilters(filters, event)))
        socket.send(JSON.stringify(['EVENT', id, event]));
      socket.send(JSON.stringify(['EOSE', id]));
    });
  });
  try {
    await page.route('https://profiles.test/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
      }),
    );
    await page.addInitScript((relay) => {
      const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }, relay);
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    const row = page.getByTestId('chat-item').filter({ hasText: peer.slice(0, 16) });
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click();
    const mine = page.getByTestId('message-bubble').filter({ hasText: 'My outgoing history' });
    const theirs = page.getByTestId('message-bubble').filter({ hasText: 'Their incoming history' });
    await expect(mine).toBeVisible();
    await expect(theirs).toBeVisible();
    await expect
      .poll(() =>
        [...subscriptions.values()].some((requests) =>
          [...requests.values()].some((filters) =>
            filters.some((filter) => filter.kinds?.includes(0) && filter.authors?.includes(peer)),
          ),
        ),
      )
      .toBe(true);
    // Block profile writes, not reads or relay event delivery. A UI tied to the
    // contact persistence queue cannot pass the assertions below.
    await page.evaluate(async () => {
      const path = '/src/services/contactsService.ts';
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => new URL(url).pathname === path);
      const { contactsService } = await import(url ?? path);
      const original = contactsService.updateContact.bind(contactsService);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      contactsService.updateContact = async (...args: unknown[]) => {
        await held;
        return original(...args);
      };
      (window as any).releaseProfileWrites = () => {
        contactsService.updateContact = original;
        release();
      };
    });
    for (const [key, name, picture] of [
      [ownKey, 'My profile', ownPicture],
      [peerKey, 'Peer profile', peerPicture],
    ] as const)
      publish(
        finalizeEvent(
          {
            kind: 0,
            created_at: now,
            tags: [],
            content: JSON.stringify({ name: 'handle', display_name: name, picture }),
          },
          key,
        ),
      );
    await expect(mine.locator('.message-author img')).toHaveAttribute('src', ownPicture);
    await expect(theirs.locator('.message-author img')).toHaveAttribute('src', peerPicture);
    await expect(theirs.locator('.message-author strong')).toHaveText('Peer profile');
    await expect(page.locator('.thread-identity strong')).toHaveText('Peer profile');
    await expect(page.getByTestId('chat-item').filter({ hasText: 'Peer profile' })).toBeVisible();
    await expect
      .poll(() => mine.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await page.evaluate(() => (window as any).releaseProfileWrites());
    await expect
      .poll(() =>
        page.evaluate(async (peer) => {
          const path = '/src/services/contactsService.ts';
          const { contactsService } = await import(path);
          return (await contactsService.getContactByPublicKey(peer))?.meta.picture;
        }, peer),
      )
      .toBe(peerPicture);
    offline = true;
    await page.reload();
    await expect(mine.locator('.message-author img')).toHaveAttribute('src', ownPicture);
    await expect(theirs.locator('.message-author img')).toHaveAttribute('src', peerPicture);
    await expect(theirs.locator('.message-author strong')).toHaveText('Peer profile');
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('refresh recovers missing group and historical-author profiles from capped snapshots and discovered outboxes', async ({
  page,
}) => {
  const servers = [0, 1].map(() => new WebSocketServer({ host: '127.0.0.1', port: 0 }));
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const urls = servers.map(
    (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
  const ownKey = generateSecretKey(),
    groupKey = generateSecretKey(),
    memberKey = generateSecretKey();
  const group = getPublicKey(groupKey),
    member = getPublicKey(memberKey);
  const now = Math.floor(Date.now() / 1000);
  const events: Event[][] = [[], []];
  for (const [key, name] of [
    [groupKey, 'Recovered group'],
    [memberKey, 'Historical author'],
  ] as const) {
    // The configured relay has only routing. Public metadata lives on an outbox
    // which this browser has never connected to. The author is NOT in a roster.
    events[0].push(
      finalizeEvent(
        { kind: 10002, created_at: now, tags: [['r', urls[1], 'write']], content: '' },
        key,
      ),
    );
    events[1].push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({
            name,
            ...(key === groupKey ? { group: true } : {}),
            picture: `https://profiles.test/${getPublicKey(key)}.png`,
          }),
        },
        key,
      ),
    );
  }
  let offline = false;
  const queries: Filter[][] = [];
  servers.forEach((server, index) =>
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') {
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ' || offline) return;
        queries.push(filters);
        // Mimic a relay's small default snapshot cap. Each filter receives its own
        // newest result, so a broad authors/kinds request does not return everyone.
        for (const filter of filters)
          for (const event of events[index]
            .filter((event) => matchFilters([filter], event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 1))
            socket.send(JSON.stringify(['EVENT', id, event]));
        socket.send(JSON.stringify(['EOSE', id]));
      }),
    ),
  );
  try {
    await page.route('https://profiles.test/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
      }),
    );
    await page.addInitScript((url) => {
      const entries = JSON.stringify([{ url, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }, urls[0]);
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await page.evaluate(
      async ({ group, member }) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        await chatDataService.createChat({
          public_key: group,
          type: 'group',
          name: group.slice(0, 16),
          meta: { inbox_state: 'accepted' },
          last_message: 'Historical group message',
          last_message_at: new Date().toISOString(),
        });
        await chatDataService.createMessage({
          chat_public_key: group,
          author_public_key: member,
          message: 'Historical group message',
          created_at: new Date().toISOString(),
          meta: {},
        });
      },
      { group, member },
    );
    await page.goto(`/chats/${group}`);
    const bubble = page
      .getByTestId('message-bubble')
      .filter({ hasText: 'Historical group message' });
    await expect(bubble).toBeVisible();
    await expect(bubble.locator('.message-author strong')).toHaveText('Historical author', {
      timeout: 20000,
    });
    await expect(bubble.locator('.message-author img')).toHaveAttribute(
      'src',
      `https://profiles.test/${member}.png`,
    );
    await expect(page.locator('.thread-identity strong')).toHaveText('Recovered group');
    await expect(page.locator('.thread-header .avatar img')).toHaveAttribute(
      'src',
      `https://profiles.test/${group}.png`,
    );
    expect(
      queries.some((filters) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(10002) &&
            filter.authors?.length === 1 &&
            filter.authors[0] === member,
        ),
      ),
    ).toBe(true);
    // No contact acceptance or roster fabrication is needed to cache this author.
    await expect
      .poll(() =>
        page.evaluate(async (member) => {
          const { contactsService } = await import('/src/services/contactsService.ts');
          return (await contactsService.getContactByPublicKey(member)) === null;
        }, member),
      )
      .toBe(true);
    offline = true;
    await page.reload();
    await expect(bubble.locator('.message-author strong')).toHaveText('Historical author');
    await expect(bubble.locator('.message-author img')).toHaveAttribute(
      'src',
      `https://profiles.test/${member}.png`,
    );
    await expect(page.locator('.thread-identity strong')).toHaveText('Recovered group');
  } finally {
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
