import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
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

test.describe.configure({ mode: 'serial' });

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

    await pauseRelayService('relay-two');
    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    const invitedMemberRow = alice.page
      .locator('.profile-members-list .q-item')
      .filter({ hasText: bobPublicKeyPrefix })
      .first();
    await expect(invitedMemberRow.getByTestId('group-member-ticket-epoch-badge')).toContainText(
      'Epoch 0'
    );
    await expect(invitedMemberRow.getByTestId('group-member-ticket-status')).toBeVisible();
    await invitedMemberRow.getByTestId('group-member-ticket-status').click();
    await expect(
      alice.page.locator('.profile-member-delivery__dialog-relay').filter({
        hasText: E2E_RELAY_URL,
      })
    ).toBeVisible();
    const failedTicketRelayRow = alice.page
      .locator('.profile-member-delivery__dialog-item')
      .filter({ hasText: E2E_RELAY_URL_TWO });
    await expect(
      failedTicketRelayRow.getByRole('button', { name: 'Retry', exact: true }).first()
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(alice.page.getByTestId('group-member-ticket-retry-all-button')).toBeVisible();

    await unpauseRelayService('relay-two');
    await retryGroupMemberTicketFailures(alice.page);
    await expect(
      failedTicketRelayRow.getByRole('button', { name: 'Retry', exact: true })
    ).toHaveCount(0, {
      timeout: 12_000,
    });
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.getByTestId('contact-profile-members-tab')).toContainText(
      'Members (2)'
    );
    await invitedMemberRow.locator('.profile-members-list__name').click();
    await alice.page.waitForURL(new RegExp(`#\\/contacts\\/${bob.session.publicKey}$`));
    await alice.page.goto(`/#/contacts/${groupPublicKey}`);
    await expect(alice.page.getByTestId('contact-profile-members-tab')).toContainText(
      'Members (2)'
    );

    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`
      )
    ).toContainText('Group invitation');
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    await navigateToChat(alice.page, groupPublicKey);
    await alice.page.getByPlaceholder('Write a message').click();
    await alice.page.keyboard.type('@');
    await expect(
      alice.page
        .getByTestId('message-mention-option')
        .filter({ hasText: bobPublicKeyPrefix })
        .first()
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
        })
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
      threadMessage(alice.page, aliceGroupMessage).getByTestId('thread-author-profile-link')
    ).toBeVisible();
    await expect(bobGroupMessageEntry.locator('.bubble__author-name')).toHaveCount(0);
    const authorLayout = await bobGroupMessageEntry.evaluate((entry) => {
      const author = entry.querySelector<HTMLElement>('.bubble__telegram-author');
      const content = entry.querySelector<HTMLElement>('.bubble__content');
      const bubble = entry.querySelector<HTMLElement>('.bubble');
      if (!author || !content || !bubble) {
        return null;
      }

      const authorRect = author.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      return {
        authorRight: authorRect.right,
        authorBottom: authorRect.bottom,
        contentLeft: contentRect.left,
        bubbleBottom: bubbleRect.bottom,
      };
    });
    expect(authorLayout).not.toBeNull();
    expect(authorLayout?.authorRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (authorLayout?.contentLeft ?? 0) + 1
    );
    expect(
      Math.abs((authorLayout?.authorBottom ?? 0) - (authorLayout?.bubbleBottom ?? 1_000))
    ).toBeLessThanOrEqual(2);

    await alice.page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const mineLeft = await threadMessage(alice.page, aliceGroupMessage)
          .locator('.bubble')
          .evaluate((bubble) => bubble.getBoundingClientRect().left);
        const theirLeft = await bobGroupMessageEntry
          .locator('.bubble')
          .evaluate((bubble) => bubble.getBoundingClientRect().left);
        return Math.abs(mineLeft - theirLeft);
      })
      .toBeLessThanOrEqual(1);
    await expect(threadMessage(alice.page, aliceGroupMessage).locator('.bubble')).toHaveCSS(
      'border-bottom-left-radius',
      '6px'
    );
    await alice.page.setViewportSize({ width: 1440, height: 960 });

    await alice.page.evaluate(() => {
      window.localStorage.setItem('ui-desktop-message-layout', 'text');
      window.dispatchEvent(
        new CustomEvent('anagram:desktop-message-layout-changed', {
          detail: { layout: 'text' },
        })
      );
    });
    await expect(bobGroupMessageEntry.locator('.bubble__telegram-author')).toHaveCount(0);
    await expect(bobGroupMessageEntry.locator('.bubble__author-name')).toBeVisible();
    await bobGroupMessageEntry.getByTestId('thread-author-profile-link').click();
    await alice.page.waitForURL(new RegExp(`#\\/chats\\/${bob.session.publicKey}$`));
    await expect(alice.page.getByPlaceholder('Write a message')).toBeVisible();

    await navigateToChat(alice.page, groupPublicKey);
    await alice.page.getByPlaceholder('Write a message').click();
    await alice.page.keyboard.type('@');
    await alice.page
      .getByTestId('message-mention-option')
      .filter({ hasText: bobPublicKeyPrefix })
      .first()
      .click();
    await alice.page.keyboard.type(` ${aliceMentionMessage}`);
    await alice.page.getByTestId('message-composer-send').click();
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
    await bob.page.goto('/#/chats');
    const groupChatItem = bob.page
      .getByTestId('chat-item')
      .filter({ hasText: aliceMentionMessage })
      .first();
    await expect(groupChatItem).toBeVisible();
    await expect(groupChatItem).toContainText(`@${bobPublicKeyPrefix}`);
    await expect(groupChatItem).not.toContainText('nostr:nprofile');
    await navigateToChat(alice.page, groupPublicKey);
    await threadMessage(alice.page, aliceMentionMessage)
      .getByTestId('message-mention-link')
      .first()
      .click();
    await alice.page.waitForURL(new RegExp(`#\\/chats\\/${bob.session.publicKey}$`));
    await sendMessage(alice.page, aliceMentionDmMessage, {
      chatId: bob.session.publicKey,
    });
    await expectPrivateContactListMember(alice.page, bob.session.publicKey);
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
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`
      )
    ).toContainText('Group invitation');
    await reloadAndWaitForApp(bob.page);
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await expect(
      bob.page.locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${groupPublicKey}"]`
      )
    ).toContainText('Group invitation');
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
