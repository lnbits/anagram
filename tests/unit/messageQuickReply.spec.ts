import {
  classifySwipe,
  SWIPE_REPLY_MAX_OFFSET,
  SWIPE_REPLY_THRESHOLD,
  swipeArmed,
  swipeOffset,
} from '#src/lib/actions/messageQuickReply.ts';
import { describe, expect, it } from 'vitest';

describe('message quick reply gestures', () => {
  it('waits for movement beyond the slop before choosing an axis', () => {
    expect(classifySwipe(0, 0)).toBe('pending');
    expect(classifySwipe(6, 6)).toBe('pending');
    expect(classifySwipe(9, 0)).toBe('pending');
  });

  it('only locks swipes moving clearly toward the reply direction', () => {
    expect(classifySwipe(12, 0)).toBe('swipe');
    expect(classifySwipe(30, 19)).toBe('swipe');
    expect(classifySwipe(30, -20)).toBe('ignore');
    expect(classifySwipe(15, 80)).toBe('ignore');
    expect(classifySwipe(0, 12)).toBe('ignore');
    expect(classifySwipe(-40, 0)).toBe('ignore');
  });

  it('follows the finger to the threshold, then damps up to the maximum offset', () => {
    expect(swipeOffset(-30)).toBe(0);
    expect(swipeOffset(20)).toBe(20);
    expect(swipeOffset(SWIPE_REPLY_THRESHOLD)).toBe(SWIPE_REPLY_THRESHOLD);
    const beyond = swipeOffset(SWIPE_REPLY_THRESHOLD + 20);
    expect(beyond).toBeGreaterThan(SWIPE_REPLY_THRESHOLD);
    expect(beyond).toBeLessThan(SWIPE_REPLY_THRESHOLD + 20);
    expect(swipeOffset(500)).toBe(SWIPE_REPLY_MAX_OFFSET);
  });

  it('arms only once the threshold is reached', () => {
    expect(swipeArmed(SWIPE_REPLY_THRESHOLD - 1)).toBe(false);
    expect(swipeArmed(SWIPE_REPLY_THRESHOLD)).toBe(true);
    expect(swipeArmed(-SWIPE_REPLY_THRESHOLD)).toBe(false);
  });
});
