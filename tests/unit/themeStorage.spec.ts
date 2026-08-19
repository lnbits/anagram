import {
  DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
  DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY,
  normalizeDesktopMessageLayoutPreference,
  readDesktopMessageLayoutPreference,
  saveDesktopMessageLayoutPreference,
} from 'src/utils/themeStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';

class TestCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

function createMockStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const api = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };

  return { api, store };
}

describe('themeStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes desktop message layout values to text by default', () => {
    expect(normalizeDesktopMessageLayoutPreference('bubbles')).toBe('bubbles');
    expect(normalizeDesktopMessageLayoutPreference(' BUBBLES ')).toBe('bubbles');
    expect(normalizeDesktopMessageLayoutPreference('text')).toBe('text');
    expect(normalizeDesktopMessageLayoutPreference('unknown')).toBe('text');
    expect(normalizeDesktopMessageLayoutPreference(null)).toBe('text');
  });

  it('reads the saved desktop message layout with text as the fallback', () => {
    const localStorage = createMockStorage({
      [DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY]: 'bubbles',
    });
    vi.stubGlobal('window', { localStorage: localStorage.api });

    expect(readDesktopMessageLayoutPreference()).toBe('bubbles');

    localStorage.store.set(DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY, 'invalid');
    expect(readDesktopMessageLayoutPreference()).toBe('text');
  });

  it('defaults packaged apps to bubbles while preserving an explicit text choice', () => {
    const localStorage = createMockStorage();
    vi.stubGlobal('window', {
      localStorage: localStorage.api,
      desktopRuntime: { isElectron: true },
    });

    expect(readDesktopMessageLayoutPreference()).toBe('bubbles');

    localStorage.store.set(DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY, 'text');
    expect(readDesktopMessageLayoutPreference()).toBe('text');
  });

  it('saves the desktop message layout and emits a same-tab change event', () => {
    const localStorage = createMockStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', { localStorage: localStorage.api, dispatchEvent });

    saveDesktopMessageLayoutPreference('bubbles');

    expect(localStorage.store.get(DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY)).toBe('bubbles');
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ layout: string }>;
    expect(event.type).toBe(DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT);
    expect(event.detail).toEqual({ layout: 'bubbles' });
  });
});
