// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  E2E_RELAY_URL,
  expectNoUnexpectedBrowserErrors,
  expectPublishedMessageRelayStatus,
  navigateToChat,
  openGroupContact,
  openGroupEpochsTab,
  openRequests,
  readGroupEpochNumbers,
  reloadAndWaitForApp,
  removeStoredMessageByEventId,
  replyToMessage,
  rotateGroupEpoch,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  threadMessage,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('group delivery still works after both users restart', async ({ browser }) => {
  test.slow();

  let alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupRestartAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRestartBob);

  try {
    const groupName = `Restart Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Restart and restore coverage',
    });
    const beforeRestartMessage = `before-restart-${Date.now()}`;
    const afterRestartMessage = `after-restart-${Date.now()}`;
    const restartReplyMessage = `reply-after-restart-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);

    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, beforeRestartMessage, {
      chatId: groupPublicKey,
    });
    await expect(
      threadMessage(alice.page, beforeRestartMessage)
        .getByTestId('message-relay-status')
        .locator('.bubble__status-segment--green'),
    ).toBeVisible();
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, beforeRestartMessage, {
      chatId: groupPublicKey,
    });

    await disposeUsers(alice, bob);
    alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupRestartAlice);
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRestartBob);

    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, beforeRestartMessage, { chatId: groupPublicKey });
    const restoredStatus = threadMessage(alice.page, beforeRestartMessage).getByTestId(
      'message-relay-status',
    );
    await expect(restoredStatus.locator('.bubble__status-segment--green')).toBeVisible();
    await restoredStatus.click();
    const statusDialog = alice.page.getByRole('dialog');
    await expect(statusDialog.getByTestId('relay-status-panel-received')).toContainText(
      E2E_RELAY_URL,
    );
    await expect(statusDialog.getByRole('tab')).toHaveCount(0);
    await expect(statusDialog.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await alice.page.keyboard.press('Escape');
    await sendMessage(alice.page, afterRestartMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, afterRestartMessage, {
      chatId: groupPublicKey,
    });
    await sendMessage(bob.page, restartReplyMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, restartReplyMessage, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('member restart restores group history from both the current and prior epochs', async ({
  browser,
}) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupEpochHistoryAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupEpochHistoryBob);

  try {
    const groupName = `Epoch History Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Historical epoch restore coverage',
    });
    const epochZeroMessage = `epoch-zero-message-${Date.now()}`;
    const epochOneMessage = `epoch-one-message-${Date.now()}`;
    const restartReplyMessage = `epoch-history-reply-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });
    await expectPublishedMessageRelayStatus(alice.page, epochZeroMessage);
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });

    await rotateGroupEpoch(alice.page, groupPublicKey, [bob.session.publicKey], [E2E_RELAY_URL]);

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, epochOneMessage, {
      chatId: groupPublicKey,
    });
    await expectPublishedMessageRelayStatus(alice.page, epochOneMessage);
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, epochOneMessage, {
      chatId: groupPublicKey,
    });

    await disposeUsers(bob);
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupEpochHistoryBob);

    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(bob.page, epochOneMessage, {
      chatId: groupPublicKey,
    });

    await openGroupContact(bob.page, groupPublicKey);
    await openGroupEpochsTab(bob.page);
    await expect.poll(() => readGroupEpochNumbers(bob.page), { timeout: 12_000 }).toEqual([1, 0]);

    await navigateToChat(bob.page, groupPublicKey);
    await sendMessage(bob.page, restartReplyMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, restartReplyMessage, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('missing prior-epoch reply targets are restored after restart', async ({ browser }) => {
  test.slow();

  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.groupReplyRepairOwner);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupReplyRepairBob);

  try {
    const groupName = `Reply Repair Group ${Date.now()}`;
    const groupPublicKey = await createGroup(owner.page, {
      name: groupName,
      about: 'Prior epoch reply repair coverage',
    });
    const epochZeroMessage = `epoch-zero-reply-target-${Date.now()}`;
    const epochOneReplyMessage = `epoch-one-reply-${Date.now()}`;
    const epochZeroCreatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await addGroupMemberAndPublish(owner.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(owner.page, groupPublicKey);
    const [seededTarget] = await sendMessagesViaBridge(
      owner.page,
      groupPublicKey,
      [epochZeroMessage],
      {
        createdAts: [epochZeroCreatedAt],
      },
    );
    if (!seededTarget?.eventId) {
      throw new Error('Expected the seeded group reply target to have an event id.');
    }

    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });

    await rotateGroupEpoch(owner.page, groupPublicKey, [bob.session.publicKey], [E2E_RELAY_URL]);
    // Remove the persisted copy. Unlimited hydration may recover it immediately;
    // do not require an artificial period in which the message stays missing.
    await removeStoredMessageByEventId(bob.page, groupPublicKey, seededTarget.eventId);
    await navigateToChat(owner.page, groupPublicKey);
    await waitForThreadMessage(owner.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });
    await replyToMessage(owner.page, epochZeroMessage, epochOneReplyMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(bob.page, epochOneReplyMessage, {
      attempts: 5,
      chatId: groupPublicKey,
      timeoutMs: 20_000,
    });

    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, epochOneReplyMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(bob.page, epochZeroMessage, {
      chatId: groupPublicKey,
    });
    await expect(
      threadMessage(bob.page, epochOneReplyMessage).locator('.reply-preview'),
    ).toContainText(epochZeroMessage, {
      timeout: 45_000,
    });
    await expectNoUnexpectedBrowserErrors([owner, bob]);
  } finally {
    await disposeUsers(owner, bob);
  }
});
