import { expect, test, type Page } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

async function dragHandle(page: Page, dx: number) {
  const handle = page.getByRole('separator', { name: 'Resize left panel' });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test('the sidebar resizes in the direction it is dragged in LTR and RTL', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.rtlResizeUser);
  try {
    const { page } = user;
    const sidebar = page.locator('aside.sidebar');
    const width = async () => (await sidebar.boundingBox())!.width;
    const handle = page.getByRole('separator', { name: 'Resize left panel' });

    let before = await width();
    await dragHandle(page, 60);
    expect(Math.round((await width()) - before)).toBe(60);
    before = await width();
    await handle.press('ArrowRight');
    expect(Math.round((await width()) - before)).toBe(16);

    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    const box = (await sidebar.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 2);
    // In RTL the sidebar is on the right, so dragging left widens it.
    before = await width();
    await dragHandle(page, -60);
    expect(Math.round((await width()) - before)).toBe(60);
    before = await width();
    await handle.press('ArrowLeft');
    expect(Math.round((await width()) - before)).toBe(16);
  } finally {
    await disposeUsers(user);
  }
});
