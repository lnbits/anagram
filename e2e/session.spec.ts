import { expect, test } from '@playwright/test';
import {
  bootstrapSessionOnPage,
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectBrowserStorageToBeEmpty,
  expectNoUnexpectedBrowserErrors,
  getDeveloperDiagnosticsSnapshot,
  logoutFromSettings,
  reloadAndWaitForApp,
  TEST_ACCOUNTS,
} from './helpers';

test.describe.configure({ mode: 'serial' });

test('logout and logging in as another user does not leak prior chat state', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.isolationAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.isolationBob);

  try {
    await establishAcceptedDirectChat(alice, bob);

    await alice.page.goto('/#/chats');
    const bobChat = alice.page.locator(
      `[data-testid="chat-item"][data-chat-public-key="${bob.session.publicKey}"]`
    );
    await expect(alice.page.getByTestId('chat-item')).toHaveCount(1);
    await expect(bobChat).toHaveCount(1);

    await logoutFromSettings(alice.page);
    await expectBrowserStorageToBeEmpty(alice.page);
    await bootstrapSessionOnPage(alice.page, TEST_ACCOUNTS.isolationCharlie);

    await alice.page.goto('/#/chats');
    await expect(alice.page.getByTestId('chat-item')).toHaveCount(0);
    await expect(bobChat).toHaveCount(0);
    await expect(alice.page.getByTestId('requests-row')).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('Blossom server preference is encrypted, restored, and shown in Settings order', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mediaSettingsAlice);
  const customServerUrl = 'https://media.example.com';
  const defaultServerUrl = 'https://blossom.nostr.build';
  const waitForSessionReady = async () => {
    // A rendered Settings input does not mean the background session restore has
    // finished. Logging out during that restore tears down its message listener.
    await expect
      .poll(
        async () => {
          const snapshot = await getDeveloperDiagnosticsSnapshot(alice.page);
          const healing = await alice.page.evaluate(
            async () => (await window.__appE2E__?.isReconnectHealing()) ?? true
          );
          return {
            restoring: snapshot.session.isRestoringStartupState,
            listening: snapshot.privateMessagesSubscription.active,
            receivedEose: Boolean(snapshot.privateMessagesSubscription.lastEoseAt),
            healing,
          };
        },
        { timeout: 30_000, message: 'Session startup and relay subscriptions are ready' }
      )
      .toEqual({ restoring: false, listening: true, receivedEose: true, healing: false });
  };

  try {
    await waitForSessionReady();
    await alice.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(alice.page).toHaveURL(/#\/settings\/profile$/);
    await expect(alice.page.locator('.settings-menu__item .q-item__label')).toHaveText([
      'Profile',
      'Relays',
      'Notifications',
      'Media & Data Storage',
      'Appearance',
      'Languages',
      'Developer',
      'Log Out',
    ]);

    await alice.page.getByTestId('settings-media-data-storage-item').click();
    const serverInput = alice.page.getByTestId('settings-blossom-server-input');
    await expect(alice.page).toHaveURL(/#\/settings\/media-data-storage$/);
    await expect(serverInput).toHaveValue(defaultServerUrl);

    await serverInput.fill(`${customServerUrl}/`);
    await alice.page.getByTestId('settings-blossom-save').click();
    await expect(alice.page.getByText('Blossom server saved.', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(serverInput).toHaveValue(customServerUrl);

    await reloadAndWaitForApp(alice.page);
    await waitForSessionReady();
    await expect(serverInput).toHaveValue(customServerUrl);

    await Promise.all([
      alice.page.waitForEvent('load', { timeout: 30_000 }),
      logoutFromSettings(alice.page),
    ]);
    await expectBrowserStorageToBeEmpty(alice.page);
    await bootstrapSessionOnPage(alice.page, TEST_ACCOUNTS.mediaSettingsAlice);
    await waitForSessionReady();
    await alice.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await alice.page.getByTestId('settings-media-data-storage-item').click();
    await expect(alice.page).toHaveURL(/#\/settings\/media-data-storage$/);
    await expect(serverInput).toHaveValue(customServerUrl);

    await alice.page.getByTestId('settings-blossom-restore-default').click();
    await expect(alice.page.getByText('Blossom server saved.', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(serverInput).toHaveValue(defaultServerUrl);
    await expectNoUnexpectedBrowserErrors([alice], {
      allowPatterns: [
        /Failed to run (?:chat checks|post-DM EOSE checks).*database connection is closing\./,
        /Failed to process my relay list event.*database connection is closing\./,
      ],
    });
  } finally {
    await disposeUsers(alice);
  }
});
