import {
  isPrivateMediaNoticeDismissed,
  setPrivateMediaNoticeDismissed,
} from '#src/utils/privateMediaNoticePreference.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
  vi.stubGlobal('window', { localStorage });
  return { store, localStorage };
}

describe('private media notice preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the notice by default', () => {
    stubStorage();

    expect(isPrivateMediaNoticeDismissed()).toBe(false);
  });

  it('remembers that the notice was dismissed', () => {
    const { store } = stubStorage();

    setPrivateMediaNoticeDismissed(true);

    expect(store.get('ui-private-media-notice-dismissed')).toBe('1');
    expect(isPrivateMediaNoticeDismissed()).toBe(true);
  });

  it('shows the notice again once it is turned back on', () => {
    const { store } = stubStorage({ 'ui-private-media-notice-dismissed': '1' });

    setPrivateMediaNoticeDismissed(false);

    expect(store.has('ui-private-media-notice-dismissed')).toBe(false);
    expect(isPrivateMediaNoticeDismissed()).toBe(false);
  });

  it('only treats the exact stored flag as dismissed', () => {
    stubStorage({ 'ui-private-media-notice-dismissed': 'true' });

    expect(isPrivateMediaNoticeDismissed()).toBe(false);
  });

  it('keeps showing the notice when storage is unavailable or throws', () => {
    expect(isPrivateMediaNoticeDismissed()).toBe(false);
    expect(() => setPrivateMediaNoticeDismissed(true)).not.toThrow();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { localStorage } = stubStorage();
    localStorage.getItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    localStorage.setItem.mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => setPrivateMediaNoticeDismissed(true)).not.toThrow();
    expect(isPrivateMediaNoticeDismissed()).toBe(false);
  });
});
