import { expect, test, type Page } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  navigateInApp,
  openDirectChatFromIdentifier,
  TEST_ACCOUNTS,
} from '../parity/helpers';

async function copyFromShareDialog(page: Page) {
  // Toasts last a few seconds; start each scenario without earlier ones.
  await expect(page.locator('.notices > div')).toHaveCount(0, { timeout: 10000 });
  await page.getByTestId('contact-profile-share-button').click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  // The app toast shows above the modal dialog, which stays open.
  const toast = page.locator('.notices > div', { hasText: 'Public Key copied.' });
  await expect(toast).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(
    await toast.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return Boolean(hit && node.contains(hit));
    }),
  ).toBe(true);
  await expect(page.getByText('Public Key copied.')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Closing the dialog returns the toast region to the page.
  await expect(page.locator('dialog .notices')).toHaveCount(0);
  await expect(toast).toBeVisible();
}

test('copying from a share dialog shows the app toast above the dialog', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.shareCopyToastUser);
  try {
    const { page, context } = user;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await navigateInApp(page, '/settings/profile');
    await copyFromShareDialog(page);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^nostr:npub1/);

    const contact = getPublicKey(generateSecretKey());
    await navigateInApp(page, '/chats');
    await openDirectChatFromIdentifier(page, contact, 'Share copy contact');
    await navigateInApp(page, `/contacts/${contact}`);
    await copyFromShareDialog(page);
  } finally {
    await disposeUsers(user);
  }
});
