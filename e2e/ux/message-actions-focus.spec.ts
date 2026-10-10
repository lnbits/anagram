import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from '../parity/helpers';

test('Escape after a message action keeps focus where the user is typing', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.escapeFocusUser);
  try {
    const { page } = user;
    const peer = nip19.npubEncode(getPublicKey(generateSecretKey()));
    await openDirectChatFromIdentifier(page, peer, 'Escape focus peer');
    await sendMessage(page, 'Escape focus fixture');
    const composer = page.getByTestId('message-composer-input');
    // Opening the menu from its trigger and choosing Reply closes the menu and
    // focuses the composer.
    await threadMessage(page, 'Escape focus fixture')
      .getByRole('button', { name: 'Message actions', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await expect(composer).toBeFocused();
    await composer.press('Escape');
    await expect(composer).toBeFocused();
    // A menu closed with Escape still returns focus to its trigger.
    const trigger = threadMessage(page, 'Escape focus fixture').getByRole('button', {
      name: 'Message actions',
      exact: true,
    });
    await trigger.click();
    await expect(page.getByTestId('message-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('message-context-menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await disposeUsers(user);
  }
});
