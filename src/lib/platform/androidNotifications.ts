import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export interface PluginListenerHandle {
  remove(): Promise<void>;
}
export function isAndroidNative(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
function command<T>(method: string, args: unknown = {}): Promise<T> {
  if (!isAndroidNative()) return Promise.reject(new Error('Android notifications are unavailable'));
  return invoke<T>('android_notification_command', { method, args });
}
// Native commands remain behind the main-webview/origin guard. Only two native
// wake-up channels exist; their removable UI listeners never retain old screens.
export function androidNotificationPlugin<T>(): T {
  return new Proxy(
    {},
    {
      get: (_, method) =>
        method === 'addListener'
          ? async (
              event: string,
              callback: (value: unknown) => void,
            ): Promise<PluginListenerHandle> => {
              let active = true;
              async function dispatch() {
                if (!active) return;
                const value =
                  event === 'notificationActionPerformed'
                    ? await command('takeNotificationAction')
                    : {};
                if (active && value) callback(value);
              }
              const unlisten = await listen(`android-relay-${event}`, () => {
                void dispatch().catch(() => {});
              });
              try {
                await command('startListener', { event });
                await dispatch(); // Includes a notification tap that launched a cold app.
              } catch (error) {
                active = false;
                unlisten();
                throw error;
              }
              return {
                remove: async () => {
                  active = false;
                  unlisten();
                },
              };
            }
          : (args?: unknown) => command(String(method), args),
    },
  ) as T;
}
