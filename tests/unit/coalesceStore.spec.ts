import { afterEach, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';
import { coalesceStore } from '../../src/lib/state/coalesceStore.ts';

afterEach(() => vi.useRealTimers());

it('publishes recipient changes immediately while keeping same-chat hydration batched', () => {
  vi.useFakeTimers();
  const source = writable({ chat: 'alice', revision: 0 });
  const seen = vi.fn();
  const stop = coalesceStore(source, (value) => value.chat).subscribe(seen);
  source.set({ chat: 'alice', revision: 1 });
  source.set({ chat: 'alice', revision: 2 });
  expect(seen).toHaveBeenCalledTimes(1);
  source.set({ chat: 'bob', revision: 3 });
  expect(seen.mock.calls).toEqual([
    [{ chat: 'alice', revision: 0 }],
    [{ chat: 'bob', revision: 3 }],
  ]);
  expect(vi.getTimerCount()).toBe(0);
  source.set({ chat: 'bob', revision: 4 });
  source.set({ chat: 'bob', revision: 5 });
  vi.advanceTimersByTime(16);
  expect(seen).toHaveBeenCalledTimes(3);
  expect(seen).toHaveBeenLastCalledWith({ chat: 'bob', revision: 5 });
  source.set({ chat: 'bob', revision: 6 });
  source.set({ chat: 'alice', revision: 7 });
  vi.runAllTimers();
  expect(seen).toHaveBeenCalledTimes(4);
  expect(seen).toHaveBeenLastCalledWith({ chat: 'alice', revision: 7 });
  stop();
});

it('publishes initial state immediately and coalesces bursts without postponing the flush', () => {
  vi.useFakeTimers();
  const source = writable(0);
  const seen: number[] = [];
  const stop = coalesceStore(source).subscribe((value) => seen.push(value));
  expect(seen).toEqual([0]);
  source.set(1);
  vi.advanceTimersByTime(10);
  source.set(2);
  vi.advanceTimersByTime(6);
  expect(seen).toEqual([0, 2]);
  source.set(3);
  vi.advanceTimersByTime(16);
  expect(seen).toEqual([0, 2, 3]);
  expect(vi.getTimerCount()).toBe(0);
  stop();
});

it('releases the source and pending flush when the component unsubscribes', () => {
  vi.useFakeTimers();
  const cleanup = vi.fn();
  let emit!: (value: number) => void;
  const source = readable(0, (set) => {
    emit = set;
    return cleanup;
  });
  const run = vi.fn();
  const stop = coalesceStore(source).subscribe(run);
  emit(1);
  stop();
  vi.runAllTimers();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('flushes an explicit navigation once without leaving timers or stopped consumers', () => {
  vi.useFakeTimers();
  const source = writable(0);
  const store = coalesceStore(source);
  const seen = vi.fn();
  const stop = store.subscribe(seen);
  source.set(1);
  source.set(2);
  store.flush();
  expect(seen.mock.calls).toEqual([[0], [2]]);
  expect(vi.getTimerCount()).toBe(0);
  store.flush();
  vi.runAllTimers();
  expect(seen).toHaveBeenCalledTimes(2);
  source.set(3);
  stop();
  store.flush();
  expect(seen).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
