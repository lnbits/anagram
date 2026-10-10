import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  navigateInApp,
  navigateToChat,
  TEST_ACCOUNTS,
} from './parity/helpers';

// Playwright tracing itself retains DOM snapshots; exclude it from heap measurements.
test.use({ trace: 'off' });

test('message rendering, profile discovery and repeated navigation settle after collection', async ({
  browser,
}, info) => {
  test.slow();
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.memoryLifetime);
  const { page } = user;
  const peer = 'a'.repeat(64);
  const cdp = await user.context.newCDPSession(page);
  const samples: Array<{ heap: number; nodes: number; listeners: number; messages: number }> = [];
  async function sample() {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    return {
      heap: usedSize,
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      messages: await page.getByTestId('message-bubble').count(),
    };
  }
  function expectSettled(baseline: (typeof samples)[number], last: (typeof samples)[number]) {
    expect(last.messages).toBeLessThanOrEqual(300);
    expect(last.nodes).toBeLessThanOrEqual(baseline.nodes + 200);
    expect(last.listeners).toBeLessThanOrEqual(baseline.listeners + 20);
    expect(last.heap).toBeLessThan(baseline.heap + 6 * 1024 * 1024);
  }
  try {
    await page.evaluate(async (peer) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      const { useChatStore } = await import('/src/stores/chatStore.ts');
      await chatDataService.createChat({
        public_key: peer,
        name: 'Memory exercise',
        meta: { inbox_state: 'accepted' },
      });
      await useChatStore().reload();
    }, peer);
    for (let round = 0; round < 8; round++) {
      await navigateToChat(page, peer);
      await page.evaluate(
        async ({ peer, round }) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const { useMessageStore } = await import('/src/stores/messageStore.ts');
          const { rememberPublicProfile } = await import('/src/lib/state/publicProfiles.ts');
          const store = useMessageStore();
          for (let n = 0; n < 320; n++) {
            const row = await chatDataService.createMessage({
              chat_public_key: peer,
              author_public_key: peer,
              message: `Memory message ${round * 320 + n}`,
              created_at: new Date(1700000000000 + (round * 320 + n) * 1000).toISOString(),
              meta: {},
            });
            if (row) await store.upsertPersistedMessage(row);
          }
          for (let n = 0; n < 6000; n++)
            rememberPublicProfile(
              (1 + round * 6000 + n).toString(16).padStart(64, '0'),
              { name: `Public profile ${round}-${n}` },
              1,
            );
        },
        { peer, round },
      );
      await expect(page.getByTestId('message-bubble').last()).toContainText(
        `Memory message ${round * 320 + 319}`,
      );
      expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(300);
      // Repeated mounting must release the prior UI's observers/listeners.
      await navigateInApp(page, '/settings/profile');
      await expect(page.getByTestId('chat-thread')).toHaveCount(0);
      await page.waitForTimeout(500); // Let the 16ms UI coalescers and observers settle.
      samples.push(await sample());
    }
    // Compare after warm-up; disk history keeps growing while live state stays bounded.
    expectSettled(samples[2], samples.at(-1)!);
    // Leave an actual conversation open across background watchdog/recheck ticks.
    await navigateToChat(page, peer);
    await page.waitForTimeout(1500);
    const idleBaseline = await sample();
    samples.push(idleBaseline);
    for (let tick = 0; tick < 2; tick++) {
      await page.waitForTimeout(20000);
      const idle = await sample();
      samples.push(idle);
      expectSettled(idleBaseline, idle);
    }
  } finally {
    console.log('Memory samples:', JSON.stringify(samples));
    await info.attach('memory-samples', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    await cdp.detach();
    await disposeUsers(user);
  }
});
