// Legacy Android integrations are never activated in the web/Tauri targets.
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
export interface PluginListenerHandle {
  remove(): Promise<void>;
}
export function registerPlugin<T>(name: string): T {
  return new Proxy(
    {},
    { get: () => () => Promise.reject(new Error(`${name} requires the Android target`)) },
  ) as T;
}
export const SecureStorage = registerPlugin<{
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}>('SecureStorage');
export const AppLauncher = registerPlugin<{
  openUrl(o: { url: string }): Promise<{ completed: boolean }>;
}>('AppLauncher');
