import { expect, test, type Page } from '@playwright/test';
import { generateSecretKey } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

async function nativeSession(page: Page) {
  const storage = {
    key: null as string | null,
    unavailable: false,
    readBarrier: undefined as Promise<void> | undefined,
    reads: 0,
    shellMounts: 0,
  };
  await page.exposeFunction('__recordNativeShellMount', () => {
    storage.shellMounts += 1;
  });
  await page.exposeFunction(
    '__nativeSessionInvoke',
    async (command: string, args?: { privateKeyHex: string }) => {
      if (command === 'read_private_key') {
        storage.reads += 1;
        const key = storage.key;
        await storage.readBarrier;
        if (storage.unavailable) throw new Error('Credential storage temporarily unavailable');
        return key;
      }
      if (command === 'write_private_key') storage.key = args!.privateKeyHex;
      if (command === 'remove_private_key') storage.key = null;
      return null;
    },
  );
  await page.addInitScript(() => {
    const runtime = window as any;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: runtime.__nativeSessionInvoke };
    let shellMounted = false;
    new MutationObserver(() => {
      if (!shellMounted && document.querySelector('.app-shell')) {
        shellMounted = true;
        void runtime.__recordNativeShellMount();
      }
    }).observe(document, { childList: true, subtree: true });
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
  await page.goto('/');
  await page.getByTestId('auth-open-key-button').click();
  await page
    .getByTestId('auth-private-key-input')
    .fill(Buffer.from(generateSecretKey()).toString('hex'));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => storage.shellMounts).toBe(1);
  expect(storage.key).not.toBeNull();
  return storage;
}

test('native restart rejects stale account metadata after logout without mounting the signed-in shell', async ({
  page,
}) => {
  const storage = await nativeSession(page);
  const pubkey = await page.evaluate(() => localStorage.getItem('npub'));
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-logout-item').click();
  await page.getByTestId('settings-logout-confirm').click();
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
  expect(storage.key).toBeNull();
  // Simulate a WebView restoring stale localStorage after a hard process exit.
  // The OS credential has already been deleted by the real logout flow.
  await page.evaluate((pubkey) => {
    localStorage.setItem('npub', pubkey!);
    localStorage.setItem('auth-method', 'nsec');
  }, pubkey);
  storage.shellMounts = 0;
  await page.reload();
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
  expect(storage.shellMounts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBeNull();
  await page.reload();
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
});

test('native restart preserves a valid session and retries credential read failures without logging out', async ({
  page,
}) => {
  const storage = await nativeSession(page);
  const key = storage.key;
  const pubkey = await page.evaluate(() => localStorage.getItem('npub'));
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => storage.shellMounts).toBe(2);
  storage.shellMounts = 0;
  storage.unavailable = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry session' })).toBeVisible();
  expect(storage.shellMounts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBe(pubkey);
  expect(storage.key).toBe(key);
  storage.unavailable = false;
  await page.getByRole('button', { name: 'Retry session' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBe(pubkey);
});

test('retry logout releases a blocked database without reopening the account', async ({ page }) => {
  const storage = await nativeSession(page);
  await page.evaluate(async () => {
    // A lingering handle cannot be released by repeating deleteDatabase in the same document.
    (window as any).__logoutBlocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('anagram-logout-blocked-test', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-logout-item').click();
  await page.getByTestId('settings-logout-confirm').click();
  await expect(page.getByRole('button', { name: 'Retry logout' })).toBeVisible();
  expect(storage.key).toBeNull();
  storage.shellMounts = 0;
  await page.getByRole('button', { name: 'Retry logout' }).click();
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
  expect(storage.shellMounts).toBe(0);
  expect(
    await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name)),
  ).not.toContain('anagram-logout-blocked-test');
});

test('a slow native credential read stays retryable without queueing more reads', async ({
  page,
}) => {
  const storage = await nativeSession(page);
  let release!: () => void;
  storage.readBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  storage.reads = 0;
  storage.shellMounts = 0;
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Retry session' })).toBeVisible({
      timeout: 12000,
    });
    expect(storage.reads).toBe(1);
    await page.getByRole('button', { name: 'Retry session' }).click();
    await expect(page.getByText('Opening account…', { exact: true })).toBeVisible();
    expect(storage.reads).toBe(1);
    expect(storage.shellMounts).toBe(0);
    release();
    await expect(page.locator('.app-shell')).toBeVisible();
  } finally {
    release();
  }
});

test('stale account metadata never deletes a different saved credential', async ({ page }) => {
  const storage = await nativeSession(page);
  const originalKey = storage.key;
  const pubkey = await page.evaluate(() => localStorage.getItem('npub'));
  const otherKey = Buffer.from(generateSecretKey()).toString('hex');
  storage.key = otherKey;
  storage.shellMounts = 0;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry session' })).toBeVisible();
  expect(storage.shellMounts).toBe(0);
  expect(storage.key).toBe(otherKey);
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBe(pubkey);
  storage.key = originalKey;
  await page.getByRole('button', { name: 'Retry session' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('logout during session restoration prevents a late credential read reopening the account', async ({
  page,
}) => {
  const storage = await nativeSession(page);
  let release!: () => void;
  storage.readBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  storage.reads = 0;
  storage.shellMounts = 0;
  try {
    await page.reload();
    await expect.poll(() => storage.reads).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('anagram-logout')));
    await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
    expect(storage.key).toBeNull();
    release();
    await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
    expect(storage.shellMounts).toBe(0);
  } finally {
    release();
  }
});
