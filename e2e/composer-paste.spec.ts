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
    // Pasted media needs explicit confirmation, and cancelling it uploads nothing.
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
      await expect(input).toHaveValue('Draft kept while pasting');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await pasteImage();
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
    // Checked again after the public group paste, so a delayed private upload would show.
    expect(uploadRequests).toBe(0);
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
    await input.press('Control+v');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    await expect(dialog).toContainText('image.png');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(input).toHaveValue('Native caption');
    await expect(page.getByTestId('message-bubble')).toHaveCount(0);
    expect(uploadRequests).toBe(0);
    await page.evaluate(() => navigator.clipboard.writeText(' plus text'));
    await input.press('Control+v');
    await expect(input).toHaveValue('Native caption plus text');
    await expect(dialog).toHaveCount(0);
    expect(user.browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
