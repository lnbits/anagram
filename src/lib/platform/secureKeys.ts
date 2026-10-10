import { isTauri, invoke } from '@tauri-apps/api/core';
export const isNativeSecureStorage = () => isTauri();
export async function readNativeKey(): Promise<string | null> {
  return invoke('read_private_key');
}
export async function writeNativeKey(privateKeyHex: string): Promise<void> {
  await invoke('write_private_key', { privateKeyHex });
}
export async function removeNativeKey(): Promise<void> {
  await invoke('remove_private_key');
}
