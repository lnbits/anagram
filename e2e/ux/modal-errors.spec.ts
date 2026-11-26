import { expect, test } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

test('dialog errors read cleanly and do not leak into the next dialog', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.modalErrorUser);
  try {
    const { page } = user;
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-identifier-input').fill('not-a-key');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    const error = dialog.getByRole('alert');
    await expect(error).toHaveText('Enter a valid npub, public key, or NIP-05 address.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'Create or join a call' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  } finally {
    await disposeUsers(user);
  }
});
