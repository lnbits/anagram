import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
import { E2E_RELAY_URL, navigateToChat } from './parity/helpers';

test('relay rejection stays on the message status bar without a popup; other send errors remain inline', async ({
  page,
}) => {
  // Intercept only after onboarding; all other relay traffic continues normally.
  let rejectMessages = false;
  let holdRejections = true;
  const rejections: Array<() => void> = [];
  await page.routeWebSocket(E2E_RELAY_URL, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const [type, event] = JSON.parse(String(raw));
      if (rejectMessages && type === 'EVENT' && event.kind === 1059) {
        const reject = () =>
          socket.send(JSON.stringify(['OK', event.id, false, 'blocked: test relay rejection']));
        if (holdRejections) rejections.push(reject);
        else reject();
      } else server.send(raw);
    });
  });
  await page.addInitScript((url) => {
    const relays = JSON.stringify([{ url, read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  }, E2E_RELAY_URL);
  const key = generateSecretKey();
  await page.goto('/');
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await navigateToChat(page, getPublicKey(key));
  await page.evaluate(async (own) => {
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
    for (let index = 0; index < 30; index++)
      await chatDataService.createMessage({
        chat_public_key: own,
        author_public_key: own,
        message: `Earlier message ${index}`,
        event_id: index.toString(16).padStart(64, '0'),
        created_at: new Date(Date.now() - (60 - index) * 1000).toISOString(),
        meta: {},
      });
    await useMessageStore().loadMessages(own, true);
  }, getPublicKey(key));
  const thread = page.getByTestId('chat-thread');
  await expect(thread.locator('.message-row')).toHaveCount(30);
  await thread.hover();
  await page.mouse.wheel(0, -300);
  await expect(page.getByRole('button', { name: 'Jump to latest messages' })).toBeVisible();
  rejectMessages = true;
  const composer = page.getByTestId('message-composer-input');
  await composer.fill('Keep the failed message visible');
  await page.getByTestId('message-send-button').click();
  const message = page
    .getByTestId('message-bubble')
    .filter({ hasText: 'Keep the failed message visible' });
  const status = message.getByTestId('message-relay-status');
  // The pending row must be revealed while the relay has not acknowledged it.
  await expect(message).toBeInViewport();
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(2);
  await expect.poll(() => rejections.length).toBeGreaterThan(0);
  holdRejections = false;
  rejections.splice(0).forEach((reject) => reject());
  await expect(status.locator('.bubble__status-segment--red')).toBeVisible();
  await expect(composer).toHaveValue('Keep the failed message visible');
  await expect(page.getByTestId('action-feedback')).toHaveCount(0);
  await status.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('blocked: test relay rejection');
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(async () => {
    const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
    useMessageStore().sendMessage = async () => {
      throw new Error('Failed to persist outbound message.');
    };
  });
  await composer.fill('Local save failure');
  await page.getByTestId('message-send-button').click();
  await expect(page.getByTestId('action-feedback')).toContainText(
    'Failed to persist outbound message.',
  );
  await expect(page.locator('.message-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await expect(page.getByTestId('action-feedback')).toHaveCount(0);
});
