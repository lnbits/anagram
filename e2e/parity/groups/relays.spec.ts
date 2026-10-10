// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  E2E_DUAL_RELAY_URLS,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openGroupContact,
  openGroupRelaysTab,
  openProfileRelaysSection,
  openRequests,
  removeGroupRelayAndPublish,
  sendMessage,
  TEST_ACCOUNTS,
  updateStoredContactRelays,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('invited members see published group relays and profile refresh restores them when missing', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupInviteRelayAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupInviteRelayBob, {
    relayUrls: [E2E_DUAL_RELAY_URLS[0]],
  });

  try {
    const groupName = `Invite Relay Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Invite relay propagation coverage',
    });

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await openGroupContact(bob.page, groupPublicKey);
    await openProfileRelaysSection(bob.page);
    await expect(bob.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[0]);
    await expect(bob.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[1]);

    await updateStoredContactRelays(bob.page, groupPublicKey, []);
    await bob.page.goto('/chats');
    await openGroupContact(bob.page, groupPublicKey);
    await openProfileRelaysSection(bob.page);
    await expect
      .poll(
        async () => {
          const panelText = (await bob.page.getByTestId('group-details').textContent()) ?? '';
          if (
            panelText.includes(E2E_DUAL_RELAY_URLS[0]) &&
            panelText.includes(E2E_DUAL_RELAY_URLS[1])
          ) {
            return 'restored';
          }

          if (await bob.page.getByText('No relays configured.', { exact: true }).isVisible()) {
            return 'empty';
          }

          return 'pending';
        },
        { timeout: 15_000 },
      )
      .not.toBe('pending');

    await bob.page.getByRole('button', { name: 'Refresh group', exact: true }).click();
    await openProfileRelaysSection(bob.page);
    await expect(bob.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[0]);
    await expect(bob.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[1]);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('group relay changes still deliver after both members restart on the updated relay set', async ({
  browser,
}) => {
  let alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupRelayAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRelayBob, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });

  try {
    const groupName = `Relay Switch Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Group relay propagation coverage',
    });
    const postRelayChangeMessage = `after-relay-change-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await openGroupContact(alice.page, groupPublicKey);
    await openGroupRelaysTab(alice.page);
    await expect(alice.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[0]);
    await expect(alice.page.getByTestId('group-details')).toContainText(E2E_DUAL_RELAY_URLS[1]);
    await removeGroupRelayAndPublish(alice.page, E2E_DUAL_RELAY_URLS[0]);

    await disposeUsers(alice, bob);
    alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupRelayAlice, {
      relayUrls: E2E_DUAL_RELAY_URLS,
    });
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupRelayBob, {
      relayUrls: E2E_DUAL_RELAY_URLS,
    });

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, postRelayChangeMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, postRelayChangeMessage, {
      chatId: groupPublicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
