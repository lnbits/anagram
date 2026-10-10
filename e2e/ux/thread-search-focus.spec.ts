import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  TEST_ACCOUNTS,
} from '../parity/helpers';

test('closing thread search returns focus to the search button', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.searchFocusUser);
  try {
    const { page } = user;
    await openDirectChatFromIdentifier(page, getPublicKey(generateSecretKey()), 'Search peer');
    const toggle = page.getByRole('button', { name: 'Search conversation', exact: true });
    const field = page.getByRole('textbox', { name: 'Search messages', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(field).toBeFocused();
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(toggle).toBeFocused();
  } finally {
    await disposeUsers(user);
  }
});
