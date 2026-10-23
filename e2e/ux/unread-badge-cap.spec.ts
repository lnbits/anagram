import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
} from '../parity/helpers';

test('unread counts above 99 are shown as 99+', async ({ browser }) => {
  test.setTimeout(180000);
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.unreadCapAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.unreadCapBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    // Leave Alice's thread so her messages stay unread.
    await bob.page.getByTestId('chat-item').filter({ hasText: 'My Self' }).click();
    await sendMessagesViaBridge(
      alice.page,
      bob.session.publicKey,
      Array.from({ length: 140 }, (_, index) => `Unread cap ${index}`),
    );
    const row = bob.page.locator(
      `[data-testid="chat-item"][data-chat-public-key="${alice.session.publicKey}"]`,
    );
    await expect(row.locator('.badge')).toHaveText('99+', { timeout: 60000 });
    // The nav badge and title count unread chats, not messages.
    await expect(bob.page.locator('.nav-badge')).toHaveText('1');
  } finally {
    await disposeUsers(alice, bob);
  }
});
