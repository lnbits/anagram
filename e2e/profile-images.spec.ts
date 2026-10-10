import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapUser,
  createGroup,
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

test('profile pictures and banners upload to the configured Blossom server and publish normally', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.profileImageOwner);
  const { page } = owner;
  try {
    const upload = await uploads(page, owner.session.publicKey);
    await navigateInApp(page, '/settings/profile');
    const picture = page.getByTestId('profile-picture');
    const publish = page.getByTestId('contact-profile-publish-button');
    await picture.fill('https://images.example.org/original.png');
    await page
      .getByLabel('Choose picture', { exact: true })
      .setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
    await expect(page.getByRole('alert')).toContainText('Choose an image');
    expect(upload.count()).toBe(0);
    upload.fail(true);
    await page.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect(page.getByRole('alert')).toContainText('Image upload failed');
    await expect(picture).toHaveValue('https://images.example.org/original.png');
    upload.fail(false);
    upload.hold();
    await page.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect.poll(upload.count).toBe(2);
    await expect(publish).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
    upload.release();
    await expect(publish).toBeEnabled();
    await expect(picture).toHaveValue('https://images.example.org/original.png');
    // Reusing the same file through the visible upload button must work.
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload picture', exact: true }).click();
    await (await choosing).setFiles(image);
    await expect(picture).toHaveValue(`${server}/3.png`);
    await page.getByText('Extra Metadata Fields (NIP-24)', { exact: true }).click();
    await page.getByLabel('Choose banner', { exact: true }).setInputFiles(image);
    await expect(page.getByTestId('profile-banner')).toHaveValue(`${server}/4.png`);
    // Contact hydration must not overwrite an uploaded draft before publication.
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      const nostr = useNostrStore();
      await nostr.refreshContactByPublicKey(nostr.getLoggedInPublicKeyHex()!);
    });
    await expect(picture).toHaveValue(`${server}/3.png`);
    await publish.click();
    await expect(page.getByRole('status')).toContainText('Profile metadata published.');
    await page.reload();
    await expect(picture).toHaveValue(`${server}/3.png`);
    await page.getByText('Extra Metadata Fields (NIP-24)', { exact: true }).click();
    await expect(page.getByTestId('profile-banner')).toHaveValue(`${server}/4.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Upload picture', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath('profile-image-mobile.png') });
  } finally {
    await disposeUsers(owner);
  }
});

test('private group picture and banner uploads survive saving and reload', async ({ browser }) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.privateImageOwner);
  try {
    await uploads(owner.page, owner.session.publicKey);
    await createGroup(owner.page, { name: 'Private picture group', about: '' });
    const details = owner.page.getByTestId('group-details');
    await details.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect(details.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/1.png`);
    await details.getByText('More profile fields', { exact: true }).click();
    await details.getByLabel('Choose banner', { exact: true }).setInputFiles(image);
    await expect(details.getByLabel('Banner URL', { exact: true })).toHaveValue(`${server}/2.png`);
    await details.getByRole('button', { name: 'Save group profile', exact: true }).click();
    await expect(details.getByRole('status')).toHaveText('Saved');
    await owner.page.reload();
    await expect(details.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/1.png`);
    await details.getByText('More profile fields', { exact: true }).click();
    await expect(details.getByLabel('Banner URL', { exact: true })).toHaveValue(`${server}/2.png`);
  } finally {
    await disposeUsers(owner);
  }
});

test('public groups can upload pictures during creation and editing', async ({ browser }) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.publicImageOwner);
  const { page } = owner;
  try {
    const upload = await uploads(page, owner.session.publicKey);
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'New public group', exact: true });
    await dialog.getByLabel('Group name', { exact: true }).fill('Public picture group');
    await dialog.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect(dialog.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/1.png`);
    await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Public group settings' }).click();
    dialog = page.getByRole('dialog', { name: 'Public group settings', exact: true });
    upload.hold();
    await dialog.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect.poll(upload.count).toBe(2);
    await expect(
      dialog.getByRole('button', { name: 'Save group profile', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close public group dialog' }).click();
    upload.release();
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await expect(dialog.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/1.png`);
    await dialog.getByLabel('Choose picture', { exact: true }).setInputFiles(image);
    await expect(dialog.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/3.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath('public-picture-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Save group profile', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await expect(dialog.getByLabel('Picture URL', { exact: true })).toHaveValue(`${server}/3.png`);
  } finally {
    await disposeUsers(owner);
  }
});
