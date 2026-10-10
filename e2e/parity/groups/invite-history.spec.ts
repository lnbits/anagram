import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  addGroupMembersAndPublish,
  selectGroupInviteMembers,
  openGroupContact,
  openGroupEpochsTab,
  readGroupEpochNumbers,
  openRequests,
  acceptFirstRequest,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  waitForNoThreadMessage,
  reloadAndWaitForApp,
  TEST_ACCOUNTS,
} from '../helpers';

test('inviting with hidden earlier messages rotates once and gives the newcomer only the new epoch', async ({
  browser,
}) => {
  test.slow();
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.inviteHistoryOwner);
  const existing = await bootstrapUser(browser, TEST_ACCOUNTS.inviteHistoryExisting);
  const newcomer = await bootstrapUser(browser, TEST_ACCOUNTS.inviteHistoryNewcomer);
  try {
    const group = await createGroup(owner.page, { name: 'Private earlier history', about: '' });
    await addGroupMembersAndPublish(owner.page, [existing.session.publicKey]);
    await openGroupEpochsTab(owner.page);
    expect(await readGroupEpochNumbers(owner.page)).toEqual([0]);
    await openRequests(existing.page, { publicKey: group });
    await acceptFirstRequest(existing.page, { publicKey: group });
    await navigateToChat(owner.page, group);
    const earlier = `Only original members ${Date.now()}`;
    const later = `All current members ${Date.now()}`;
    await sendMessage(owner.page, earlier, { chatId: group });
    await navigateToChat(existing.page, group);
    await waitForThreadMessage(existing.page, earlier, { chatId: group });

    await openGroupContact(owner.page, group);
    const dialog = await selectGroupInviteMembers(owner.page, [newcomer.session.publicKey]);
    const option = dialog.getByRole('checkbox', { name: 'Hide earlier messages from new members' });
    await expect(option).not.toBeChecked();
    await option.check();
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await expect(option).toBeVisible();
    await dialog.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(dialog).toBeHidden();
    await openGroupEpochsTab(owner.page);
    expect(await readGroupEpochNumbers(owner.page)).toEqual([1, 0]);

    await openRequests(newcomer.page, { publicKey: group });
    await acceptFirstRequest(newcomer.page, { publicKey: group });
    await openGroupContact(newcomer.page, group);
    await openGroupEpochsTab(newcomer.page);
    expect(await readGroupEpochNumbers(newcomer.page)).toEqual([1]);
    await navigateToChat(owner.page, group);
    await sendMessage(owner.page, later, { chatId: group });
    for (const member of [existing, newcomer]) {
      await navigateToChat(member.page, group);
      await waitForThreadMessage(member.page, later, { chatId: group });
    }
    await waitForThreadMessage(existing.page, earlier, { chatId: group });
    await waitForNoThreadMessage(newcomer.page, earlier, { chatId: group, timeoutMs: 3000 });
    await reloadAndWaitForApp(newcomer.page);
    await navigateToChat(newcomer.page, group);
    await waitForThreadMessage(newcomer.page, later, { chatId: group });
    await waitForNoThreadMessage(newcomer.page, earlier, { chatId: group, timeoutMs: 3000 });
    await openGroupContact(newcomer.page, group);
    await openGroupEpochsTab(newcomer.page);
    expect(await readGroupEpochNumbers(newcomer.page)).toEqual([1]);
  } finally {
    await disposeUsers(owner, existing, newcomer);
  }
});
