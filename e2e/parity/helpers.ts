import { test, expect, type Browser, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from '../auth-helpers';
export const E2E_RELAY_URL = 'ws://127.0.0.1:7777/';
export const E2E_RELAY_URL_TWO = 'ws://127.0.0.1:7778/';
export const E2E_RELAY_URL_HANG = 'ws://127.0.0.1:65534/';
export const E2E_DUAL_RELAY_URLS = [E2E_RELAY_URL, E2E_RELAY_URL_TWO];
export interface TestAccount {
  privateKey: string;
  displayName: string;
}
const accounts = new Map<string, TestAccount>();
export const TEST_ACCOUNTS = new Proxy({} as Record<string, TestAccount>, {
  get: (_, name: string) => {
    if (!accounts.has(name))
      accounts.set(name, {
        privateKey: Buffer.from(generateSecretKey()).toString('hex'),
        displayName: name,
      });
    return accounts.get(name);
  },
});
export interface BootstrappedUser {
  page: Page;
  context: Awaited<ReturnType<Browser['newContext']>>;
  account: TestAccount;
  session: { publicKey: string; npub: string; relayUrls: string[] };
  browserErrors: string[];
}
export async function waitForAppBridge(page: Page) {
  await page.evaluate(async (diagnostics) => {
    const { installAppE2EBridge } = await import('/src/testing/e2eBridge.ts');
    installAppE2EBridge();
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    useNostrStore().setDeveloperDiagnosticsEnabled(diagnostics);
  }, process.env.ANAGRAM_E2E_DIAGNOSTICS === '1');
}
export async function bootstrapUser(
  browser: Browser,
  account: TestAccount,
  options: { relayUrls?: string[]; passiveRestore?: boolean; callMedia?: boolean } = {},
): Promise<BootstrappedUser> {
  const context = await browser.newContext(
    options.callMedia ? { permissions: ['microphone', 'camera'], ignoreHTTPSErrors: true } : {},
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const relayUrls = options.relayUrls ?? [E2E_RELAY_URL];
  await context.addInitScript((urls) => {
    if (!window.name.includes('anagram-e2e-seeded')) {
      window.name += 'anagram-e2e-seeded';
      const entries = JSON.stringify(urls.map((url) => ({ url, read: true, write: true })));
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }
  }, relayUrls);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(account.privateKey);
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await waitForAppBridge(page);
  if (!options.passiveRestore)
    await page.evaluate(
      async ({ name, relayUrls }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        await useNostrStore().publishMyRelayList(
          relayUrls.map((url) => ({ url, read: true, write: true })),
          relayUrls,
        );
        await useNostrStore().publishUserMetadata({ name }, relayUrls);
      },
      { name: account.displayName, relayUrls },
    );
  const key = Uint8Array.from(Buffer.from(account.privateKey, 'hex'));
  const publicKey = getPublicKey(key);
  return {
    page,
    context,
    account,
    session: { publicKey, npub: nip19.npubEncode(publicKey), relayUrls },
    browserErrors,
  };
}
export async function disposeUsers(...users: BootstrappedUser[]) {
  if (
    process.env.ANAGRAM_E2E_DIAGNOSTICS === '1' ||
    test.info().status !== test.info().expectedStatus
  ) {
    for (const user of users) {
      try {
        const diagnostics = await user.page.evaluate(async () => {
          const { useNostrStore } = await import('/src/stores/nostrStore.ts');
          return {
            snapshot: await window.__appE2E__?.getDeveloperDiagnosticsSnapshot(),
            trace: await useNostrStore().listDeveloperTraceEntries(),
          };
        });
        await test.info().attach(`diagnostics-${user.account.displayName}`, {
          body: JSON.stringify(diagnostics),
          contentType: 'application/json',
        });
      } catch {
        /* A closed page has no diagnostics. */
      }
    }
  }
  await Promise.all(users.map((user) => user.context.close()));
}
export async function expectNoUnexpectedBrowserErrors(
  users: BootstrappedUser | BootstrappedUser[],
  options: { allowPatterns?: RegExp[] } = {},
) {
  expect(
    [users]
      .flat()
      .flatMap((u) => u.browserErrors)
      .filter((e) => !options.allowPatterns?.some((p) => p.test(e))),
  ).toEqual([]);
}
export function threadMessage(page: Page, text: string) {
  return page
    .getByTestId('message-bubble')
    .filter({ has: page.locator('.message-text').filter({ hasText: text }) })
    .last();
}
export async function navigateInApp(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const { navigateInApp } = await import('/src/testing/e2eBridge.ts');
    await navigateInApp(path);
  }, path);
}
export async function navigateToChat(page: Page, publicKey: string) {
  await page.bringToFront();
  const row = page.locator(`[data-testid="chat-item"][data-chat-public-key="${publicKey}"]`);
  if (await row.isVisible()) await row.click();
  else await navigateInApp(page, `/chats/${publicKey}`);
  await expect(page).toHaveURL(new RegExp(`/chats/${publicKey}$`));
  await expect(page.getByTestId('chat-thread')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useChatStore } = await import('/src/stores/chatStore.ts');
        return useChatStore().selectedChatId;
      }),
    )
    .toBe(publicKey);
  await waitForAppBridge(page);
}
export async function openDirectChatFromIdentifier(
  page: Page,
  identifier: string,
  givenName: string,
) {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByTestId('new-chat-button').click();
  await page.getByTestId('contact-identifier-input').fill(identifier);
  await page.getByLabel('Name (optional)', { exact: true }).fill(givenName);
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}
export async function sendMessage(page: Page, text: string, _options = {}) {
  await page.getByTestId('message-composer-input').fill(text);
  await page.getByTestId('message-send-button').click();
  await expect(threadMessage(page, text)).toBeVisible();
  await expectPublishedMessageRelayStatus(page, text);
}
export async function waitForThreadMessage(page: Page, text: string, _options = {}) {
  await expect(threadMessage(page, text)).toBeVisible({ timeout: 30000 });
}
export async function waitForNoThreadMessage(
  page: Page,
  text: string,
  options: { chatId?: string; refresh?: boolean; timeoutMs?: number } = {},
) {
  if (options.refresh !== false) await refreshSession(page, options.chatId);
  // Observe absence throughout the delivery window; a single immediate count
  // could pass before a forbidden post-removal message has even reached the relay.
  const deadline = Date.now() + (options.timeoutMs ?? 1500);
  do {
    expect(await threadMessage(page, text).count()).toBe(0);
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
}
export async function waitForThreadMessageCount(
  page: Page,
  text: string,
  count: number,
  _options = {},
) {
  await expect(page.getByTestId('message-bubble').filter({ hasText: text })).toHaveCount(count);
}
export async function openRequests(page: Page, _match?: unknown) {
  await page.getByTestId('requests-row').click();
}
function request(page: Page, match?: string | RegExp | { publicKey: string }) {
  const items = page.getByTestId('chat-request-item');
  return typeof match === 'object' && !(match instanceof RegExp)
    ? page.locator(`[data-testid="chat-request-item"][data-chat-public-key="${match.publicKey}"]`)
    : match
      ? items.filter({ hasText: match }).first()
      : items.first();
}
export async function acceptFirstRequest(
  page: Page,
  match?: string | RegExp | { publicKey: string },
) {
  await request(page, match).getByRole('button', { name: 'Accept', exact: true }).click();
}
export async function deleteFirstRequest(page: Page) {
  await request(page).getByRole('button', { name: 'Delete Chat', exact: true }).click();
}
export async function blockFirstRequest(page: Page) {
  await request(page).getByRole('button', { name: 'Block', exact: true }).click();
}
export async function waitForNoRequests(page: Page) {
  await expect(page.getByTestId('chat-request-item')).toHaveCount(0);
}
export async function establishAcceptedDirectChat(alice: BootstrappedUser, bob: BootstrappedUser) {
  await openDirectChatFromIdentifier(alice.page, bob.session.publicKey, bob.account.displayName);
  await sendMessage(alice.page, 'Establish conversation');
  await openRequests(bob.page);
  await acceptFirstRequest(bob.page);
  await navigateToChat(bob.page, alice.session.publicKey);
  await sendMessage(bob.page, 'Accepted conversation');
  await waitForThreadMessage(alice.page, 'Accepted conversation');
}
export async function reloadAndWaitForApp(page: Page) {
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await waitForAppBridge(page);
}
export async function refreshSession(page: Page, chatId?: string) {
  await waitForAppBridge(page);
  await page.evaluate(async (chatId) => window.__appE2E__!.refreshSession({ chatId }), chatId);
}
export async function sendMessagesViaBridge(
  page: Page,
  chatId: string,
  texts: string[],
  options: { createdAts?: string[] } = {},
) {
  await waitForAppBridge(page);
  return page.evaluate(async (options) => window.__appE2E__!.sendMessages(options), {
    chatId,
    texts,
    ...options,
  });
}
export async function removeStoredMessageByEventId(page: Page, chatId: string, eventId: string) {
  await waitForAppBridge(page);
  expect(
    await page.evaluate(
      async (options) => window.__appE2E__!.removeStoredMessageByEventId(options),
      { chatId, eventId },
    ),
  ).toBe(true);
}
export async function action(page: Page, text: string, name: string) {
  const message = threadMessage(page, text);
  await message.hover();
  // A message's centre can be a URL with its own Copy Link context menu.
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
export async function editMessage(page: Page, text: string, replacement: string, _options = {}) {
  await action(page, text, 'Edit');
  await sendMessage(page, replacement);
}
export async function replyToMessage(page: Page, text: string, reply: string, _options = {}) {
  await action(page, text, 'Reply');
  await sendMessage(page, reply);
}
export async function reactToMessage(page: Page, text: string, _label = '') {
  await threadMessage(page, text).click({ button: 'right' });
  await page.getByRole('button', { name: 'React', exact: true }).click();
}
export async function deleteMessage(page: Page, text: string) {
  await action(page, text, 'Delete');
}
export async function openReplyPreview(page: Page, text: string) {
  await threadMessage(page, text).locator('.reply-preview').click();
}
export async function waitForReplyPreviewText(
  page: Page,
  text: string,
  preview: string,
  _options = {},
) {
  await expect(threadMessage(page, text).locator('.reply-preview')).toContainText(preview);
}
export async function waitForReaction(page: Page, label: RegExp, _options = {}) {
  await expect(page.getByRole('button', { name: label }).first()).toBeVisible();
}
export async function waitForReactionCount(page: Page, label: RegExp, count: number) {
  await expect(page.getByRole('button', { name: label })).toHaveCount(count);
}
export async function waitForDeletedMessageState(page: Page, text: string, _options = {}) {
  await expect(threadMessage(page, text)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Deleted Message' })).toHaveCount(0);
  await expect(page.getByTestId('message-deleted').first()).toHaveText('Message deleted');
}
export async function createGroup(page: Page, options: { name: string; about: string }) {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'New private group' }).click();
  await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
  await page.getByLabel('Group name', { exact: true }).fill(options.name);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await confirmGroupBackup(page);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/chats\/[a-f0-9]{64}$/);
  const group = page.url().split('/').at(-1)!;
  await openGroupContact(page, group);
  await page.getByLabel('Description', { exact: true }).fill(options.about);
  await page.getByRole('button', { name: 'Save group profile', exact: true }).click();
  await expect(page.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  return group;
}
export async function openGroupContact(page: Page, publicKey: string) {
  await navigateInApp(page, `/contacts/${publicKey}`);
  await expect(page.getByTestId('group-details')).toBeVisible();
  await waitForAppBridge(page);
}
export async function selectGroupInviteMembers(page: Page, keys: string[]) {
  await page.getByRole('tab', { name: 'Members', exact: true }).click();
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite members', exact: true });
  for (const key of keys) {
    await dialog.getByRole('textbox', { name: 'Search people' }).fill(key);
    const results = dialog.locator(
      '[data-testid="invite-contact-result"], [data-testid="profile-search-result"]',
    );
    await expect(results).toHaveCount(1);
    await results.click();
  }
  return dialog;
}
export async function addGroupMembersAndPublish(
  page: Page,
  keys: string[],
  partialDelivery = false,
) {
  const dialog = await selectGroupInviteMembers(page, keys);
  await dialog.getByRole('button', { name: `Invite (${keys.length})`, exact: true }).click();
  if (partialDelivery) {
    await expect(dialog.getByRole('alert')).toContainText('invitations need a retry');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry relay', exact: true }).first(),
    ).toBeVisible();
  } else {
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('group-details').getByRole('status')).toHaveText(
      'Invitations sent',
    );
  }
}
export async function addGroupMemberAndPublish(page: Page, key: string, partialDelivery = false) {
  await addGroupMembersAndPublish(page, [key], partialDelivery);
}
export async function removeGroupMemberAndPublish(page: Page, key: string) {
  await page.getByRole('tab', { name: 'Members', exact: true }).click();
  const row = page.locator(`.member[data-public-key="${key}"]`);
  await row.getByRole('button', { name: 'Remove member', exact: true }).click();
  await expect(page.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await expect(row).toHaveCount(0);
}
export async function openGroupEpochsTab(page: Page) {
  await page.getByRole('tab', { name: 'Epochs', exact: true }).click();
}
export async function readGroupEpochNumbers(page: Page) {
  return page
    .locator('.epoch strong')
    .allTextContents()
    .then((values) => values.map((v) => Number(v.replace('Epoch ', ''))));
}
export async function rotateGroupEpoch(
  page: Page,
  groupPublicKey: string,
  memberPublicKeys: string[],
  relayUrls = [E2E_RELAY_URL],
) {
  await waitForAppBridge(page);
  await page.evaluate(async (options) => window.__appE2E__!.rotateGroupEpoch(options), {
    groupPublicKey,
    memberPublicKeys,
    relayUrls,
  });
}
export async function updateStoredContactRelays(
  page: Page,
  publicKey: string,
  relayUrls: string[],
) {
  await waitForAppBridge(page);
  await page.evaluate(async (options) => window.__appE2E__!.updateContactRelays(options), {
    publicKey,
    relayUrls,
  });
}
export async function replaceStoredGroupMembers(
  page: Page,
  groupPublicKey: string,
  memberPublicKeys: string[],
) {
  await waitForAppBridge(page);
  await page.evaluate(async (options) => window.__appE2E__!.replaceStoredGroupMembers(options), {
    groupPublicKey,
    memberPublicKeys,
  });
}
export async function openGroupRelaysTab(page: Page) {
  await page.getByRole('tab', { name: 'Relays', exact: true }).click();
}
export async function removeGroupRelayAndPublish(page: Page, relayUrl: string) {
  await openGroupRelaysTab(page);
  await page
    .locator('.group-details .relay')
    .filter({ hasText: relayUrl })
    .getByRole('button', { name: /^Remove/ })
    .click();
  await page.getByRole('button', { name: 'Save group relays' }).click();
  await expect(page.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
}
export async function retryGroupMemberTicketFailures(page: Page) {
  await page.getByRole('button', { name: 'Retry all failed deliveries' }).click();
  await expect(page.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
}
export async function expectPrivateContactListMember(page: Page, publicKey: string) {
  await waitForAppBridge(page);
  await expect
    .poll(() =>
      page.evaluate(
        async (publicKey) => window.__appE2E__!.isPrivateContactListMember({ publicKey }),
        publicKey,
      ),
    )
    .toBe(true);
}
export async function getDeveloperDiagnosticsSnapshot(page: Page) {
  await waitForAppBridge(page);
  return page.evaluate(() => window.__appE2E__!.getDeveloperDiagnosticsSnapshot());
}
export async function refreshPrivateMessagesLiveReconnect(page: Page, options = {}) {
  await waitForAppBridge(page);
  return page.evaluate(
    (options) => window.__appE2E__!.refreshPrivateMessagesLiveReconnect(options),
    options,
  );
}
export async function setAppVisibility(
  page: Page,
  options: { visibilityState: 'visible' | 'hidden'; hasFocus: boolean },
) {
  await page.evaluate(({ visibilityState, hasFocus }) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => visibilityState === 'hidden',
    });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => hasFocus });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(hasFocus ? 'focus' : 'blur'));
  }, options);
}
function chatRow(page: Page, match?: string | RegExp) {
  const rows = page.locator('.chat-row');
  return match ? rows.filter({ hasText: match }).first() : rows.first();
}
export async function waitForChatPreview(page: Page, text: string, match?: string | RegExp) {
  await expect(chatRow(page, match ?? text)).toContainText(text);
}
export async function waitForChatUnreadCount(page: Page, count: number, match?: string | RegExp) {
  await expect(chatRow(page, match).locator('.badge')).toHaveText(String(count));
}
export async function waitForChatUnreadBadge(page: Page, match?: string | RegExp) {
  await expect(chatRow(page, match).locator('.badge')).toBeVisible();
}
export async function waitForNoChatUnreadBadge(page: Page, match?: string | RegExp) {
  await expect(chatRow(page, match).locator('.badge')).toHaveCount(0);
}
export async function waitForUnreadChatTotalBadge(page: Page, count: number) {
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).locator('.badge'),
  ).toHaveText(String(count));
}
export async function waitForNoUnreadChatTotalBadge(page: Page) {
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).locator('.badge'),
  ).toHaveCount(0);
}
export async function waitForChatReactionBadge(page: Page, count: number, match?: string | RegExp) {
  await expect(chatRow(page, match).locator('.reaction-badge')).toHaveAttribute(
    'aria-label',
    `${count} unseen reactions`,
  );
}
export async function markChatAsRead(page: Page, match?: string | RegExp) {
  await chatRow(page, match).getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: /Mark as read/i }).click();
  await waitForNoChatUnreadBadge(page, match);
}
export async function searchThreadMessages(page: Page, query: string) {
  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search messages' }).fill(query);
}
export async function waitForThreadSearchStatus(page: Page, text: string) {
  await expect(page.getByTestId('thread-search-status')).toHaveText(text.replace(' of ', ' / '));
}
export async function openPreviousThreadSearchResult(page: Page) {
  await page.getByRole('button', { name: 'Previous search result' }).click();
}
export async function openNextThreadSearchResult(page: Page) {
  await page.getByRole('button', { name: 'Next search result' }).click();
}
export async function waitForThreadSearchFocusedMessage(page: Page, text: string) {
  await expect(page.locator('.message-row.highlighted')).toContainText(text);
}
export async function publishOwnProfile(page: Page, options: { name: string; about?: string }) {
  await navigateInApp(page, '/settings/profile');
  await page.getByLabel('Name', { exact: true }).fill(options.name);
  if (options.about) await page.getByLabel('About', { exact: true }).fill(options.about);
  await page.getByTestId('contact-profile-publish-button').click();
  await expect(page.getByRole('status')).toContainText('published');
}
export async function openProfileRelaysSection(page: Page) {
  await page.getByRole('tab', { name: 'Relays', exact: true }).click();
}
export async function expectPublishedMessageRelayStatus(page: Page, text: string) {
  await expect(
    threadMessage(page, text)
      .getByTestId('message-relay-status')
      .locator('.bubble__status-segment--green, .bubble__status-segment--blue')
      .first(),
  ).toBeVisible();
}
export async function logoutFromSettings(page: Page) {
  await navigateInApp(page, '/settings');
  await page.getByTestId('settings-logout-item').click();
  await page.getByTestId('settings-logout-confirm').click();
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
}
export async function expectBrowserStorageToBeEmpty(page: Page) {
  // SvelteKit recreates navigation bookkeeping; an empty public-profile database can
  // also be opened by the login screen. Assert no account state or stored records.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const databases = await indexedDB.databases();
        const counts = await Promise.all(
          databases.map(
            (info) =>
              new Promise<number>((resolve, reject) => {
                const request = indexedDB.open(info.name!);
                request.onerror = () => reject(request.error);
                request.onsuccess = async () => {
                  const db = request.result;
                  try {
                    const sizes = await Promise.all(
                      [...db.objectStoreNames].map(
                        (name) =>
                          new Promise<number>((done, fail) => {
                            const count = db.transaction(name).objectStore(name).count();
                            count.onsuccess = () => done(count.result);
                            count.onerror = () => fail(count.error);
                          }),
                      ),
                    );
                    resolve(sizes.reduce((sum, value) => sum + value, 0));
                  } finally {
                    db.close();
                  }
                };
              }),
          ),
        );
        return {
          local: Object.keys(localStorage),
          session: Object.keys(sessionStorage).filter(
            (key) =>
              ![
                'sveltekit:history-info',
                'sveltekit:snapshot',
                'sveltekit:navigation-snapshot',
              ].includes(key),
          ),
          records: counts.reduce((sum, value) => sum + value, 0),
        };
      }),
    )
    .toEqual({ local: [], session: [], records: 0 });
}
export async function pauseRelayService(service: string) {
  await controlRelay(service, true);
}
export async function unpauseRelayService(service: string) {
  await controlRelay(service, false);
}
async function controlRelay(service: string, paused: boolean) {
  const { default: WebSocket } = await import('ws');
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(service === 'relay-two' ? E2E_RELAY_URL_TWO : E2E_RELAY_URL);
    socket.on('open', () => socket.send(JSON.stringify(['TEST_CONTROL', paused])));
    socket.on('message', () => {
      socket.close();
      resolve();
    });
    socket.on('error', reject);
  });
}
export async function bootstrapSessionOnPage(page: Page, account: TestAccount) {
  await page.evaluate((relay) => {
    const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
    localStorage.setItem('relays', entries);
    localStorage.setItem('nip65_relays', entries);
  }, E2E_RELAY_URL);
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(account.privateKey);
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await waitForAppBridge(page);
}
export async function openAppRelaysSettings(page: Page) {
  await navigateInApp(page, '/settings/relays');
  await page.getByTestId('settings-relays-app-tab').click();
}
export async function removeRelayFromSettings(page: Page, url: string) {
  const panel = page.getByTestId('settings-relays-app-panel');
  await panel
    .locator('.relay-entry')
    .filter({ hasText: url })
    .getByRole('button', { name: 'Delete relay', exact: true })
    .click();
}
export async function sendMessageAndMeasureOptimisticRender(page: Page, text: string) {
  await page.getByTestId('message-composer-input').fill(text);
  return page.getByTestId('message-send-button').evaluate(async (button, text) => {
    const start = performance.now();
    (button as HTMLButtonElement).click();
    while (performance.now() - start < 1000) {
      if (
        [...document.querySelectorAll('[data-testid="message-bubble"]')].some((el) =>
          el.textContent?.includes(text),
        )
      )
        return performance.now() - start;
      await new Promise(requestAnimationFrame);
    }
    throw new Error('Optimistic message did not render within one second');
  }, text);
}
export async function startDelayedRelayProxy(options: { delayMs: number }) {
  const { startMockRelayProxy } = await import('../../scripts/mock-relay-proxy.cjs');
  return startMockRelayProxy({ listenPort: 7780, targetUrl: E2E_RELAY_URL, ...options });
}
export async function forwardMessage(page: Page, text: string, name: string, _options = {}) {
  await action(page, text, 'Forward');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

export async function confirmGroupBackup(page: Page) {
  const words = await page
    .getByRole('list', { name: 'Recovery words' })
    .locator('strong')
    .allTextContents();
  await page
    .getByRole('checkbox', { name: 'I have saved my recovery words somewhere safe' })
    .check();
  await page.getByRole('button', { name: 'Verify backup', exact: true }).click();
  const inputs = page.getByRole('textbox', { name: /^Word \d+$/ });
  for (let i = 0; i < 3; i++) {
    const input = inputs.nth(i);
    const label = await input.evaluate(
      (el) => (el as HTMLInputElement).labels?.[0]?.textContent || '',
    );
    const number = Number(label.match(/Word (\d+)/)?.[1]);
    await input.fill(words[number - 1]);
  }
}
