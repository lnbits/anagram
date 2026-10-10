import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
  type EventTemplate,
} from 'nostr-tools';
import { WebSocket } from 'ws';
import type { BrowserContext } from '@playwright/test';
import { E2E_RELAY_URL } from './helpers';
export async function installExtension(context: BrowserContext, secret: Uint8Array) {
  await context.exposeFunction('__signerPublicKey', () => getPublicKey(secret));
  await context.exposeFunction('__signerSign', (event: EventTemplate) =>
    finalizeEvent(event, secret),
  );
  await context.exposeFunction('__signerEncrypt', (key: string, text: string) =>
    nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(secret, key)),
  );
  await context.exposeFunction('__signerDecrypt', (key: string, text: string) =>
    nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(secret, key)),
  );
  await context.addInitScript((relay) => {
    const w = window as any;
    w.nostr = {
      getPublicKey: () => w.__signerPublicKey(),
      signEvent: (event: any) => w.__signerSign(event),
      getRelays: async () => ({ [relay]: { read: true, write: true } }),
      nip44: {
        encrypt: (key: string, text: string) => w.__signerEncrypt(key, text),
        decrypt: (key: string, text: string) => w.__signerDecrypt(key, text),
      },
    };
  }, E2E_RELAY_URL);
}
// The signer key remains in Node. The browser negotiates real NIP-46 events through the relay.
export async function startBunker() {
  const secret = generateSecretKey(),
    publicKey = getPublicKey(secret);
  const socket = new WebSocket(E2E_RELAY_URL);
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('open', () =>
      socket.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [publicKey] }])),
    );
    socket.on('message', async (raw) => {
      const [type, , event] = JSON.parse(String(raw));
      if (type === 'EOSE') {
        resolve();
        return;
      }
      if (type !== 'EVENT' || !verifyEvent(event) || seen.has(event.id)) return;
      seen.add(event.id);
      const key = nip44.v2.utils.getConversationKey(secret, event.pubkey);
      let rpc;
      try {
        rpc = JSON.parse(nip44.v2.decrypt(event.content, key));
      } catch {
        return;
      }
      let result = '',
        error;
      try {
        switch (rpc.method) {
          case 'connect':
            result = 'ack';
            break;
          case 'ping':
            result = 'pong';
            break;
          case 'get_public_key':
            result = publicKey;
            break;
          case 'get_relays':
            result = JSON.stringify({ [E2E_RELAY_URL]: { read: true, write: true } });
            break;
          case 'sign_event':
            result = JSON.stringify(finalizeEvent(JSON.parse(rpc.params[0]), secret));
            break;
          case 'nip44_encrypt':
            result = nip44.v2.encrypt(
              rpc.params[1],
              nip44.v2.utils.getConversationKey(secret, rpc.params[0]),
            );
            break;
          case 'nip44_decrypt':
            result = nip44.v2.decrypt(
              rpc.params[1],
              nip44.v2.utils.getConversationKey(secret, rpc.params[0]),
            );
            break;
          default:
            throw new Error('Unsupported method');
        }
      } catch {
        error = 'Signer request failed';
      }
      socket.send(
        JSON.stringify([
          'EVENT',
          finalizeEvent(
            {
              kind: 24133,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', event.pubkey]],
              content: nip44.v2.encrypt(JSON.stringify({ id: rpc.id, result, error }), key),
            },
            secret,
          ),
        ]),
      );
    });
  });
  return {
    publicKey,
    bunkerUrl: `bunker://${publicKey}?relay=${encodeURIComponent(E2E_RELAY_URL)}`,
    stop: () => socket.close(),
  };
}
export async function seedAuth(context: BrowserContext) {
  await context.addInitScript((relay) => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (!window.name.includes('anagram-e2e-seeded')) {
      window.name += 'anagram-e2e-seeded';
      for (const key of ['relays', 'nip65_relays'])
        localStorage.setItem(key, JSON.stringify([{ url: relay, read: true, write: true }]));
    }
  }, E2E_RELAY_URL);
}
