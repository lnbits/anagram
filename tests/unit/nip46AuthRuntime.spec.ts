import { NostrNip46Signer, nip19 } from '#src/lib/nostr/client.ts';
import {
  buildNip46NostrConnectUri,
  createNip46AuthRuntime,
  getNip46SessionSnapshotFromPayload,
  normalizeNip46BunkerUri,
  normalizeNip46Pubkey,
  normalizeNip46RelayUrl,
} from '#src/stores/nostr/nip46AuthRuntime.ts';
import { describe, expect, it, vi } from 'vitest';

const REMOTE_SIGNER_PUBKEY = 'a'.repeat(64);
const USER_PUBKEY = 'b'.repeat(64);
const CLIENT_PUBKEY = 'c'.repeat(64);

describe('nip46 auth runtime helpers', () => {
  it('normalizes NIP-46 relay URLs and rejects non-websocket URLs', () => {
    expect(normalizeNip46RelayUrl(' wss://relay.example.com ')).toBe('wss://relay.example.com/');
    expect(normalizeNip46RelayUrl('https://relay.example.com')).toBeNull();
    expect(normalizeNip46RelayUrl('not-a-url')).toBeNull();
  });

  it('normalizes bunker URLs with signer, user, and relay parameters', () => {
    const normalized = normalizeNip46BunkerUri(
      `bunker://${REMOTE_SIGNER_PUBKEY.toUpperCase()}?pubkey=${USER_PUBKEY.toUpperCase()}&relay=wss://relay.example.com&secret=abc`,
    );

    expect(normalized).not.toBeNull();
    const url = new URL(normalized ?? '');
    expect(url.protocol).toBe('bunker:');
    expect(url.hostname).toBe(REMOTE_SIGNER_PUBKEY);
    expect(url.searchParams.get('pubkey')).toBe(USER_PUBKEY);
    expect(url.searchParams.getAll('relay')).toEqual(['wss://relay.example.com/']);
    expect(url.searchParams.get('secret')).toBe('abc');
  });

  it('normalizes NIP-46 npub values to hex pubkeys', () => {
    const remoteSignerNpub = nip19.npubEncode(REMOTE_SIGNER_PUBKEY);
    const userNpub = nip19.npubEncode(USER_PUBKEY);
    const normalized = normalizeNip46BunkerUri(
      `bunker://${remoteSignerNpub}?pubkey=${userNpub}&relay=wss://relay.example.com`,
    );

    expect(normalizeNip46Pubkey(remoteSignerNpub)).toBe(REMOTE_SIGNER_PUBKEY);
    expect(normalized).not.toBeNull();
    const url = new URL(normalized ?? '');
    expect(url.hostname).toBe(REMOTE_SIGNER_PUBKEY);
    expect(url.searchParams.get('pubkey')).toBe(USER_PUBKEY);
  });

  it('rejects bunker URLs without usable relays or signer pubkeys', () => {
    expect(normalizeNip46BunkerUri(`bunker://${REMOTE_SIGNER_PUBKEY}`)).toBeNull();
    expect(
      normalizeNip46BunkerUri('bunker://not-a-pubkey?relay=wss://relay.example.com'),
    ).toBeNull();
  });

  it('builds nostrconnect URLs with broad signing and NIP-44 permissions', () => {
    const uri = buildNip46NostrConnectUri({
      clientPubkey: CLIENT_PUBKEY,
      relayUrl: 'wss://relay.example.com',
      secret: 'secret',
    });

    const url = new URL(uri);
    expect(url.protocol).toBe('nostrconnect:');
    expect(url.hostname).toBe(CLIENT_PUBKEY);
    expect(url.searchParams.get('relay')).toBe('wss://relay.example.com/');
    expect(url.searchParams.get('secret')).toBe('secret');
    expect(url.searchParams.get('perms')).toContain('sign_event');
    expect(url.searchParams.get('perms')).toContain('nip44_encrypt');
    expect(url.searchParams.get('perms')).toContain('nip44_decrypt');
  });

  it('reads diagnostics details from persisted NIP-46 signer payloads', () => {
    const payload = JSON.stringify({
      type: 'nip46',
      payload: {
        bunkerPubkey: REMOTE_SIGNER_PUBKEY.toUpperCase(),
        userPubkey: USER_PUBKEY,
        relayUrls: ['wss://relay.example.com', 'https://not-a-relay.example'],
      },
    });

    expect(getNip46SessionSnapshotFromPayload(payload)).toEqual({
      signerPubkey: REMOTE_SIGNER_PUBKEY,
      relayUrls: ['wss://relay.example.com/'],
    });
    expect(getNip46SessionSnapshotFromPayload('not-json')).toEqual({
      signerPubkey: null,
      relayUrls: [],
    });
  });
});

it('cancels a bunker login immediately and refuses a late signer authorization', async () => {
  let ready!: (user: { pubkey: string }) => void;
  const signer = {
    blockUntilReady: () =>
      new Promise<{ pubkey: string }>((resolve) => {
        ready = resolve;
      }),
    stop: vi.fn(),
    on: vi.fn(),
    toPayload: vi.fn(),
  };
  const bunker = vi
    .spyOn(NostrNip46Signer, 'bunker')
    .mockReturnValue(signer as unknown as NostrNip46Signer);
  const setStoredAuthSession = vi.fn();
  const clearCurrentAuthSession = vi.fn();
  const ndk = { signer: undefined };
  try {
    const runtime = createNip46AuthRuntime({
      ndk: ndk as never,
      clearCurrentAuthSession,
      setStoredAuthSession,
      resetEventSinceForFreshLogin: vi.fn(),
      setCachedSigner: vi.fn(),
      setCachedSignerSessionKey: vi.fn(),
      setStoredNip46SignerPayload: vi.fn(),
    });
    const controller = new AbortController();
    const login = runtime.loginWithNip46Bunker({
      connectionToken: `bunker://${REMOTE_SIGNER_PUBKEY}?relay=wss://relay.example.com`,
      signal: controller.signal,
    });
    controller.abort();
    await expect(login).rejects.toThrow('cancelled');
    expect(signer.stop).toHaveBeenCalledOnce();
    ready({ pubkey: USER_PUBKEY });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setStoredAuthSession).not.toHaveBeenCalled();
    expect(clearCurrentAuthSession).not.toHaveBeenCalled();
    expect(ndk.signer).toBeUndefined();
  } finally {
    bunker.mockRestore();
  }
});
