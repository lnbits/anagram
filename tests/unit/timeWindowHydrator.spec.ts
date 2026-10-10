import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateTimeWindows } from '#src/stores/nostr/timeWindowHydrator.ts';

afterEach(() => vi.useRealTimers());
describe('bounded time-window hydration workers', () => {
  it('limits concurrent batches to two and discovers new groups between batches', async () => {
    vi.useFakeTimers();
    const targets = [{ key: 'dm' }, { key: 'group-a' }, { key: 'group-b' }];
    let active = 0,
      peak = 0;
    const seen: string[] = [];
    const work = hydrateTimeWindows({
      discover: async () => [...targets],
      cancelled: () => false,
      signal: new AbortController().signal,
      onError: vi.fn(),
      step: async (target) => {
        active++;
        peak = Math.max(peak, active);
        seen.push(target.key);
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (target.key === 'dm') targets.push({ key: 'older-group' });
        active--;
        return true;
      },
    });
    await vi.runAllTimersAsync();
    await work;
    expect(peak).toBe(2);
    expect(seen).toEqual(['dm', 'group-a', 'group-b', 'older-group']);
  });
  it('continues a healthy route while another route retries with backoff', async () => {
    vi.useFakeTimers();
    let healthyPages = 0,
      brokenAttempts = 0;
    const onError = vi.fn();
    const work = hydrateTimeWindows({
      discover: async () => [{ key: 'broken' }, { key: 'healthy' }],
      cancelled: () => false,
      signal: new AbortController().signal,
      onError,
      step: async (target) => {
        if (target.key === 'broken' && ++brokenAttempts === 1) throw new Error('offline');
        if (target.key === 'healthy') return ++healthyPages === 3;
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(healthyPages).toBe(3);
    expect(brokenAttempts).toBe(1);
    await vi.runAllTimersAsync();
    await work;
    expect(brokenAttempts).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('does not let two stalled groups on one relay occupy both workers', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const seen: string[] = [];
    const work = hydrateTimeWindows({
      discover: async () => [
        { key: 'broken-group-a', relay: 'broken' },
        { key: 'broken-group-b', relay: 'broken' },
        { key: 'healthy-inbox', relay: 'healthy' },
      ],
      signal: abort.signal,
      concurrencyKey: (target) => target.relay,
      cancelled: () => false,
      onError: vi.fn(),
      step: async (target) => {
        seen.push(target.key);
        if (target.relay === 'broken') await new Promise<void>(() => {});
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual(['broken-group-a', 'healthy-inbox']);
    abort.abort();
    await work;
  });
  it('cancels immediately during an offline retry delay', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const step = vi.fn(async () => {
      throw new Error('offline');
    });
    const work = hydrateTimeWindows({
      discover: async () => [{ key: 'dm' }],
      step,
      cancelled: () => false,
      signal: abort.signal,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await work;
    await vi.runAllTimersAsync();
    expect(step).toHaveBeenCalledTimes(1);
  });
});

it('rotates busy routes so a newly discovered inbox gets its first page promptly', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const targets = [{ key: 'busy-a' }, { key: 'busy-b' }];
  const seen: string[] = [];
  const work = hydrateTimeWindows({
    discover: async () => [...targets],
    cancelled: () => false,
    signal: abort.signal,
    onError: vi.fn(),
    step: async (target) => {
      seen.push(target.key);
      if (seen.length === 1) targets.push({ key: 'new-inbox' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return target.key === 'new-inbox';
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen.indexOf('new-inbox')).toBeLessThan(4);
  expect(seen).toContain('new-inbox');
  abort.abort();
  await work;
});

it('a pair of silent relays does not occupy all configured history slots', async () => {
  vi.useFakeTimers();
  const abort = new AbortController(),
    seen: string[] = [];
  const work = hydrateTimeWindows({
    discover: async () => [{ key: 'silent-a' }, { key: 'silent-b' }, { key: 'inbox' }],
    concurrency: 4,
    cancelled: () => false,
    signal: abort.signal,
    onError: vi.fn(),
    step: async (target) => {
      seen.push(target.key);
      if (target.key.startsWith('silent')) await new Promise<void>(() => {});
      return true;
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(seen).toEqual(['silent-a', 'silent-b', 'inbox']);
  abort.abort();
  await work;
});
