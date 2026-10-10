import { test, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  type Filter,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

for (const rejectSearch of [false, true])
  test(`chat search finds profiles and public groups, cancels stale queries and opens results (search ${rejectSearch ? 'rejected' : 'supported'})`, async ({
    page,
  }) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const relay = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const ownKey = generateSecretKey(),
      localKey = generateSecretKey(),
      remoteKey = generateSecretKey(),
      oldKey = generateSecretKey();
    const local = getPublicKey(localKey),
      remote = getPublicKey(remoteKey);
    const events = [
      [localKey, 'Fiat local'],
      [remoteKey, 'Fiat finder'],
      [oldKey, 'Old search'],
    ].map(([key, name]) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            name,
            picture: 'https://profiles.test/avatar.png',
            ...(key === remoteKey ? { nip05: 'bc@identity.test' } : {}),
          }),
        },
        key as Uint8Array,
      ),
    );
    const group = (name: string, slug: string) =>
      finalizeEvent(
        {
          kind: 34550,
          created_at: Math.floor(Date.now() / 1000),
          content: '',
          tags: [
            ['d', slug],
            ['name', name],
            ['description', 'Bitcoin discussions'],
            ['anagram-room', '1'],
            ['relay', relay],
          ],
        },
        remoteKey,
      );
    const joinedGroup = group('Fiat joined lounge', 'joined'),
      discoveredGroup = group('Fiat public lounge', 'discovered');
    events.push(joinedGroup, discoveredGroup, group('Old group', 'old'));
    const queries: Filter[] = [];
    const sent: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') {
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ') return;
        queries.push(...filters);
        if (rejectSearch && filters.some((filter: Filter) => filter.search)) {
          socket.send(
            JSON.stringify(['CLOSED', id, 'ERROR: bad req: unrecognised filter item: search']),
          );
          return;
        }
        const send = () => {
          if (socket.readyState !== 1) return;
          for (const event of events.filter((event) =>
            filters.some(
              (filter: Filter) =>
                matchFilters([filter], event) &&
                (!filter.search ||
                  event.content.toLowerCase().includes(filter.search.toLowerCase())),
            ),
          ))
            socket.send(JSON.stringify(['EVENT', id, event]));
          const eose = () => {
            if (socket.readyState === 1) socket.send(JSON.stringify(['EOSE', id]));
          };
          if (filters.some((filter: Filter) => filter.search)) timers.push(setTimeout(eose, 2000));
          else eose();
        };
        if (filters.some((filter: Filter) => filter.search === 'old'))
          timers.push(setTimeout(send, 1200));
        else send();
      }),
    );
    try {
      await page.route('https://profiles.test/**', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>',
        }),
      );
      await page.route('https://identity.test/.well-known/nostr.json?name=bc', (route) =>
        route.fulfill({ json: { names: { bc: remote }, relays: { [remote]: [relay] } } }),
      );
      await page.addInitScript((relay) => {
        const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
        localStorage.setItem('relays', entries);
        localStorage.setItem('nip65_relays', entries);
      }, relay);
      page.on('websocket', (socket) =>
        socket.on('framesent', (frame) => sent.push(String(frame.payload))),
      );
      await page.goto('/');
      await page.getByTestId('auth-open-login-button').click();
      await page.getByTestId('auth-open-key-button').click();
      await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
      await page.getByTestId('auth-login-button').click();
      await finishOnboarding(page);
      await page.evaluate(async (local) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        await chatDataService.createChat({
          public_key: local,
          name: 'Fiat local',
          type: 'user',
          meta: { inbox_state: 'accepted' },
          last_message: 'Cached conversation',
          last_message_at: new Date().toISOString(),
        });
      }, local);
      await page.evaluate(async (event) => {
        const { PublicGroupData } = await import('/src/services/publicGroupData.ts');
        const { parsePublicRoom } = await import('/src/stores/nostr/publicGroups.ts');
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        const db = new PublicGroupData(useNostrStore().getLoggedInPublicKeyHex()!);
        const room = parsePublicRoom(event);
        await db.save({ address: room.address, room, joined: true, updated: Date.now() });
        await db.close();
      }, joinedGroup);
      await page.reload();
      const search = page.getByRole('textbox', { name: 'Search chats' });
      const results = page.getByTestId('profile-search-result');
      await expect(page.getByTestId('chat-item')).toHaveCount(3);
      await search.fill('old');
      await expect.poll(() => queries.some((filter) => filter.search === 'old')).toBe(true);
      await search.fill('fiat');
      await expect(page.getByTestId('chat-item')).toHaveCount(1);
      await expect(results).toHaveCount(1);
      await expect(results).toContainText('Fiat finder');
      const publicResults = page.getByTestId('public-group-search-result');
      await expect(publicResults).toHaveCount(1);
      await expect(publicResults).toContainText('Fiat public lounge');
      await expect(page.getByTestId('public-chat-item')).toHaveCount(1);
      expect(
        queries.some((filter) => filter.kinds?.includes(34550) && filter.search === 'fiat'),
      ).toBe(true);
      if (!rejectSearch)
        await expect(
          page.getByRole('region', { name: 'People on relays' }).getByRole('status'),
        ).toContainText('Searching profiles');
      await expect(results.locator('img')).toHaveAttribute(
        'src',
        'https://profiles.test/avatar.png',
      );
      await expect(page.getByText('Searching profiles…', { exact: true })).toBeHidden();
      await expect(page.getByText(/search is unavailable/)).toHaveCount(0);
      await expect(results).toHaveCount(1);
      expect(
        await page.evaluate(async (remote) => {
          const { contactsService } = await import('/src/services/contactsService.ts');
          return (await contactsService.getContactByPublicKey(remote)) === null;
        }, remote),
      ).toBe(true);
      await search.fill('bc@identity.test');
      await expect(page.getByTestId('chat-item')).toHaveCount(0);
      await expect(results).toContainText('Fiat finder');
      await expect(results).toContainText('bc@identity.test');
      await search.press('ArrowDown');
      await expect(results).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/chats/${remote}$`));
      await expect(search).toHaveValue('');
      await expect(page.getByTestId('chat-item')).toHaveCount(4);
      await search.fill('local');
      await expect(page.getByTestId('chat-item')).toHaveCount(1);
      await page.getByTestId('chat-item').click();
      await expect(page).toHaveURL(new RegExp(`/chats/${local}$`));
      await page.getByRole('button', { name: 'Clear search', exact: true }).click();
      await expect(page.getByTestId('chat-item')).toHaveCount(4);
      await search.fill(nip19.nsecEncode(ownKey));
      await page.waitForTimeout(400);
      expect(sent.some((frame) => frame.includes(nip19.nsecEncode(ownKey)))).toBe(false);
      await search.fill(Buffer.from(ownKey).toString('hex'));
      await page.waitForTimeout(500);
      expect(sent.some((frame) => frame.includes(Buffer.from(ownKey).toString('hex')))).toBe(false);
      await search.fill('finder');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      await expect(search).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await search.fill('public lounge');
      await expect(publicResults).toHaveCount(1);
      await expect(page.getByTestId('public-chat-item')).toHaveCount(0);
      await search.press('ArrowDown');
      await expect(publicResults).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/public\/naddr/);
      await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
        'Fiat public lounge',
      );
      await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      await expect(search).toHaveValue('');
      await expect(page.getByTestId('public-chat-item')).toHaveCount(3);
      await search.fill('bitcoin discussions');
      await expect(page.getByTestId('public-chat-item')).toHaveCount(2);
      await expect(publicResults).toHaveCount(1); // Only the unjoined "Old group" remains in discovery.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    } finally {
      timers.forEach(clearTimeout);
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
