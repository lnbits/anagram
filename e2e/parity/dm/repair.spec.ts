// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openReplyPreview,
  reactToMessage,
  removeStoredMessageByEventId,
  replyToMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  threadMessage,
  waitForNoThreadMessage,
  waitForReactionCount,
  waitForThreadMessage,
  waitForThreadMessageCount,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('missing reply targets are repaired when the reply preview is opened', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.replyRepairAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.replyRepairBob);

  try {
    const targetMessage = `reply-repair-target-${Date.now()}`;
    const replyMessage = `reply-repair-reply-${Date.now()}`;
    const targetCreatedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);

    const [seededTarget] = await sendMessagesViaBridge(
      alice.page,
      bob.session.publicKey,
      [targetMessage],
      {
        createdAts: [targetCreatedAt],
      },
    );
    if (!seededTarget?.eventId) {
      throw new Error('Expected the seeded DM target to have an event id.');
    }

    await waitForThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });
    await removeStoredMessageByEventId(bob.page, alice.session.publicKey, seededTarget.eventId);
    await waitForNoThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
      refresh: false,
      timeoutMs: 6_000,
    });

    await navigateToChat(alice.page, bob.session.publicKey);
    await replyToMessage(alice.page, targetMessage, replyMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, replyMessage, {
      chatId: alice.session.publicKey,
    });
    await expect(threadMessage(bob.page, replyMessage).locator('.reply-preview')).toBeVisible();

    await openReplyPreview(bob.page, replyMessage);
    await expect(threadMessage(bob.page, targetMessage)).toBeVisible({
      timeout: 45_000,
    });
    await expect(threadMessage(bob.page, replyMessage).locator('.reply-preview')).toContainText(
      targetMessage,
      {
        timeout: 45_000,
      },
    );
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('missing reaction targets are repaired after the recipient reconnects', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.reactionRepairAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.reactionRepairBob);

  try {
    const targetMessage = `reaction-repair-target-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);

    const [seededTarget] = await sendMessagesViaBridge(alice.page, bob.session.publicKey, [
      targetMessage,
    ]);
    if (!seededTarget?.eventId) {
      throw new Error('Expected the seeded DM reaction target to have an event id.');
    }

    await waitForThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
    });
    await removeStoredMessageByEventId(bob.page, alice.session.publicKey, seededTarget.eventId);
    await waitForNoThreadMessage(bob.page, targetMessage, {
      chatId: alice.session.publicKey,
      refresh: false,
      timeoutMs: 6_000,
    });

    await bob.context.close();
    await navigateToChat(alice.page, bob.session.publicKey);
    await reactToMessage(alice.page, targetMessage);

    bob = await bootstrapUser(browser, TEST_ACCOUNTS.reactionRepairBob);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessageCount(bob.page, targetMessage, 1, {
      chatId: alice.session.publicKey,
    });
    await waitForReactionCount(bob.page, /thumbs up reaction/i, 1);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
