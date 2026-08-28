import { STARTUP_CHECKPOINT_STORAGE_KEY } from 'src/stores/nostr/constants';
import {
  buildStartupRelaySignature,
  isStartupCheckpointCurrent,
  normalizeStartupCheckpoint,
  readStartupCheckpoint,
  writeStartupCheckpoint,
} from 'src/stores/nostr/startupCheckpoint';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBKEY = 'a'.repeat(64);

function installLocalStorage() {
  const values = new Map<string, string>();
  const localStorage = {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
  vi.stubGlobal('window', { localStorage });
  return localStorage;
}

describe('startup checkpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes relay URLs into a stable signature', () => {
    expect(
      buildStartupRelaySignature([
        'wss://relay.two',
        'wss://relay.one/',
        'wss://relay.two/',
        'invalid',
      ])
    ).toBe('wss://relay.one/,wss://relay.two/');
  });

  it('writes and validates a completed per-user checkpoint', () => {
    const localStorage = installLocalStorage();
    const relayUrls = ['wss://relay.one/'];

    const checkpoint = writeStartupCheckpoint(PUBKEY, relayUrls, 'complete');

    expect(localStorage.setItem).toHaveBeenCalledWith(
      STARTUP_CHECKPOINT_STORAGE_KEY,
      expect.any(String)
    );
    expect(readStartupCheckpoint()).toEqual(checkpoint);
    expect(isStartupCheckpointCurrent(checkpoint, PUBKEY, relayUrls)).toBe(true);
    expect(isStartupCheckpointCurrent(checkpoint, 'b'.repeat(64), relayUrls)).toBe(false);
    expect(isStartupCheckpointCurrent(checkpoint, PUBKEY, ['wss://relay.two/'])).toBe(false);
  });

  it('rejects incomplete, failed, or malformed checkpoints', () => {
    const baseCheckpoint = {
      version: 1,
      pubkey: PUBKEY,
      relaySignature: 'wss://relay.one/',
      updatedAt: '2026-08-28T10:00:00.000Z',
    };

    expect(
      isStartupCheckpointCurrent(
        normalizeStartupCheckpoint({ ...baseCheckpoint, status: 'in_progress' }),
        PUBKEY,
        ['wss://relay.one/']
      )
    ).toBe(false);
    expect(
      isStartupCheckpointCurrent(
        normalizeStartupCheckpoint({ ...baseCheckpoint, status: 'failed' }),
        PUBKEY,
        ['wss://relay.one/']
      )
    ).toBe(false);
    expect(normalizeStartupCheckpoint({ ...baseCheckpoint, status: 'complete', version: 0 })).toBe(
      null
    );
  });
});
