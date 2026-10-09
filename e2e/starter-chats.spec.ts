import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  bootstrapSessionOnPage,
  disposeUsers,
  TEST_ACCOUNTS,
} from './parity/helpers';
import { getPublicKey, nip19 } from 'nostr-tools';

const botKey = nip19.decode('npub1nder966vtwg2xlazeddlpkdfh2ku2tr8d7wzzwxhlx24rn4sk8fqmq5hd2')
  .data as string;

for (const width of [1280, 390]) {
  test(`starter public group, self-chat and bot appear once and respect removal at ${width}px`, async ({
    browser,
  }) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`starter${width}`]);
    const page = user.page;
    try {
      await page.setViewportSize({ width, height: 844 });
      // Starter rows are local data; opening the supplied public room can use its
      // signed cached profile even when its external relays are unavailable.
      await page.routeWebSocket(/^wss:/, (socket) => socket.close());
      const own = page.locator(
        `[data-testid="chat-item"][data-chat-public-key="${user.session.publicKey}"]`,
      );
      const bot = page.locator(`[data-testid="chat-item"][data-chat-public-key="${botKey}"]`);
      const group = page.getByTestId('public-chat-item').filter({ hasText: 'Anagram rants' });
      await expect(page.getByTestId('chat-item')).toHaveCount(2);
      await expect(own).toContainText('My Self');
      await expect(bot).toContainText('Dad Jokes (Example Anagram Bot)');
      await expect(group).toHaveCount(1);
      await page.reload();
      await expect(page.getByTestId('chat-item')).toHaveCount(2);
      await expect(group).toHaveCount(1);
      await expect(bot).toHaveCount(1);
      await bot.click();
      await expect(page).toHaveURL(new RegExp(`/chats/${botKey}$`));
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await expect(page.getByTestId('message-bubble')).toHaveCount(0);
      if (width === 390)
        await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      const botRow = page.locator('.chat-row').filter({ has: bot });
      await botRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await botRow.getByRole('menuitem', { name: 'Delete Chat', exact: true }).click();
      await expect(bot).toHaveCount(0);
      await own.click();
      await expect(page).toHaveURL(new RegExp(`/chats/${user.session.publicKey}$`));
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await expect(page.locator('.self-chat-quote')).toBeVisible();
      if (width === 390)
        await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      const ownRow = page.locator('.chat-row').filter({ has: own });
      await ownRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await ownRow.getByRole('menuitem', { name: 'Delete Chat', exact: true }).click();
      await expect(own).toHaveCount(0);
      await group.click();
      await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
        'Anagram rants',
      );
      await page.getByRole('button', { name: 'Public group settings' }).click();
      await page.getByRole('button', { name: 'Leave public group', exact: true }).click();
      await page.getByRole('button', { name: 'Leave group', exact: true }).click();
      await expect(group).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
      await expect(page.getByTestId('chat-item')).toHaveCount(0);
      await expect(group).toHaveCount(0);
      expect(user.browserErrors).toEqual([]);
    } finally {
      await disposeUsers(user);
    }
  });
}

test('existing accounts do not receive a new starter bot on upgrade', async ({ page }) => {
  const account = TEST_ACCOUNTS.existingStarterAccount;
  const own = getPublicKey(Uint8Array.from(Buffer.from(account.privateKey, 'hex')));
  await page.goto('/');
  await page.evaluate((key) => localStorage.setItem(`anagram-starter-self-chat:${key}`, '1'), own);
  await bootstrapSessionOnPage(page, account);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByTestId('chat-item')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByTestId('chat-item')).toHaveCount(0);
});
