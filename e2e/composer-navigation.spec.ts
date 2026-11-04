import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  navigateToChat,
  TEST_ACCOUNTS,
  threadMessage,
} from './parity/helpers';

for (const width of [1280, 390])
  test(`new chat accepts immediate typing for its recipient while history waits at ${width}px`, async ({
    browser,
  }) => {
    const alice = await bootstrapUser(browser, TEST_ACCOUNTS[`navigationAlice${width}`]);
    const bob = await bootstrapUser(browser, TEST_ACCOUNTS[`navigationBob${width}`]);
    const page = alice.page;
    const previousDraft = 'Keep my previous conversation draft';
    const newDraft = 'Typed immediately after opening the new conversation';
    try {
      await navigateToChat(page, alice.session.publicKey);
      await page.getByTestId('message-composer-input').fill(previousDraft);
      await page.setViewportSize({ width, height: 844 });
      if (width === 390) await page.getByRole('button', { name: 'Back to chats' }).click();
      await page.getByRole('button', { name: 'Chat options' }).click();
      await page.getByTestId('new-chat-button').click();
      await page.getByTestId('contact-identifier-input').fill(bob.session.publicKey);
      await page.getByLabel('Name (optional)', { exact: true }).fill('New recipient');

      await page.evaluate(
        async ({ recipient, text }) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const original = chatDataService.listLatestMessages.bind(chatDataService);
          let release!: () => void;
          const pending = new Promise<void>((resolve) => (release = resolve));
          chatDataService.listLatestMessages = async (chatId, ...args) => {
            if (chatId === recipient) {
              (window as any).__navigationHistoryWaiting = true;
              await pending;
            }
            return original(chatId, ...args);
          };
          (window as any).__releaseNavigationHistory = () => {
            chatDataService.listLatestMessages = original;
            release();
          };
          // Observe the first exposed composer, without waiting for the expected
          // recipient or refilling text after a later draft reset.
          const observer = new MutationObserver(() => {
            if (document.querySelector('dialog[aria-label="contact"]')) return;
            observer.disconnect();
            const input = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="message-composer-input"]',
            );
            (window as any).__exposedComposer = {
              recipient: document
                .querySelector('[data-testid="chat-thread"]')
                ?.getAttribute('data-chat-public-key'),
              draft: input?.value,
              disabled: input?.disabled,
            };
            if (input && !input.disabled) {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        },
        { recipient: bob.session.publicKey, text: newDraft },
      );

      await page.getByRole('button', { name: 'Add contact', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'contact', exact: true })).toBeHidden();
      expect(await page.evaluate(() => (window as any).__exposedComposer)).toEqual({
        recipient: bob.session.publicKey,
        draft: '',
        disabled: false,
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).__navigationHistoryWaiting))
        .toBe(true);
      await expect(page.getByTestId('message-composer-input')).toHaveValue(newDraft);
      await expect(page.getByTestId('message-send-button')).toBeEnabled();
      await page.getByTestId('message-send-button').click();
      await expect(threadMessage(page, newDraft)).toBeVisible();
      await navigateToChat(bob.page, alice.session.publicKey);
      await expect(threadMessage(bob.page, newDraft)).toBeVisible();
      await page.evaluate(() => (window as any).__releaseNavigationHistory());
      await expect(threadMessage(page, newDraft)).toBeVisible();
      if (width === 390) await page.getByRole('button', { name: 'Back to chats' }).click();
      await navigateToChat(page, alice.session.publicKey);
      await expect(page.getByTestId('message-composer-input')).toHaveValue(previousDraft);
      await expect(threadMessage(page, newDraft)).toHaveCount(0);
    } finally {
      await page.evaluate(() => (window as any).__releaseNavigationHistory?.()).catch(() => {});
      await disposeUsers(alice, bob);
    }
  });
