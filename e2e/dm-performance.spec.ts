import { finishOnboarding } from './auth-helpers';
import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19, nip59 } from 'nostr-tools';

// Explicit opt-in: timings are diagnostic, structural bounds are assertions.
// Generated accounts only; no keys or message bodies enter the report.
test('NIP-17 large-history and burst benchmark', async ({ page }, testInfo) => {
  test.skip(process.env.ANAGRAM_PERF_TEST !== '1', 'Set ANAGRAM_PERF_TEST=1');
  test.setTimeout(120000);
  const key = generateSecretKey(),
    peerKey = generateSecretKey();
  const own = getPublicKey(key),
    peer = getPublicKey(peerKey);
  await page.addInitScript(() => {
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  const wrapped = Array.from({ length: 128 }, (_, n) =>
    nip59.wrapEvent(
      {
        kind: 14,
        created_at: Math.floor(Date.now() / 1000) + n,
        tags: [['p', own]],
        content: `Benchmark DM ${n}`,
      },
      peerKey,
      own,
    ),
  );
  const report = await page.evaluate(
    async ({ own, peer, wrapped }) => {
      async function liveModule(path: string) {
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((url) => new URL(url).pathname === path);
        return import(url ?? path);
      }
      const { chatDataService: data } = await liveModule('/src/services/chatDataService.ts');
      const { useChatStore } = await liveModule('/src/stores/chatStore.ts');
      const { useNostrStore } = await liveModule('/src/stores/nostrStore.ts');
      await data.createChat({
        public_key: peer,
        name: 'Performance fixture',
        meta: { inbox_state: 'accepted' },
      });
      const db = await data.getDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        for (let n = 0; n < 20000; n++)
          tx.objectStore('messages').add({
            chat_public_key: peer,
            author_public_key: n === 0 ? peer : own,
            message: 'Cached fixture',
            created_at: new Date(1700000000000 + n * 1000).toISOString(),
            meta: {},
          });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      await useChatStore().reload();
      let cursorSteps = 0,
        transactions = 0;
      let fullHistoryReads = 0;
      const originalGetAll = IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll = function (...args) {
        if (this.objectStore.name === 'messages' && this.name === 'chat_public_key' && !args[1])
          fullHistoryReads++;
        return originalGetAll.apply(this, args);
      };
      const originalContinue = IDBCursor.prototype.continue;
      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBCursor.prototype.continue = function (...args) {
        cursorSteps++;
        return originalContinue.apply(this, args);
      };
      IDBDatabase.prototype.transaction = function (...args) {
        transactions++;
        return originalTransaction.apply(this, args);
      };
      const beforeRead = performance.now();
      await useChatStore().markAsRead(peer);
      const markRead = { ms: performance.now() - beforeRead, cursorSteps, transactions };
      cursorSteps = transactions = 0;
      const serviceTimings: Record<string, { calls: number; ms: number }> = {};
      const restores: Array<() => void> = [];
      for (const [label, service, names] of [
        [
          'messages',
          data,
          [
            'getChatByPublicKey',
            'getIncomingMessageContext',
            'getMessageByEventId',
            'getMessageByEventIdOrEditReference',
            'createMessage',
            'findDeletedMessageInSecond',
            'updateChatMeta',
            'listMessagesReplyingTo',
            'updateChatPreview',
          ],
        ],
        [
          'contacts',
          (await liveModule('/src/services/contactsService.ts')).contactsService,
          ['getContactByPublicKey'],
        ],
        [
          'events',
          (await liveModule('/src/services/nostrEventDataService.ts')).nostrEventDataService,
          ['upsertEvent'],
        ],
      ] as const)
        for (const name of names) {
          const original = service[name];
          service[name] = async function (...args) {
            const started = performance.now();
            try {
              return await original.apply(this, args);
            } finally {
              const timing = (serviceTimings[`${label}.${name}`] ??= { calls: 0, ms: 0 });
              timing.calls++;
              timing.ms += performance.now() - started;
            }
          };
          restores.push(() => {
            service[name] = original;
          });
        }
      let firstVisibleMs = 0,
        worstHeartbeatMs = 0;
      let heartbeatAt = performance.now();
      const start = heartbeatAt;
      const timer = setInterval(() => {
        const now = performance.now();
        worstHeartbeatMs = Math.max(worstHeartbeatMs, now - heartbeatAt);
        heartbeatAt = now;
        if (
          !firstVisibleMs &&
          useChatStore().chats.some((chat) => chat.lastMessage?.startsWith('Benchmark DM'))
        )
          firstVisibleMs = now - start;
      }, 16);
      try {
        const outcomes = await Promise.all(
          wrapped.map((event) =>
            useNostrStore().ingestAndroidRelayNotificationEvent({
              event,
              ownerPubkey: own,
              relayUrl: 'ws://127.0.0.1:7777/',
            }),
          ),
        );
        const elapsedMs = performance.now() - start;
        const latest = await data.listLatestMessages(peer, 128);
        return {
          cachedMessages: 20000,
          burstMessages: wrapped.length,
          markRead,
          burst: {
            ms: elapsedMs,
            messagesPerSecond: (wrapped.length * 1000) / elapsedMs,
            firstVisibleMs,
            worstHeartbeatMs,
            transactions,
            cursorSteps,
            committed: latest.rows.filter((row) => row.message.startsWith('Benchmark DM')).length,
            acknowledged: outcomes.filter(Boolean).length,
          },
          fullHistoryReads,
          serviceTimings,
        };
      } finally {
        clearInterval(timer);
        restores.forEach((restore) => restore());
        IDBIndex.prototype.getAll = originalGetAll;
        IDBCursor.prototype.continue = originalContinue;
        IDBDatabase.prototype.transaction = originalTransaction;
      }
    },
    { own, peer, wrapped },
  );
  expect(report.fullHistoryReads).toBe(0);
  expect(report.markRead.cursorSteps).toBeLessThan(20);
  expect(report.burst.cursorSteps).toBeLessThan(4096);
  expect(report.burst.committed).toBe(128);
  expect(report.burst.acknowledged).toBe(128);
  // A reload discards in-memory queues, worker caches and event deduplication.
  // Completion receipts must still avoid decrypting committed wrappers again.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  const replay = await page.evaluate(
    async ({ own, wrapped }) => {
      const path = '/src/stores/nostrStore.ts';
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((url) => new URL(url).pathname === path);
      const { useNostrStore } = await import(url ?? path);
      const ids = new Set(wrapped.map((event) => event.id));
      let decryptions = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        if (ids.has(args[0]?.wrap?.id)) decryptions++;
        return post.apply(this, args);
      };
      const start = performance.now();
      try {
        const results = await Promise.all(
          wrapped.map((event) =>
            useNostrStore().ingestAndroidRelayNotificationEvent({
              event,
              ownerPubkey: own,
              relayUrl: 'ws://127.0.0.1:7777/',
            }),
          ),
        );
        return {
          ms: performance.now() - start,
          decryptions,
          acknowledged: results.filter(Boolean).length,
        };
      } finally {
        Worker.prototype.postMessage = post;
      }
    },
    { own, wrapped },
  );
  expect(replay.decryptions).toBe(0);
  expect(replay.acknowledged).toBe(128);
  const finalReport = { ...report, replayAfterReload: replay };
  console.log('DM_PERFORMANCE', JSON.stringify(finalReport));
  await testInfo.attach('dm-performance.json', {
    body: JSON.stringify(finalReport, null, 2),
    contentType: 'application/json',
  });
});
