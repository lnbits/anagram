import { expect, test } from '@playwright/test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  navigateToChat,
  TEST_ACCOUNTS,
} from './parity/helpers';

for (const width of [1280, 390])
  for (const kind of ['private', 'public'] as const) {
    test(`${kind} loads newer local history near the bottom without jumping at ${width}px`, async ({
      browser,
    }) => {
      const user = await bootstrapUser(browser, TEST_ACCOUNTS[`newer-${kind}-${width}`]);
      const { page } = user;
      await page.setViewportSize({ width, height: 844 });
      const start = Math.floor(Date.now() / 1000) - 10000;
      try {
        if (kind === 'private') {
          const group = await createGroup(page, { name: 'Newer history', about: '' });
          await page.evaluate(
            async ({ group, start }) => {
              const { chatDataService } = await import('/src/services/chatDataService.ts');
              for (let index = 0; index < 150; index++)
                await chatDataService.createMessage({
                  chat_public_key: group,
                  author_public_key: group,
                  message: `Newer history row ${index}`,
                  created_at: new Date((start + index) * 1000).toISOString(),
                });
            },
            { group, start },
          );
          await navigateToChat(page, group);
          await page.evaluate(async (group) => {
            const { chatDataService } = await import('/src/services/chatDataService.ts');
            const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
            const messages = useMessageStore();
            // Keep this local-paging fixture stable while testing scroll intent.
            // History-hydration tests cover background inbox refreshes, which can
            // otherwise expand the window between the assertions below.
            messages.reloadLoadedMessages = async () => {};
            const [first] = (await chatDataService.listLatestMessages(group, 150)).rows;
            await messages.ensureMessageLoaded(group, String(first.id));
          }, group);
        } else {
          await page.getByRole('button', { name: 'Chat options' }).click();
          await page.getByRole('button', { name: 'New public group', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'New public group', exact: true });
          await dialog.getByLabel('Group name', { exact: true }).fill('Newer public history');
          await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
          await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
          const address = await page.evaluate(async () => {
            const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
            let address = '';
            useNostrStore().publicGroups.state.subscribe((state) => {
              address = state.room!.address;
            })();
            return address;
          });
          const key = generateSecretKey();
          const events = Array.from({ length: 150 }, (_, index) =>
            finalizeEvent(
              {
                kind: 9,
                created_at: start + index,
                tags: [['a', address]],
                content: `Newer history row ${index}`,
              },
              key,
            ),
          );
          await page.evaluate(
            async ({ address, events }) => {
              const { PublicGroupData } = await import('/src/services/publicGroupData.ts');
              const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
              const nostr = useNostrStore();
              const db = new PublicGroupData(nostr.getLoggedInPublicKeyHex()!);
              await db.putMany(address, events);
              await db.close();
              nostr.publicGroups.state.update((state) => ({
                ...state,
                messages: events.slice(0, 51),
                hasNewer: true,
                loading: false,
              }));
            },
            { address, events },
          );
        }
        const thread = page.getByTestId('chat-thread');
        await expect(thread.locator('.message-row')).toHaveCount(51);
        await expect(
          page.getByRole('button', { name: 'Load newer messages', exact: true }),
        ).toHaveCount(1);
        // Position restoration alone must not start paging.
        await thread.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await page.waitForTimeout(250);
        await expect(thread.locator('.message-row')).toHaveCount(51);
        const saved = await thread.evaluate((node) => {
          const top = node.getBoundingClientRect().top;
          const row = [...node.querySelectorAll<HTMLElement>('.message-row')].find(
            (row) => row.getBoundingClientRect().bottom > top + 38,
          )!;
          return { id: row.id, offset: row.getBoundingClientRect().top - top };
        });
        if (width === 390) {
          await thread.dispatchEvent('touchstart', {
            touches: [{ identifier: 1, clientX: 200, clientY: 400 }],
          });
          await thread.dispatchEvent('touchmove', {
            touches: [{ identifier: 1, clientX: 200, clientY: 350 }],
          });
          await thread.dispatchEvent('touchend', { touches: [] });
        } else {
          await page.getByRole('button', { name: 'Load newer messages', exact: true }).click();
        }
        await expect.poll(() => thread.locator('.message-row').count()).toBeGreaterThan(51);
        await expect(
          thread.locator('[data-testid="thread-load-newer"][aria-busy="true"]'),
        ).toHaveCount(0);
        const count = await thread.locator('.message-row').count();
        expect(count).toBeLessThanOrEqual(151);
        await expect
          .poll(() =>
            thread.evaluate((node, saved) => {
              const row = document.getElementById(saved.id);
              return row
                ? Math.abs(
                    row.getBoundingClientRect().top -
                      node.getBoundingClientRect().top -
                      saved.offset,
                  )
                : Infinity;
            }, saved),
          )
          .toBeLessThan(3);
        await page.waitForTimeout(300);
        await expect(thread.locator('.message-row')).toHaveCount(count);
        expect(user.browserErrors).toEqual([]);
      } finally {
        await disposeUsers(user);
      }
    });
  }

test('newer paging ignores idle layout changes and coalesces input while loading', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { threadNewerScroll } = await import('/src/lib/actions/threadNewerScroll.ts');
    const node = document.createElement('div');
    node.style.cssText = 'height:200px;overflow:auto';
    node.innerHTML = '<div style="height:1000px"></div>';
    document.body.append(node);
    let calls = 0;
    let release = () => {};
    const action = threadNewerScroll(node, {
      chatId: 'test',
      canLoad: () => true,
      load: () => {
        calls++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const scroll = (top: number) => {
      node.scrollTop = top;
      node.dispatchEvent(new Event('scroll'));
    };
    const wheel = (deltaY: number) => node.dispatchEvent(new WheelEvent('wheel', { deltaY }));
    try {
      scroll(650);
      const idle = calls;
      wheel(-1);
      const upward = calls;
      wheel(1);
      for (let i = 0; i < 10; i++) wheel(1);
      const inFlight = calls;
      release();
      await Promise.resolve();
      scroll(700);
      const restored = calls;
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
      const keyboard = calls;
      release();
      await Promise.resolve();
      action.destroy();
      wheel(1);
      return { idle, upward, inFlight, restored, keyboard, afterDestroy: calls };
    } finally {
      action.destroy();
      node.remove();
    }
  });
  expect(result).toEqual({
    idle: 0,
    upward: 0,
    inFlight: 1,
    restored: 1,
    keyboard: 2,
    afterDestroy: 2,
  });
});
