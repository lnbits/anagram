import type { EventTemplate, Event } from 'nostr-tools';
declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string>; signEvent(event: EventTemplate): Promise<Event>; nip44?: { encrypt(pubkey: string, content: string): Promise<string>; decrypt(pubkey: string, content: string): Promise<string> } };
    desktopRuntime?: { isElectron: boolean; encryptPrivateKey(value: string): Promise<string>; decryptPrivateKey(value: string): Promise<string | null>; showIncomingMessageNotification(input: {chatPubkey: string; title: string; body: string}): void };
  }
}
export {};
