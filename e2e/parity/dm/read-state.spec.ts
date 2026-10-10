// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  markChatAsRead,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessage,
  setAppVisibility,
  TEST_ACCOUNTS,
  waitForChatPreview,
  waitForChatUnreadBadge,
  waitForChatUnreadCount,
  waitForNoChatUnreadBadge,
  waitForNoUnreadChatTotalBadge,
  waitForUnreadChatTotalBadge,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('mark as read survives a hard reload', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.markReadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.markReadBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.markReadCharlie);

  try {
    const firstMessage = `mark-read-one-${Date.now()}`;
    const secondMessage = `mark-read-two-${Date.now()}`;
    const latestOtherChatMessage = `mark-read-other-${Date.now()}`;

    await establishAcceptedDirectChat(charlie, bob);
    await establishAcceptedDirectChat(alice, bob);

    await navigateToChat(bob.page, charlie.session.publicKey);
    await bob.page.goto('/settings/profile');
    await sendMessage(alice.page, firstMessage, {
      chatId: bob.session.publicKey,
    });
    const firstSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, firstSecond);
    await sendMessage(alice.page, secondMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(charlie.page, latestOtherChatMessage, {
      chatId: bob.session.publicKey,
    });

    await bob.page.goto('/chats');
    await waitForChatPreview(bob.page, latestOtherChatMessage);
    await waitForChatPreview(bob.page, secondMessage, secondMessage);
    await waitForChatUnreadBadge(bob.page, secondMessage);

    await markChatAsRead(bob.page, secondMessage);
    await reloadAndWaitForApp(bob.page);
    await waitForChatPreview(bob.page, secondMessage, secondMessage);
    await waitForNoChatUnreadBadge(bob.page, secondMessage);

    await expectNoUnexpectedBrowserErrors([alice, bob, charlie]);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});

test('active thread only marks incoming messages as read after the app regains focus', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.backgroundUnreadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.backgroundUnreadBob);

  try {
    const hiddenMessage = `background-unread-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForNoUnreadChatTotalBadge(bob.page);
    await waitForNoChatUnreadBadge(bob.page);

    await setAppVisibility(bob.page, {
      visibilityState: 'hidden',
      hasFocus: false,
    });
    // Nostr timestamps have one-second precision. Make this activity newer
    // than the setup/read cursor instead of randomly sharing its timestamp.
    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction(
      (second) => Math.floor(Date.now() / 1000) > second,
      setupSecond,
    );

    await sendMessage(alice.page, hiddenMessage, {
      chatId: bob.session.publicKey,
    });

    await waitForChatPreview(bob.page, hiddenMessage);
    await waitForChatUnreadCount(bob.page, 1);
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await expect.poll(() => bob.page.title()).toBe('(1) Anagram');

    await setAppVisibility(bob.page, {
      visibilityState: 'visible',
      hasFocus: true,
    });

    await waitForNoChatUnreadBadge(bob.page);
    await waitForNoUnreadChatTotalBadge(bob.page);
    await expect.poll(() => bob.page.title()).toBe('Anagram');
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});


test('opening an unread conversation removes its divider when the chat is marked read', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.unreadDividerAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.unreadDividerBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await bob.page.goto('/settings/profile');
    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, setupSecond);
    const text = `unread-divider-${Date.now()}`;
    await sendMessage(alice.page, text, { chatId: bob.session.publicKey });
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForNoChatUnreadBadge(bob.page);
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
    await reloadAndWaitForApp(bob.page);
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
  } finally {
    await disposeUsers(alice, bob);
  }
});
