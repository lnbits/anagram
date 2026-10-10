import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createThreadHistoryRuntime,
  type ThreadHistoryQuery,
} from '#src/stores/nostr/threadHistoryRuntime.ts';
const now = 1800000000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => vi.useRealTimers());
function setup(query?: (q: ThreadHistoryQuery) => Promise<{ eventCount: number; oldest: number }>) {
  let owner = 'account';
  const fetch = vi.fn(
    query ??
      (async (q) => {
        q.pager?.advance(0, Infinity);
        return { eventCount: 0, oldest: Infinity };
      }),
  );
  const context = vi.fn(async (chat: string) => ({
    routes: [{ publicKey: chat === 'group' ? 'epoch' : 'account', relayUrls: ['wss://inbox/'] }],
    timestamps: [now - 100 * 86400],
  }));
  const runtime = createThreadHistoryRuntime({
    owner: () => owner,
    context,
    query: fetch,
    onError: vi.fn(),
  });
  return {
    runtime,
    fetch,
    context,
    changeAccount: () => {
      owner = 'another-account';
    },
  };
}
it('rechecks the cached conversation period before recent history, then probes older history', async () => {
  const { runtime, fetch } = setup();
  runtime.select('peer');
  await vi.runAllTimersAsync();
  const requests = fetch.mock.calls.map(([q]) => q);
  expect(requests[0].until).toBeLessThan(now - 90 * 86400);
  expect(requests[0].since).toBeLessThan(now - 102 * 86400);
  expect(requests[0].publicKey).toBe('account');
  expect(requests.some((q) => q.until === now)).toBe(true);
  expect(requests.some((q) => q.probe && q.since === 0)).toBe(true);
  runtime.stop();
});
it('coalesces duplicate active selections and re-fetches when a completed thread is clicked again', async () => {
  const { runtime, fetch, context } = setup();
  runtime.select('peer');
  runtime.select('peer');
  await vi.runAllTimersAsync();
  expect(context).toHaveBeenCalledTimes(1);
  const count = fetch.mock.calls.length;
  runtime.select('peer');
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(count);
  runtime.select('peer', true);
  await vi.runAllTimersAsync();
  expect(fetch.mock.calls.length).toBeGreaterThan(count);
  runtime.stop();
});
it('aborts the old request immediately on switching threads or leaving the chat', async () => {
  const { runtime, fetch } = setup(async () => new Promise(() => {}));
  runtime.select('peer');
  await vi.advanceTimersByTimeAsync(0);
  const first = fetch.mock.calls[0][0];
  runtime.select('group');
  expect(first.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  const second = fetch.mock.calls[1][0];
  expect(second.publicKey).toBe('epoch');
  runtime.select(null);
  expect(second.signal.aborted).toBe(true);
});
it('discards late context after an account switch', async () => {
  const { runtime, fetch, changeAccount } = setup();
  runtime.select('peer');
  changeAccount();
  await vi.runAllTimersAsync();
  expect(fetch).not.toHaveBeenCalled();
  runtime.stop();
});
it('continues independent relays while a failed relay backs off', async () => {
  const { runtime, context, fetch } = setup(async (q) => {
    if (q.relayUrl === 'wss://offline/') throw new Error('offline');
    q.pager?.advance(0, Infinity);
    return { eventCount: 0, oldest: Infinity };
  });
  context.mockResolvedValue({
    routes: [{ publicKey: 'account', relayUrls: ['wss://offline/', 'wss://inbox/'] }],
    timestamps: [],
  });
  runtime.select('peer');
  await vi.advanceTimersByTimeAsync(800);
  expect(fetch.mock.calls.some(([q]) => q.relayUrl === 'wss://inbox/' && q.probe)).toBe(true);
  runtime.stop();
});

it('explicitly clicking an active thread starts a fresh check instead of hiding behind an old scan', async () => {
  const { runtime, fetch, context } = setup(async () => new Promise(() => {}));
  runtime.select('peer');
  await vi.advanceTimersByTimeAsync(1);
  const first = fetch.mock.calls[0][0];
  runtime.select('peer', true);
  await vi.advanceTimersByTimeAsync(1);
  expect(first.signal.aborted).toBe(true);
  expect(context).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  runtime.stop();
});
