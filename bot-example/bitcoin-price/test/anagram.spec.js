import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateToChat,
  confirmGroupBackup,
  disposeUsers,
} from '../../../e2e/parity/helpers.ts';
import { PriceBot, publishProfile } from '../bot.js';
import { PriceFeed } from '../price.js';
import { Network, State } from '../runtime.js';
import { relay } from './relay.js';

test('Anagram UI can DM the bot and add it to private and public groups', async ({ browser }) => {
  const local = await relay();
  const parent = fileURLToPath(new URL('../data/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(`${parent}browser-`);
  const store = new State(dir);
  const joke = 'BTC: $67,123 USD'; // The expected reply text.
  const bot = new PriceBot({
    store,
    net: new Network([local.url]),
    feed: new PriceFeed({ fetchText: async () => '{"USD":67123}', log() {} }),
    cooldown: 0,
    log() {},
  });
  let user;
  try {
    await bot.start();
    await publishProfile(bot, { pictureURL: 'https://example.org/btc.png' });
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    const npub = nip19.npubEncode(bot.pubkey);
    async function expectPromptBeforeReply(testId, prompt) {
      const rows = page.getByTestId(testId);
      await expect(rows.filter({ hasText: joke })).toBeVisible();
      await expect
        .poll(async () => {
          const texts = await rows.locator('.message-text').allTextContents();
          const promptIndex = texts.findIndex((text) => text.includes(prompt));
          return promptIndex >= 0 && promptIndex < texts.findIndex((text) => text.includes(joke));
        })
        .toBe(true);
      await page.reload();
      await expect(rows.filter({ hasText: joke })).toBeVisible();
      const texts = await rows.locator('.message-text').allTextContents();
      expect(texts.findIndex((text) => text.includes(prompt))).toBeGreaterThanOrEqual(0);
      expect(texts.findIndex((text) => text.includes(prompt))).toBeLessThan(
        texts.findIndex((text) => text.includes(joke)),
      );
    }

    await openDirectChatFromIdentifier(page, npub, 'Bitcoin Price');
    await navigateToChat(page, bot.pubkey);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('price USD');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('message-bubble', 'price USD');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New private group', exact: true }).click();
    await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Private price');
    await page.getByLabel('Members', { exact: true }).fill(npub);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await confirmGroupBackup(page);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => Object.keys(store.data.groups).length).toBe(1);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`price USD nostr:${npub}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('message-bubble', 'price USD');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Public price');
    await page.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page).toHaveURL(/\/public\/naddr/);
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await page.getByRole('tab', { name: 'Trusted', exact: true }).click();
    await page.getByRole('button', { name: 'Add trusted users', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trusted users' });
    await picker.getByLabel('Search people').fill(npub);
    await picker
      .locator('[data-testid="profile-search-result"], [data-testid="invite-contact-result"]')
      .click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Public group settings' })).toBeHidden();
    await expect.poll(() => Object.keys(store.data.rooms).length).toBe(1);
    await page
      .getByRole('textbox', { name: 'Public message', exact: true })
      .fill(`price USD nostr:${npub}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('public-message', 'price USD');
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
