// Ports original auth behavior. History selection is intentionally replaced with unlimited hydration.
import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { finishOnboarding } from '../auth-helpers';
import { DEFAULT_RELAYS } from '../../src/constants/relays';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  openRequests,
  acceptFirstRequest,
  navigateToChat,
  waitForThreadMessage,
  logoutFromSettings,
  expectBrowserStorageToBeEmpty,
  waitForAppBridge,
} from './helpers';
import { installExtension, seedAuth, startBunker } from './signer-fixtures';

test('logout stays responsive during stalled storage cleanup and resumes after reload', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.logoutRecovery);
  try {
    await user.page.evaluate(() => {
      const remove = indexedDB.deleteDatabase.bind(indexedDB);
      indexedDB.deleteDatabase = (name: string) => {
        const request = remove(name);
        // Delete the data but withhold completion, as a stuck storage backend
        // would. Reload restores the real API and must resume pending cleanup.
        return {
          set onsuccess(_callback: unknown) {},
          set onerror(callback: IDBOpenDBRequest['onerror']) {
            request.onerror = callback;
          },
          set onblocked(callback: IDBOpenDBRequest['onblocked']) {
            request.onblocked = callback;
          },
          get error() {
            return request.error;
          },
        } as IDBOpenDBRequest;
      };
    });
    await user.page.getByRole('button', { name: 'settings', exact: true }).click();
    await user.page.getByTestId('settings-logout-item').click();
    await user.page.getByTestId('settings-logout-confirm').click();
    await expect(user.page.getByRole('button', { name: 'Retry logout' })).toBeVisible({
      timeout: 12000,
    });
    await expect(user.page.getByTestId('auth-login-button')).toHaveCount(0);
    expect(await user.page.evaluate(() => localStorage.getItem('npub'))).toBeNull();
    expect(
      await user.page.evaluate(() => localStorage.getItem('nostr-chat-pending-logout-cleanup')),
    ).toBe('1');
    await user.page.reload();
    await expect(user.page.getByTestId('auth-open-key-button')).toBeVisible();
    expect(
      await user.page.evaluate(() => localStorage.getItem('nostr-chat-pending-logout-cleanup')),
    ).toBeNull();
  } finally {
    await disposeUsers(user);
  }
});
test('onboarding has no history restriction and logout clears either generated or supplied keys', async ({
  browser,
}) => {
  for (const generated of [false, true]) {
    const context = await browser.newContext();
    await seedAuth(context);
    const page = await context.newPage();
    try {
      await page.goto('/');
      if (generated) {
        await page.getByRole('button', { name: 'Create Account', exact: true }).click();
        await page.getByRole('button', { name: 'Login Now', exact: true }).click();
      } else {
        await page.getByTestId('auth-open-key-button').click();
        await page
          .getByTestId('auth-private-key-input')
          .fill(Buffer.from(generateSecretKey()).toString('hex'));
        await page.getByTestId('auth-login-button').click();
      }
      await page.getByTestId('auth-onboarding-relays-next-button').click();
      await expect(page.getByTestId('auth-onboarding-profile-start-button')).toBeVisible();
      await expect(page.getByRole('slider')).toHaveCount(0);
      await expect(page.getByText('Restore message history', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeVisible();
      await page.getByTestId('auth-onboarding-logout-button').click();
      await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
      await expectBrowserStorageToBeEmpty(page);
      // Starting again without a page reload must initialize a fresh relay list.
      await page.getByRole('button', { name: 'Create Account', exact: true }).click();
      await page.getByRole('button', { name: 'Login Now', exact: true }).click();
      await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeVisible();
      await expect(page.getByTestId('auth-onboarding-relay-input')).toBeHidden();
      await page.getByText('Edit relays', { exact: true }).click();
      await expect(page.getByTestId('auth-onboarding-relay-input')).toBeVisible();
      for (const relay of DEFAULT_RELAYS)
        await expect(page.locator('.onboarding .relay').filter({ hasText: relay })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});
test('bunker query negotiates a remote signer and removes the connection URL', async ({
  browser,
}) => {
  const bunker = await startBunker(),
    context = await browser.newContext();
  await seedAuth(context);
  const page = await context.newPage();
  try {
    await page.goto(`/?bunker=${encodeURIComponent(bunker.bunkerUrl)}`);
    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeVisible({
      timeout: 30000,
    });
    await expect(page).not.toHaveURL(/bunker=/);
    await finishOnboarding(page);
    await waitForAppBridge(page);
    expect((await page.evaluate(() => window.__appE2E__!.getSessionSnapshot())).publicKey).toBe(
      bunker.publicKey,
    );
    expect(await page.evaluate(() => localStorage.getItem('auth-method'))).toBe('nip46');
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  } finally {
    await context.close();
    bunker.stop();
  }
});
test('invalid bunker query leaves a retryable signer form', async ({ browser }) => {
  const context = await browser.newContext();
  await seedAuth(context);
  const page = await context.newPage();
  try {
    await page.goto('/?bunker=invalid-bunker');
    await expect(page.getByTestId('auth-remote-signer-bunker-input')).toHaveValue('invalid-bunker');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).not.toHaveURL(/bunker=/);
  } finally {
    await context.close();
  }
});
test('signed-in account ignores bunker query without switching identity', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.ignoreBunker);
  try {
    await user.page.goto('/chats?bunker=invalid');
    await expect(user.page.getByText('A user is already logged in.')).toBeVisible();
    await expect(user.page).not.toHaveURL(/bunker=/);
    await waitForAppBridge(user.page);
    expect(
      (await user.page.evaluate(() => window.__appE2E__!.getSessionSnapshot())).publicKey,
    ).toBe(user.session.publicKey);
  } finally {
    await disposeUsers(user);
  }
});
test('NIP-07 login exchanges encrypted DMs and survives reload without storing the signer key', async ({
  browser,
}) => {
  const secret = generateSecretKey(),
    pubkey = getPublicKey(secret),
    context = await browser.newContext();
  await seedAuth(context);
  await installExtension(context, secret);
  const page = await context.newPage();
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.extensionBob);
  page.on('dialog', (d) => d.accept());
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Login with Extension', exact: true }).click();
    await finishOnboarding(page);
    await waitForAppBridge(page);
    await openDirectChatFromIdentifier(page, bob.session.publicKey, 'Extension Bob');
    await sendMessage(page, 'Extension opening');
    await openRequests(bob.page);
    await acceptFirstRequest(bob.page);
    await navigateToChat(bob.page, pubkey);
    await sendMessage(bob.page, 'Extension reply');
    await waitForThreadMessage(page, 'Extension reply');
    await page.reload();
    await waitForThreadMessage(page, 'Extension reply');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
      Buffer.from(secret).toString('hex'),
    );
    await logoutFromSettings(page);
    await expectBrowserStorageToBeEmpty(page);
  } catch (error) {
    await test.info().attach('extension-diagnostics', {
      body: JSON.stringify(
        await page.evaluate(async () => window.__appE2E__!.getDeveloperDiagnosticsSnapshot()),
      ),
      contentType: 'application/json',
    });
    await test.info().attach('recipient-diagnostics', {
      body: JSON.stringify(
        await bob.page.evaluate(async () => window.__appE2E__!.getDeveloperDiagnosticsSnapshot()),
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await context.close();
    await disposeUsers(bob);
  }
});
