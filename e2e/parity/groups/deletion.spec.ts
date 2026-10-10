import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  addGroupMembersAndPublish,
  openRequests,
  acceptFirstRequest,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  reloadAndWaitForApp,
  openGroupContact,
  rotateGroupEpoch,
  TEST_ACCOUNTS,
  expectNoUnexpectedBrowserErrors,
} from '../helpers';

const row = (page: Page, group: string) =>
  page.locator(`[data-testid="chat-item"][data-chat-id="${group}"]`);
async function deleteGroup(page: Page, group: string) {
  await row(page, group).locator('..').getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete Chat', exact: true }).click();
  await expect(row(page, group)).toHaveCount(0);
}
async function refreshAndCheckDeleted(page: Page, group: string) {
  await page.evaluate(async () => {
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    const { useChatStore } = await import('/src/stores/chatStore.ts');
    await useNostrStore().restoreGroupIdentitySecrets();
    await useNostrStore().refreshPrivateMessages();
    await useChatStore().reload();
  });
  await expect(row(page, group)).toHaveCount(0);
  expect(
    await page.evaluate(async (group) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      const chat = await chatDataService.getChatByPublicKey(group);
      return {
        deleted: chat?.meta.deleted_locally,
        unread: chat?.unread_count,
        messages: (await chatDataService.listLatestMessages(group, 1)).rows.length,
      };
    }, group),
  ).toEqual({ deleted: true, unread: 0, messages: 0 });
}

test('deleted owner and member groups stay deleted across backups, new tickets, traffic and reload; Contacts can reopen them', async ({
  browser,
}) => {
  test.slow();
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.deleteGroupOwner);
  const member = await bootstrapUser(browser, TEST_ACCOUNTS.deleteGroupMember);
  try {
    const group = await createGroup(owner.page, { name: 'Keep deleted', about: '' });
    await addGroupMembersAndPublish(owner.page, [member.session.publicKey]);
    await openRequests(member.page, { publicKey: group });
    await acceptFirstRequest(member.page, { publicKey: group });
    await navigateToChat(owner.page, group);
    await sendMessage(owner.page, 'Before deleting', { chatId: group });
    await navigateToChat(member.page, group);
    await waitForThreadMessage(member.page, 'Before deleting', { chatId: group });

    await deleteGroup(owner.page, group);
    await sendMessage(member.page, 'While owner deleted', { chatId: group });
    await refreshAndCheckDeleted(owner.page, group);
    await reloadAndWaitForApp(owner.page);
    await refreshAndCheckDeleted(owner.page, group);
    await openGroupContact(owner.page, group);
    await owner.page.getByRole('button', { name: 'Open Chat', exact: true }).click();
    await expect(row(owner.page, group)).toBeVisible();
    await sendMessage(member.page, 'After owner reopened', { chatId: group });
    await waitForThreadMessage(owner.page, 'After owner reopened', { chatId: group });

    await deleteGroup(member.page, group);
    await rotateGroupEpoch(owner.page, group, [member.session.publicKey]);
    await sendMessage(owner.page, 'New epoch after deletion', { chatId: group });
    await reloadAndWaitForApp(member.page);
    await refreshAndCheckDeleted(member.page, group);
    await openGroupContact(member.page, group);
    await member.page.getByRole('button', { name: 'Open Chat', exact: true }).click();
    await expect(row(member.page, group)).toBeVisible();
    await sendMessage(owner.page, 'After member reopened', { chatId: group });
    await waitForThreadMessage(member.page, 'After member reopened', { chatId: group });
    await expectNoUnexpectedBrowserErrors([owner, member]);
  } finally {
    await disposeUsers(owner, member);
  }
});

for (const operation of ['profile', 'chat-list'] as const) {
  test(`a ${operation} refresh started before deletion cannot revive the group`, async ({
    browser,
  }) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`deleteRace${operation}`]);
    try {
      const group = await createGroup(user.page, { name: 'Deletion race', about: '' });
      const result = await user.page.evaluate(
        async ({ group, operation }) => {
          const { useChatStore } = await import('/src/stores/chatStore.ts');
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const { contactsService } = await import('/src/services/contactsService.ts');
          const store = useChatStore();
          let release!: () => void, entered!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const reached = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const readContacts = contactsService.getContactByPublicKey.bind(contactsService);
          const readChats = chatDataService.listChats.bind(chatDataService);
          let intercepted = false;
          if (operation === 'profile') {
            contactsService.getContactByPublicKey = async (key) => {
              const contact = await readContacts(key);
              if (key === group && !intercepted) {
                intercepted = true;
                entered();
                await held;
              }
              return contact;
            };
          } else {
            chatDataService.listChats = async () => {
              const rows = await readChats();
              if (!intercepted) {
                intercepted = true;
                entered();
                await held;
              }
              return rows;
            };
          }
          let pending: Promise<void> | undefined;
          try {
            pending = operation === 'profile' ? store.syncContactProfile(group) : store.reload();
            await reached;
            await store.deleteChat(group);
            release();
            await pending;
            return {
              listed: store.inboxChats.some((chat) => chat.id === group),
              deleted: (await chatDataService.getChatByPublicKey(group))?.meta.deleted_locally,
            };
          } finally {
            release();
            contactsService.getContactByPublicKey = readContacts;
            chatDataService.listChats = readChats;
            await pending;
          }
        },
        { group, operation },
      );
      expect(result).toEqual({ listed: false, deleted: true });
      await expect(row(user.page, group)).toHaveCount(0);
    } finally {
      await disposeUsers(user);
    }
  });
}
