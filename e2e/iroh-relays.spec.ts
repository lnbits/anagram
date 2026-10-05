import { expect, test } from '@playwright/test';
import {
  bootstrapSessionOnPage,
  bootstrapUser,
  disposeUsers,
  expectNoUnexpectedBrowserErrors,
  logoutFromSettings,
  openAppRelaysSettings,
} from './helpers';

test('call relay pool modes prevent individual built-ins and restore custom preferences', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, {
    privateKey: '86'.repeat(32),
    displayName: 'Call Relay Settings',
  });
  try {
    const page = user.page;
    await openAppRelaysSettings(page);
    await page.getByTestId('settings-relays-iroh-tab').click();
    const rows = page.getByTestId('iroh-relay-row');
    const input = page.getByTestId('iroh-new-relay');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('https://127.0.0.1:7004/');
    await expect(rows.first().getByTestId('iroh-delete-relay')).toHaveCount(0);
    await expect(page.getByTestId('iroh-relay-enabled')).toHaveCount(0);
    await expect(page.getByTestId('iroh-mode-custom')).toHaveAttribute('aria-disabled', 'true');
    await input.fill('https://iroh.nostr.com/');
    await expect(page.getByTestId('iroh-add-relay')).toBeDisabled();
    await input.fill('http://example.com');
    await expect(page.getByTestId('iroh-add-relay')).toBeDisabled();
    await input.fill('https://custom.example.com');
    await page.getByTestId('iroh-add-relay').click();
    await expect(input).toHaveValue('');
    await expect(rows).toHaveCount(2);
    await input.fill('HTTPS://CUSTOM.EXAMPLE.COM/');
    await expect(page.getByTestId('iroh-add-relay')).toBeDisabled();
    await input.fill('');
    await expect(page.getByTestId('iroh-mode-pool-custom')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('iroh-mode-pool').click();
    await expect(page.getByTestId('iroh-mode-pool')).toHaveAttribute('aria-checked', 'true');
    await expect(rows.filter({ hasText: 'https://custom.example.com/' })).toContainText('not used');
    await expect(input).toBeEnabled();
    await page.getByTestId('iroh-mode-custom').click();
    await expect(page.getByTestId('iroh-mode-custom')).toHaveAttribute('aria-checked', 'true');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId('iroh-delete-relay')).toBeDisabled();
    await expect(input).toBeEnabled();
    // A fresh sign-in restores encrypted account preferences; ordinary reload uses the startup checkpoint.
    await Promise.all([page.waitForEvent('load'), logoutFromSettings(page)]);
    await bootstrapSessionOnPage(page, {
      privateKey: '86'.repeat(32),
      displayName: 'Call Relay Settings',
    });
    await openAppRelaysSettings(page);
    await page.getByTestId('settings-relays-iroh-tab').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('https://custom.example.com/');
    await expect(page.getByTestId('iroh-mode-custom')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('iroh-mode-pool-custom').click();
    await expect(rows).toHaveCount(2);
    await expect(input).toBeEnabled();
    await rows
      .filter({ hasText: 'https://custom.example.com/' })
      .getByTestId('iroh-delete-relay')
      .click();
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('iroh-mode-pool')).toHaveAttribute('aria-checked', 'true');
    await expect(input).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('settings-relays-iroh-tab')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.getByTestId('iroh-default-relays').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('https://127.0.0.1:7004/');
    await expect(input).toBeEnabled();
    await expectNoUnexpectedBrowserErrors([user]);
  } finally {
    await disposeUsers(user);
  }
});
