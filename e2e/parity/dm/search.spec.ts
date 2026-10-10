// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  markChatAsRead,
  navigateToChat,
  openNextThreadSearchResult,
  openPreviousThreadSearchResult,
  refreshSession,
  searchThreadMessages,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  waitForNoThreadMessage,
  waitForThreadMessage,
  waitForThreadSearchFocusedMessage,
  waitForThreadSearchStatus,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('thread search finds hidden DB messages and previous or next navigation uses the corrected direction', async ({
  browser,
}) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.threadSearchAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.threadSearchBob);

  try {
    const searchSeed = Date.now();
    const searchToken = `thread-search-hidden-${searchSeed}`;
    const olderHiddenMatch = `older hidden ${searchToken}`;
    const newerHiddenMatch = `newer hidden ${searchToken}`;
    const loadedGapMessage = `gap fill ${searchSeed}`;
    const olderMessages = Array.from({ length: 15 }, (_, index) => {
      if (index === 2) {
        return olderHiddenMatch;
      }

      if (index === 5) {
        return newerHiddenMatch;
      }

      if (index === 10) {
        return loadedGapMessage;
      }

      return `thread-search-older-filler-${String(index).padStart(2, '0')}-${searchSeed}`;
    });
    const paginationBoundaryMessage = `thread-search-boundary-${searchSeed}`;
    const newerMessages = Array.from(
      { length: 49 },
      (_, index) => `thread-search-newer-filler-${String(index).padStart(2, '0')}-${searchSeed}`,
    );
    const baseCreatedAtMs = Date.now() - 120_000;
    const toCreatedAt = (offsetSeconds: number): string =>
      new Date(baseCreatedAtMs + offsetSeconds * 1_000).toISOString();
    const olderMessageCreatedAts = olderMessages.map((_, index) => toCreatedAt(index));

    await establishAcceptedDirectChat(alice, bob);
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, olderMessages, {
      createdAts: olderMessageCreatedAts,
    });
    await sendMessage(bob.page, paginationBoundaryMessage, {
      chatId: alice.session.publicKey,
    });
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, newerMessages);

    await bob.page.goto('/chats');
    await refreshSession(bob.page);
    await markChatAsRead(bob.page);
    await refreshSession(bob.page, alice.session.publicKey);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessage(bob.page, newerMessages[newerMessages.length - 1] ?? '', {
      chatId: alice.session.publicKey,
    });
    await waitForNoThreadMessage(bob.page, newerHiddenMatch, {
      chatId: alice.session.publicKey,
      refresh: false,
      timeoutMs: 1_500,
    });
    await waitForNoThreadMessage(bob.page, olderHiddenMatch, {
      chatId: alice.session.publicKey,
      refresh: false,
      timeoutMs: 1_500,
    });

    await searchThreadMessages(bob.page, searchToken);
    await waitForThreadSearchStatus(bob.page, '1 of 2');
    await waitForThreadSearchFocusedMessage(bob.page, newerHiddenMatch);
    await waitForThreadMessage(bob.page, loadedGapMessage, {
      chatId: alice.session.publicKey,
    });

    await openPreviousThreadSearchResult(bob.page);
    await waitForThreadSearchStatus(bob.page, '2 of 2');
    await waitForThreadSearchFocusedMessage(bob.page, olderHiddenMatch);

    await openNextThreadSearchResult(bob.page);
    await waitForThreadSearchStatus(bob.page, '1 of 2');
    await waitForThreadSearchFocusedMessage(bob.page, newerHiddenMatch);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
