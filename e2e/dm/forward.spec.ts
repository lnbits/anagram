import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  forwardMessage,
  navigateToChat,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  waitForThreadMessage,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

test('accepted DM forwards message content to another chat without attribution', async ({
  browser,
}) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.forwardAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.forwardBob);
  const charlie = await bootstrapUser(browser, TEST_ACCOUNTS.forwardCharlie);

  try {
    const linkedUrl = 'https://example.com/docs?view=chat';
    const originalMessage = `forward-content-${Date.now()} ${linkedUrl}.`;

    await establishAcceptedDirectChat(alice, bob);
    await establishAcceptedDirectChat(alice, charlie);

    await navigateToChat(alice.page, bob.session.publicKey);
    const attachmentButton = alice.page.getByTestId('message-composer-menu');
    await expect(attachmentButton.locator('.q-icon')).toHaveText('attach_file');
    await attachmentButton.click();
    const attachmentMenu = alice.page.locator('.composer__menu-list');
    await expect(attachmentMenu.getByRole('listitem')).toHaveCount(2);
    await expect(attachmentMenu).toContainText('Photo or Video');
    await expect(attachmentMenu).toContainText('File');
    await expect(attachmentMenu.getByText('Emoji', { exact: true })).toHaveCount(0);
    await alice.page.keyboard.press('Escape');

    const emojiButton = alice.page.getByTestId('message-composer-emoji');
    await expect(emojiButton).toBeVisible();
    await expect(
      alice.page.locator('.composer__input .q-field__control').filter({ has: emojiButton })
    ).toBeVisible();
    await emojiButton.click();
    await expect(alice.page.getByPlaceholder('Search emoji')).toBeVisible();
    await alice.page.keyboard.press('Escape');

    await sendMessage(alice.page, originalMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, originalMessage, {
      chatId: alice.session.publicKey,
    });
    await bob.page.evaluate(() => {
      Object.defineProperty(window, 'open', {
        configurable: true,
        value: (url?: string | URL | null) => {
          window.sessionStorage.setItem('e2e:last-opened-url', String(url ?? ''));
          return null;
        },
      });
    });
    await threadMessage(bob.page, originalMessage).getByTestId('message-url-link').click();
    await expect(
      threadMessage(bob.page, originalMessage).getByTestId('message-url-link')
    ).toHaveCSS('text-align', 'left');
    await expect
      .poll(() => bob.page.evaluate(() => window.sessionStorage.getItem('e2e:last-opened-url')))
      .toBe(linkedUrl);

    await bob.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            window.sessionStorage.setItem('e2e:last-copied-text', value);
          },
        },
      });
    });
    await threadMessage(bob.page, originalMessage)
      .getByTestId('message-url-link')
      .click({ button: 'right' });
    await bob.page.getByTestId('message-link-copy').click();
    await expect
      .poll(() => bob.page.evaluate(() => window.sessionStorage.getItem('e2e:last-copied-text')))
      .toBe(linkedUrl);

    await forwardMessage(alice.page, originalMessage, charlie.account.displayName, {
      publicKey: charlie.session.publicKey,
    });

    const compactChatRowHeight = await alice.page
      .getByTestId('chat-item')
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(compactChatRowHeight).toBeLessThanOrEqual(64);

    await waitForThreadMessage(charlie.page, originalMessage, {
      chatId: alice.session.publicKey,
    });
    await expect(
      threadMessage(charlie.page, originalMessage).locator('.bubble__reply-preview')
    ).toHaveCount(0);
    await expect(threadMessage(charlie.page, originalMessage)).not.toContainText(
      bob.account.displayName
    );
    await expectNoUnexpectedBrowserErrors([alice, bob, charlie]);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});
