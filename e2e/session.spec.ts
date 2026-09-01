import { expect, test } from '@playwright/test';
import {
  bootstrapSessionOnPage,
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectBrowserStorageToBeEmpty,
  expectNoUnexpectedBrowserErrors,
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
    await expect(alice.page.getByTestId('chat-item')).toHaveCount(1);
    await expect(alice.page.getByText(TEST_ACCOUNTS.isolationBob.displayName)).toBeVisible();

    await logoutFromSettings(alice.page);
    await expectBrowserStorageToBeEmpty(alice.page);
    await bootstrapSessionOnPage(alice.page, TEST_ACCOUNTS.isolationCharlie);

    await alice.page.goto('/#/chats');
    await expect(alice.page.getByTestId('chat-item')).toHaveCount(0);
    await expect(alice.page.getByText(TEST_ACCOUNTS.isolationBob.displayName)).toHaveCount(0);
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

  try {
    await alice.page.goto('/#/settings/profile');
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
    await expect(serverInput).toHaveValue(customServerUrl);

    await Promise.all([
      alice.page.waitForEvent('load', { timeout: 30_000 }),
      logoutFromSettings(alice.page),
    ]);
    await expectBrowserStorageToBeEmpty(alice.page);
    await bootstrapSessionOnPage(alice.page, TEST_ACCOUNTS.mediaSettingsAlice);
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
      ],
    });
  } finally {
    await disposeUsers(alice);
  }
});
