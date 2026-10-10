import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import {
  action,
  bootstrapUser,
  disposeUsers,
  openDirectChatFromIdentifier,
  sendMessage,
  TEST_ACCOUNTS,
} from '../parity/helpers';

test('copying a message confirms that it was copied', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.copyFeedbackUser);
  try {
    const { page, context } = user;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const peer = nip19.npubEncode(getPublicKey(generateSecretKey()));
    await openDirectChatFromIdentifier(page, peer, 'Copy feedback peer');
    await sendMessage(page, 'Copy feedback fixture');
    await action(page, 'Copy feedback fixture', 'Copy message');
    await expect(page.locator('.notices')).toContainText('Message copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Copy feedback fixture');
  } finally {
    await disposeUsers(user);
  }
});
