import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateInApp,
} from './parity/helpers';
test('existing image paste opens upload confirmation in private and public chats', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.ExistingClipboard);
  const { page, context } = user;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDirectChatFromIdentifier(page, user.session.npub, 'My Self');
    // The encryption notice is dismissed, but pasted media still needs explicit confirmation,
    // and cancelling it uploads nothing.
    await page.evaluate(() => localStorage.setItem('ui-private-media-notice-dismissed', '1'));
    let uploadRequests = 0;
    await page.route('**/upload', async (route) => {
      uploadRequests += 1;
      await route.abort();
    });
    async function pasteImage() {
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 4;
        canvas.getContext('2d')!.fillRect(0, 0, 4, 4);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((blob) => resolve(blob!), 'image/png'),
        );
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
      const input = page.getByTestId('message-composer-input');
      await input.fill('Draft kept while pasting');
      await input.press('ControlOrMeta+v');
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
      await expect(dialog).toContainText('image.png');
      await expect(page.getByTestId('composer-media-notice')).toHaveCount(0);
      await expect(input).toHaveValue('Draft kept while pasting');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await pasteImage();
    await page.waitForTimeout(500);
    expect(uploadRequests).toBe(0);
    await expect(page.getByTestId('message-bubble')).toHaveCount(0);
    await navigateInApp(page, '/chats');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New public group' });
    await dialog.getByLabel('Group name', { exact: true }).fill('Existing clipboard check');
    await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
    await pasteImage();
    await page.evaluate(() => navigator.clipboard.writeText(' plain text'));
    const input = page.getByTestId('message-composer-input');
    await input.press('ControlOrMeta+v');
    await expect(input).toHaveValue('Draft kept while pasting plain text');
    expect(user.browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Linux native fallback opens the existing confirmation without sending', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.NativeClipboard);
  const { page, context } = user;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const png = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), 'image/png'),
      );
      const bytes = await png.arrayBuffer();
      // Simulate Linux IPC only. This verifies the frontend wiring, not GTK itself.
      Object.defineProperty(navigator, 'userAgent', { value: 'Linux', configurable: true });
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            if (command !== 'read_clipboard_image') throw new Error(`Unexpected IPC: ${command}`);
            return bytes;
          },
        },
      });
      await navigator.clipboard.writeText('');
    });
    await openDirectChatFromIdentifier(page, user.session.npub, 'My Self');
    let uploadRequests = 0;
    await page.route('**/upload', async (route) => {
      uploadRequests += 1;
      await route.abort();
    });
    const input = page.getByTestId('message-composer-input');
    await input.fill('Native caption');
    await input.press('ControlOrMeta+v');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    await expect(dialog).toContainText('image.png');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(input).toHaveValue('Native caption');
    await expect(page.getByTestId('message-bubble')).toHaveCount(0);
    expect(uploadRequests).toBe(0);
    await page.evaluate(() => navigator.clipboard.writeText(' plus text'));
    await input.press('ControlOrMeta+v');
    await expect(input).toHaveValue('Native caption plus text');
    await expect(dialog).toHaveCount(0);
    expect(user.browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('confirmed pasted media is sent encrypted as kind 15 even with the notice dismissed', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.PasteEncryptedSend);
  const { page, context } = user;
  const server = 'https://paste-media.example.org';
  const bodies: Buffer[] = [];
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route(`${server}/**`, async (route) => {
      const request = route.request();
      if (request.method() !== 'PUT') {
        const body = bodies[Number(new URL(request.url()).pathname.slice(1)) - 1];
        await route.fulfill(
          body
            ? { contentType: 'application/octet-stream', body }
            : { status: 404, body: 'Not found' },
        );
        return;
      }
      expect(request.headers()['content-type']).toBe('application/octet-stream');
      bodies.push(request.postDataBuffer()!);
      await route.fulfill({
        status: 201,
        json: {
          url: `${server}/${bodies.length}`,
          sha256: request.headers()['x-sha-256'],
          size: bodies.at(-1)!.length,
          type: 'application/octet-stream',
        },
      });
    });
    await openDirectChatFromIdentifier(page, user.session.npub, 'My Self');
    await page.evaluate(async (server) => {
      localStorage.setItem('ui-private-media-notice-dismissed', '1');
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      await useNostrStore().savePrivateMediaBlossomServerUrl(server);
    }, server);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      canvas.getContext('2d')!.fillRect(0, 0, 4, 4);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), 'image/png'),
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    const input = page.getByTestId('message-composer-input');
    await input.fill('Pasted caption');
    await input.press('ControlOrMeta+v');
    const dialog = page.getByRole('dialog', { name: 'upload', exact: true });
    await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    expect(bodies).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const rows = page.getByTestId('message-bubble');
    await expect(rows).toHaveCount(1);
    await expect(rows.getByTestId('message-encrypted-image')).toBeVisible({ timeout: 30_000 });
    expect(bodies).toHaveLength(1);
    await expect(input).toHaveValue('Pasted caption');
    await expect(rows).not.toContainText('Pasted caption');
    expect(user.browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
