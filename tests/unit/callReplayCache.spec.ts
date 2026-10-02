import { hasSeenCallControl, rememberCallControl } from 'src/services/callReplayCache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('call control replay cache', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('persists recently handled IDs and isolates accounts and peers', () => {
    rememberCallControl('owner', 'peer', 'call');
    expect(hasSeenCallControl('owner', 'peer', 'call')).toBe(true);
    expect(hasSeenCallControl('other-owner', 'peer', 'call')).toBe(false);
    expect(hasSeenCallControl('owner', 'other-peer', 'call')).toBe(false);
  });
  it('expires old controls and bounds stored entries', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 300; i++) rememberCallControl('owner', 'peer', String(i));
    expect(hasSeenCallControl('owner', 'peer', '0')).toBe(false);
    expect(hasSeenCallControl('owner', 'peer', '299')).toBe(true);
    vi.advanceTimersByTime(120_001);
    expect(hasSeenCallControl('owner', 'peer', '299')).toBe(false);
  });
  it('tolerates unavailable or corrupt storage', () => {
    values.set('anagram:call-controls:owner', '{');
    expect(hasSeenCallControl('owner', 'peer', 'call')).toBe(false);
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('disabled');
      },
      setItem: () => {
        throw new Error('disabled');
      },
    });
    expect(() => rememberCallControl('owner', 'peer', 'call')).not.toThrow();
  });
});
