import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  action,
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from '../parity/helpers';

test('copying the event ID in message info shows the app toast and keeps the dialog open', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.messageInfoCopyUser);
  try {
    const { page, context } = user;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDirectChatFromIdentifier(page, getPublicKey(generateSecretKey()), 'Info peer');
    await sendMessage(page, 'Message info fixture');
    const eventId = await threadMessage(page, 'Message info fixture').getAttribute('data-event-id');
    await action(page, 'Message info fixture', 'Nostr info');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Copy event ID' }).click();
    await expect(page.locator('.notices > div', { hasText: 'Event ID copied.' })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Event ID copied.')).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(eventId);
  } finally {
    await disposeUsers(user);
  }
});
