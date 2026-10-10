import { test, expect } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  createGroup,
  navigateToChat,
} from './parity/helpers';

for (const kind of ['dm', 'private', 'public'] as const) {
  test(`${kind} replies summarize invite and media URLs and stay within the thread`, async ({
    browser,
  }, info) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`replyPreview${kind}`]);
    const peer =
      kind === 'dm' ? await bootstrapUser(browser, TEST_ACCOUNTS.replyPreviewPeer) : undefined;
    const page = user.page;
    try {
      await page.route('https://media.example.org/**', (route) => route.fulfill({ status: 204 }));
      let chatId = '';
      if (peer) {
        await establishAcceptedDirectChat(user, peer);
        chatId = peer.session.publicKey;
        await navigateToChat(page, chatId);
      } else if (kind === 'private') {
        chatId = await createGroup(page, { name: 'Reply previews', about: 'Shared previews' });
        await navigateToChat(page, chatId);
      } else {
        await page.getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('button', { name: 'New public group', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'New public group' });
        await dialog.getByLabel('Group name', { exact: true }).fill('Reply previews');
        await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
        await expect(page).toHaveURL(/\/public\/naddr/);
        await expect(page.getByLabel('Public message', { exact: true })).toBeEnabled();
      }
      const naddr = nip19.naddrEncode({
        kind: 34550,
        pubkey: user.session.publicKey,
        identifier: 'invitation',
        relays: ['wss://relay.example.org/' + 'x'.repeat(180)],
      });
      const token = Buffer.from(
        JSON.stringify({
          id: '12345678-1234-4123-8123-123456789abc',
          host: user.session.publicKey,
          secret: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          relays: ['ws://127.0.0.1:7777/'],
        }),
      ).toString('base64url');
      const cases = [
        { text: `https://anagram.chat/join/chat.html#/public/${naddr}`, label: 'Join chat' },
        { text: `https://anagram.chat/join/call.html#/call/${token}`, label: 'Join call' },
        {
          text: `https://media.example.org/${'a'.repeat(64)}`,
          label: 'Picture',
          mimeType: 'image/png',
        },
        {
          text: `https://media.example.org/${'b'.repeat(64)}`,
          label: 'Video',
          mimeType: 'video/mp4',
        },
        { text: `https://example.org/${'x'.repeat(500)}`, label: 'https://example.org/' },
      ];
      for (const [index, item] of cases.entries()) {
        if (index === 2) await page.setViewportSize({ width: 390, height: 844 });
        const id = await page.evaluate(
          async ({ kind, chatId, item }) => {
            const attachment = item.mimeType
              ? { type: 'media' as const, url: item.text, mimeType: item.mimeType, size: 10 }
              : undefined;
            if (kind === 'public') {
              const { useNostrStore } = await import('/src/stores/nostrStore.ts');
              const runtime = useNostrStore().publicGroups;
              await runtime.send(item.text, attachment);
              let id = '';
              const stop = runtime.state.subscribe((state) => {
                id = state.messages.find((event) => event.content === item.text)?.id ?? '';
              });
              stop();
              return id;
            }
            const { useMessageStore } = await import('/src/stores/messageStore.ts');
            const store = useMessageStore();
            const message = attachment
              ? await store.sendMediaAttachment(chatId, attachment)
              : await store.sendMessage(chatId, item.text);
            return message!.id;
          },
          { kind, chatId, item },
        );
        const source = page.locator(`[id="message-${id}"]`);
        await source.hover();
        await source.getByRole('button', { name: 'Message actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
        await expect(page.locator('.composer-context')).toContainText(item.label);
        if (index < 4) await expect(page.locator('.composer-context')).not.toContainText(item.text);
        const reply = `Reply preview case ${index}`;
        await page.getByTestId('message-composer-input').fill(reply);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const row = page
          .getByTestId(kind === 'public' ? 'public-message' : 'message-bubble')
          .filter({ hasText: reply });
        const quote = row.locator('.reply-preview');
        await expect(quote).toContainText(item.label);
        if (index < 4) await expect(quote).not.toContainText(item.text);
        expect(await quote.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (peer)
          await expect(
            peer.page
              .getByTestId('message-bubble')
              .filter({ hasText: reply })
              .locator('.reply-preview'),
          ).toContainText(item.label);
        await quote.click();
        await expect(source).toHaveClass(/highlighted/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          page.viewportSize()!.width,
        );
      }
      await page.reload();
      await expect(page.locator('.reply-preview').filter({ hasText: 'Join chat' })).toHaveCount(1);
      await expect(page.locator('.reply-preview').filter({ hasText: 'Video' })).toHaveCount(1);
      await page.screenshot({ path: info.outputPath(`${kind}-reply-previews.png`) });
    } finally {
      await disposeUsers(user, ...(peer ? [peer] : []));
    }
  });
}
