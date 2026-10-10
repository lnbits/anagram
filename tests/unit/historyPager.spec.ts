import { describe, it, expect } from 'vitest';
import { HistoryPager } from '#src/stores/nostr/historyPager.ts';
describe('bounded relay history cursor', () => {
  it('keeps the oldest second inclusive so ties cannot be skipped', () => {
    const pager = new HistoryPager(10, 100);
    pager.advance(128, 50);
    expect(pager.until).toBe(50);
    pager.advance(128, 50);
    expect(pager.limit).toBe(256);
    expect(pager.until).toBe(50);
    pager.advance(256, 40);
    expect(pager.until).toBe(40);
    expect(pager.limit).toBe(128);
    pager.advance(12, 10);
    expect(pager.done).toBe(true);
  });
  it('continues short pages through older timestamps within a bounded time window', () => {
    const pager = new HistoryPager(10, 100, true);
    pager.advance(32, 80);
    expect(pager.done).toBe(false);
    expect(pager.until).toBe(80);
    pager.advance(1, 80);
    expect(pager.until).toBe(79);
    pager.advance(12, 30);
    expect(pager.until).toBe(30);
    pager.advance(0, Infinity);
    expect(pager.done).toBe(true);
  });
  it('fails a saturated second without claiming complete coverage', () => {
    const pager = new HistoryPager(10, 10);
    for (let n = 0; n < 5; n++) pager.advance(pager.limit, 10);
    expect(() => pager.advance(pager.limit, 10)).toThrow(/capacity/);
    expect(pager.done).toBe(false);
  });
});
