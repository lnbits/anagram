import { expect, test, type Page } from '@playwright/test';
import {
  acceptFirstRequest,
  bootstrapUser,
  createGroup,
  deleteMessage,
  disposeUsers,
  editMessage,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openRequests,
  selectGroupInviteMembers,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  waitForThreadMessage,
} from '../helpers';

async function sendMention(page: Page, displayName: string, text: string) {
  await page.getByTestId('message-composer-input').click();
  await page.keyboard.type('@');
  await page.getByTestId('message-mention-option').filter({ hasText: displayName }).first().click();
  await page.keyboard.type(` ${text}`);
  await page.getByTestId('message-send-button').click();
  await waitForThreadMessage(page, text);
}

test('group mentions show an @ indicator until read and follow edits and deletions', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mentionIndicatorAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mentionIndicatorBob);

  try {
    const stamp = Date.now();
    const plain = `mention-plain-${stamp}`;
    const editedAway = `mention-edited-${stamp}`;
    const deleted = `mention-deleted-${stamp}`;
    const kept = `mention-kept-${stamp}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: `Mentions ${stamp}`,
      about: 'Mention indicators',
    });
    const invite = await selectGroupInviteMembers(alice.page, [bob.session.publicKey]);
    await invite.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(invite).toBeHidden();
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    // Bob reads another chat, so group arrivals are unread while the list stays visible.
    await navigateToChat(bob.page, bob.session.publicKey);
    const groupRow = bob.page.locator(
      `[data-testid="chat-item"][data-chat-public-key="${groupPublicKey}"]`,
    );
    const mentionBadge = groupRow.getByTestId('chat-unread-mention-badge');

    // Nostr timestamps are whole seconds; start after Bob's read boundary second.
    const readSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction(
      (second) => Math.floor(Date.now() / 1000) > second,
      readSecond,
    );
    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, plain);
    await expect(groupRow).toContainText(plain);
    await expect(groupRow.locator('.badge')).toBeVisible();
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, editedAway);
    await expect(mentionBadge).toBeVisible();
    await editMessage(alice.page, editedAway, `${editedAway} without mention`);
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, deleted);
    await expect(mentionBadge).toBeVisible();
    await deleteMessage(alice.page, deleted);
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, kept);
    await expect(mentionBadge).toHaveText('@');
    await expect(groupRow.locator('.badge')).toBeVisible();
    // The sender never sees their own mention highlighted.
    await expect(threadMessage(alice.page, kept)).not.toHaveAttribute('data-mentions-me');

    await navigateToChat(bob.page, groupPublicKey);
    await expect(threadMessage(bob.page, kept)).toHaveAttribute('data-mentions-me', 'true');
    await expect(threadMessage(bob.page, plain)).not.toHaveAttribute('data-mentions-me');
    await expect(
      threadMessage(bob.page, `${editedAway} without mention`),
    ).not.toHaveAttribute('data-mentions-me');

    await navigateToChat(bob.page, bob.session.publicKey);
    await expect(groupRow).toBeVisible();
    await expect(mentionBadge).toHaveCount(0);
    await expect(groupRow.locator('.badge')).toHaveCount(0);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
