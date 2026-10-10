import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  createGroup,
  navigateToChat,
  openDirectChatFromIdentifier,
} from './parity/helpers';

for (const kind of ['Direct messages', 'Private groups', 'Public groups']) {
  test(`${kind} share the rendered spec dialog on desktop and mobile`, async ({
    browser,
  }, info) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`spec${kind}`]);
    const peer =
      kind === 'Direct messages' ? await bootstrapUser(browser, TEST_ACCOUNTS.specPeer) : undefined;
    const page = user.page;
    try {
      if (peer) {
        await openDirectChatFromIdentifier(page, peer.session.npub, 'Spec peer');
        await page.getByRole('button', { name: 'Contact profile', exact: true }).click();
      } else if (kind === 'Private groups') {
        const group = await createGroup(page, { name: 'Spec private group', about: '' });
        // The same contact details also appear as a nested dialog from the thread.
        await navigateToChat(page, group);
        await page.getByRole('button', { name: 'Contact profile', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('button', { name: 'New public group', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'New public group', exact: true });
        await create.getByLabel('Group name', { exact: true }).fill('Spec public group');
        await create.getByRole('button', { name: 'Create public group', exact: true }).click();
        await expect(page).toHaveURL(/\/public\/naddr/);
        await page.getByRole('button', { name: 'Public group settings', exact: true }).click();
      }
      const settings = page.getByRole('dialog');
      const button = settings.getByRole('button', { name: 'Spec', exact: true });
      const spec = page.getByRole('dialog', { name: `${kind} spec`, exact: true });
      for (const mobile of [false, true]) {
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        );
        for (const dark of [false, true]) {
          await page.evaluate((dark) => document.body.classList.toggle('body--dark', dark), dark);
          await button.click();
          await expect(
            spec.getByRole('heading', { name: `${kind} spec`, exact: true }),
          ).toBeVisible();
          await expect(spec.getByRole('list').first()).toBeVisible();
          await expect(spec.locator('code').first()).toBeVisible();
          expect(await spec.innerText()).not.toContain('## ');
          expect(await spec.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          const bounds = await spec.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
          await expect(spec.getByRole('button', { name: 'Close spec' })).toBeFocused();
          if (mobile && dark)
            await spec.screenshot({ path: info.outputPath('spec-mobile-dark.png') });
          await page.keyboard.press('Escape');
          await expect(spec).toHaveCount(0);
          await expect(button).toBeFocused();
        }
      }
      await button.click();
      await page.mouse.click(2, 2);
      await expect(spec).toHaveCount(0);
      await expect(button).toBeVisible();
      expect(user.browserErrors).toEqual([]);
    } finally {
      await disposeUsers(user, ...(peer ? [peer] : []));
    }
  });
}
