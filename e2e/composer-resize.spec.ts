import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateToChat,
} from './parity/helpers';

test('composer shrinks after sending and restores the right height for each chat draft', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.ComposerSizing);
  const { page } = user;
  try {
    await openDirectChatFromIdentifier(page, user.session.npub, 'My Self');
    const input = page.getByTestId('message-composer-input');
    const height = () => input.evaluate((node) => node.getBoundingClientRect().height);
    await expect.poll(height).toBe(40);
    const multiline = Array.from({ length: 8 }, (_, index) => `Draft line ${index + 1}`).join('\n');
    await input.fill(multiline);
    await expect.poll(height).toBe(140);
    await page.getByTestId('message-send-button').click();
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(40);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Draft line 8' }),
    ).toBeVisible();

    await page
      .getByTestId('message-bubble')
      .filter({ hasText: 'Draft line 8' })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(input).toHaveValue(multiline);
    await expect.poll(height).toBe(140);
    await page.getByRole('button', { name: 'Cancel reply or edit' }).click();
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(40);

    await input.fill(multiline);
    const other = getPublicKey(generateSecretKey());
    await openDirectChatFromIdentifier(page, other, 'Another chat');
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(40);
    await navigateToChat(page, user.session.publicKey);
    await expect(input).toHaveValue(multiline);
    await expect.poll(height).toBe(140);
    await input.fill('');
    await expect.poll(height).toBe(40);

    // Wrapping changes when the window or desktop sidebar changes width, even
    // though the draft itself has not changed.
    await page.setViewportSize({ width: 1440, height: 900 });
    await input.fill('A draft that wraps when the chat gets narrower. '.repeat(4));
    await expect
      .poll(() => input.evaluate((node) => node.clientHeight === node.scrollHeight))
      .toBe(true);
    const wideHeight = await height();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(height).toBeGreaterThan(wideHeight);
    await expect.poll(height).toBeLessThanOrEqual(140);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(height).toBe(wideHeight);
    await input.fill('');
    await expect.poll(height).toBe(40);
    expect(user.browserErrors).toEqual([]);
  } finally {
    await user.context.close();
  }
});
