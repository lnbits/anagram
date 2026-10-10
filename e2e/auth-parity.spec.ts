import { test, expect } from '@playwright/test';
import { finishOnboarding } from './auth-helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
});

test('registration downloads the secret without rendering it and continues through onboarding', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: /Creating account/i })).toBeVisible();
  const downloadButton = page.getByRole('button', { name: 'Download Account Secret', exact: true });
  await expect(downloadButton).toBeVisible();
  expect((await page.locator('body').innerText()).includes('nsec1')).toBe(false);
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe('anagram-account-secret.txt');
  await page.getByRole('button', { name: 'Login Now', exact: true }).click();
  await finishOnboarding(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('signer tabs, pairing QR, cancellation and key warning match the original flow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await expect(page.getByRole('button', { name: 'Login with Extension', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Login with Remote Signer', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Bunker URL', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Nostr Connect', exact: true }).click();
  await page.getByTestId('auth-remote-signer-relay-input').fill('ws://127.0.0.1:7777/');
  await page.getByTestId('auth-remote-signer-create-nostrconnect-button').click();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-qr')).toBeVisible();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-uri')).toHaveValue(
    /^nostrconnect:\/\//,
  );
  await page.getByTestId('auth-remote-signer-cancel-button').click();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-qr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('auth-open-key-button').click();
  await expect(page.locator('.key-warning')).toBeVisible();
  await expect(page.getByTestId('auth-private-key-input')).toHaveAttribute('type', 'password');
});

test('startup progress updates without blocking the inbox and keeps private errors out of the UI', async ({
  browser,
}) => {
  const { bootstrapUser, TEST_ACCOUNTS } = await import('./parity/helpers');
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.StartupProgress);
  const page = user.page;
  try {
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useNostrStore } = await import('/src/stores/nostrStore.ts');
          const nostr = useNostrStore();
          return (
            nostr.isRestoringStartupState ||
            nostr.startupSteps.some((step) => step.status === 'in_progress')
          );
        }),
      )
      .toBe(false);
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      const nostr = useNostrStore();
      nostr.startupSteps = nostr.startupSteps.map((step) => ({
        ...step,
        status: step.id === 'message-history-restore' ? 'in_progress' : 'success',
        internalTasks: [],
      }));
      const failed = nostr.startupSteps.find((step) => step.id === 'my-relays-restore')!;
      failed.status = 'error';
      failed.errorMessage = 'PRIVATE_SIGNER_ERROR_SENTINEL';
    });
    const progress = page.getByTestId('history-sync-status').getByRole('status');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Restore message history');
    await page.getByRole('button', { name: 'Show startup history', exact: true }).click();
    await expect(page.locator('#startup-history-details')).toContainText('Failed');
    await expect(page.locator('#startup-history-details')).not.toContainText(
      'PRIVATE_SIGNER_ERROR_SENTINEL',
    );
    await page.getByRole('button', { name: 'contacts', exact: true }).click();
    await expect(page.getByTestId('contact-list-search')).toBeVisible();
    await expect(progress).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(progress).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `/tmp/anagram-startup-${width}.png` });
    }
    await page.getByRole('button', { name: 'Hide startup history', exact: true }).click();
    await expect(page.locator('#startup-history-details')).toHaveCount(0);
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      const step = useNostrStore().startupSteps.find(
        (step) => step.id === 'message-history-restore',
      )!;
      step.status = 'success';
    });
    await expect(progress).toHaveText('Startup History');
    const detailsButton = page.getByRole('button', { name: 'Show startup history', exact: true });
    await expect(detailsButton).toBeVisible();
    await detailsButton.click();
    await expect(page.locator('#startup-history-details')).toBeVisible();
    await expect(page.locator('#startup-history-details')).toContainText('Restore message history');
    await expect(page.locator('#startup-history-details')).not.toContainText(
      'PRIVATE_SIGNER_ERROR_SENTINEL',
    );
  } finally {
    await user.context.close();
  }
});
