import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  createGroup,
  navigateToChat,
  openDirectChatFromIdentifier,
  sendMessagesViaBridge,
} from './parity/helpers';

for (const kind of ['dm', 'private', 'public'] as const) {
  test(`${kind} releases bottom following on a gentle upward scroll`, async ({ browser }) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`bottomFollow${kind}`]);
    const peer =
      kind === 'dm' ? await bootstrapUser(browser, TEST_ACCOUNTS.bottomFollowPeer) : undefined;
    const page = user.page;
    try {
      let chatId = '';
      if (peer) {
        chatId = peer.session.publicKey;
        await openDirectChatFromIdentifier(page, peer.session.npub, 'Scroll peer');
      } else if (kind === 'private') {
        chatId = await createGroup(page, { name: 'Scroll group', about: '' });
        await navigateToChat(page, chatId);
      } else {
        await page.getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('button', { name: 'New public group', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'New public group', exact: true });
        await dialog.getByLabel('Group name', { exact: true }).fill('Scroll public group');
        await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
        await expect(page.getByLabel('Public message', { exact: true })).toBeEnabled();
      }
      const append = async (texts: string[]) => {
        if (kind === 'public') {
          await page.evaluate(async (texts) => {
            const { useNostrStore } = await import('/src/stores/nostrStore.ts');
            for (const text of texts) await useNostrStore().publicGroups.send(text);
          }, texts);
        } else await sendMessagesViaBridge(page, chatId, texts);
      };
      const thread = page.getByTestId('chat-thread');
      const latest = page.getByRole('button', { name: 'Jump to latest messages' });
      await append(['First message']);
      await thread.hover();
      await page.mouse.wheel(0, -2);
      await expect(latest).toHaveCount(0);
      await append(
        Array.from({ length: 25 }, (_, i) => `Scroll message ${i}\nSecond line\nThird line`),
      );
      const bottomDistance = () =>
        thread.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
      await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
      expect(
        await thread.evaluate((node) => node.scrollHeight - node.clientHeight),
      ).toBeGreaterThan(200);
      await thread.hover();
      for (let step = 0; step < 4; step++) {
        const before = await thread.evaluate((node) => node.scrollTop);
        await page.mouse.wheel(0, -2);
        await expect.poll(() => thread.evaluate((node) => node.scrollTop)).toBeLessThan(before);
        await expect(latest).toBeVisible();
      }
      // Stay well inside the old 100px sticky zone while new events update the UI.
      expect(await bottomDistance()).toBeLessThan(100);
      const readingTop = await thread.evaluate((node) => node.scrollTop);
      await append(['A new message while reading']);
      await expect(thread.getByText('A new message while reading', { exact: true })).toHaveCount(1);
      await expect
        .poll(() => thread.evaluate((node, top) => Math.abs(node.scrollTop - top), readingTop))
        .toBeLessThan(2);
      await expect(latest).toBeVisible();
      // A composer/viewport resize must not silently turn following back on.
      await page.setViewportSize({ width: 1280, height: 680 });
      await expect(latest).toBeVisible();
      await latest.click();
      await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
      await expect(latest).toHaveCount(0);
      await append(['A new message while following']);
      await expect(thread.getByText('A new message while following', { exact: true })).toHaveCount(
        1,
      );
      await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
      // Returning manually to the bottom resumes following too.
      await thread.hover();
      await page.mouse.wheel(0, -3);
      await expect(latest).toBeVisible();
      await page.mouse.wheel(0, 1000);
      await expect(latest).toHaveCount(0);
      await append(['Still following after scrolling down']);
      await expect(
        thread.getByText('Still following after scrolling down', { exact: true }),
      ).toHaveCount(1);
      await expect.poll(bottomDistance).toBeLessThanOrEqual(1);
      expect(user.browserErrors).toEqual([]);
    } finally {
      await disposeUsers(user, ...(peer ? [peer] : []));
    }
  });
}
