import { createPrivateMessagesUiRuntime } from 'src/stores/nostr/privateMessagesUiRuntime';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
it('coalesces a restore burst and resolves the final flush only after the final reload', async () => {
  vi.useFakeTimers();
  let drain = () => {};
  let finishReload = () => {};
  const reload = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishReload = resolve;
      })
  );
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const runtime = createPrivateMessagesUiRuntime({
    chatStore: { reload },
    normalizeThrottleMs: (ms) => ms ?? 0,
    refreshDeveloperPendingQueues: vi.fn(async () => {}),
    waitForPrivateMessagesIngestQueue: () => drained,
  });
  for (let i = 0; i < 1000; i++)
    runtime.queuePrivateMessagesUiRefresh({ reloadChats: true, throttleMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(reload).not.toHaveBeenCalled();
  let done = false;
  const flushed = runtime.flushPrivateMessagesUiRefreshNow().then(() => {
    done = true;
  });
  drain();
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  finishReload();
  await flushed;
  expect(done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not reload a previous session after cancellation', async () => {
  vi.useFakeTimers();
  let drain = () => {};
  const reload = vi.fn(async () => {});
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const runtime = createPrivateMessagesUiRuntime({
    chatStore: { reload },
    normalizeThrottleMs: (ms) => ms ?? 0,
    refreshDeveloperPendingQueues: vi.fn(async () => {}),
    waitForPrivateMessagesIngestQueue: () => drained,
  });
  runtime.queuePrivateMessagesUiRefresh({ reloadChats: true });
  const flushed = runtime.flushPrivateMessagesUiRefreshNow();
  runtime.resetPrivateMessagesUiRuntimeState({ includeRefreshQueue: true });
  drain();
  await flushed;
  expect(reload).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
