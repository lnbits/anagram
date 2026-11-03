import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  enabled: true,
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
  unregister: vi.fn(),
  unminimize: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
  addPluginListener: native.addPluginListener,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => native,
}));
import {
  isDesktopNative,
  showDesktopMessageNotification,
  startDesktopNotificationListener,
} from '#src/lib/platform/desktopNotifications.ts';
import { createInboundPresentationRuntime } from '#src/stores/nostr/inboundPresentationRuntime.ts';
import { areBrowserNotificationsEnabled } from '#src/utils/browserNotificationPreference.ts';

const ownerPubkey = 'a'.repeat(64);
const chatPubkey = 'b'.repeat(64);
const input = { ownerPubkey, chatPubkey, title: 'Alice', body: 'Hello there' };
let storage: Map<string, string>;
let browserNotification: ReturnType<typeof vi.fn>;
function runtime(
  options: { foreground?: boolean; restoring?: boolean; visibleChat?: string } = {},
) {
  return createInboundPresentationRuntime({
    formatSubscriptionLogValue: (value) => value ?? null,
    getLoggedInPublicKeyHex: () => ownerPubkey,
    getVisibleChatId: () => options.visibleChat ?? null,
    isAppForeground: options.foreground ?? false,
    isRestoringStartupState: options.restoring ?? false,
    logDeveloperTrace: vi.fn(),
    normalizeEventId: () => null,
  });
}
function action(chat: unknown = chatPubkey, owner: unknown = ownerPubkey) {
  return { actionId: 'tap', notification: { extra: { ownerPubkey: owner, chatPubkey: chat } } };
}
function receive(value: unknown) {
  native.addPluginListener.mock.calls.at(-1)![2](value);
}

beforeEach(() => {
  vi.resetAllMocks();
  native.enabled = true;
  native.invoke.mockResolvedValue(undefined);
  native.unregister.mockResolvedValue(undefined);
  native.addPluginListener.mockResolvedValue({ unregister: native.unregister });
  native.unminimize.mockResolvedValue(undefined);
  native.show.mockResolvedValue(undefined);
  native.setFocus.mockResolvedValue(undefined);
  storage = new Map([['ui-browser-notifications', '1']]);
  browserNotification = vi.fn();
  vi.stubGlobal('navigator', { userAgent: 'Linux', maxTouchPoints: 0 });
  vi.stubGlobal('window', {
    Notification: browserNotification,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    'CustomEvent',
    class extends Event {
      detail: unknown;
      constructor(name: string, options?: CustomEventInit) {
        super(name);
        this.detail = options?.detail;
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop native message notifications', () => {
  it.each(['Linux', 'Windows', 'Macintosh'])(
    'delivers through Tauri on %s without an Electron bridge',
    async (userAgent) => {
      vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0 });
      runtime().showIncomingMessageBrowserNotification({
        chatPubkey,
        title: 'Alice',
        messageText: '  Hello   there ',
      });
      expect(native.invoke).toHaveBeenCalledExactlyOnceWith('plugin:notification|notify', {
        options: { title: 'Alice', body: 'Hello there', extra: { ownerPubkey, chatPubkey } },
      });
      expect(browserNotification).not.toHaveBeenCalled();
    },
  );

  it.each([{ foreground: true }, { restoring: true }, { visibleChat: chatPubkey }])(
    'keeps existing notification suppression: %j',
    (options) => {
      runtime(options).showIncomingMessageBrowserNotification({
        chatPubkey,
        title: 'Alice',
        messageText: 'Hello',
      });
      expect(native.invoke).not.toHaveBeenCalled();
    },
  );

  it('respects the global notification opt-out', () => {
    storage.set('ui-browser-notifications', '0');
    expect(areBrowserNotificationsEnabled()).toBe(false);
    runtime().showIncomingMessageBrowserNotification({
      chatPubkey,
      title: 'Alice',
      messageText: 'Hello',
    });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { userAgent: 'Linux', maxTouchPoints: 0, enabled: false },
    { userAgent: 'Android', maxTouchPoints: 5, enabled: true },
    { userAgent: 'iPhone', maxTouchPoints: 5, enabled: true },
    { userAgent: 'Macintosh', maxTouchPoints: 5, enabled: true },
  ])('does not activate the desktop plugin on web/mobile: %j', async (platform) => {
    native.enabled = platform.enabled;
    vi.stubGlobal('navigator', platform);
    expect(isDesktopNative()).toBe(false);
    await showDesktopMessageNotification(input);
    startDesktopNotificationListener(() => ownerPubkey, vi.fn())();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.addPluginListener).not.toHaveBeenCalled();
  });

  it('catches native delivery failures without falling through to a duplicate browser alert', async () => {
    const error = new Error('Notification service unavailable');
    native.invoke.mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtime().showIncomingMessageBrowserNotification({
      chatPubkey,
      title: 'Alice',
      messageText: 'Hello',
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Failed to show incoming desktop notification', error),
    );
    expect(browserNotification).not.toHaveBeenCalled();
  });
});

describe('desktop notification clicks', () => {
  it.each([chatPubkey, `34550:${chatPubkey}:test-room`])(
    'restores the window and opens the same-account conversation %s',
    async (chat) => {
      const open = vi.fn();
      const stop = startDesktopNotificationListener(() => ownerPubkey, open);
      receive(action(chat));
      await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(chat));
      expect(native.unminimize).toHaveBeenCalledOnce();
      expect(native.show).toHaveBeenCalledOnce();
      expect(native.setFocus).toHaveBeenCalledOnce();
      stop();
      stop();
      await vi.waitFor(() => expect(native.unregister).toHaveBeenCalledOnce());
      receive(action(chat));
      expect(open).toHaveBeenCalledOnce();
    },
  );

  it('ignores invalid, unrelated, and previous-account notifications', async () => {
    let current: string | null = ownerPubkey;
    const open = vi.fn();
    const stop = startDesktopNotificationListener(() => current, open);
    receive(action(chatPubkey, 'c'.repeat(64)));
    receive(action('https://example.com'));
    receive(action(42));
    receive({});
    receive({ ...action(), actionId: 'dismiss' });
    current = null;
    receive(action());
    current = 'c'.repeat(64);
    receive(action());
    await Promise.resolve();
    expect(native.unminimize).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    stop();
  });

  it('does not navigate if logout happens during window activation', async () => {
    let current: string | null = ownerPubkey;
    let finish!: () => void;
    native.unminimize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const open = vi.fn();
    const stop = startDesktopNotificationListener(() => current, open);
    receive(action());
    await vi.waitFor(() => expect(native.unminimize).toHaveBeenCalledOnce());
    current = null;
    finish();
    await vi.waitFor(() => expect(native.setFocus).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    stop();
  });

  it('unregisters a pending native listener after unmount', async () => {
    let finish!: (handle: { unregister: typeof native.unregister }) => void;
    native.addPluginListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const open = vi.fn();
    const stop = startDesktopNotificationListener(() => ownerPubkey, open);
    stop();
    receive(action());
    finish({ unregister: native.unregister });
    await vi.waitFor(() => expect(native.unregister).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
  });
});
