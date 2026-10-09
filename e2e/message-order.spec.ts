import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
} from './parity/helpers';

test('outgoing messages render before persistence or relay publishing and use Nostr timestamp precision', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.instantOrderAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.instantOrderBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await alice.page.evaluate(async () => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      const original = chatDataService.createMessage.bind(chatDataService);
      chatDataService.createMessage = async (input) => {
        if (input.message === 'Visible before publishing') {
          await new Promise<void>((resolve) => {
            (window as any).__releaseOutbound = resolve;
          });
        }
        return original(input);
      };
    });
    await alice.page.getByTestId('message-composer-input').fill('Visible before publishing');
    await alice.page.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = alice.page
      .getByTestId('message-bubble')
      .filter({ hasText: 'Visible before publishing' });
    await expect(sent).toBeVisible();
    await expect(sent).toHaveAttribute('id', /^message-optimistic-/);
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'Visible before publishing' }),
    ).toHaveCount(0);
    await expect
      .poll(() => alice.page.evaluate(() => typeof (window as any).__releaseOutbound))
      .toBe('function');
    await alice.page.evaluate(() => (window as any).__releaseOutbound());
    await expect(
      bob.page.getByTestId('message-bubble').filter({ hasText: 'Visible before publishing' }),
    ).toBeVisible();
    const sentAt = await alice.page.evaluate(async (chatId) => {
      const { useMessageStore } = await import('/src/stores/messageStore.ts');
      return useMessageStore()
        .getMessages(chatId)
        .find((row) => row.text === 'Visible before publishing')!.sentAt;
    }, bob.session.publicKey);
    expect(Date.parse(sentAt) % 1000).toBe(0);
  } finally {
    await disposeUsers(alice, bob);
  }
});
