import { expect, test, type Locator } from '@playwright/test';
import { bootstrapUser, disposeUsers, navigateInApp, TEST_ACCOUNTS } from '../parity/helpers';

const outline = (locator: Locator) =>
  locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });

test('keyboard focus is visible on selects and the contacts filter', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.focusIndicatorUser);
  try {
    const { page } = user;
    await navigateInApp(page, '/contacts');
    const filter = page.getByTestId('contact-list-search');
    await filter.focus();
    expect(await outline(filter)).toBe('solid 2px');

    await navigateInApp(page, '/settings/language');
    const language = page.locator('.settings-select-field select').first();
    await expect(language).toBeVisible();
    await page.keyboard.press('Shift');
    await language.focus();
    expect(await outline(language)).toBe('solid 2px');
  } finally {
    await disposeUsers(user);
  }
});
