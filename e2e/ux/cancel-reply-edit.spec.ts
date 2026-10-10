import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import {
  action,
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
} from '../parity/helpers';

test('Escape and the cancel button end a reply or edit and keep the composer focused', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.cancelContextUser);
  try {
    const { page } = user;
    const peer = nip19.npubEncode(getPublicKey(generateSecretKey()));
    await openDirectChatFromIdentifier(page, peer, 'Cancel context peer');
    await sendMessage(page, 'Cancel context fixture');
    const composer = page.getByTestId('message-composer-input');
    const banner = page.locator('.composer-context');

    await action(page, 'Cancel context fixture', 'Reply');
    await expect(banner).toContainText('Reply to');
    await composer.press('Escape');
    await expect(banner).toHaveCount(0);
    await expect(composer).toBeFocused();

    await action(page, 'Cancel context fixture', 'Reply');
    await page.getByRole('button', { name: 'Cancel reply or edit' }).click();
    await expect(banner).toHaveCount(0);
    await expect(composer).toBeFocused();

    // Open autocomplete takes the first Escape; the next one cancels the reply.
    await action(page, 'Cancel context fixture', 'Reply');
    await composer.pressSequentially(':smi');
    const suggestions = page.getByRole('listbox', { name: 'Emoji suggestions' });
    await expect(suggestions).toBeVisible();
    await composer.press('Escape');
    await expect(suggestions).toHaveCount(0);
    await expect(banner).toBeVisible();
    await composer.press('Escape');
    await expect(banner).toHaveCount(0);
    await expect(composer).toHaveValue(':smi');

    // Cancelling an edit restores the unsent draft.
    await composer.fill('unsent draft');
    await action(page, 'Cancel context fixture', 'Edit');
    await expect(composer).toHaveValue('Cancel context fixture');
    await composer.press('Escape');
    await expect(banner).toHaveCount(0);
    await expect(composer).toHaveValue('unsent draft');
    await expect(composer).toBeFocused();
  } finally {
    await disposeUsers(user);
  }
});
