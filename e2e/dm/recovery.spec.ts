import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  getDeveloperDiagnosticsSnapshot,
  navigateToChat,
  refreshPrivateMessagesLiveReconnect,
  reloadAndWaitForApp,
  sendMessage,
  TEST_ACCOUNTS,
  waitForChatPreview,
  waitForNoChatUnreadBadge,
  waitForThreadMessage,
  waitForThreadMessageCount,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

const NIP17_GIFT_WRAP_CREATED_AT_OVERLAP_SECONDS = 2 * 24 * 60 * 60;

test('hard reload restores accepted DM chat list, unread count, and thread history', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.startupRestoreAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.startupRestoreBob);

  try {
    const firstMessage = `startup-restore-one-${Date.now()}`;
    const secondMessage = `startup-restore-two-${Date.now()}`;
    const thirdMessage = `startup-restore-three-${Date.now()}`;
    const replyAfterReload = `startup-restore-reply-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);

    await bob.page.goto('/#/chats');
    await sendMessage(alice.page, firstMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(alice.page, secondMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(alice.page, thirdMessage, {
      chatId: bob.session.publicKey,
    });

    await waitForChatPreview(bob.page, thirdMessage);

    await bob.page.getByTestId('chat-item').first().click();
    await waitForThreadMessage(bob.page, firstMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForThreadMessage(bob.page, secondMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForThreadMessage(bob.page, thirdMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForNoChatUnreadBadge(bob.page, TEST_ACCOUNTS.startupRestoreAlice.displayName);

    await reloadAndWaitForApp(bob.page);
    await expect(bob.page).toHaveURL(new RegExp(`#\\/chats\\/${alice.session.publicKey}$`));
    await waitForThreadMessage(bob.page, thirdMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForNoChatUnreadBadge(bob.page, TEST_ACCOUNTS.startupRestoreAlice.displayName);

    await sendMessage(bob.page, replyAfterReload, {
      chatId: alice.session.publicKey,
    });
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, replyAfterReload, {
      chatId: bob.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
    await alice.page.goto('/#/settings/developer');
    await alice.page.getByRole('button', { name: /^Startup History/ }).click();
    const startupHistory = alice.page.locator('.developer-card__section--startup-history');
    const startupSteps = startupHistory.locator('.app-status__history-item');
    await expect(startupSteps).toHaveCount(16);
    await expect(startupSteps.nth(11)).toContainText('12/16');
    await expect(startupSteps.nth(11)).toContainText('Listen for new messages');
    await expect(startupSteps.nth(11).locator('.app-status__status-icon--success')).toBeVisible();
    await expect(startupSteps.nth(15)).toContainText('16/16');
    await expect(startupSteps.nth(15)).toContainText('Restore message history');
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('accepted DM restores thread history and keeps working after both users restart', async ({
  browser,
}) => {
  let alice = await bootstrapUser(browser, TEST_ACCOUNTS.dmRestartAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.dmRestartBob);

  try {
    const beforeRestartMessage = `dm-before-restart-${Date.now()}`;
    const afterRestartReply = `dm-after-restart-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, beforeRestartMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, beforeRestartMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForNoChatUnreadBadge(bob.page, TEST_ACCOUNTS.dmRestartAlice.displayName);

    await disposeUsers(alice, bob);
    alice = await bootstrapUser(browser, TEST_ACCOUNTS.dmRestartAlice);
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.dmRestartBob);

    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessage(bob.page, beforeRestartMessage, {
      chatId: alice.session.publicKey,
    });
    await waitForNoChatUnreadBadge(bob.page, TEST_ACCOUNTS.dmRestartAlice.displayName);
    await sendMessage(bob.page, afterRestartReply, {
      chatId: alice.session.publicKey,
    });
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, afterRestartReply, {
      chatId: bob.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('accepted DMs catch up after the recipient reconnects without duplicates', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.catchupAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.catchupBob);

  try {
    const offlineMessageOne = `offline-catchup-one-${Date.now()}`;
    const offlineMessageTwo = `offline-catchup-two-${Date.now()}`;
    const bobPublicKey = bob.session.publicKey;

    await establishAcceptedDirectChat(alice, bob);

    await bob.context.close();

    await sendMessage(alice.page, offlineMessageOne, {
      chatId: bobPublicKey,
    });
    await sendMessage(alice.page, offlineMessageTwo, {
      chatId: bobPublicKey,
    });

    bob = await bootstrapUser(browser, TEST_ACCOUNTS.catchupBob);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessageCount(bob.page, offlineMessageOne, 1, {
      chatId: alice.session.publicKey,
    });
    await waitForThreadMessageCount(bob.page, offlineMessageTwo, 1, {
      chatId: alice.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('live DM reconnect anchors the NIP-17 overlap to last live coverage', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.liveReconnectAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.liveReconnectBob);

  try {
    await establishAcceptedDirectChat(alice, bob);

    await expect
      .poll(
        async () =>
          (await getDeveloperDiagnosticsSnapshot(bob.page)).privateMessagesSubscription
            .liveCoverageAt,
        {
          timeout: 15_000,
        }
      )
      .not.toBeNull();

    const beforeReconnectDiagnostics = await getDeveloperDiagnosticsSnapshot(bob.page);
    const liveCoverageAt = beforeReconnectDiagnostics.privateMessagesSubscription.liveCoverageAt;
    expect(liveCoverageAt).not.toBeNull();

    const afterReconnectDiagnostics = await refreshPrivateMessagesLiveReconnect(bob.page, {
      forceRecreate: true,
    });

    expect(afterReconnectDiagnostics.privateMessagesSubscription.since).toBe(
      (liveCoverageAt as number) - NIP17_GIFT_WRAP_CREATED_AT_OVERLAP_SECONDS
    );
    expect(
      afterReconnectDiagnostics.privateMessagesSubscription.liveCoverageAt
    ).toBeGreaterThanOrEqual(liveCoverageAt as number);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
