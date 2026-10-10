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
  navigateToChat,
  openGroupContact,
  openGroupEpochsTab,
  openRequests,
  readGroupEpochNumbers,
  rotateGroupEpoch,
  sendMessage,
  TEST_ACCOUNTS,
  waitForAppBridge,
  waitForNoChatUnreadBadge,
  waitForNoUnreadChatTotalBadge,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('hard reload after rotation keeps the higher group epoch current and messaging working', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupEpochAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupEpochBob);

  try {
    const groupName = `Epoch Restore Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Stale epoch regression coverage',
    });
    const rotatedOwnerMessage = `epoch-reload-owner-${Date.now()}`;
    const rotatedMemberReply = `epoch-reload-member-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await rotateGroupEpoch(alice.page, groupPublicKey, [bob.session.publicKey], [E2E_RELAY_URL]);

    await bob.page.reload();
    await waitForAppBridge(bob.page);
    await openGroupContact(bob.page, groupPublicKey);
    await openGroupEpochsTab(bob.page);
    await expect
      .poll(async () => (await readGroupEpochNumbers(bob.page))[0] ?? null, {
        timeout: 12_000,
      })
      .toBe(1);

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, rotatedOwnerMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, rotatedOwnerMessage, {
      chatId: groupPublicKey,
    });
    await sendMessage(bob.page, rotatedMemberReply, {
      chatId: groupPublicKey,
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, rotatedMemberReply, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('group messages continue both ways after an explicit epoch rotation', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupRotateAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRotateBob);

  try {
    const groupName = `Rotated Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Post-rotation messaging coverage',
    });
    const rotatedOwnerMessage = `owner-after-rotation-${Date.now()}`;
    const rotatedMemberReply = `member-after-rotation-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await rotateGroupEpoch(alice.page, groupPublicKey, [bob.session.publicKey], [E2E_RELAY_URL]);

    await openGroupContact(bob.page, groupPublicKey);
    await openGroupEpochsTab(bob.page);
    await expect.poll(() => readGroupEpochNumbers(bob.page), { timeout: 12_000 }).toEqual([1, 0]);
    await navigateToChat(bob.page, groupPublicKey);
    await waitForNoChatUnreadBadge(bob.page, groupName);
    await waitForNoUnreadChatTotalBadge(bob.page);
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, rotatedOwnerMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, rotatedOwnerMessage, {
      chatId: groupPublicKey,
    });
    await sendMessage(bob.page, rotatedMemberReply, {
      chatId: groupPublicKey,
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, rotatedMemberReply, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
