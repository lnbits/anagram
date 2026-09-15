import {
  type DeveloperTraceEntry,
  developerTraceDataService,
} from 'src/services/developerTraceDataService';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

it('writes a batch in one transaction, counts once, and prunes only the oldest overflow', async () => {
  const rows = Array.from({ length: 9999 }, (_, index) => ({ id: String(index) }));
  const deleted: string[] = [];
  const transaction = { oncomplete: null as null | (() => void), objectStore: () => store };
  const store = {
    put: vi.fn((entry: DeveloperTraceEntry) => {
      rows.push(entry);
    }),
    count: vi.fn(() => {
      const request = { result: rows.length, onsuccess: null as null | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }),
    index: vi.fn(() => ({
      openCursor: vi.fn(() => {
        let index = 0;
        const request = { result: null as unknown, onsuccess: null as null | (() => void) };
        const advance = () => {
          request.result =
            index < rows.length
              ? {
                  delete: () => {
                    deleted.push(rows[index]?.id ?? '');
                  },
                  continue: () => {
                    index += 1;
                    queueMicrotask(advance);
                  },
                }
              : null;
          request.onsuccess?.();
          // Match IDB completion: the transaction completes once no more requests
          // were queued by the last cursor callback (9999 + 3 - 10000 = 2).
          if (deleted.length === 2) queueMicrotask(() => transaction.oncomplete?.());
        };
        queueMicrotask(advance);
        return request;
      }),
    })),
  };
  const db = { transaction: vi.fn(() => transaction) };
  vi.spyOn(
    developerTraceDataService as unknown as { getDatabase: () => Promise<unknown> },
    'getDatabase'
  ).mockResolvedValue(db);
  const entries = ['a', 'b', 'c'].map(
    (id): DeveloperTraceEntry => ({
      id,
      timestamp: new Date().toISOString(),
      scope: 'relay',
      phase: 'auth-failed',
      level: 'warn',
      details: { repeatCount: 1300 },
    })
  );
  await developerTraceDataService.appendEntries(entries);
  expect(db.transaction).toHaveBeenCalledExactlyOnceWith('trace_entries', 'readwrite');
  expect(store.put).toHaveBeenCalledTimes(3);
  expect(store.count).toHaveBeenCalledTimes(1);
  expect(deleted).toEqual(['0', '1']);
  expect(rows.length - deleted.length).toBe(10000);
});
