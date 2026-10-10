import { expect, test, type Page } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

async function createGroupWithMessages(page: Page) {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'New public group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New public group' });
  await dialog.getByLabel('Group name', { exact: true }).fill('Quick reply lounge');
  await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
  await expect(page).toHaveURL(/\/public\/naddr/);
  for (const text of ['Public quick reply first', 'Public quick reply second']) {
    await page.getByTestId('message-composer-input').fill(text);
    await page.getByTestId('message-send-button').click();
    await expect(publicMessage(page, text)).toBeVisible();
  }
}
const publicMessage = (page: Page, text: string) =>
  page.getByTestId('public-message').filter({ hasText: text }).last();

test('double-clicking a public group message replies to that message', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.publicQuickReplyDesktop);
  try {
    const { page } = user;
    await createGroupWithMessages(page);
    const banner = page.locator('.composer-context');
    const composer = page.getByTestId('message-composer-input');

    // Interactive content keeps its own behavior.
    await publicMessage(page, 'Public quick reply first')
      .getByRole('button', { name: 'Message actions', exact: true })
      .dblclick();
    await page.keyboard.press('Escape');
    await expect(banner).toHaveCount(0);

    await publicMessage(page, 'Public quick reply first')
      .locator('.message-text')
      .dblclick({ position: { x: 6, y: 6 } });
    await expect(banner).toContainText('Reply to You: Public quick reply first');
    await expect(banner).not.toContainText('second');
    await expect(composer).toBeFocused();
    await expect(page.getByTestId('message-context-menu')).toHaveCount(0);

    // The posted reply quotes the double-clicked message, as with ⋯ → Reply.
    await composer.fill('Public quick reply answer');
    await page.getByTestId('message-send-button').click();
    const answer = publicMessage(page, 'Public quick reply answer');
    await expect(answer.locator('.reply-preview')).toContainText('Public quick reply first');
    await expect(banner).toHaveCount(0);
  } finally {
    await disposeUsers(user);
  }
});

test.describe('public group with real touch input', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('a swipe that starts on message text replies to that message', async ({ browser }) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS.publicQuickReplyTouch);
    try {
      const { page } = user;
      await createGroupWithMessages(page);
      const banner = page.locator('.composer-context');
      const menu = page.getByTestId('message-context-menu');
      const cdp = await page.context().newCDPSession(page);
      async function touch(text: string, dx: number, dy: number, holdMs = 0) {
        const target = publicMessage(page, text).locator('.message-text');
        await expect(target).toBeVisible();
        let box = await target.boundingBox();
        await expect.poll(async () => (box = await target.boundingBox())).not.toBeNull();
        const x = box!.x + 8,
          y = box!.y + box!.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        if (holdMs) await page.waitForTimeout(holdMs);
        for (let step = 1; dx || dy ? step <= 12 : false; step++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + (dx * step) / 12, y: y + (dy * step) / 12 }],
          });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }

      await touch('Public quick reply first', 30, 0);
      await touch('Public quick reply first', 0, 90);
      await touch('Public quick reply first', 0, 0);
      await touch('Public quick reply first', 0, 0);
      await expect(banner).toHaveCount(0);

      await touch('Public quick reply first', 96, 0);
      await expect(banner).toContainText('Reply to You: Public quick reply first');
      await expect(banner).not.toContainText('second');
      await page.getByRole('button', { name: 'Cancel reply or edit' }).click();

      await touch('Public quick reply second', 0, 0, 700);
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(banner).toHaveCount(0);

      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
      });
      await touch('Public quick reply second', 96, 0);
      await expect(banner).toHaveCount(0);
      await touch('Public quick reply second', -96, 0);
      await expect(banner).toContainText('Public quick reply second');
    } finally {
      await disposeUsers(user);
    }
  });
});
