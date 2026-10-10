import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  sendMessage,
  threadMessage,
  refreshSession,
} from '../helpers';
test('message healing preserves the open image viewer and download filename', async ({
  browser,
}, info) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.imageAlice),
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.imageBob);
  const url = 'https://media.example.test/e2e-image.svg';
  try {
    await alice.page.route(url, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'access-control-allow-origin': '*' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1400"><rect width="1800" height="1400" fill="green"/></svg>',
      }),
    );
    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, 'Image viewer fixture');
    await alice.page.evaluate(
      async ({ chatId, url }) =>
        window.__appE2E__!.setStoredMessageAttachments({
          chatId,
          messageText: 'Image viewer fixture',
          attachments: [
            { type: 'media', url, mimeType: 'image/svg+xml', size: 128, name: 'e2e-image.svg' },
          ],
        }),
      { chatId: bob.session.publicKey, url },
    );
    await threadMessage(alice.page, 'Image viewer fixture')
      .getByRole('img', { name: 'e2e-image.svg' })
      .click();
    const viewer = alice.page.getByRole('dialog', { name: 'Image attachment' });
    await expect(viewer).toBeVisible();
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await alice.page.setViewportSize(size);
      await expect
        .poll(async () =>
          viewer.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const image = node.querySelector('img')!.getBoundingClientRect();
            const canvas = node.querySelector('.image-canvas')!.getBoundingClientRect();
            return (
              rect.x === 0 &&
              rect.y === 0 &&
              rect.width === innerWidth &&
              rect.height === innerHeight &&
              image.width > 0 &&
              image.height > 0 &&
              image.left >= 0 &&
              image.right <= innerWidth &&
              image.top >= canvas.top &&
              image.bottom <= canvas.bottom &&
              Math.abs(image.left + image.width / 2 - innerWidth / 2) < 1 &&
              Math.abs(image.top + image.height / 2 - (canvas.top + canvas.height / 2)) < 1
            );
          }),
        )
        .toBe(true);
      await alice.page.screenshot({ path: info.outputPath(`image-viewer-${size.width}.png`) });
    }
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await refreshSession(alice.page, bob.session.publicKey);
    await expect(viewer).toBeVisible();
    await alice.page.evaluate(() => window.__appE2E__!.startManualReconnectHealing());
    await expect
      .poll(() => alice.page.evaluate(() => window.__appE2E__!.isReconnectHealing()))
      .toBe(false);
    await expect(viewer).toBeVisible();
    const downloaded = alice.page.waitForEvent('download');
    await viewer.getByRole('button', { name: 'Download image', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('e2e-image.svg');
    await viewer.getByRole('img', { name: 'Attachment', exact: true }).click();
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const canvas = await viewer.locator('.image-canvas').boundingBox();
    await alice.page.mouse.move(canvas!.x + 4, canvas!.y + 20);
    await alice.page.mouse.down();
    await alice.page.mouse.move(canvas!.x + 40, canvas!.y + 60, { steps: 4 });
    await alice.page.mouse.up();
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await viewer.locator('.image-canvas').click({ position: { x: 4, y: 20 } });
    await expect(viewer).toBeHidden();
    await threadMessage(alice.page, 'Image viewer fixture')
      .getByRole('img', { name: 'e2e-image.svg' })
      .click();
    await expect(viewer).toBeVisible();
    await alice.page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('media URLs move into attachment menus while captions and ordinary links remain', async ({
  browser,
}, info) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mediaLinksAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mediaLinksBob);
  const image = 'https://media.example.test/caption-image.svg';
  const video = 'https://media.example.test/caption-video.mp4';
  const caption = 'Media caption fixture';
  const text = `${caption}\nhttps://example.org/article\n${image}\n${video}`;
  try {
    await alice.page.route(image, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#365d75"/></svg>',
      }),
    );
    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, text);
    await alice.page.evaluate(
      async ({ chatId, text, image, video }) => {
        await window.__appE2E__!.setStoredMessageAttachments({
          chatId,
          messageText: text,
          attachments: [
            {
              type: 'media',
              url: image,
              mimeType: 'image/svg+xml',
              size: 128,
              name: 'caption-image.svg',
            },
            {
              type: 'media',
              url: video,
              mimeType: 'video/mp4',
              size: 128,
              name: 'caption-video.mp4',
            },
          ],
        });
      },
      { chatId: bob.session.publicKey, text, image, video },
    );
    const message = threadMessage(alice.page, caption);
    await expect(message.locator('.message-text')).toHaveText(
      `${caption}\nhttps://example.org/article`,
    );
    await expect(message.getByTestId('message-url-link')).toHaveCount(1);
    await expect(message.locator('video')).toHaveAttribute('src', video);
    await expect(message.getByRole('button', { name: 'Media options' })).toHaveCount(2);
    await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    for (const [index, url] of [image, video].entries()) {
      const options = message.getByRole('button', { name: 'Media options' }).nth(index);
      await options.click();
      await expect(alice.page.getByRole('menuitem', { name: 'Open original' })).toBeVisible();
      await alice.page.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
      expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe(url);
      await expect(options).toBeFocused();
    }
    await alice.page.setViewportSize({ width: 390, height: 844 });
    const options = message.getByRole('button', { name: 'Media options' }).last();
    await options.click();
    await expect(alice.page.getByRole('menuitem', { name: 'Open original' })).toBeVisible();
    await alice.page.screenshot({ path: info.outputPath('media-options-mobile.png') });
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.getByRole('menu')).toHaveCount(0);
    await expect(options).toBeFocused();
  } finally {
    await disposeUsers(alice, bob);
  }
});
