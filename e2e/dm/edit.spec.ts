import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  editMessage,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  waitForNoThreadMessage,
  waitForThreadMessage,
  waitForThreadMessageCount,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('encrypted DM edit replaces the original without duplicate messages', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.editAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.editBob);

  try {
    const originalText = `dm-before-edit-${Date.now()}`;
    const editedText = `dm-after-edit-${Date.now()}`;
    const preservedDraft = `unsent-draft-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await sendMessage(alice.page, originalText, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
    });

    await alice.page.getByTestId('message-composer-input').fill(preservedDraft);
    await editMessage(alice.page, originalText, editedText, {
      chatId: bob.session.publicKey,
    });
    await expect(alice.page.getByTestId('message-composer-input')).toHaveValue(preservedDraft);
    await expect(
      threadMessage(alice.page, editedText).getByTestId('message-edited-label')
    ).toBeVisible();

    await waitForThreadMessage(bob.page, editedText, {
      chatId: alice.session.publicKey,
    });
    await waitForNoThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
      refresh: false,
    });
    await waitForThreadMessageCount(bob.page, editedText, 1, {
      chatId: alice.session.publicKey,
    });
    await expect(
      threadMessage(bob.page, editedText).getByTestId('message-edited-label')
    ).toBeVisible();

    await reloadAndWaitForApp(bob.page);
    await waitForNoThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
      refresh: false,
    });
    await waitForThreadMessageCount(bob.page, editedText, 1, {
      chatId: alice.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
