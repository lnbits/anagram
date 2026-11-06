import { expect, test } from '@playwright/test';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { bootstrapUser, disposeUsers, navigateToChat, TEST_ACCOUNTS } from '../parity/helpers';

test('a slow lookup leaves the new chat dialog closable, and a closed one ignores it', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.dialogBusyUser);
  try {
    const { page } = user;
    // Hold identifier resolution (e.g. a slow NIP-05 lookup) until released.
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const store = useNostrStore();
      const resolve = store.resolveIdentifier.bind(store);
      const held = window as unknown as { releaseLookup: () => void; lookups: number };
      held.lookups = 0;
      let release = () => {};
      held.releaseLookup = () => release();
      store.resolveIdentifier = async (value: string) => {
        await new Promise<void>((done) => (release = done));
        const found = await resolve(value);
        held.lookups++;
        return found;
      };
    });
    const released = (count: number) =>
      expect
        .poll(() => page.evaluate(() => (window as unknown as { lookups: number }).lookups))
        .toBe(count);
    const dialog = page.getByRole('dialog');
    const abandoned = getPublicKey(generateSecretKey());
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(abandoned));
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Add contact', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The abandoned lookup finishes later: no contact, no chat, no error in the next dialog.
    await page.evaluate(() => (window as unknown as { releaseLookup: () => void }).releaseLookup());
    await released(1);
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(page.url()).not.toContain(abandoned);
    expect(
      await page.evaluate(async (key) => {
        const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
        return useChatStore().chats.some((chat) => chat.publicKey === key);
      }, abandoned),
    ).toBe(false);

    // A lookup that finishes while its dialog is open still adds the contact.
    await page
      .getByTestId('contact-identifier-input')
      .fill(nip19.npubEncode(getPublicKey(generateSecretKey())));
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Add contact', exact: true })).toBeDisabled();
    await page.evaluate(() => (window as unknown as { releaseLookup: () => void }).releaseLookup());
    await released(2);
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
