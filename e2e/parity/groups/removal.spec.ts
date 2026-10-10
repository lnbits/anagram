// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMembersAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openGroupContact,
  openGroupEpochsTab,
  openRequests,
  readGroupEpochNumbers,
  reloadAndWaitForApp,
  removeGroupMemberAndPublish,
  sendMessage,
  TEST_ACCOUNTS,
  waitForNoThreadMessage,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('group member removal rotates epoch and blocks removed members from new messages', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalOwner);
  const survivingMember = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalBob);
  const removedMember = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalCharlie);

  try {
    const groupName = `Removal Group ${Date.now()}`;
    const groupPublicKey = await createGroup(owner.page, {
      name: groupName,
      about: 'Group epoch rotation coverage',
    });
    const initialMessage = `before-removal-${Date.now()}`;
    const postRemovalMessage = `after-removal-${Date.now()}`;

    await addGroupMembersAndPublish(owner.page, [
      survivingMember.session.publicKey,
      removedMember.session.publicKey,
    ]);

    await openRequests(survivingMember.page, { publicKey: groupPublicKey });
    await expect(
      survivingMember.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(survivingMember.page, { publicKey: groupPublicKey });

    await openRequests(removedMember.page, { publicKey: groupPublicKey });
    await expect(
      removedMember.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(removedMember.page, { publicKey: groupPublicKey });

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, initialMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(survivingMember.page, groupPublicKey);
    await waitForThreadMessage(survivingMember.page, initialMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(removedMember.page, groupPublicKey);
    await waitForThreadMessage(removedMember.page, initialMessage, {
      chatId: groupPublicKey,
    });

    await openGroupContact(survivingMember.page, groupPublicKey);
    await survivingMember.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(survivingMember.page.getByTestId('group-remove-member')).toHaveCount(0);
    await openGroupContact(owner.page, groupPublicKey);
    await owner.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(
      owner.page
        .locator(`.member[data-public-key="${owner.session.publicKey}"]`)
        .getByRole('button', { name: 'Remove member', exact: true }),
    ).toHaveCount(0);
    await expect(owner.page.getByLabel('Member public keys')).toHaveCount(0);
    await expect(
      owner.page.getByRole('button', { name: 'Update members', exact: true }),
    ).toHaveCount(0);
    await removeGroupMemberAndPublish(owner.page, removedMember.session.publicKey);
    await expect(
      owner.page.locator(`.member[data-public-key="${survivingMember.session.publicKey}"]`),
    ).toBeVisible();
    await openGroupEpochsTab(owner.page);
    await expect.poll(() => readGroupEpochNumbers(owner.page), { timeout: 12_000 }).toEqual([1, 0]);

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, postRemovalMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(survivingMember.page, groupPublicKey);
    await waitForThreadMessage(survivingMember.page, postRemovalMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(removedMember.page, groupPublicKey);
    await waitForNoThreadMessage(removedMember.page, postRemovalMessage, {
      chatId: groupPublicKey,
      timeoutMs: 6_000,
    });
    await expectNoUnexpectedBrowserErrors([owner, survivingMember, removedMember]);
  } finally {
    await disposeUsers(owner, survivingMember, removedMember);
  }
});

test('removed group member stays blocked after hard reload and cannot deliver new group messages', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalReloadOwner);
  const survivingMember = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalReloadBob);
  const removedMember = await bootstrapUser(browser, TEST_ACCOUNTS.groupRemovalReloadCharlie);

  try {
    const groupName = `Removal Reload Group ${Date.now()}`;
    const groupPublicKey = await createGroup(owner.page, {
      name: groupName,
      about: 'Removed member reload coverage',
    });
    const initialMessage = `before-removal-reload-${Date.now()}`;
    const postRemovalMessage = `after-removal-reload-${Date.now()}`;
    const removedMemberAttempt = `removed-member-attempt-${Date.now()}`;

    await addGroupMembersAndPublish(owner.page, [
      survivingMember.session.publicKey,
      removedMember.session.publicKey,
    ]);

    await openRequests(survivingMember.page, { publicKey: groupPublicKey });
    await acceptFirstRequest(survivingMember.page, { publicKey: groupPublicKey });
    await openRequests(removedMember.page, { publicKey: groupPublicKey });
    await acceptFirstRequest(removedMember.page, { publicKey: groupPublicKey });

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, initialMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(survivingMember.page, groupPublicKey);
    await waitForThreadMessage(survivingMember.page, initialMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(removedMember.page, groupPublicKey);
    await waitForThreadMessage(removedMember.page, initialMessage, {
      chatId: groupPublicKey,
    });

    await openGroupContact(owner.page, groupPublicKey);
    await removeGroupMemberAndPublish(owner.page, removedMember.session.publicKey);
    await openGroupEpochsTab(owner.page);
    await expect.poll(() => readGroupEpochNumbers(owner.page), { timeout: 12_000 }).toEqual([1, 0]);

    await navigateToChat(owner.page, groupPublicKey);
    await sendMessage(owner.page, postRemovalMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(survivingMember.page, groupPublicKey);
    await waitForThreadMessage(survivingMember.page, postRemovalMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(removedMember.page, groupPublicKey);
    await waitForNoThreadMessage(removedMember.page, postRemovalMessage, {
      chatId: groupPublicKey,
      timeoutMs: 6_000,
    });

    await reloadAndWaitForApp(removedMember.page);
    await navigateToChat(removedMember.page, groupPublicKey);
    await waitForNoThreadMessage(removedMember.page, postRemovalMessage, {
      chatId: groupPublicKey,
      timeoutMs: 6_000,
    });

    await sendMessage(removedMember.page, removedMemberAttempt, {
      chatId: groupPublicKey,
    });
    await navigateToChat(owner.page, groupPublicKey);
    await waitForNoThreadMessage(owner.page, removedMemberAttempt, {
      chatId: groupPublicKey,
      timeoutMs: 6_000,
    });
    await navigateToChat(survivingMember.page, groupPublicKey);
    await waitForNoThreadMessage(survivingMember.page, removedMemberAttempt, {
      chatId: groupPublicKey,
      timeoutMs: 6_000,
    });
    await expectNoUnexpectedBrowserErrors([owner, survivingMember, removedMember]);
  } finally {
    await disposeUsers(owner, survivingMember, removedMember);
  }
});
