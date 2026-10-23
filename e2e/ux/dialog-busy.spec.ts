import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { bootstrapUser, disposeUsers, navigateToChat, TEST_ACCOUNTS } from '../parity/helpers';

test('the new chat dialog stays open while the contact is being added', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.dialogBusyUser);
  try {
    const { page } = user;
    // Hold identifier resolution (e.g. a slow NIP-05 lookup) until released.
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
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

test('a slow send does not lock the new chat dialog', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.dialogBusySendUser);
  try {
    const { page } = user;
    await page.evaluate(async () => {
      const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
      const held = window as unknown as { releaseSend: () => void; sendHeld?: boolean };
      const gate = new Promise<void>((release) => (held.releaseSend = release));
      useMessageStore().sendMessage = async () => {
        held.sendHeld = true;
        await gate;
      };
    });
    await navigateToChat(page, user.session.publicKey);
    // The chat may restore its stored draft just after opening; retry until the send is held.
    await expect(async () => {
      await page.getByTestId('message-composer-input').fill('Held send');
      await page.getByTestId('message-send-button').click({ timeout: 1000 });
      expect(
        await page.evaluate(() => (window as unknown as { sendHeld?: boolean }).sendHeld),
      ).toBe(true);
    }).toPass();
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.evaluate(() => (window as unknown as { releaseSend: () => void }).releaseSend());
  } finally {
    await disposeUsers(user);
  }
});
