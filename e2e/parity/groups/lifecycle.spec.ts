// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  selectGroupInviteMembers,
  bootstrapUser,
  createGroup,
  disposeUsers,
  deleteMessage,
  waitForDeletedMessageState,
  E2E_DUAL_RELAY_URLS,
  E2E_RELAY_URL,
  E2E_RELAY_URL_TWO,
  expectNoUnexpectedBrowserErrors,
  expectPrivateContactListMember,
  navigateToChat,
  openRequests,
  pauseRelayService,
  reloadAndWaitForApp,
  retryGroupMemberTicketFailures,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  unpauseRelayService,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('group owner can create a group, invite a member, and exchange messages both ways', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupBob, {
    relayUrls: [E2E_RELAY_URL],
  });

  try {
    const groupName = `Group ${Date.now()}`;
    const groupAbout = 'Relay-backed group e2e';
    const aliceGroupMessage = `group-hello-from-alice-${Date.now()}`;
    const bobGroupMessage = `group-hello-from-bob-${Date.now()}`;
    const aliceMentionMessage = `mention-bob-${Date.now()}`;
    const aliceMentionDmMessage = `mention-opened-dm-${Date.now()}`;
    const bobPublicKeyPrefix = bob.session.publicKey.slice(0, 8);

    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: groupAbout,
    });

    const invite = await selectGroupInviteMembers(alice.page, [bob.session.publicKey]);
    // A replica going offline after review must not veto a successful invitation
    // through the remaining relay.
    await pauseRelayService('relay-two');
    await invite.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(invite).toBeHidden();
    await expect(
      alice.page.locator(`.member[data-public-key="${bob.session.publicKey}"]`),
    ).toBeVisible();
    await unpauseRelayService('relay-two');
    await expect(alice.page.getByTestId('group-details').getByRole('status')).toHaveText(
      'Invitations sent',
    );
    const invitedMemberRow = alice.page.locator(
      `.member[data-public-key="${bob.session.publicKey}"]`,
    );
    await expect(invitedMemberRow).toContainText('Epoch 0');
    await expect(invitedMemberRow).toContainText(E2E_RELAY_URL);
    await expect(invitedMemberRow).toContainText(E2E_RELAY_URL_TWO);
    await expect(alice.page.locator('.member')).toHaveCount(2);
    await invitedMemberRow.locator('.member-profile').click();
    await expect(alice.page).toHaveURL(new RegExp(`/contacts/${bob.session.publicKey}$`));
    await alice.page.goto(`/contacts/${groupPublicKey}`);
    await alice.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(alice.page.locator('.member')).toHaveCount(2);

    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(alice.page, groupPublicKey);
    await alice.page.getByPlaceholder('Write a message').click();
    await alice.page.keyboard.type('@');
    await expect(
      alice.page
        .getByTestId('message-mention-option')
        .filter({ hasText: bob.account.displayName })
        .first(),
    ).toBeVisible();
    await alice.page.keyboard.press('Escape');
    await alice.page.getByPlaceholder('Write a message').fill('');

    await sendMessage(alice.page, aliceGroupMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, aliceGroupMessage, {
      chatId: groupPublicKey,
    });
    await sendMessage(bob.page, bobGroupMessage, {
      chatId: groupPublicKey,
    });
    await alice.page.evaluate(() => {
      window.localStorage.setItem('ui-desktop-message-layout', 'bubbles');
      window.dispatchEvent(
        new CustomEvent('anagram:desktop-message-layout-changed', {
          detail: { layout: 'bubbles' },
        }),
      );
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, bobGroupMessage, {
      chatId: groupPublicKey,
    });
    const bobGroupMessageEntry = threadMessage(alice.page, bobGroupMessage);
    const bobAuthorProfileLink = bobGroupMessageEntry.getByTestId('thread-author-profile-link');
    await expect(bobAuthorProfileLink).toBeVisible();
    await expect(
      threadMessage(alice.page, aliceGroupMessage).getByTestId('thread-author-profile-link'),
    ).toBeVisible();
    // Both layouts retain the author action and readable message content on mobile.
    await alice.page.setViewportSize({ width: 390, height: 844 });
    await expect(bobAuthorProfileLink).toBeVisible();
    expect(
      await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await alice.page.setViewportSize({ width: 1440, height: 960 });
    await alice.page.evaluate(() => {
      localStorage.setItem('ui-desktop-message-layout', 'text');
      window.dispatchEvent(
        new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout: 'text' } }),
      );
    });
    await expect(bobAuthorProfileLink).toBeVisible();
    await bobGroupMessageEntry.getByTestId('thread-author-profile-link').click();
    await alice.page.waitForURL(new RegExp(`\\/chats\\/${bob.session.publicKey}$`));
    await expect(alice.page.getByPlaceholder('Write a message')).toBeVisible();

    await navigateToChat(alice.page, groupPublicKey);
    await alice.page.getByPlaceholder('Write a message').click();
    await alice.page.keyboard.type('@');
    await alice.page
      .getByTestId('message-mention-option')
      .filter({ hasText: bob.account.displayName })
      .first()
      .click();
    await alice.page.keyboard.type(` ${aliceMentionMessage}`);
    await alice.page.getByTestId('message-send-button').click();
    await waitForThreadMessage(alice.page, aliceMentionMessage, {
      chatId: groupPublicKey,
    });
    const mentionLink = threadMessage(alice.page, aliceMentionMessage)
      .getByTestId('message-mention-link')
      .first();
    await expect(mentionLink).toContainText(/^@/);
    const mentionLabel = (await mentionLink.textContent())?.trim() ?? '';
    expect(mentionLabel).not.toContain('nostr:');
    await waitForThreadMessage(bob.page, aliceMentionMessage, {
      chatId: groupPublicKey,
    });
    await bob.page.goto('/chats');
    const groupChatItem = bob.page
      .getByTestId('chat-item')
      .filter({ hasText: aliceMentionMessage })
      .first();
    await expect(groupChatItem).toBeVisible();
    await expect(groupChatItem).toContainText(`@${bob.account.displayName}`);
    await expect(groupChatItem).not.toContainText('nostr:nprofile');
    await navigateToChat(alice.page, groupPublicKey);
    await threadMessage(alice.page, aliceMentionMessage)
      .getByTestId('message-mention-link')
      .first()
      .click();
    await alice.page.waitForURL(new RegExp(`\\/chats\\/${bob.session.publicKey}$`));
    await sendMessage(alice.page, aliceMentionDmMessage, {
      chatId: bob.session.publicKey,
    });
    await expectPrivateContactListMember(alice.page, bob.session.publicKey);
    await navigateToChat(alice.page, groupPublicKey);
    await navigateToChat(bob.page, groupPublicKey);
    await deleteMessage(alice.page, aliceGroupMessage);
    await waitForDeletedMessageState(alice.page, aliceGroupMessage);
    await waitForDeletedMessageState(bob.page, aliceGroupMessage);
    for (const participant of [alice, bob]) {
      await reloadAndWaitForApp(participant.page);
      await navigateToChat(participant.page, groupPublicKey);
      await waitForThreadMessage(participant.page, bobGroupMessage, { chatId: groupPublicKey });
      await waitForDeletedMessageState(participant.page, aliceGroupMessage);
    }
    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: [/127\.0\.0\.1:7001/i, /relay-two/i, /websocket/i],
    });
  } finally {
    await unpauseRelayService('relay-two').catch(() => undefined);
    await disposeUsers(alice, bob);
  }
});

test('group invite survives hard reload before acceptance and still opens a working chat', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.inviteReloadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.inviteReloadBob);

  try {
    const groupName = `Reload Invite Group ${Date.now()}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: groupName,
      about: 'Invite reload coverage',
    });
    const ownerMessage = `invite-reload-owner-${Date.now()}`;
    const memberReply = `invite-reload-member-${Date.now()}`;

    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);

    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await reloadAndWaitForApp(bob.page);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`,
      ),
    ).toContainText('This is an invitation to a group.');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, ownerMessage, {
      chatId: groupPublicKey,
    });
    await navigateToChat(bob.page, groupPublicKey);
    await waitForThreadMessage(bob.page, ownerMessage, {
      chatId: groupPublicKey,
    });
    await sendMessage(bob.page, memberReply, {
      chatId: groupPublicKey,
    });
    await navigateToChat(alice.page, groupPublicKey);
    await waitForThreadMessage(alice.page, memberReply, {
      chatId: groupPublicKey,
    });
    const groupChatItem = alice.page
      .getByTestId('chat-item')
      .filter({ hasText: groupName })
      .first();
    await expect(groupChatItem).toContainText(memberReply);
    await expect(groupChatItem.getByTestId('chat-item-preview-author')).toContainText(/:$/);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('new groups use verified recovery relays when another account relay is unavailable', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.groupAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.groupBob, {
    relayUrls: [E2E_RELAY_URL],
  });
  try {
    await pauseRelayService('relay-two');
    const group = await createGroup(alice.page, {
      name: `Available relay group ${Date.now()}`,
      about: 'Creation with an unavailable candidate relay',
    });
    const selected = await alice.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      return (await useNostrStore().groupRecovery.current(group)).recovery_state!.relays;
    }, group);
    expect(selected).toEqual([new URL(E2E_RELAY_URL).href]);
    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: group });
    await acceptFirstRequest(bob.page, { publicKey: group });
    await navigateToChat(alice.page, group);
    const greeting = `available-relay-owner-${Date.now()}`;
    await sendMessage(alice.page, greeting, { chatId: group });
    await navigateToChat(bob.page, group);
    await waitForThreadMessage(bob.page, greeting, { chatId: group });
    const reply = `available-relay-member-${Date.now()}`;
    await sendMessage(bob.page, reply, { chatId: group });
    await waitForThreadMessage(alice.page, reply, { chatId: group });
    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: [/127\.0\.0\.1:7001/i, /relay-two/i, /websocket/i],
    });
  } finally {
    await unpauseRelayService('relay-two').catch(() => undefined);
    await disposeUsers(alice, bob);
  }
});
