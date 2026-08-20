import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  deleteMessage,
  disposeUsers,
  E2E_DUAL_RELAY_URLS,
  establishAcceptedDirectChat,
  expectBrowserStorageToBeEmpty,
  expectNoUnexpectedBrowserErrors,
  logoutFromSettings,
  navigateToChat,
  reactToMessage,
  reloadAndWaitForApp,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  waitForChatReactionBadge,
  waitForDeletedMessageState,
  waitForReaction,
  waitForReactionCount,
  waitForThreadMessage,
  waitForThreadMessageCount,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('reactions surface in the chat list and deleted messages stay deleted after reloads', async ({
  browser,
}) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.reactionReloadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.reactionReloadBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.reactionReloadCharlie);

  try {
    const targetMessage = `reaction-reload-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await establishAcceptedDirectChat(alice, charlie);
    await navigateToChat(alice.page, bob.session.publicKey);
    await sendMessage(alice.page, targetMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });

    await threadMessage(bob.page, targetMessage).locator('.bubble').click();
    await expect(bob.page.getByText('Reply', { exact: true })).toHaveCount(0);

    await navigateToChat(alice.page, charlie.session.publicKey);
    await reactToMessage(bob.page, targetMessage);
    await waitForChatReactionBadge(alice.page, 1, bob.account.displayName);

    await alice.page
      .getByTestId('chat-item')
      .filter({ hasText: bob.account.displayName })
      .first()
      .click();
    await waitForReaction(alice.page, /thumbs up reaction/i, {
      chatId: bob.session.publicKey,
    });
    await expect(
      alice.page
        .getByTestId('chat-item')
        .filter({ hasText: bob.account.displayName })
        .first()
        .locator('.chat-item__reaction-badge')
    ).toHaveCount(0);

    await navigateToChat(alice.page, bob.session.publicKey);
    await reloadAndWaitForApp(alice.page);
    await expect(alice.page).toHaveURL(new RegExp(`#\\/chats\\/${bob.session.publicKey}$`));
    await waitForReaction(alice.page, /thumbs up reaction/i, {
      chatId: bob.session.publicKey,
    });

    await deleteMessage(alice.page, targetMessage);
    await reloadAndWaitForApp(bob.page);
    await expect(bob.page).toHaveURL(new RegExp(`#\\/chats\\/${alice.session.publicKey}$`));
    await waitForDeletedMessageState(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob, charlie]);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});

test('accepted DM supports reactions, deletion, and logout', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.actionsAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.actionsBob);

  try {
    const targetMessage = `reaction-delete-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, targetMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });

    await reactToMessage(bob.page, targetMessage);
    await waitForReaction(alice.page, /thumbs up reaction/i, {
      chatId: bob.session.publicKey,
    });

    await deleteMessage(alice.page, targetMessage);
    await waitForDeletedMessageState(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });

    await logoutFromSettings(alice.page);
    await expectBrowserStorageToBeEmpty(alice.page);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('duplicate delivery across multiple relays does not duplicate messages, reactions, or deletions', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.dedupeAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.dedupeBob, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });

  try {
    const targetMessage = `dedupe-target-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, targetMessage, {
      chatId: bob.session.publicKey,
    });
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessageCount(bob.page, targetMessage, 1, {
      chatId: alice.session.publicKey,
    });

    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessageCount(bob.page, targetMessage, 1, {
      chatId: alice.session.publicKey,
    });

    await reactToMessage(bob.page, targetMessage);
    await waitForReaction(alice.page, /thumbs up reaction/i, {
      chatId: bob.session.publicKey,
    });
    await reloadAndWaitForApp(alice.page);
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForReactionCount(alice.page, /thumbs up reaction/i, 1);

    await deleteMessage(alice.page, targetMessage);
    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForDeletedMessageState(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForThreadMessageCount(bob.page, targetMessage, 1, {
      chatId: alice.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
