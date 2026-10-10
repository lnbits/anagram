import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  generateMnemonic,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

export const GROUP_RECOVERY_VERSION = 1;
export const GROUP_RECOVERY_TAG = 'anagram-group-recovery-v1';
export const GENESIS_REVISION = '0'.repeat(64);
const DOMAIN = 'nip171/group-recovery/v1';
const HEX = /^[0-9a-f]{64}$/;

export function normalizeGroupPhrase(value: string): string {
  return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}
export function groupEntropyFromPhrase(value: string): string {
  const phrase = normalizeGroupPhrase(value);
  if (phrase.split(' ').length !== 12 || !validateMnemonic(phrase, wordlist)) {
    throw new Error(
      'Enter a valid 12-word group recovery phrase. Check the words and their order.',
    );
  }
  return bytesToHex(mnemonicToEntropy(phrase, wordlist));
}
export function groupPhraseFromEntropy(entropy: string): string {
  if (!/^[0-9a-f]{32}$/.test(entropy)) throw new Error('Invalid group recovery key.');
  return entropyToMnemonic(hexToBytes(entropy), wordlist);
}
export function generateGroupRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

// Each output is independently derived. Never use non-hardened HD child derivation:
// members deliberately receive child private keys. No member receives the seed.
function deriveScalar(entropy: string, purpose: string): string {
  const seed = mnemonicToSeedSync(groupPhraseFromEntropy(entropy), '');
  try {
    for (let counter = 0; counter < 256; counter++) {
      const key = hkdf(sha256, seed, utf8ToBytes(DOMAIN), utf8ToBytes(`${purpose}/${counter}`), 32);
      try {
        getPublicKey(key); // Reject zero and values outside the secp256k1 scalar field.
        return bytesToHex(key);
      } catch {
        /* Deterministic rejection sampling. */
      } finally {
        key.fill(0);
      }
    }
    throw new Error('Could not derive a group key.');
  } finally {
    seed.fill(0);
  }
}
export function deriveGroupIdentityKey(entropy: string): string {
  return deriveScalar(entropy, 'identity');
}
export function deriveGroupEpochKey(entropy: string, epoch: number, revision: string): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !HEX.test(revision)) {
    throw new Error('Invalid group epoch descriptor.');
  }
  return deriveScalar(entropy, `epoch/${epoch}/${revision}`);
}
export function newGroupRevision(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface GroupRecoveryState {
  version: 1;
  revision: string;
  epoch_revision: string;
  epoch: number;
  parents: string[];
  members: string[];
  owners: string[];
  relays: string[];
  name: string;
  about: string;
}
export interface GroupRecoveryRecord {
  id: string;
  state: GroupRecoveryState;
  event?: import('#src/lib/nostr/client.ts').NostrEvent;
}
export function normalizeRecoveryState(value: unknown): GroupRecoveryState {
  if (!value || typeof value !== 'object') throw new Error('Invalid group recovery record.');
  const s = value as GroupRecoveryState;
  const keys = (v: unknown): v is string[] =>
    Array.isArray(v) &&
    v.length <= 4096 &&
    v.every((k) => typeof k === 'string' && HEX.test(k)) &&
    new Set(v).size === v.length;
  if (
    s.version !== 1 ||
    !HEX.test(s.revision) ||
    !HEX.test(s.epoch_revision) ||
    !Number.isSafeInteger(s.epoch) ||
    s.epoch < 0 ||
    !keys(s.parents) ||
    !keys(s.members) ||
    !keys(s.owners) ||
    !s.owners.length ||
    !Array.isArray(s.relays) ||
    !s.relays.length ||
    s.relays.length > 32 ||
    !s.relays.every((r) => {
      try {
        const u = new URL(r);
        return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password;
      } catch {
        return false;
      }
    }) ||
    typeof s.name !== 'string' ||
    s.name.length > 200 ||
    typeof s.about !== 'string' ||
    s.about.length > 4000 ||
    (!s.parents.length &&
      (s.epoch !== 0 || s.revision !== GENESIS_REVISION || s.epoch_revision !== GENESIS_REVISION))
  ) {
    throw new Error('Invalid group recovery record.');
  }
  return {
    version: 1,
    revision: s.revision,
    epoch_revision: s.epoch_revision,
    epoch: s.epoch,
    parents: [...s.parents],
    members: [...s.members],
    owners: [...s.owners],
    relays: [...s.relays],
    name: s.name,
    about: s.about,
  };
}
export function recoveryHeads(records: GroupRecoveryRecord[]): GroupRecoveryRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const parents = new Set<string>();
  for (const { id, state } of records) {
    for (const parent of state.parents) {
      const previous = byId.get(parent);
      if (
        parent === id ||
        !previous ||
        previous.state.epoch > state.epoch ||
        (previous.state.epoch === state.epoch &&
          previous.state.epoch_revision !== state.epoch_revision)
      )
        throw new Error('Group recovery history is incomplete. Try the other group relays.');
      parents.add(parent);
    }
  }
  return records.filter((r) => !parents.has(r.id)).sort((a, b) => a.id.localeCompare(b.id));
}
// A fork is never resolved by last-write-wins. An explicit reconciliation starts
// from the intersection, preventing a concurrent stale add from undoing a removal.
export function safeRecoveryMembers(heads: GroupRecoveryRecord[]): string[] {
  return heads.length
    ? heads[0].state.members.filter((k) => heads.every((h) => h.state.members.includes(k)))
    : [];
}
export interface GroupRecoveryBackup {
  format: 'anagram-group-recovery';
  version: 1;
  phrase: string;
  recovery_key: string;
  group_pubkey: string;
  relays: string[];
}
export function makeGroupRecoveryBackup(phrase: string, relays: string[]): GroupRecoveryBackup {
  const entropy = groupEntropyFromPhrase(phrase);
  return {
    format: 'anagram-group-recovery',
    version: 1,
    phrase: groupPhraseFromEntropy(entropy),
    recovery_key: entropy,
    group_pubkey: getPublicKey(hexToBytes(deriveGroupIdentityKey(entropy))),
    relays,
  };
}
export function parseGroupRecoveryBackup(text: string): GroupRecoveryBackup {
  if (text.length > 65536) throw new Error('The recovery file is too large.');
  let value: GroupRecoveryBackup;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Choose an Anagram group recovery file.');
  }
  if (
    value.format !== 'anagram-group-recovery' ||
    value.version !== 1 ||
    typeof value.phrase !== 'string' ||
    !Array.isArray(value.relays) ||
    value.relays.length > 32 ||
    !value.relays.every((r) => typeof r === 'string')
  ) {
    throw new Error('Unsupported group recovery file.');
  }
  const expected = makeGroupRecoveryBackup(value.phrase, value.relays);
  if (
    value.group_pubkey !== expected.group_pubkey ||
    value.recovery_key !== expected.recovery_key
  ) {
    throw new Error('The recovery file contains mismatched keys.');
  }
  return expected;
}
