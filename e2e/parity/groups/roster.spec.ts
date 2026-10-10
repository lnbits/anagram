// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  expectNoUnexpectedBrowserErrors,
  openGroupContact,
  openRequests,
  publishOwnProfile,
  replaceStoredGroupMembers,
  TEST_ACCOUNTS,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('group roster subscriptions update regular members and Refresh rebuilds members from the published roster', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.groupRosterOwner);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRosterBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.groupRosterCharlie);

  try {
    const groupName = `Roster Group ${Date.now()}`;
    const groupPublicKey = await createGroup(owner.page, {
      name: groupName,
      about: 'Shared roster coverage',
    });
    const charlieInitialName = `Charlie Roster Initial ${Date.now()}`;
    const charlieRefreshedName = `Charlie Roster Refreshed ${Date.now()}`;

    await publishOwnProfile(charlie.page, {
      name: charlieInitialName,
      about: 'Initial roster profile',
    });

    await addGroupMemberAndPublish(owner.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await openGroupContact(bob.page, groupPublicKey);
    await bob.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(bob.page.getByTestId('group-details')).not.toContainText(charlieInitialName);

    await addGroupMemberAndPublish(owner.page, charlie.session.publicKey);

    await expect(bob.page.getByTestId('group-details')).toContainText(charlieInitialName, {
      timeout: 12_000,
    });

    await publishOwnProfile(charlie.page, {
      name: charlieRefreshedName,
      about: 'Refreshed roster profile',
    });

    await replaceStoredGroupMembers(bob.page, groupPublicKey, []);
    await bob.page.goto('/chats');
    await openGroupContact(bob.page, groupPublicKey);
    await bob.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(bob.page.getByTestId('group-details')).not.toContainText(charlieRefreshedName);

    await bob.page
      .getByTestId('group-details')
      .getByRole('button', { name: 'Refresh members', exact: true })
      .click();
    await expect(bob.page.getByTestId('group-details')).toContainText(charlieRefreshedName, {
      timeout: 12_000,
    });
    await expectNoUnexpectedBrowserErrors([owner, bob, charlie]);
  } finally {
    await disposeUsers(owner, bob, charlie);
  }
});
