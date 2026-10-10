import { expect, test, type Browser } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from '../parity/helpers';

async function menuOpacities(browser: Browser, name: string) {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS[name]);
  try {
    const { page } = user;
    await openDirectChatFromIdentifier(page, getPublicKey(generateSecretKey()), 'Touch menu peer');
    await sendMessage(page, 'Touch menu fixture');
    await page.mouse.move(0, 0);
    const opacity = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node).opacity);
    await expect(threadMessage(page, 'Touch menu fixture')).toBeVisible();
    return {
      hover: await page.evaluate(() => matchMedia('(hover: none)').matches),
      chat: await opacity('.chat-row .row-menu'),
      message: await opacity('.message-menu-trigger'),
    };
  } finally {
    await disposeUsers(user);
  }
}

test.describe('tablet touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });
  test('message and chat menu buttons are visible without hover', async ({ browser }) => {
    expect(await menuOpacities(browser, 'touchMenuTablet')).toEqual({
      hover: true,
      chat: '1',
      message: '1',
    });
  });
});

test('desktop keeps menu buttons hidden until hover', async ({ browser }) => {
  expect(await menuOpacities(browser, 'touchMenuDesktop')).toEqual({
    hover: false,
    chat: '0',
    message: '0',
  });
});
