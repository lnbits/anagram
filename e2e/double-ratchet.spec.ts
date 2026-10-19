import { test, expect, type Page } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  navigateInApp,
  action,
} from './parity/helpers';

async function openPrivateMessageDetails(page: Page) {
  await page.getByRole('button', { name: 'Contact profile', exact: true }).click();
  const details = page.getByTestId('contact-details');
  await details.getByText('Private messages', { exact: true }).click();
  await expect(details.getByTestId('dm-protocol')).toHaveCount(0);
  await expect(
    details.getByTestId('contact-protocol').locator('input, select, button'),
  ).toHaveCount(0);
  return details;
}

async function expectPlainThreadHeader(page: Page) {
  await expect(page.getByTestId('dm-mode')).toHaveCount(0);
  await expect(page.locator('.thread-header').getByText('Encrypted', { exact: true })).toHaveCount(
    0,
  );
}

test('Settings preference persists, contact details show automatic upgrades, and saved NIP-17 overrides remain honored', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.ratchetAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.ratchetBob);
  try {
    await navigateInApp(alice.page, '/settings/messaging');
    await expect(alice.page.getByTestId('prefer-ratchet')).toBeChecked();
    await alice.page.getByTestId('prefer-ratchet').uncheck();
    await alice.page.reload();
    await expect(alice.page.getByTestId('prefer-ratchet')).not.toBeChecked();
    await alice.page.getByTestId('prefer-ratchet').check();
    await alice.page.reload();
    await expect(alice.page.getByTestId('prefer-ratchet')).toBeChecked();
    await navigateInApp(alice.page, '/chats');
    await establishAcceptedDirectChat(alice, bob);
    await expectPlainThreadHeader(alice.page);
    const details = await openPrivateMessageDetails(alice.page);
    await expect(details.getByTestId('contact-protocol')).toHaveAttribute('data-protocol', 'nip17');
    // Simulate the other client's first device enrollment after this chat exists.
    // Enrollment is fixture setup, not a per-contact control in the interface.
    await bob.page.evaluate(async (peer) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      await useNostrStore().setDirectMessageProtocol(peer, 'ndr');
    }, alice.session.publicKey);
    await expect(details.getByTestId('contact-protocol')).toHaveAttribute('data-protocol', 'ndr', {
      timeout: 20000,
    });
    await details.getByRole('button', { name: 'Open Chat', exact: true }).click();
    await expectPlainThreadHeader(alice.page);
    await alice.page.getByTestId('message-composer-input').fill('Ratchet hello');
    await alice.page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'Ratchet hello' }),
    ).toBeVisible();
    await alice.page.evaluate(async (peer) => {
      const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
      const store = useMessageStore();
      const original = store.getMessages(peer).find((message) => message.text === 'Ratchet hello')!;
      const edited = await store.editMessage(peer, original.id, 'Ratchet edited');
      if (edited?.eventId !== original.eventId)
        throw new Error('An edit changed the original message ID.');
    }, bob.session.publicKey);
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'Ratchet edited' }),
    ).toBeVisible();
    await bob.page.reload();
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'Ratchet edited' }),
    ).toBeVisible();
    await bob.page.getByTestId('message-composer-input').fill('After reload');
    await bob.page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      alice.page.getByTestId('message-bubble').filter({ hasText: 'After reload' }),
    ).toBeVisible();
    await action(alice.page, 'Ratchet edited', 'Nostr info');
    await expect(alice.page.getByTestId('message-protocol')).toHaveText('Double ratchet');
    await alice.page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    // Older installations may retain an explicit per-contact choice. Keep that
    // compatibility coverage without requiring a removed selector in the UI.
    await alice.page.evaluate(async (peer) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      await useNostrStore().setDirectMessageProtocol(peer, 'nip17');
    }, bob.session.publicKey);
    await alice.page.reload();
    await expectPlainThreadHeader(alice.page);
    const restoredDetails = await openPrivateMessageDetails(alice.page);
    await expect(restoredDetails.getByTestId('contact-protocol')).toHaveAttribute(
      'data-protocol',
      'nip17',
    );
    await restoredDetails.getByRole('button', { name: 'Open Chat', exact: true }).click();
    await alice.page.getByTestId('message-composer-input').fill('NIP-17 still works');
    await alice.page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'NIP-17 still works' }),
    ).toBeVisible();
    await action(alice.page, 'Ratchet edited', 'Nostr info');
    await expect(alice.page.getByTestId('message-protocol')).toHaveText('Double ratchet');
  } finally {
    await disposeUsers(alice, bob);
  }
});
