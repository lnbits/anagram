// Ports original auth behavior. History selection is intentionally replaced with unlimited hydration.
import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { finishOnboarding } from '../auth-helpers';
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
        await page.getByTestId('auth-open-login-button').click();
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
      await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
      await expectBrowserStorageToBeEmpty(page);
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
    await page.getByTestId('auth-open-login-button').click();
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
    await test
      .info()
      .attach('extension-diagnostics', {
        body: JSON.stringify(
          await page.evaluate(async () => window.__appE2E__!.getDeveloperDiagnosticsSnapshot()),
        ),
        contentType: 'application/json',
      });
    await test
      .info()
      .attach('recipient-diagnostics', {
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
