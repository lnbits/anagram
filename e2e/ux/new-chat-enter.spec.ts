import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

test('Enter in the new chat dialog adds the contact', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.newChatEnterUser);
  try {
    const { page } = user;
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    const identifier = page.getByTestId('contact-identifier-input');
    // Enter with nothing typed does nothing, like the disabled button.
    await identifier.press('Enter');
    await expect(dialog).toBeVisible();
    await identifier.fill(nip19.npubEncode(getPublicKey(generateSecretKey())));
    const name = page.getByLabel('Name (optional)', { exact: true });
    await name.fill('Enter key peer');
    await name.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('message-composer-input')).toBeVisible();
    await expect(page.getByTestId('chat-item').filter({ hasText: 'Enter key peer' })).toBeVisible();
  } finally {
    await disposeUsers(user);
  }
});
