import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  sendMessage,
  threadMessage,
  TEST_ACCOUNTS,
  E2E_RELAY_URL,
  navigateToChat,
  waitForThreadMessage,
} from '../helpers';

test('message relay details update after retry and only standalone emoji are enlarged', async ({
  browser,
}, info) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.presentationAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.presentationBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    for (const text of ['Hello 👍🏽', '👍🏽👍🏽', '123', '👍🏽']) await sendMessage(alice.page, text);
    const fontSize = (text: string) =>
      threadMessage(alice.page, text)
        .locator('.message-text')
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const normal = await fontSize('Hello 👍🏽');
    expect(await fontSize('👍🏽')).toBe(normal * 3);
    expect(await fontSize('👍🏽👍🏽')).toBe(normal);
    expect(await fontSize('123')).toBe(normal);

    const sent = threadMessage(alice.page, '123');
    const indicator = sent.getByTestId('message-relay-status');
    await expect(indicator.locator('.bubble__status-segment--green')).toBeVisible();
    await expect(indicator.locator('.bubble__status-segment--blue')).toBeVisible();
    await indicator.click();
    const details = alice.page.getByRole('dialog', { name: 'Relay Status', exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByTestId('relay-status-panel-recipient')).toContainText(E2E_RELAY_URL);
    await details.getByTestId('relay-status-tab-self').click();
    await expect(details.getByTestId('relay-status-panel-self')).toContainText('published');
    await alice.page.keyboard.press('Escape');
    await expect(details).toBeHidden();

    // Simulate a lost acknowledgement for a real signed event. Retry must use
    // its stored envelope and update the open dialog without a page reload.
    await alice.page.evaluate(async (chatId) => {
      const { useMessageStore } = await import('/src/stores/messageStore.ts');
      const store = useMessageStore();
      const message = store.getMessages(chatId).find((message) => message.text === '123')!;
      const relay = message.nostrEvent!.relay_statuses.find(
        (status) => status.scope === 'recipient',
      )!.relay_url;
      await window.__appE2E__!.seedFailedOutboundRelay({
        eventId: message.eventId!,
        relayUrl: relay,
      });
      await store.reloadLoadedMessages();
    }, bob.session.publicKey);
    await expect(indicator.locator('.bubble__status-segment--red')).toBeVisible();
    await indicator.click();
    await details.getByTestId('relay-status-tab-recipient').click();
    await expect(details.getByTestId('relay-status-panel-recipient')).toContainText('failed');
    await details.getByTestId('relay-status-retry-all-button').click();
    await expect(details.getByTestId('relay-status-panel-recipient')).toContainText('published');
    await expect(indicator.locator('.bubble__status-segment--red')).toHaveCount(0);
    await alice.page.screenshot({ path: info.outputPath('relay-details.png') });
    await details.getByRole('button', { name: 'Close relay details' }).click();

    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessage(bob.page, '123');
    await threadMessage(bob.page, '123').getByTestId('message-relay-status').click();
    const received = bob.page.getByRole('dialog');
    await expect(received).toContainText(E2E_RELAY_URL);
    await expect(received.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await bob.page.keyboard.press('Escape');

    const sidebar = alice.page.locator('.sidebar-content');
    await alice.page.getByTestId('chat-thread').hover();
    await expect(sidebar).toHaveCSS('scrollbar-width', 'thin');
    await expect(sidebar).toHaveCSS('scrollbar-color', 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
    await expect(alice.page.getByTestId('chat-thread')).toHaveCSS('scrollbar-width', 'thin');
    // Overflow reveals the shared thumb on hover without shifting chat rows.
    const sidebarWidth = await sidebar.evaluate((node) => {
      const spacer = document.createElement('div');
      spacer.dataset.scrollbarTest = '';
      spacer.style.height = '2000px';
      node.appendChild(spacer);
      node.scrollTop = 100;
      if (node.scrollTop === 0) throw new Error('Sidebar must remain scrollable');
      return node.clientWidth;
    });
    await sidebar.hover();
    await expect(sidebar).toHaveCSS('scrollbar-color', 'rgb(82, 97, 113) rgba(0, 0, 0, 0)');
    expect(await sidebar.evaluate((node) => node.clientWidth)).toBe(sidebarWidth);
    await alice.page.getByTestId('chat-thread').hover();
    await expect(sidebar).toHaveCSS('scrollbar-color', 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
    await sidebar.evaluate((node) => node.querySelector('[data-scrollbar-test]')?.remove());
    await alice.page.screenshot({ path: info.outputPath('message-presentation.png') });
    await alice.page.setViewportSize({ width: 390, height: 844 });
    await indicator.click();
    await expect(details).toBeVisible();
    expect(
      await details.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        );
      }),
    ).toBe(true);
    await alice.page.screenshot({ path: info.outputPath('relay-details-mobile.png') });
    await alice.page.keyboard.press('Escape');
    await expect(details).toBeHidden();
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('bubble authors sit inside the first bubble with avatars beside the last, while text view is preserved', async ({
  browser,
}, info) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.bubbleLayoutAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.bubbleLayoutBob);
  const caption = 'Bubble layout media caption';
  const image = 'https://media.example.test/bubble-layout.svg';
  async function layout(value: 'text' | 'bubbles') {
    await alice.page.evaluate((layout) => {
      localStorage.setItem('ui-desktop-message-layout', layout);
      window.dispatchEvent(
        new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout } }),
      );
    }, value);
  }
  try {
    await alice.page.route(image, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="220"><rect width="480" height="220" fill="#427286"/><circle cx="240" cy="110" r="65" fill="#72cab7"/></svg>',
      }),
    );
    await establishAcceptedDirectChat(alice, bob);
    const setupSecond = Math.floor(Date.now() / 1000);
    await bob.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, setupSecond);
    // An outgoing message separates this author's run from the setup greeting.
    await sendMessage(alice.page, 'Show the bubble layout');
    const firstSecond = Math.floor(Date.now() / 1000);
    await bob.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, firstSecond);
    await sendMessage(bob.page, caption);
    const second = Math.floor(Date.now() / 1000);
    await bob.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, second);
    await sendMessage(bob.page, 'Gm');
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, 'Gm');
    await alice.page.evaluate(
      async ({ chatId, caption, image, author }) => {
        const { useTrustedMediaStore } = await import('/src/stores/trustedMediaStore.ts');
        useTrustedMediaStore().trustImageSender(author);
        await window.__appE2E__!.setStoredMessageAttachments({
          chatId,
          messageText: caption,
          attachments: [
            {
              type: 'media',
              url: image,
              mimeType: 'image/svg+xml',
              size: 128,
              name: 'bubble-layout.svg',
            },
          ],
        });
      },
      { chatId: bob.session.publicKey, caption, image, author: bob.session.publicKey },
    );
    const first = threadMessage(alice.page, caption);
    const last = threadMessage(alice.page, 'Gm');
    await layout('text');
    const textStyle = () =>
      first.locator('.message-content').evaluate((node) => {
        const css = getComputedStyle(node);
        return {
          padding: css.padding,
          background: css.backgroundColor,
          radius: css.borderRadius,
          fontSize: css.fontSize,
        };
      });
    const original = await textStyle();
    await expect(first.locator(':scope > .message-author')).toBeVisible();
    await layout('bubbles');
    await expect(first.locator('.message-content > .bubble-author-name')).toHaveText(
      bob.account.displayName,
    );
    await expect(last.locator('.bubble-author-name')).toHaveCount(0);
    await expect(first.locator('.bubble-avatar')).toHaveCount(0);
    await expect(last.locator('.bubble-avatar')).toBeVisible();
    const checkGeometry = async () => {
      // Image loading and scroll anchoring can move the row between separate
      // boundingBox calls. Read both rectangles in the same browser frame.
      await expect
        .poll(() =>
          last.evaluate((row) => {
            const avatar = row.querySelector('.bubble-avatar')!.getBoundingClientRect();
            const bubble = row.querySelector('.message-content')!.getBoundingClientRect();
            return avatar.right < bubble.left && Math.abs(avatar.bottom - bubble.bottom) < 2;
          }),
        )
        .toBe(true);
      await expect
        .poll(() =>
          first
            .locator('.media-attachment img')
            .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      // Scroll anchoring can move the row; compare both positions in one frame.
      await expect
        .poll(() =>
          first.evaluate((row) => {
            const media = row.querySelector('.media-attachment img')!.getBoundingClientRect();
            const text = row.querySelector('.message-text')!.getBoundingClientRect();
            return media.bottom <= text.top;
          }),
        )
        .toBe(true);
      expect(
        await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    };
    await checkGeometry();
    const shortText = await last.locator('.message-text').boundingBox();
    const time = await last.locator('.message-time').boundingBox();
    expect(Math.abs(shortText!.y - time!.y)).toBeLessThan(8);
    await alice.page.screenshot({ path: info.outputPath('bubble-layout-desktop.png') });
    await last.getByTestId('message-relay-status').click();
    await expect(alice.page.getByRole('dialog')).toBeVisible();
    await alice.page.keyboard.press('Escape');
    await alice.page.setViewportSize({ width: 390, height: 844 });
    await checkGeometry();
    await alice.page.screenshot({ path: info.outputPath('bubble-layout-mobile.png') });
    await alice.page.setViewportSize({ width: 1280, height: 720 });
    await layout('text');
    await expect(first.locator(':scope > .message-author')).toBeVisible();
    await expect(first.locator('.bubble-author-name')).toHaveCount(0);
    expect(await textStyle()).toEqual(original);
  } finally {
    await disposeUsers(alice, bob);
  }
});
