import { test, expect } from '@playwright/test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  nip44,
  nip59,
  verifyEvent,
  type Event,
  type Filter,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
import { PUBLIC_DISCOVERY_INDEXERS } from '../src/stores/nostr/metadataIndexers';

test('anonymous indexers discover an unknown account inbox and stream all peer profiles despite a silent indexer', async ({
  page,
}) => {
  const seed = 'wss://seed.example.org/',
    outbox = 'wss://outbox.example.org/',
    inbox = 'wss://inbox.example.org/';
  const ownKey = generateSecretKey(),
    own = getPublicKey(ownKey);
  const peers = Array.from({ length: 12 }, () => generateSecretKey());
  const now = Math.floor(Date.now() / 1000);
  const records = new Map<string, Event[]>(
    [seed, outbox, inbox, ...PUBLIC_DISCOVERY_INDEXERS].map((url) => [url, []]),
  );
  const wire: Array<{ url: string; frame: any[] }> = [];
  function wrap(sender: Uint8Array, recipient: string, content: string, days: number) {
    const rumor = nip59.createRumor(
      { kind: 14, content, tags: [['p', recipient]], created_at: now - days * 86400 },
      sender,
    );
    const seal = nip59.createSeal(rumor, sender, own),
      ephemeral = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        tags: [['p', own]],
        created_at: rumor.created_at - 3600,
        content: nip44.v2.encrypt(
          JSON.stringify(seal),
          nip44.v2.utils.getConversationKey(ephemeral, own),
        ),
      },
      ephemeral,
    );
  }
  const indexer = PUBLIC_DISCOVERY_INDEXERS[1];
  records
    .get(indexer)!
    .push(
      finalizeEvent(
        { kind: 10002, created_at: now, content: '', tags: [['r', outbox, 'write']] },
        ownKey,
      ),
    );
  records
    .get(outbox)!
    .push(
      finalizeEvent(
        { kind: 10050, created_at: now, content: '', tags: [['relay', inbox]] },
        ownKey,
      ),
    );
  for (const [i, key] of [ownKey, ...peers].entries())
    records.get(indexer)!.push(
      finalizeEvent(
        {
          kind: 0,
          created_at: now,
          content: JSON.stringify({
            name: i === 0 ? 'Account' : `Peer ${i}`,
            picture: `https://profiles.test/${getPublicKey(key)}.png`,
          }),
          tags: [],
        },
        key,
      ),
    );
  for (const [i, key] of peers.entries()) {
    records.get(seed)!.push(wrap(ownKey, getPublicKey(key), `Outgoing ${i}`, 40 + i * 80));
    for (let reply = 0; reply < 3; reply++)
      records.get(inbox)!.push(wrap(key, own, `Incoming ${i} reply ${reply}`, 40 + i * 80 + reply));
  }
  // Every websocket is intercepted: no public relay or real account is involved.
  await page.routeWebSocket(/^(wss?:)/, (socket) => {
    const url = socket.url();
    if (new URL(url).host === new URL(test.info().project.use.baseURL!).host) {
      socket.connectToServer();
      return;
    }
    let challenged = false,
      authenticated = false;
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw)),
        [verb, id, ...filters] = frame;
      wire.push({ url, frame });
      if (verb === 'AUTH') {
        authenticated = verifyEvent(id) && id.pubkey === own && id.kind === 22242;
        socket.send(JSON.stringify(['OK', id.id, authenticated, '']));
        return;
      }
      if (verb === 'EVENT') {
        socket.send(JSON.stringify(['OK', id.id, true, '']));
        return;
      }
      if (verb !== 'REQ') return;
      // Indexers challenge too: public discovery must never sign an AUTH for them.
      if (!challenged && PUBLIC_DISCOVERY_INDEXERS.includes(url)) {
        challenged = true;
        socket.send(JSON.stringify(['AUTH', 'public-indexer']));
      }
      if (url === PUBLIC_DISCOVERY_INDEXERS[0]) return;
      if (
        url === inbox &&
        !authenticated &&
        filters.some((filter: Filter) => filter.kinds?.includes(1059))
      ) {
        socket.send(JSON.stringify(['CLOSED', id, 'auth-required: authenticate first']));
        if (!challenged) {
          challenged = true;
          socket.send(JSON.stringify(['AUTH', 'account-inbox']));
        }
        return;
      }
      for (const filter of filters as Filter[])
        for (const event of (records.get(url) ?? [])
          .filter((event) => matchFilters([filter], event))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, Math.min(filter.limit ?? Infinity, 2)))
          socket.send(JSON.stringify(['EVENT', id, event]));
      socket.send(JSON.stringify(['EOSE', id]));
    });
  });
  await page.route('https://profiles.test/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
    }),
  );
  await page.addInitScript((seed) => {
    const entries = JSON.stringify([{ url: seed, read: true, write: true }]);
    localStorage.setItem('relays', entries);
    localStorage.setItem('nip65_relays', entries);
  }, seed);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await expect(page.getByTestId('chat-item')).toHaveCount(14, { timeout: 45000 });
  await expect
    .poll(
      () =>
        page.evaluate(async (keys) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          return Promise.all(
            keys.map(
              async (key) =>
                (await chatDataService.listLatestMessages(key, 10)).rows.filter(
                  (row) => row.author_public_key === key,
                ).length,
            ),
          );
        }, peers.map(getPublicKey)),
      { timeout: 45000 },
    )
    .toEqual(peers.map(() => 3));
  for (let i = 0; i < peers.length; i++) {
    const row = page
      .getByTestId('chat-item')
      .filter({ has: page.locator('strong', { hasText: new RegExp(`^Peer ${i + 1}$`) }) });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('img')).toHaveAttribute(
      'src',
      `https://profiles.test/${getPublicKey(peers[i])}.png`,
    );
  }
  const first = page
    .getByTestId('chat-item')
    .filter({ has: page.locator('strong', { hasText: /^Peer 1$/ }) });
  await first.click();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Incoming 0 reply' }),
  ).toHaveCount(3);
  await expect(
    page
      .getByTestId('message-bubble')
      .filter({ hasText: 'Outgoing 0' })
      .locator('.bubble-avatar img, .message-author img'),
  ).toHaveAttribute('src', `https://profiles.test/${own}.png`);
  await page.reload();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Incoming 0 reply' }),
  ).toHaveCount(3);
  expect(wire.some(({ url, frame }) => url === inbox && frame[0] === 'AUTH')).toBe(true);
  for (const { url, frame } of wire) {
    if (PUBLIC_DISCOVERY_INDEXERS.includes(url)) {
      expect(frame[0]).not.toBe('AUTH');
      expect(frame[0]).not.toBe('EVENT');
      if (frame[0] === 'REQ')
        expect(frame.slice(2).flatMap((filter) => filter.kinds ?? [])).not.toContain(1059);
    }
    if (frame[0] === 'REQ')
      expect(frame.slice(2).flatMap((filter) => filter.kinds ?? [])).not.toContain(4);
  }
});
