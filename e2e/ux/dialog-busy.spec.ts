import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from '../parity/helpers';

test('the new chat dialog stays open while the contact is being added', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.dialogBusyUser);
  try {
    const { page } = user;
    // Hold identifier resolution (e.g. a slow NIP-05 lookup) until released.
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      const store = useNostrStore();
      const resolve = store.resolveIdentifier.bind(store);
      const gate = new Promise<void>((release) => {
        (window as unknown as { releaseLookup: () => void }).releaseLookup = release;
      });
      store.resolveIdentifier = async (value: string) => {
        await gate;
        return resolve(value);
      };
    });
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await page
      .getByTestId('contact-identifier-input')
      .fill(nip19.npubEncode(getPublicKey(generateSecretKey())));
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    await page.evaluate(() => (window as unknown as { releaseLookup: () => void }).releaseLookup());
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('message-composer-input')).toBeVisible();
  } finally {
    await disposeUsers(user);
  }
});
