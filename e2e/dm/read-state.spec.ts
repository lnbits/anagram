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

test.describe.configure({ mode: 'serial' });

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
    await bob.page.goto('/#/settings/profile');
    await sendMessage(alice.page, firstMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(alice.page, secondMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(charlie.page, latestOtherChatMessage, {
      chatId: bob.session.publicKey,
    });

    await bob.page.goto('/#/chats');
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
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
