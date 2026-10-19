import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  navigateInApp,
  action,
} from './parity/helpers';

test('Auto upgrades new DMs when a device appears, persists across reload and honors NIP-17 override', async ({
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
    await navigateInApp(alice.page, '/chats');
    await establishAcceptedDirectChat(alice, bob);
    await expect(alice.page.getByTestId('dm-mode')).toHaveAttribute('data-protocol', 'nip17');
    for (const [user, peer] of [[bob, alice]]) {
      await navigateInApp(user.page, `/contacts/${peer.session.publicKey}`);
      await user.page.getByText('Private messages', { exact: true }).click();
      await expect(user.page.getByTestId('dm-protocol')).toHaveValue('auto');
      await user.page.getByTestId('dm-protocol').selectOption('ndr');
      await expect(user.page.getByTestId('dm-protocol')).toBeEnabled({ timeout: 20000 });
      await expect(user.page.getByTestId('dm-protocol')).toHaveValue('ndr');
      await user.page
        .getByTestId('contact-details')
        .getByRole('button', { name: 'Open Chat', exact: true })
        .click();
    }
    await expect(alice.page.getByTestId('dm-mode')).toHaveAttribute('data-protocol', 'ndr', {
      timeout: 20000,
    });
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
    await navigateInApp(alice.page, `/contacts/${bob.session.publicKey}`);
    await alice.page.getByText('Private messages', { exact: true }).click();
    await alice.page.getByTestId('dm-protocol').selectOption('nip17');
    await alice.page
      .getByTestId('contact-details')
      .getByRole('button', { name: 'Open Chat', exact: true })
      .click();
    await expect(alice.page.getByTestId('dm-mode')).toHaveAttribute('data-protocol', 'nip17');
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
