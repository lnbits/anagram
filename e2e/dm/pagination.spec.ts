import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  markChatAsRead,
  navigateToChat,
  refreshSession,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  threadMessage,
  waitForNoThreadMessage,
  waitForThreadMessage,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('a second upward scroll at the top loads older messages', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.threadPaginationAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.threadPaginationBob);

  try {
    const seed = Date.now();
    const olderMessages = Array.from(
      { length: 15 },
      (_, index) => `thread-pagination-older-${String(index).padStart(2, '0')}-${seed}`
    );
    const paginationBoundaryMessage = `thread-pagination-boundary-${seed}`;
    const newerMessages = Array.from(
      { length: 49 },
      (_, index) => `thread-pagination-newer-${String(index).padStart(2, '0')}-${seed}`
    );
    const baseCreatedAtMs = Date.now() - 120_000;
    const olderMessageCreatedAts = olderMessages.map((_, index) =>
      new Date(baseCreatedAtMs + index * 1_000).toISOString()
    );

    await establishAcceptedDirectChat(alice, bob);
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, olderMessages, {
      createdAts: olderMessageCreatedAts,
    });
    await sendMessage(bob.page, paginationBoundaryMessage, {
      chatId: alice.session.publicKey,
    });
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, newerMessages);

    await bob.page.goto('/#/chats');
    await refreshSession(bob.page);
    await markChatAsRead(bob.page);
    await refreshSession(bob.page, alice.session.publicKey);
    await bob.page.evaluate(() => {
      window.localStorage.setItem('ui-desktop-message-layout', 'bubbles');
      window.dispatchEvent(
        new CustomEvent('nostr-chat:desktop-message-layout-changed', {
          detail: { layout: 'bubbles' },
        })
      );
    });
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessage(bob.page, newerMessages[newerMessages.length - 1] ?? '', {
      chatId: alice.session.publicKey,
    });
    await waitForNoThreadMessage(bob.page, olderMessages[0] ?? '', {
      chatId: alice.session.publicKey,
      refresh: false,
      timeoutMs: 1_500,
    });
    const latestIncomingMessage = threadMessage(
      bob.page,
      newerMessages[newerMessages.length - 1] ?? ''
    );
    await expect(latestIncomingMessage.getByTestId('thread-author-profile-link')).toBeVisible();
    await expect(
      threadMessage(bob.page, paginationBoundaryMessage).getByTestId('thread-author-profile-link')
    ).toBeVisible();
    await expect(latestIncomingMessage.locator('.bubble__author-name')).toHaveCount(0);

    const threadBody = bob.page.locator('.thread-body');
    await expect(bob.page.getByTestId('thread-load-older')).toBeVisible();

    // Dispatch both events in one browser task so host load cannot turn them into
    // separate gestures by stretching their timestamps beyond the gesture gap.
    await threadBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: -20,
        })
      );
      element.scrollTop = 0;
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: -48,
        })
      );
    });
    await expect(threadMessage(bob.page, olderMessages[0] ?? '')).toHaveCount(0);

    // A fresh pull/scroll while already at the top acts like pressing More.
    await bob.page.waitForTimeout(220);
    await threadBody.dispatchEvent('wheel', { deltaY: -48, deltaMode: 0 });
    await expect(threadMessage(bob.page, olderMessages[0] ?? '')).toBeVisible({ timeout: 12_000 });

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
