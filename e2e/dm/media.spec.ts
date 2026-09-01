import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  pullToRefresh,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('manual healing and message reloads do not close the image viewer', async ({ browser }) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mediaViewerAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mediaViewerBob);

  try {
    const messageText = `media-viewer-${Date.now()}`;
    const imageUrl =
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" fill="%2300a67e"/%3E%3C/svg%3E';

    await establishAcceptedDirectChat(alice, bob);

    const refreshButton = alice.page.getByTestId('refresh-chats-button');
    await expect(refreshButton).toBeVisible();
    await expect(refreshButton.locator('.q-btn-dropdown__arrow')).toHaveCount(0);
    await refreshButton.click();
    await expect
      .poll(() =>
        alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false)
      )
      .toBe(true);
    await expect(refreshButton).toBeDisabled();
    await expect
      .poll(
        () =>
          alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false),
        { timeout: 20_000 }
      )
      .toBe(false);

    await pullToRefresh(alice.page, 'chat-list-pull-to-refresh');
    await expect
      .poll(() =>
        alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false)
      )
      .toBe(true);
    await expect(refreshButton.locator('.q-spinner')).toHaveCount(0);
    await expect
      .poll(
        () =>
          alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false),
        { timeout: 20_000 }
      )
      .toBe(false);

    await sendMessage(alice.page, messageText, {
      chatId: bob.session.publicKey,
    });
    await alice.page.evaluate(
      async ({ chatId, messageText, imageUrl }) => {
        await window.__appE2E__?.setStoredMessageAttachments({
          chatId,
          messageText,
          attachments: [
            {
              type: 'media',
              url: imageUrl,
              mimeType: 'image/svg+xml',
              size: 128,
              name: 'e2e-image.svg',
            },
          ],
        });
      },
      {
        chatId: bob.session.publicKey,
        messageText,
        imageUrl,
      }
    );

    await threadMessage(alice.page, messageText)
      .getByRole('button', { name: 'e2e-image.svg' })
      .click();
    const fullscreenImage = alice.page.getByTestId('message-image-fullscreen');
    await expect(fullscreenImage).toBeVisible();

    await alice.page.keyboard.press('Escape');
    await expect(fullscreenImage).toBeVisible();

    await alice.page.evaluate(() => {
      window.__appE2E__?.startManualReconnectHealing();
    });
    await expect
      .poll(() =>
        alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false)
      )
      .toBe(true);
    await expect(fullscreenImage).toBeVisible();
    await expect
      .poll(
        () =>
          alice.page.evaluate(async () => (await window.__appE2E__?.isReconnectHealing()) ?? false),
        { timeout: 20_000 }
      )
      .toBe(false);
    await expect(fullscreenImage).toBeVisible();

    const downloadPromise = alice.page.waitForEvent('download');
    await alice.page.getByTestId('message-image-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('e2e-image.svg');

    await alice.page.getByTestId('message-image-close').click();
    await expect(fullscreenImage).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
