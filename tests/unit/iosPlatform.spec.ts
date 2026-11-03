import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled }));
import { isIosNative } from '#src/lib/platform/ios.ts';
import {
  isBrowserNotificationSupported,
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  requestBrowserNotificationsAfterLogin,
} from '#src/utils/browserNotificationPreference.ts';

const requestPermission = vi.fn();
beforeEach(() => {
  native.enabled = true;
  requestPermission.mockReset().mockResolvedValue('granted');
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    Notification: { permission: 'default', requestPermission },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['iPhone', 'iPad', 'Macintosh'])(
  'native %s skips notification permission even if the webview exposes the API',
  async (userAgent) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 5 });
    expect(isIosNative()).toBe(true);
    expect(isBrowserNotificationSupported()).toBe(false);
    expect(getBrowserNotificationPermission()).toBe('unsupported');
    expect(await requestBrowserNotificationPermission()).toBe('unsupported');
    expect(await requestBrowserNotificationsAfterLogin()).toBe('unsupported');
    expect(requestPermission).not.toHaveBeenCalled();
  },
);

it.each([
  { userAgent: 'iPhone', enabled: false, maxTouchPoints: 5 },
  { userAgent: 'Macintosh', enabled: false, maxTouchPoints: 5 },
  { userAgent: 'Android', enabled: true, maxTouchPoints: 5 },
  { userAgent: 'Linux', enabled: false, maxTouchPoints: 0 },
])('preserves notifications for $userAgent (native=$enabled)', async (platform) => {
  native.enabled = platform.enabled;
  vi.stubGlobal('navigator', platform);
  expect(isIosNative()).toBe(false);
  expect(isBrowserNotificationSupported()).toBe(true);
  expect(getBrowserNotificationPermission()).toBe('default');
  expect(await requestBrowserNotificationPermission()).toBe('granted');
  expect(requestPermission).toHaveBeenCalledOnce();
});

it.each(['Macintosh', 'Windows', 'Linux'])(
  'uses native notifications on Tauri %s without browser permission',
  async (userAgent) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0 });
    delete (window as any).Notification;
    expect(isBrowserNotificationSupported()).toBe(true);
    expect(getBrowserNotificationPermission()).toBe('native');
    expect(await requestBrowserNotificationPermission()).toBe('native');
    expect(await requestBrowserNotificationsAfterLogin()).toBe('native');
    expect(requestPermission).not.toHaveBeenCalled();
  },
);

it('preserves the existing Electron notification path', async () => {
  native.enabled = false;
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', maxTouchPoints: 0 });
  (window as any).desktopRuntime = {
    isElectron: true,
    showIncomingMessageNotification: vi.fn(),
  };
  expect(getBrowserNotificationPermission()).toBe('native');
  expect(await requestBrowserNotificationsAfterLogin()).toBe('native');
  expect(requestPermission).not.toHaveBeenCalled();
});
