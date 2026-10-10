import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  groupEntropyFromPhrase,
  groupPhraseFromEntropy,
  deriveGroupIdentityKey,
  deriveGroupEpochKey,
  makeGroupRecoveryBackup,
  parseGroupRecoveryBackup,
  normalizeRecoveryState,
  recoveryHeads,
  safeRecoveryMembers,
  GENESIS_REVISION,
  type GroupRecoveryRecord,
} from '#src/stores/nostr/groupRecovery.ts';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const entropy = '0'.repeat(32);
const owner = 'a'.repeat(64),
  alice = 'b'.repeat(64),
  bob = 'c'.repeat(64);
function record(
  id: string,
  epoch = 0,
  parents: string[] = [],
  members = [owner, alice, bob],
): GroupRecoveryRecord {
  return {
    id,
    state: {
      version: 1,
      revision: epoch ? id : GENESIS_REVISION,
      epoch_revision: epoch ? id : GENESIS_REVISION,
      epoch,
      parents,
      members,
      owners: [owner],
      name: 'Group',
      about: '',
      relays: ['wss://relay.example/'],
    },
  };
}
describe('group seed recovery', () => {
  it('uses the BIP39 128-bit test phrase and validates checksum and word count', () => {
    expect(groupPhraseFromEntropy(entropy)).toBe(phrase);
    expect(groupEntropyFromPhrase(`  ${phrase.toUpperCase().replaceAll(' ', '\n')} `)).toBe(
      entropy,
    );
    expect(() => groupEntropyFromPhrase('abandon '.repeat(12))).toThrow('valid 12-word');
    expect(() => groupEntropyFromPhrase(phrase + ' abandon')).toThrow();
    expect(() => groupPhraseFromEntropy('0'.repeat(64))).toThrow();
  });
  it('derives valid, reproducible and separated keys across epochs and concurrent rotations', () => {
    const groupKey = deriveGroupIdentityKey(entropy);
    expect(groupKey).toBe('13d184e4bcb80ec9e3e9e474783e5c33708154e48c3e75fca524a79966211111');
    expect(deriveGroupEpochKey(entropy, 0, GENESIS_REVISION)).toBe(
      '15bb3fbeafd0839896fe006fee52cc18e69fbc9054fa7c29e3c8033f1cda3b34',
    );
    expect(getPublicKey(hexToBytes(groupKey))).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveGroupIdentityKey(groupEntropyFromPhrase(phrase))).toBe(groupKey);
    const a = deriveGroupEpochKey(entropy, 1, alice);
    const b = deriveGroupEpochKey(entropy, 1, bob);
    expect(new Set([groupKey, a, b, deriveGroupEpochKey(entropy, 2, alice)]).size).toBe(4);
    expect(deriveGroupEpochKey(entropy, 1, alice)).toBe(a);
    expect(() => deriveGroupEpochKey(entropy, Number.MAX_SAFE_INTEGER + 1, alice)).toThrow();
  });
  it('roundtrips a recovery file and rejects mismatched or malformed backup material', () => {
    const backup = makeGroupRecoveryBackup(phrase, ['wss://relay.example/']);
    expect(parseGroupRecoveryBackup(JSON.stringify(backup))).toEqual(backup);
    expect(() =>
      parseGroupRecoveryBackup(JSON.stringify({ ...backup, group_pubkey: alice })),
    ).toThrow('mismatched');
    expect(() =>
      parseGroupRecoveryBackup(JSON.stringify({ ...backup, recovery_key: 'f'.repeat(32) })),
    ).toThrow('mismatched');
    expect(() => parseGroupRecoveryBackup('x'.repeat(65537))).toThrow('too large');
  });
  it('rejects malformed recovery state and missing or non-monotonic ancestors', () => {
    const root = record(owner);
    expect(normalizeRecoveryState(root.state)).toEqual(root.state);
    expect(() => normalizeRecoveryState({ ...root.state, owners: [] })).toThrow();
    expect(() => normalizeRecoveryState({ ...root.state, members: [alice, alice] })).toThrow();
    expect(() =>
      normalizeRecoveryState({ ...root.state, relays: ['https://example.com'] }),
    ).toThrow();
    expect(() => recoveryHeads([record(alice, 1, [owner])])).toThrow('incomplete');
    expect(() => recoveryHeads([root, record(alice, 0, [owner])])).not.toThrow();
    expect(() => recoveryHeads([root, record(alice, 1, [alice])])).toThrow();
  });
  it('detects concurrent owners and reconciles removals instead of choosing the latest timestamp', () => {
    const root = record(owner);
    const left = record(alice, 1, [owner], [owner, alice]);
    const right = record(bob, 1, [owner], [owner, bob]);
    const heads = recoveryHeads([right, root, left]);
    expect(heads.map((h) => h.id)).toEqual([alice, bob]);
    expect(safeRecoveryMembers(heads)).toEqual([owner]);
    const merged = record('d'.repeat(64), 2, [alice, bob], [owner]);
    expect(recoveryHeads([right, root, merged, left])).toEqual([merged]);
  });
});
