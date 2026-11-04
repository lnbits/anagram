import { expect, test, type Page } from '@playwright/test';
import {
  action,
  bootstrapUser,
  disposeUsers,
  navigateToChat,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  threadMessage,
} from '../parity/helpers';

async function expectJumpClearOfContext(page: Page) {
  const thread = page.getByTestId('chat-thread');
  await thread.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -1500);
  const jump = page.getByRole('button', { name: 'Jump to latest messages' });
  await expect(jump).toBeVisible();
  const button = (await jump.boundingBox())!;
  const context = (await page.locator('.composer-context').boundingBox())!;
  // The floating button stays above the reply/edit bar instead of covering its cancel button.
  expect(button.y + button.height).toBeLessThanOrEqual(context.y);
  await jump.click();
  await expect(jump).toHaveCount(0);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    test('jump to latest never covers the reply or edit bar', async ({ browser }) => {
      const user = await bootstrapUser(
        browser,
        TEST_ACCOUNTS[`jumpLatestContextUser${viewport.width}`],
      );
      try {
        const { page } = user;
        const self = user.session.publicKey;
        await navigateToChat(page, self);
        await sendMessagesViaBridge(
          page,
          self,
          Array.from({ length: 40 }, (_, index) => `Jump fixture ${index}`),
        );
        await expect(threadMessage(page, 'Jump fixture 39')).toBeVisible();

        await action(page, 'Jump fixture 39', 'Reply');
        await expect(page.locator('.composer-context')).toContainText('Reply to');
        await expectJumpClearOfContext(page);
        await page.getByRole('button', { name: 'Cancel reply or edit' }).click();

        await action(page, 'Jump fixture 39', 'Edit');
        await expect(page.locator('.composer-context')).toContainText('Editing message');
        await expectJumpClearOfContext(page);
      } finally {
        await disposeUsers(user);
      }
    });
  });
}
