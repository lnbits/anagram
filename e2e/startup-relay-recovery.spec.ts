import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  nip44,
  type Event,
  type Filter,
} from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

test('startup uses a healthy snapshot and automatically recovers a silent replica', async ({
  page,
}) => {
  const key = generateSecretKey();
  const own = getPublicKey(key);
  const now = Math.floor(Date.now() / 1000);
  const servers = [
    new WebSocketServer({ host: '127.0.0.1', port: 0 }),
    new WebSocketServer({ host: '127.0.0.1', port: 0 }),
  ];
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const urls = servers.map(
    (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
  const initialSecret = '1'.repeat(64),
    recoveredSecret = '2'.repeat(64);
  const preferences = (contactSecret: string, created_at: number) =>
    finalizeEvent(
      {
        kind: 30078,
        created_at,
        tags: [['d', '1']],
        content: nip44.v2.encrypt(
          JSON.stringify({ contactSecret }),
          nip44.v2.utils.getConversationKey(key, own),
        ),
      },
      key,
    );
  const common = [
    finalizeEvent(
      { kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Relay recovery' }) },
      key,
    ),
    finalizeEvent(
      { kind: 10002, created_at: now, tags: urls.map((url) => ['r', url]), content: '' },
      key,
    ),
    finalizeEvent(
      { kind: 10050, created_at: now, tags: urls.map((url) => ['relay', url]), content: '' },
      key,
    ),
  ];
  const events: Event[][] = [
    [...common, preferences(initialSecret, now - 20)],
    [...common, preferences(recoveredSecret, now - 10)],
  ];
  let recovering = false;
  const preferenceRequests = [0, 0];
  for (const [index, server] of servers.entries())
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') {
          events[index]!.push(id);
          socket.send(JSON.stringify(['OK', id.id, true, '']));
          return;
        }
        if (verb !== 'REQ') return;
        const isPreferences = filters.some(
          (filter: Filter) => filter.kinds?.includes(30078) && filter['#d']?.includes('1'),
        );
        if (isPreferences) {
          preferenceRequests[index]!++;
          if (index === 1 && !recovering) return;
        }
        const seen = new Set<string>();
        for (const filter of filters)
          for (const event of events[index]!.filter((event) => matchFilters([filter], event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? Infinity)) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            socket.send(JSON.stringify(['EVENT', id, event]));
          }
        socket.send(JSON.stringify(['EOSE', id]));
      });
    });
  try {
    await page.addInitScript((urls) => {
      const relays = JSON.stringify(urls.map((url) => ({ url, read: true, write: true })));
      localStorage.setItem('relays', relays);
      localStorage.setItem('nip65_relays', relays);
    }, urls);
    await page.goto('/');
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => JSON.parse(localStorage.getItem('privatePreferences') ?? '{}').contactSecret,
          ),
        { timeout: 30000 },
      )
      .toBe(initialSecret);
    await page.getByRole('button', { name: 'Show startup history', exact: true }).click();
    const bar = page.getByTestId('startup-relay-status-private-preferences');
    await expect(bar.locator('.green')).toHaveCount(1);
    await expect(bar.locator('.red')).toHaveCount(1);
    await bar.click();
    const dialog = page.getByRole('dialog', {
      name: 'Relay Status: Restore encrypted private preferences',
    });
    await expect(dialog).toContainText(urls[1]!);
    await expect(dialog).toContainText('No completion response before the deadline');
    const healthyRequests = preferenceRequests[0];
    recovering = true;
    await expect
      .poll(
        () =>
          page.evaluate(
            () => JSON.parse(localStorage.getItem('privatePreferences') ?? '{}').contactSecret,
          ),
        { timeout: 75000 },
      )
      .toBe(recoveredSecret);
    await expect(dialog).toContainText('2 synchronized');
    expect(preferenceRequests[0]).toBe(healthyRequests);
    expect(preferenceRequests[1]).toBeGreaterThan(1);
    await page.keyboard.press('Escape');
    await expect(bar.locator('.red')).toHaveCount(0);
    await expect(bar.locator('.gray')).toHaveCount(0);
  } finally {
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
