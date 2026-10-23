// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test, type WebSocketRoute } from '@playwright/test';
import {
  bootstrapUser,
  E2E_RELAY_URL,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  markChatAsRead,
  navigateInApp,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessage,
  setAppVisibility,
  TEST_ACCOUNTS,
  waitForChatPreview,
  waitForChatUnreadBadge,
  waitForChatUnreadCount,
  waitForNoChatUnreadBadge,
  waitForNoUnreadChatTotalBadge,
  waitForThreadMessage,
  waitForUnreadChatTotalBadge,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('mark as read survives a hard reload', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.markReadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.markReadBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.markReadCharlie);

  try {
    const firstMessage = `mark-read-one-${Date.now()}`;
    const secondMessage = `mark-read-two-${Date.now()}`;
    const latestOtherChatMessage = `mark-read-other-${Date.now()}`;

    await establishAcceptedDirectChat(charlie, bob);
    await establishAcceptedDirectChat(alice, bob);

    await navigateToChat(bob.page, charlie.session.publicKey);
    await bob.page.goto('/settings/profile');
    await setAppVisibility(bob.page, { visibilityState: 'hidden', hasFocus: false });
    await sendMessage(alice.page, firstMessage, {
      chatId: bob.session.publicKey,
    });
    const firstSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, firstSecond);
    await sendMessage(alice.page, secondMessage, {
      chatId: bob.session.publicKey,
    });
    await sendMessage(charlie.page, latestOtherChatMessage, {
      chatId: bob.session.publicKey,
    });

    // Desktop /chats can select the newest conversation and mark it read.
    // Keep the other chat open while testing Alice's unread context-menu action.
    await navigateToChat(bob.page, charlie.session.publicKey);
    await setAppVisibility(bob.page, { visibilityState: 'visible', hasFocus: true });
    await waitForChatPreview(bob.page, latestOtherChatMessage);
    await waitForChatPreview(bob.page, secondMessage, secondMessage);
    await waitForChatUnreadBadge(bob.page, secondMessage);

    await markChatAsRead(bob.page, secondMessage);
    await reloadAndWaitForApp(bob.page);
    await waitForChatPreview(bob.page, secondMessage, secondMessage);
    await waitForNoChatUnreadBadge(bob.page, secondMessage);

    await expectNoUnexpectedBrowserErrors([alice, bob, charlie]);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});

test('active thread only marks incoming messages as read after the app regains focus', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.backgroundUnreadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.backgroundUnreadBob);

  try {
    const hiddenMessage = `background-unread-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForNoUnreadChatTotalBadge(bob.page);
    await waitForNoChatUnreadBadge(bob.page);

    await setAppVisibility(bob.page, {
      visibilityState: 'hidden',
      hasFocus: false,
    });
    // Nostr timestamps have one-second precision. Make this activity newer
    // than the setup/read cursor instead of randomly sharing its timestamp.
    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction(
      (second) => Math.floor(Date.now() / 1000) > second,
      setupSecond,
    );

    await sendMessage(alice.page, hiddenMessage, {
      chatId: bob.session.publicKey,
    });

    await waitForChatPreview(bob.page, hiddenMessage);
    await waitForChatUnreadCount(bob.page, 1, alice.account.displayName);
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await expect.poll(() => bob.page.title()).toBe('(1) Anagram');

    await setAppVisibility(bob.page, {
      visibilityState: 'visible',
      hasFocus: true,
    });

    await waitForNoChatUnreadBadge(bob.page);
    await waitForNoUnreadChatTotalBadge(bob.page);
    await expect.poll(() => bob.page.title()).toBe('Anagram');
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});


test('opening an unread conversation removes its divider when the chat is marked read', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.unreadDividerAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.unreadDividerBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await bob.page.goto('/settings/profile');
    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, setupSecond);
    const text = `unread-divider-${Date.now()}`;
    await sendMessage(alice.page, text, { chatId: bob.session.publicKey });
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForNoChatUnreadBadge(bob.page);
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
    await reloadAndWaitForApp(bob.page);
    await expect(bob.page.getByTestId('thread-unread-separator')).toHaveCount(0);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('reading on one device clears the unread badge on another without restarting', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReadAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReadBob);
  let bobPhone: Awaited<ReturnType<typeof bootstrapUser>> | undefined;

  try {
    await establishAcceptedDirectChat(alice, bob);
    // A second session for the same key is a second device with its own storage.
    bobPhone = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReadBob, {
      passiveRestore: true,
    });
    await navigateInApp(bob.page, '/settings/profile');
    await navigateInApp(bobPhone.page, '/settings/profile');
    await waitForNoUnreadChatTotalBadge(bobPhone.page);

    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, setupSecond);
    await sendMessage(alice.page, `cross-device-unread-${Date.now()}`, {
      chatId: bob.session.publicKey,
    });
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await waitForUnreadChatTotalBadge(bobPhone.page, 1);

    // Opening the chat on one device publishes the encrypted cursor; the other applies it live.
    await navigateToChat(bob.page, alice.session.publicKey);
    await setAppVisibility(bob.page, { visibilityState: 'visible', hasFocus: true });
    await waitForNoUnreadChatTotalBadge(bob.page);
    await waitForNoUnreadChatTotalBadge(bobPhone.page);

    // A message that lands in the focused chat is read there, so the other device clears too.
    const readSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, readSecond);
    const focusedMessage = `cross-device-focused-${Date.now()}`;
    await sendMessage(alice.page, focusedMessage, { chatId: bob.session.publicKey });
    await waitForThreadMessage(bob.page, focusedMessage);
    await waitForNoUnreadChatTotalBadge(bob.page);
    // Stay off the thread on the second device; opening it there would mark it read locally.
    await expect
      .poll(() =>
        bobPhone!.page.evaluate(
          async ({ chatId, text }) => {
            const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
            const chat = useChatStore().chats.find((entry) => entry.id === chatId);
            return chat?.lastMessage.includes(text) ? chat.unreadCount : null;
          },
          { chatId: alice.session.publicKey, text: focusedMessage },
        ),
        // Automatic reads publish after the coalescing delay and its jitter.
        { timeout: 30_000 },
      )
      .toBe(0);
    await waitForNoUnreadChatTotalBadge(bobPhone.page);

    await expectNoUnexpectedBrowserErrors([alice, bob, bobPhone]);
  } finally {
    await disposeUsers(...[alice, bob, bobPhone].filter((user) => user !== undefined));
  }
});

function isE2ERelayUrl(url: URL): boolean {
  return url.href.replace(/\/$/, '') === E2E_RELAY_URL.replace(/\/$/, '');
}

// The live cursor subscription filter: account and kind only, never a d-tag.
function isLiveCursorRequest(message: string | Buffer, author: string): boolean {
  try {
    const [verb, , ...filters] = JSON.parse(message.toString());
    return (
      verb === 'REQ' &&
      filters.some(
        (filter: Record<string, unknown>) =>
          Array.isArray(filter.kinds) &&
          filter.kinds.includes(30078) &&
          Array.isArray(filter.authors) &&
          filter.authors.includes(author) &&
          Object.keys(filter).every((key) => !key.startsWith('#')),
      )
    );
  } catch {
    return false;
  }
}

test('read cursors keep syncing after a device loses every relay connection', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReconnectAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReconnectBob);
  let bobPhone: Awaited<ReturnType<typeof bootstrapUser>> | undefined;
  // The second device reaches its single relay through a route the test can cut or hold down.
  const phoneSockets = new Map<WebSocketRoute, WebSocketRoute>();
  let relayDown = false;
  let liveCursorRequests = 0;
  async function dropPhoneRelays(): Promise<void> {
    const sockets = [...phoneSockets];
    phoneSockets.clear();
    await Promise.all(
      sockets.map(async ([page, server]) => {
        await page.close();
        await server.close();
      }),
    );
  }

  try {
    await establishAcceptedDirectChat(alice, bob);
    bobPhone = await bootstrapUser(browser, TEST_ACCOUNTS.crossDeviceReconnectBob, {
      passiveRestore: true,
      prepareContext: (context) =>
        context.routeWebSocket(isE2ERelayUrl, (page) => {
          if (relayDown) {
            void page.close();
            return;
          }
          const server = page.connectToServer();
          phoneSockets.set(page, server);
          page.onMessage((message) => {
            if (isLiveCursorRequest(message, bob.session.publicKey)) liveCursorRequests += 1;
            server.send(message);
          });
          server.onMessage((message) => page.send(message));
          page.onClose(() => {
            phoneSockets.delete(page);
            void server.close();
          });
          server.onClose(() => {
            phoneSockets.delete(page);
            void page.close();
          });
        }),
    });
    await navigateInApp(bob.page, '/settings/profile');
    await navigateInApp(bobPhone.page, '/settings/profile');
    await expect.poll(() => liveCursorRequests).toBeGreaterThan(0);

    // Read boundaries have one-second resolution; send after the setup's last second.
    const setupSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, setupSecond);
    await sendMessage(alice.page, `reconnect-unread-${Date.now()}`, {
      chatId: bob.session.publicKey,
    });
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await waitForUnreadChatTotalBadge(bobPhone.page, 1);

    // Cycle 1: every relay drops and stays down while the other device reads.
    relayDown = true;
    await dropPhoneRelays();
    await navigateToChat(bob.page, alice.session.publicKey);
    await setAppVisibility(bob.page, { visibilityState: 'visible', hasFocus: true });
    await waitForNoUnreadChatTotalBadge(bob.page);
    await bob.page.waitForTimeout(3000);
    await waitForUnreadChatTotalBadge(bobPhone.page, 1);
    const requestsBeforeRecovery = liveCursorRequests;
    relayDown = false;
    // The relay reconnect restores the subscription, whose replay carries the missed cursor.
    await expect(
      bobPhone.page.getByRole('navigation', { name: 'Main navigation' }).locator('.badge'),
    ).toHaveCount(0, { timeout: 90_000 });
    expect(liveCursorRequests).toBe(requestsBeforeRecovery + 1);

    // Cycle 2: a plain drop and reconnect recovers once more, without duplicate listeners.
    await navigateInApp(bob.page, '/settings/profile');
    const requestsBeforeDrop = liveCursorRequests;
    await dropPhoneRelays();
    await expect
      .poll(() => liveCursorRequests, { timeout: 90_000 })
      .toBe(requestsBeforeDrop + 1);
    await bobPhone.page.waitForTimeout(3000);
    expect(liveCursorRequests).toBe(requestsBeforeDrop + 1);

    const readSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, readSecond);
    await sendMessage(alice.page, `reconnect-again-${Date.now()}`, {
      chatId: bob.session.publicKey,
    });
    await waitForUnreadChatTotalBadge(bob.page, 1);
    await waitForUnreadChatTotalBadge(bobPhone.page, 1);
    await navigateToChat(bob.page, alice.session.publicKey);
    await setAppVisibility(bob.page, { visibilityState: 'visible', hasFocus: true });
    await waitForNoUnreadChatTotalBadge(bob.page);
    await waitForNoUnreadChatTotalBadge(bobPhone.page);

    await expectNoUnexpectedBrowserErrors([alice, bob, bobPhone]);
  } finally {
    await disposeUsers(...[alice, bob, bobPhone].filter((user) => user !== undefined));
  }
});
