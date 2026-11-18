import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapUser,
  acceptFirstRequest,
  addGroupMemberAndPublish,
  createGroup,
  disposeUsers,
  establishAcceptedDirectChat,
  navigateInApp,
  navigateToChat,
  openRequests,
  reloadAndWaitForApp,
  refreshSession,
  sendMessage,
  TEST_ACCOUNTS,
  waitForChatUnreadCount,
  waitForNoUnreadChatTotalBadge,
} from '../helpers';

async function waitForStartup(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
        return useNostrStore().isRestoringStartupState;
      }),
    )
    .toBe(false);
}

test('blocking a conversation survives reload and rejects later messages', async ({ browser }) => {
  const sender = await bootstrapUser(browser, TEST_ACCOUNTS.persistBlockSender);
  const receiver = await bootstrapUser(browser, TEST_ACCOUNTS.persistBlockReceiver);
  try {
    await establishAcceptedDirectChat(sender, receiver);
    await receiver.page
      .locator(`[data-testid="chat-item"][data-chat-public-key="${sender.session.publicKey}"]`)
      .locator('..')
      .getByRole('button', { name: 'Chat actions' })
      .click();
    await receiver.page.getByRole('menuitem', { name: 'Block', exact: true }).click();
    await receiver.page
      .getByRole('dialog', { name: 'Block conversation?' })
      .getByRole('button', { name: 'Block', exact: true })
      .click();
    await expect(receiver.page.getByRole('dialog')).toHaveCount(0);
    await reloadAndWaitForApp(receiver.page);
    await waitForStartup(receiver.page);
    // A cached startup checkpoint can defer this restore until its next retry.
    await receiver.page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      await useNostrStore().restoreMuteList();
    });
    await expect
      .poll(() =>
        receiver.page.evaluate(async (key) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          return (await chatDataService.getChatByPublicKey(key))?.meta.inbox_state;
        }, sender.session.publicKey),
      )
      .toBe('blocked');
    await sendMessage(sender.page, 'Must stay blocked after reload');
    await refreshSession(receiver.page);
    await expect
      .poll(() =>
        receiver.page.evaluate(async (key) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const rows = await chatDataService.listLatestMessages(key, 10);
          return rows.rows.some((row) => row.message === 'Must stay blocked after reload');
        }, sender.session.publicKey),
      )
      .toBe(false);
  } finally {
    await disposeUsers(sender, receiver);
  }
});

for (const conversation of ['direct message', 'private group']) {
  test(`reading a ${conversation} on desktop clears unread state on an open mobile session`, async ({
    browser,
  }) => {
    const sender = await bootstrapUser(browser, TEST_ACCOUNTS[`syncReadSender-${conversation}`]);
    const desktop = await bootstrapUser(browser, TEST_ACCOUNTS[`syncReadReceiver-${conversation}`]);
    let mobile: typeof desktop | undefined;
    try {
      let chatId = sender.session.publicKey;
      let chatName = sender.account.displayName;
      if (conversation === 'direct message') await establishAcceptedDirectChat(sender, desktop);
      else {
        chatName = `Synced private group ${Date.now()}`;
        chatId = await createGroup(sender.page, { name: chatName, about: '' });
        await addGroupMemberAndPublish(sender.page, desktop.session.publicKey);
        await openRequests(desktop.page);
        await acceptFirstRequest(desktop.page, { publicKey: chatId });
        await navigateToChat(desktop.page, chatId);
        await navigateToChat(sender.page, chatId);
      }
      await navigateInApp(desktop.page, '/settings/profile');
      mobile = await bootstrapUser(browser, desktop.account, { passiveRestore: true });
      await mobile.page.setViewportSize({ width: 390, height: 844 });
      if (conversation === 'private group') {
        await openRequests(mobile.page);
        await acceptFirstRequest(mobile.page, { publicKey: chatId });
        await navigateToChat(mobile.page, chatId);
      }
      await navigateInApp(mobile.page, '/chats');
      await waitForStartup(mobile.page);
      const second = Math.floor(Date.now() / 1000);
      await sender.page.waitForFunction((value) => Math.floor(Date.now() / 1000) > value, second);
      await sendMessage(sender.page, 'Read this on desktop');
      await waitForChatUnreadCount(mobile.page, 1, chatName);
      await navigateToChat(desktop.page, chatId);
      await waitForNoUnreadChatTotalBadge(mobile.page);
      // A genuinely newer message must become unread, and reads sync back too.
      await navigateInApp(desktop.page, '/settings/profile');
      const nextSecond = Math.floor(Date.now() / 1000);
      await sender.page.waitForFunction(
        (value) => Math.floor(Date.now() / 1000) > value,
        nextSecond,
      );
      await sendMessage(sender.page, 'Read this on mobile');
      await waitForChatUnreadCount(mobile.page, 1, chatName);
      await navigateToChat(mobile.page, chatId);
      await waitForNoUnreadChatTotalBadge(desktop.page);
      await navigateInApp(mobile.page, '/chats');
      await reloadAndWaitForApp(mobile.page);
      await waitForStartup(mobile.page);
      await waitForNoUnreadChatTotalBadge(mobile.page);
    } finally {
      await disposeUsers(sender, desktop, ...(mobile ? [mobile] : []));
    }
  });
}
