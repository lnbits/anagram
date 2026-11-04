import { expect, test, type Browser } from '@playwright/test';

// Exercise cold entry into the *bundled* recovery path. Visiting Auth first or
// using the development server hides cyclic chunk initialization failures.
async function coldSession(
  browser: Browser,
  baseURL: string,
  metadata: Record<string, string>,
  android = false,
) {
  const context = await browser.newContext({
    ...(android
      ? { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/150 Mobile' }
      : {}),
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: Object.entries(metadata).map(([name, value]) => ({ name, value })),
        },
      ],
    },
  });
  const storage = {
    key: null as string | null,
    stopFails: false,
    stops: 0,
    removals: 0,
  };
  await context.exposeFunction(
    '__nativeSessionInvoke',
    async (command: string, args?: { method?: string }) => {
      if (command === 'read_private_key') {
        return storage.key;
      }
      if (command === 'remove_private_key') {
        storage.key = null;
        storage.removals++;
      }
      if (command === 'android_notification_command' && args?.method === 'stop') {
        storage.stops++;
        if (storage.stopFails) throw new Error('Notification shutdown failed');
        return { enabled: false, permission: 'granted', startOnBoot: false };
      }
      return null;
    },
  );
  await context.addInitScript(() => {
    const runtime = window as any;
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = { invoke: runtime.__nativeSessionInvoke };
  });
  const page = await context.newPage();
  return { context, page, storage };
}

for (const pending of [false, true]) {
  test(`production cold restart finishes logout (pending marker: ${pending})`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page, storage } = await coldSession(
      browser,
      baseURL!,
      pending
        ? { 'nostr-chat-pending-logout-cleanup': '1' }
        : { npub: 'a'.repeat(64), 'auth-method': 'nsec' },
    );
    try {
      await page.goto(baseURL!);
      await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
      expect(storage.removals).toBe(1);
      expect(await page.evaluate(() => localStorage.getItem('npub'))).toBeNull();
      expect(
        await page.evaluate(() => localStorage.getItem('nostr-chat-pending-logout-cleanup')),
      ).toBeNull();
      await page.reload();
      await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
      expect(storage.removals).toBe(1);
    } finally {
      await context.close();
    }
  });
}

for (const invalidMetadata of [false, true]) {
  test(`production session recovery requires explicit logout for damaged credentials (metadata: ${invalidMetadata})`, async ({
    browser,
    baseURL,
  }) => {
    const npub = invalidMetadata ? 'damaged' : 'a'.repeat(64);
    const { context, page, storage } = await coldSession(browser, baseURL!, {
      npub,
      'auth-method': 'nsec',
    });
    storage.key = '0'.repeat(63) + '1';
    try {
      await page.goto(baseURL!);
      await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Retry session', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible();
      expect(storage.removals).toBe(0);
      expect(storage.key).not.toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('npub'))).toBe(npub);
      await page.getByRole('button', { name: 'Log out and clear local data', exact: true }).click();
      await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
      expect(storage.key).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('npub'))).toBeNull();
    } finally {
      await context.close();
    }
  });
}

test('production Android restart cannot finish logout until notification keys are removed', async ({
  browser,
  baseURL,
}) => {
  const { context, page, storage } = await coldSession(
    browser,
    baseURL!,
    { 'nostr-chat-pending-logout-cleanup': '1' },
    true,
  );
  storage.stopFails = true;
  try {
    await page.goto(baseURL!);
    await expect(page.getByRole('button', { name: 'Retry logout', exact: true })).toBeVisible();
    expect(storage.stops).toBe(1);
    expect(
      await page.evaluate(() => localStorage.getItem('nostr-chat-pending-logout-cleanup')),
    ).toBe('1');
    await expect(page.getByTestId('auth-open-key-button')).toHaveCount(0);
    storage.stopFails = false;
    await page.reload();
    await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
    expect(storage.stops).toBe(2);
    expect(
      await page.evaluate(() => localStorage.getItem('nostr-chat-pending-logout-cleanup')),
    ).toBeNull();
  } finally {
    await context.close();
  }
});
