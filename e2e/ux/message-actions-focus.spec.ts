import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  navigateToChat,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from '../parity/helpers';

test('Escape after a message action keeps focus where the user is typing', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.escapeFocusUser);
  try {
    const { page } = user;
    const peer = getPublicKey(generateSecretKey());
    await openDirectChatFromIdentifier(page, nip19.npubEncode(peer), 'Escape focus peer');
    await navigateToChat(page, peer);
    await sendMessage(page, 'Escape focus fixture');
    const composer = page.getByTestId('message-composer-input');
    // Opening the menu from the message and choosing Reply closes the menu and
    // focuses the composer.
    const content = threadMessage(page, 'Escape focus fixture').locator('.message-content');
    await content.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await expect(composer).toBeFocused();
    await composer.press('Escape');
    await expect(composer).toBeFocused();
    // A menu closed with Escape still returns focus to the message it came from.
    await content.click({ button: 'right' });
    await expect(page.getByTestId('message-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('message-context-menu')).toHaveCount(0);
    await expect(content).toBeFocused();
  } finally {
    await disposeUsers(user);
  }
});
