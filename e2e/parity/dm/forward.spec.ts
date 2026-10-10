import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  threadMessage,
  forwardMessage,
} from '../helpers';
test('forwarding preserves content and clickable links without reply or sender attribution', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.forwardAlice),
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.forwardBob),
    charlie = await bootstrapUser(browser, TEST_ACCOUNTS.forwardCharlie);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await establishAcceptedDirectChat(alice, charlie);
    await navigateToChat(alice.page, bob.session.publicKey);
    await alice.page.getByTestId('message-composer-menu').click();
    await expect(alice.page.locator('.attachment-menu').getByRole('button')).toHaveCount(2);
    await expect(alice.page.locator('.attachment-menu')).toContainText('Photo or Video');
    await expect(alice.page.locator('.attachment-menu')).toContainText('File');
    await alice.page.keyboard.press('Escape');
    await alice.page.getByTestId('message-composer-emoji').click();
    await expect(alice.page.getByPlaceholder('Search emoji')).toBeVisible();
    await alice.page.keyboard.press('Escape');
    const url = 'https://example.com/docs?view=chat',
      text = `Forward ${Date.now()} ${url}.`;
    await sendMessage(alice.page, text);
    await waitForThreadMessage(bob.page, text);
    await bob.page.evaluate(() => {
      window.open = ((url: unknown) => {
        sessionStorage.setItem('opened-url', String(url));
        return null;
      }) as typeof window.open;
    });
    const link = threadMessage(bob.page, text).getByTestId('message-url-link');
    await expect(link).toHaveAttribute('href', url);
    await link.click();
    await expect
      .poll(() => bob.page.evaluate(() => sessionStorage.getItem('opened-url')))
      .toBe(url);
    await bob.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value: string) => sessionStorage.setItem('copied-link', value) },
      });
    });
    await link.click({ button: 'right' });
    await bob.page.getByTestId('message-link-copy').click();
    await expect
      .poll(() => bob.page.evaluate(() => sessionStorage.getItem('copied-link')))
      .toBe(url);
    await forwardMessage(alice.page, text, charlie.account.displayName);
    await waitForThreadMessage(charlie.page, text);
    await expect(threadMessage(charlie.page, text).locator('.reply-preview')).toHaveCount(0);
    await expect(threadMessage(charlie.page, text)).not.toContainText(bob.account.displayName);
    expect(
      await alice.page
        .getByTestId('chat-item')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(64);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});

test('group call invitations show compact join links and open the call lobby', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.callLinkAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.callLinkBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    const token = Buffer.from(
      JSON.stringify({
        id: '12345678-1234-4123-8123-123456789abc',
        host: alice.session.publicKey,
        secret: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        relays: ['ws://127.0.0.1:7777/'],
      }),
    ).toString('base64url');
    for (const prefix of ['https://anagram.chat/#/call/', 'anagram://room/call/']) {
      const url = prefix + token;
      const marker = `Come chat ${prefix.startsWith('https') ? 'web' : 'app'}`;
      await alice.page.getByTestId('message-composer-input').fill(`${marker}: ${url}`);
      await alice.page.getByTestId('message-send-button').click();
      const message = threadMessage(bob.page, marker);
      const join = message.getByRole('link', { name: 'Join group call' });
      await expect(join).toBeVisible();
      await expect(join).toHaveAttribute('href', url);
      await expect(message).not.toContainText(token);
      await join.click();
      await expect(bob.page.getByTestId('room-join-link')).toHaveValue(url);
      await expect(bob.page.getByTestId('room-join-audio')).toBeEnabled();
      await expect(bob.page.getByTestId('room-join-video')).toBeEnabled();
      await bob.page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    }
  } finally {
    await disposeUsers(alice, bob);
  }
});
