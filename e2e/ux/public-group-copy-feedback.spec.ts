import { expect, test } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

test('public group copy actions use the app toast', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.publicCopyToastUser);
  try {
    const { page, context } = user;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New public group' });
    await create.getByLabel('Group name', { exact: true }).fill('Copy toast lounge');
    await create.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page).toHaveURL(/\/public\/naddr/);
    const toast = (text: string) => page.locator('.notices > div', { hasText: text });

    await page.getByRole('button', { name: 'Copy public group link' }).click();
    await expect(toast('Group link copied.')).toBeVisible();

    await page.getByRole('button', { name: 'Public group settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Public group settings' });
    await expect(toast('Group link copied.')).toHaveCount(0, { timeout: 10000 });
    await settings.getByRole('button', { name: 'Copy group link', exact: true }).click();
    await expect(toast('Group link copied.')).toBeVisible();
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('message-composer-input').fill('Public copy fixture');
    await page.getByTestId('message-send-button').click();
    const message = page.getByTestId('public-message').filter({ hasText: 'Public copy fixture' });
    await expect(message).toBeVisible();
    await message.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click();
    await expect(toast('Message copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Public copy fixture');
    await expect(page.locator('p.status', { hasText: 'copied' })).toHaveCount(0);
  } finally {
    await disposeUsers(user);
  }
});
