import { expect, test, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

async function emulateIos(page: Page, userAgent: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        // Mock only the OS Keychain boundary, retaining the real login flow.
        if (command === 'read_private_key') return sessionStorage.getItem('test-native-key');
        if (command === 'write_private_key')
          sessionStorage.setItem('test-native-key', args.privateKeyHex);
        if (command === 'remove_private_key') sessionStorage.removeItem('test-native-key');
        return null;
      },
    };
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  }, userAgent);
}

for (const userAgent of ['iPhone', 'Macintosh']) {
  test(`native ${userAgent} keeps login, chat and dialogs above system insets and keyboard`, async ({
    page,
  }) => {
    await emulateIos(page, userAgent);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/ios-app/);
    // Browser automation has no physical notch. Supply its CSS dimensions,
    // then exercise the same visualViewport events WKWebView sends.
    await page.addStyleTag({
      content:
        'html.ios-app { --app-safe-top: calc(var(--ios-viewport-top) + 47px); --app-safe-bottom: 34px; }',
    });
    await expect(page.locator('.app-viewport')).toHaveCSS('height', '763px');
    await page.getByTestId('auth-open-key-button').click();
    const keyInput = page.getByTestId('auth-private-key-input');
    expect(
      parseFloat(await keyInput.evaluate((node) => getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await keyInput.fill(nip19.nsecEncode(generateSecretKey()));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await expect(page.getByTestId('auth-notifications-skip')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveCSS('height', '763px');
    const shell = (await page.locator('.app-shell').boundingBox())!;
    expect(shell.y).toBe(47);

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    const contactPubkey = getPublicKey(generateSecretKey());
    await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(contactPubkey));
    await page.getByLabel('Name (optional)').fill('iPhone contact');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page.getByTestId('chat-thread')).toHaveAttribute(
      'data-chat-public-key',
      contactPubkey,
    );
    const composer = page.getByTestId('message-composer-input');
    await expect(composer).toBeVisible();
    await composer.fill('Keyboard draft');
    await page.addStyleTag({
      content:
        'html.ios-app { --app-safe-bottom: calc(var(--ios-layout-height) - var(--ios-viewport-height) - var(--ios-viewport-top) + var(--ios-bottom-inset)); }',
    });
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 500, offsetTop: 10 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '453px');
    const visible = (await composer.boundingBox())!;
    expect(visible.y).toBeGreaterThanOrEqual(57);
    expect(visible.y + visible.height).toBeLessThanOrEqual(510);
    await expect(composer).toHaveValue('Keyboard draft');
    await page.getByTestId('message-send-button').click();
    const message = page.getByTestId('message-bubble').filter({ hasText: 'Keyboard draft' });
    await expect(message).toBeVisible();
    await message.locator('.message-content').click({ button: 'right' });
    const menu = page.getByTestId('message-context-menu');
    await expect(menu).toBeVisible();
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.y).toBeGreaterThanOrEqual(57);
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(510);
    await page.keyboard.press('Escape');

    // Native top-layer dialogs live outside the route's scrolling ancestor.
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal';
      dialog.dataset.testid = 'ios-dialog-probe';
      dialog.innerHTML = '<div style="height:900px">Scrollable dialog content</div>';
      document.body.append(dialog);
      dialog.showModal();
    });
    const dialog = (await page.getByTestId('ios-dialog-probe').boundingBox())!;
    expect(dialog.y).toBeGreaterThanOrEqual(57);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(510);
    await page.evaluate(() => document.querySelector('[data-testid="ios-dialog-probe"]')?.remove());
    await page.setViewportSize({ width: 844, height: 390 });
    await page.addStyleTag({
      content:
        'html.ios-app { --app-safe-top: 0px; --app-safe-bottom: 21px; --app-safe-left: 47px; --app-safe-right: 47px; }',
    });
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 390, offsetTop: 0 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('.app-shell')).toHaveCSS('height', '369px');
    const landscape = (await page.locator('.app-viewport').boundingBox())!;
    expect(landscape.x).toBe(47);
    expect(landscape.width).toBe(750);
    await page.evaluate(async () => {
      const { useCallStore } = await import('/src/stores/callStore.ts');
      const call = useCallStore();
      // Layout only; this does not simulate native capture or an Iroh connection.
      call.session = {
        id: 'ios-layout',
        peerPubkey: 'a'.repeat(64),
        peerName: 'Caller',
        direction: 'incoming',
        mode: 'audio',
        phase: 'incoming',
        startedAt: null,
        microphoneMuted: false,
        cameraMuted: true,
        mediaVersion: 2,
      } as any;
    });
    await expect(page.getByTestId('call-panel')).toBeVisible();
    const call = (await page.getByTestId('call-panel').boundingBox())!;
    expect(call.x).toBe(47);
    expect(call.width).toBe(750);
    expect(call.y + call.height).toBeLessThanOrEqual(369);
    await expect(page.getByTestId('call-remote-audio')).toHaveJSProperty(
      'disableRemotePlayback',
      true,
    );
    await page.evaluate(async () => {
      const { useCallStore } = await import('/src/stores/callStore.ts');
      useCallStore().session = null;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings/notifications');
    await expect(page.getByTestId('ios-notifications-info')).toContainText('Keep Anagram open');
    await expect(page.getByTestId('settings-notifications-toggle')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('Safari and native Android retain their existing viewport handling', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  });
  await page.goto('/');
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/ios-app/);
  await expect(page.locator('.app-viewport')).toHaveCount(0);
  await page.evaluate(async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' });
    (window as any).isTauri = true;
    const { iosViewport } = await import('/src/lib/actions/iosViewport.ts');
    iosViewport(document.createElement('div'));
  });
  await expect(page.locator('html')).not.toHaveClass(/ios-app/);
});
