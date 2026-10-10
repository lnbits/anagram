import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  tauri: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.tauri, invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
import {
  androidNotificationPlugin,
  isAndroidNative,
  type PluginListenerHandle,
} from '#src/lib/platform/androidNotifications.ts';
beforeEach(() => {
  native.tauri = true;
  vi.clearAllMocks();
  native.invoke.mockResolvedValue(null);
  native.listen.mockResolvedValue(native.unlisten);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla Android' });
});
it('requires the Android native app, not an Android browser or desktop webview', () => {
  expect(isAndroidNative()).toBe(true);
  native.tauri = false;
  expect(isAndroidNative()).toBe(false);
  native.tauri = true;
  vi.stubGlobal('navigator', { userAgent: 'Linux desktop' });
  expect(isAndroidNative()).toBe(false);
});
it('routes guarded calls, replays cold-start taps and releases UI listeners', async () => {
  const plugin = androidNotificationPlugin<{
    getState(): Promise<unknown>;
    addListener(event: string, fn: (payload: unknown) => void): Promise<PluginListenerHandle>;
  }>();
  await plugin.getState();
  expect(native.invoke).toHaveBeenLastCalledWith('android_notification_command', {
    method: 'getState',
    args: {},
  });
  native.invoke.mockImplementation(async (_command, { method }) =>
    method === 'takeNotificationAction' ? { chatPubkey: 'a'.repeat(64) } : null,
  );
  const listener = vi.fn();
  const handle = await plugin.addListener('notificationActionPerformed', listener);
  expect(listener).toHaveBeenCalledWith({ chatPubkey: 'a'.repeat(64) });
  expect(native.invoke).toHaveBeenCalledWith('android_notification_command', {
    method: 'startListener',
    args: { event: 'notificationActionPerformed' },
  });
  await handle.remove();
  expect(native.unlisten).toHaveBeenCalledOnce();
  native.listen.mock.calls[0][1]({ payload: {} });
  await Promise.resolve();
  expect(listener).toHaveBeenCalledOnce();
  native.tauri = false;
  await expect(plugin.getState()).rejects.toThrow('unavailable');
});
it('cleans up a listener if native registration fails', async () => {
  native.invoke.mockRejectedValue(new Error('offline'));
  const plugin = androidNotificationPlugin<{
    addListener(e: string, fn: () => void): Promise<PluginListenerHandle>;
  }>();
  await expect(plugin.addListener('pendingEventsAvailable', vi.fn())).rejects.toThrow('offline');
  expect(native.unlisten).toHaveBeenCalledOnce();
});
