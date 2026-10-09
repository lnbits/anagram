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

for (const width of [1280, 390]) {
  test(`new conversation reuses relay search and excludes contacts without chats at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const relay = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const ownKey = generateSecretKey(),
      knownKey = generateSecretKey(),
      newKey = generateSecretKey();
    const known = getPublicKey(knownKey),
      discovered = getPublicKey(newKey);
    const profiles = [
      [knownKey, 'Dialog known'],
      [newKey, 'Dialog new'],
    ].map(([key, name]) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            name,
            ...(key === newKey ? { nip05: 'new@identity.test' } : {}),
          }),
        },
        key as Uint8Array,
      ),
    );
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb === 'EVENT') socket.send(JSON.stringify(['OK', id.id, true, '']));
        if (verb !== 'REQ') return;
        for (const profile of profiles)
          if (
            filters.some(
              (filter: Filter) =>
                matchFilters([filter], profile) &&
                (!filter.search ||
                  profile.content.toLowerCase().includes(filter.search.toLowerCase())),
            )
          )
            socket.send(JSON.stringify(['EVENT', id, profile]));
        socket.send(JSON.stringify(['EOSE', id]));
      }),
    );
    try {
      await page.route('https://identity.test/.well-known/nostr.json?name=new', (route) =>
        route.fulfill({ json: { names: { new: discovered }, relays: { [discovered]: [relay] } } }),
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
      await page.evaluate(async (known) => {
        const { contactsService } = await import('/src/services/contactsService.ts');
        await contactsService.createContact({
          public_key: known,
          name: 'Dialog known',
          type: 'user',
          meta: {},
        });
      }, known);
      await page.getByRole('button', { name: 'Chat options' }).click();
      await page.getByTestId('new-chat-button').click();
      const dialog = page.getByRole('dialog', { name: 'contact', exact: true });
      const input = dialog.getByTestId('contact-identifier-input');
      const results = dialog.getByTestId('profile-search-result');
      await input.fill('Dialog');
      await expect(results).toHaveCount(1);
      await expect(results).toContainText('Dialog new');
      await expect(dialog.getByText('Dialog known', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: 'Public groups on relays' })).toHaveCount(0);
      await input.fill(nip19.npubEncode(known));
      await expect(results).toHaveCount(0);
      await expect(
        dialog.getByText('Matching profiles are already in your contacts.'),
      ).toBeVisible();
      await input.fill('new@identity.test');
      await expect(results).toHaveCount(1);
      await expect(results).toContainText('Dialog new');
      await page.screenshot({ path: `test-results/new-conversation-search-${width}.png` });
      if (width === 390) await dialog.getByLabel('Name (optional)').fill('My nickname');
      await input.press('ArrowDown');
      await expect(results).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue(nip19.npubEncode(discovered));
      await expect(input).toBeFocused();
      await expect(results).toHaveCount(0);
      await expect(dialog.getByLabel('Name (optional)')).toHaveValue(
        width === 390 ? 'My nickname' : 'Dialog new',
      );
      expect(
        await page.evaluate(async (key) => {
          const { contactsService } = await import('/src/services/contactsService.ts');
          return (await contactsService.getContactByPublicKey(key)) === null;
        }, discovered),
      ).toBe(true);
      await dialog.getByRole('button', { name: 'Add contact', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/chats/${discovered}$`));
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
