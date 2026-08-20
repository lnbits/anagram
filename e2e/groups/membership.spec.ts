import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  editMessage,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openGroupContact,
  openGroupEpochsTab,
  openRequests,
  readGroupEpochNumbers,
  sendMessage,
  TEST_ACCOUNTS,
  waitForThreadMessage,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('adding a new group member without rotation keeps the current epoch and messaging working for all members', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.groupAddOwner);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupAddBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.groupAddCharlie);

  try {
    const groupName = `Add Member Group ${Date.now()}`;
    const groupPublicKey = await createGroup(owner.page, {
      name: groupName,
      about: 'No-rotation add-member coverage',
    });
    const beforeAddMessage = `before-add-${Date.now()}`;
    const editedBeforeAddMessage = `before-add-edited-${Date.now()}`;
    const afterAddMessage = `after-add-${Date.now()}`;
    const charlieReply = `charlie-reply-${Date.now()}`;

    await addGroupMemberAndPublish(owner.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`
      )
    ).toContainText('Group invitation');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, beforeAddMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, beforeAddMessage, {
      chatId: groupPublicKey,
    });
    await editMessage(owner.page, beforeAddMessage, editedBeforeAddMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(bob.page, editedBeforeAddMessage, {
      chatId: groupPublicKey,
    });
    await expect(
      bob.page.locator('.thread-message-entry').filter({ hasText: beforeAddMessage })
    ).toHaveCount(0);
    await expect(
      bob.page
        .locator('.thread-message-entry')
        .filter({ hasText: editedBeforeAddMessage })
        .getByTestId('message-edited-label')
    ).toBeVisible();

    await openGroupContact(owner.page, groupPublicKey);
    await addGroupMemberAndPublish(owner.page, charlie.session.publicKey);
    await openGroupEpochsTab(owner.page);
    await expect.poll(() => readGroupEpochNumbers(owner.page), { timeout: 12_000 }).toEqual([0]);

    await openRequests(charlie.page, { publicKey: groupPublicKey });
    await expect(
      charlie.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`
      )
    ).toContainText('Group invitation');
    await acceptFirstRequest(charlie.page, { publicKey: groupPublicKey });

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, afterAddMessage, {
      chatId: groupPublicKey,
    });

    await navigateToChat(charlie.page, groupPublicKey);
    await waitForThreadMessage(charlie.page, editedBeforeAddMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(charlie.page, afterAddMessage, {
      chatId: groupPublicKey,
    });

    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, editedBeforeAddMessage, {
      chatId: groupPublicKey,
    });
    await waitForThreadMessage(bob.page, afterAddMessage, {
      chatId: groupPublicKey,
    });

    await sendMessage(charlie.page, charlieReply, {
      chatId: groupPublicKey,
    });
    await navigateToChat(owner.page, groupPublicKey);
    await waitForThreadMessage(owner.page, charlieReply, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([owner, bob, charlie]);
  } finally {
    await disposeUsers(owner, bob, charlie);
  }
});
