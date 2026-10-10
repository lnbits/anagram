import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
const relay = 'ws://127.0.0.1:7777/';
async function prepare(page: Page) {
  const key = generateSecretKey(),
    peer = getPublicKey(generateSecretKey()),
    group = getPublicKey(generateSecretKey());
  await page.addInitScript((url) => {
    for (const name of ['relays', 'nip65_relays'])
      localStorage.setItem(name, JSON.stringify([{ url, read: true, write: true }]));
  }, relay);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await page.evaluate(
    async ({ peer, group, relay }) => {
      const { contactsService } = await import('/src/services/contactsService.ts');
      await contactsService.createContact({
        public_key: peer,
        name: 'Alice Contact',
        relays: [{ url: relay, read: true, write: true }],
        meta: {
          name: 'alice',
          display_name: 'Alice Contact',
          about: 'Contact biography',
          nip05: 'alice@example.test',
          lud16: 'alice@lightning.test',
          lud06: 'lnurl1example',
          website: 'https://example.test',
          banner: 'https://example.test/banner.png',
          birthday: { year: 1990, month: 4, day: 12 },
          private_contact_list_member: true,
        },
      });
      await contactsService.createContact({
        public_key: group,
        type: 'group',
        name: 'Contact Group',
        relays: [{ url: relay, read: true, write: true }],
        meta: {
          name: 'Contact Group',
          about: 'Group biography',
          group: true,
          group_private_key_encrypted: 'encrypted-do-not-render',
          group_members: [{ public_key: peer, name: 'Alice Contact' }],
          private_contact_list_member: true,
        },
      });
    },
    { peer, group, relay },
  );
  await page.getByRole('button', { name: 'contacts', exact: true }).click();
  return { peer, group, key };
}

test('contacts open cached details, public metadata, sharing, relay information and group tabs without creating chats', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { peer, group, key } = await prepare(page);
  const alice = page.getByTestId('contact-item').filter({ hasText: 'Alice Contact' });
  await alice.click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${peer}$`));
  const details = page.getByTestId('contact-details');
  await expect(details).toHaveAttribute('data-public-key', peer);
  await expect(details.getByLabel('Name', { exact: true })).toHaveValue('alice');
  await expect(details.getByLabel('About', { exact: true })).toHaveValue('Contact biography');
  await expect(details.getByLabel('NIP-05', { exact: true })).toHaveValue('alice@example.test');
  await expect(details.getByLabel('Name', { exact: true })).toHaveAttribute('readonly', '');
  expect(
    await page.evaluate(async (peer) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      return await chatDataService.getChatByPublicKey(peer);
    }, peer),
  ).toBeNull();
  await expect(details.getByLabel('Public Key (npub)', { exact: true })).toHaveValue(
    nip19.npubEncode(peer),
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await details.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(nip19.npubEncode(peer));
  await details.getByRole('button', { name: 'Show public key in hex format' }).click();
  await expect(details.getByLabel('Public Key (hex)', { exact: true })).toHaveValue(peer);
  await details.getByRole('button', { name: 'Show public key in npub format' }).click();
  await details.locator('summary').filter({ hasText: 'NIP-24' }).click();
  await expect(details.getByLabel('Website', { exact: true })).toHaveValue('https://example.test');
  await expect(details.getByLabel('Year', { exact: true })).toHaveValue('1990');
  await details.locator('summary').filter({ hasText: 'NIP-65' }).click();
  const appRelays = details.getByRole('switch', { name: /Send.*App Relays/i });
  await expect(appRelays).toHaveCount(0);
  await details.getByTestId('contact-profile-share-button').click();
  const share = page.getByRole('dialog', { name: 'Share Contact' });
  await expect(share.getByRole('img')).toBeVisible();
  await expect(share).toContainText('nostr:');
  await expect(share).not.toContainText(nip19.nsecEncode(key));
  await share.getByRole('button', { name: 'Close share dialog' }).click();
  await page.reload();
  await expect(details.getByLabel('About', { exact: true })).toHaveValue('Contact biography');
  await details.locator('summary').filter({ hasText: 'NIP-65' }).click();
  await expect(appRelays).toHaveCount(0);
  await page.getByTestId('contact-item').filter({ hasText: 'Contact Group' }).click();
  await expect(details).toHaveAttribute('data-public-key', group);
  await details.getByRole('tab', { name: 'Members', exact: true }).click();
  await expect(details.getByTestId('group-details')).toContainText('Alice Contact');
  await details.getByRole('tab', { name: 'Epochs', exact: true }).click();
  await expect(details).not.toContainText('encrypted-do-not-render');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to contacts' }).click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(alice).toBeVisible();
  await alice.click();
  await expect(details).toBeVisible();
  await page.goBack();
  await expect(alice).toBeVisible();
  await alice.click();
  await details.getByRole('button', { name: 'Open Chat', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chats/${peer}$`));
  await expect(page.getByTestId('message-composer-input')).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Copy npub', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(nip19.npubEncode(peer));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await expect(page.getByLabel('Public Key (npub)', { exact: true })).toHaveValue(
    nip19.npubEncode(peer),
  );
  expect(errors).toEqual([]);
});

test('contact search, add, mute, block, unblock and delete preserve contact navigation', async ({
  page,
}) => {
  const { peer } = await prepare(page);
  await page.getByTestId('contact-list-search').fill('alice@example.test');
  const alice = page.getByTestId('contact-item').filter({ hasText: 'Alice Contact' });
  await expect(alice).toBeVisible();
  await expect(page.getByTestId('contact-item')).toHaveCount(1);
  await page.getByTestId('contact-list-search').fill('');
  await alice.click();
  const row = alice.locator('..');
  async function action(name: string) {
    await row.getByRole('button', { name: 'Contact actions' }).click();
    await row.getByRole('menuitem', { name, exact: true }).click();
  }
  await action('Mute');
  await expect(row.locator('[aria-label="Mute"]')).toBeVisible();
  await action('Unmute');
  await expect(row.locator('[aria-label="Mute"]')).toHaveCount(0);
  await action('Block');
  await expect(
    page.getByTestId('contact-details').getByRole('button', { name: 'Open Chat', exact: true }),
  ).toBeDisabled();
  await action('Unblock');
  await expect(
    page.getByTestId('contact-details').getByRole('button', { name: 'Open Chat', exact: true }),
  ).toBeEnabled();
  await action('Delete Contact');
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(alice).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Contact', exact: true }).click();
  await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(peer));
  await page.getByLabel('Name (optional)').fill('Added again');
  await page.getByRole('dialog').getByRole('button', { name: 'Add contact', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${peer}$`));
  await expect(page.getByTestId('contact-details')).toBeVisible();
});

test('cached request profiles stay out of contacts until acceptance or a reply', async ({
  page,
}) => {
  await prepare(page);
  const pending = [
    { publicKey: getPublicKey(generateSecretKey()), name: 'Pending person', type: 'user' },
    { publicKey: getPublicKey(generateSecretKey()), name: 'Pending group', type: 'group' },
    { publicKey: getPublicKey(generateSecretKey()), name: 'Reply person', type: 'user' },
  ];
  await page.evaluate(async (pending) => {
    const { contactsService } = await import('/src/services/contactsService.ts');
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    for (const entry of pending) {
      await contactsService.createContact({
        public_key: entry.publicKey,
        name: entry.name,
        type: entry.type as 'user' | 'group',
        meta: { name: entry.name },
      });
      await chatDataService.createChat({
        public_key: entry.publicKey,
        name: entry.name,
        type: entry.type as 'user' | 'group',
        last_message: 'Unapproved incoming message',
        last_message_at: new Date().toISOString(),
        meta: { last_incoming_message_at: new Date().toISOString() },
      });
    }
  }, pending);
  await page.reload();
  const contact = (name: string) => {
    const key = pending.find((entry) => entry.name === name)?.publicKey;
    return key
      ? page.locator(`[data-testid=contact-item][data-public-key="${key}"]`)
      : page.getByTestId('contact-item').filter({ hasText: name });
  };
  await expect(contact('Alice Contact')).toBeVisible();
  for (const entry of pending) await expect(contact(entry.name)).toHaveCount(0);
  await page.getByTestId('contact-list-search').fill('Pending');
  await expect(page.getByTestId('contact-item')).toHaveCount(0);
  await page.getByTestId('contact-list-search').fill('');

  await page.getByRole('button', { name: 'chats', exact: true }).click();
  await page.getByTestId('requests-row').click();
  const request = (name: string) => page.locator('.request-list article').filter({ hasText: name });
  for (const entry of pending) await expect(request(entry.name)).toBeVisible();
  await request('Pending group').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(request('Pending group')).toHaveCount(0);
  await page.getByRole('button', { name: 'contacts', exact: true }).click();
  await expect(contact('Pending group')).toBeVisible();
  await expect(contact('Pending person')).toHaveCount(0);
  await expect(contact('Reply person')).toHaveCount(0);

  await page.getByRole('button', { name: 'chats', exact: true }).click();
  await page.getByTestId('requests-row').click();
  await request('Reply person').getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByTestId('message-composer-input').fill('Accept through a reply');
  await page.getByTestId('message-send-button').click();
  await page.getByRole('button', { name: 'contacts', exact: true }).click();
  await expect(contact('Reply person')).toBeVisible();
  await expect(contact('Pending person')).toHaveCount(0);
  await page.reload();
  await expect(contact('Reply person')).toBeVisible();
  await expect(contact('Pending group')).toBeVisible();
  await expect(contact('Pending person')).toHaveCount(0);
});
