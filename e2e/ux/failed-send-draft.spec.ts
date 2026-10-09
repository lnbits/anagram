import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  navigateToChat,
  openDirectChatFromIdentifier,
  TEST_ACCOUNTS,
} from '../parity/helpers';

test('a failed send keeps the typed text as the chat draft', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.failedSendDraftUser);
  try {
    const { page } = user;
    const first = getPublicKey(generateSecretKey()),
      second = getPublicKey(generateSecretKey());
    await openDirectChatFromIdentifier(page, first, 'Failed send peer');
    await openDirectChatFromIdentifier(page, second, 'Other peer');
    await navigateToChat(page, first);
    await page.evaluate(async () => {
      const { useMessageStore } = await import('/src/stores/messageStore.ts');
      useMessageStore().sendMessage = async () => {
        throw new Error('Relay offline');
      };
    });
    const composer = page.getByTestId('message-composer-input');
    await composer.fill('Draft that fails to send');
    await page.getByTestId('message-send-button').click();
    await expect(page.locator('.notices')).toContainText('Relay offline');
    await expect(composer).toHaveValue('Draft that fails to send');
    await navigateToChat(page, second);
    await expect(composer).toHaveValue('');
    await navigateToChat(page, first);
    await expect(composer).toHaveValue('Draft that fails to send');
  } finally {
    await disposeUsers(user);
  }
});
