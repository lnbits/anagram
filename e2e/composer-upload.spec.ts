import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapUser,
  navigateToChat,
  disposeUsers,
  navigateInApp,
  TEST_ACCOUNTS,
} from './parity/helpers';

const server = 'https://images.example.org';
const image = {
  name: 'avatar.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
};
async function uploads(page: Page, account: string) {
  let count = 0;
  let fail = false;
  let hold: Promise<void> | undefined;
  let release = () => {};
  await page.route(`${server}/**`, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fulfill({ contentType: 'image/png', body: image.buffer });
      return;
    }
    expect(route.request().url()).toBe(`${server}/upload`);
    const headers = route.request().headers();
    const auth = JSON.parse(
      Buffer.from(headers.authorization.slice('Nostr '.length), 'base64').toString(),
    );
    expect(auth.kind).toBe(24242);
    expect(auth.pubkey).toBe(account);
    const number = ++count;
    await hold;
    if (fail) {
      await route.fulfill({ status: 500, body: 'Image upload failed' });
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        url: `${server}/${number}.png`,
        sha256: headers['x-sha-256'],
        size: image.buffer.length,
        type: 'image/png',
      },
    });
  });
  await page.evaluate(async (server) => {
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    await useNostrStore().saveBlossomServerUrl(server);
  }, server);
  return {
    count: () => count,
    fail: (value: boolean) => {
      fail = value;
    },
    hold: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
      hold = undefined;
    },
  };
}

test('private upload can be cancelled and adds its link to a caption draft before sending', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.composerUpload);
  try {
    const { page } = user;
    await navigateToChat(page, user.session.publicKey);
    const input = page.getByTestId('message-composer-input');
    const rows = page.getByTestId('message-bubble');
    const upload = await uploads(page, user.session.publicKey);
    await input.fill('My caption');
    upload.hold();
    await page.locator('input[type="file"]').setInputFiles(image);
    const dialog = page.getByRole('dialog', { name: 'upload', exact: true });
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect.poll(upload.count).toBe(1);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    upload.release();
    await expect(input).toHaveValue('My caption');
    await expect(rows).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles(image);
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(input).toHaveValue('My caption\nhttps://images.example.org/2.png');
    await expect(rows).toHaveCount(0);
    await input.fill('My finished caption\nhttps://images.example.org/2.png');
    await page.getByTestId('message-send-button').click();
    await expect(rows).toContainText('My finished caption');
    await expect(rows.locator('img[src="https://images.example.org/2.png"]')).toBeVisible();
    await expect(input).toHaveValue('');
  } finally {
    await disposeUsers(user);
  }
});
