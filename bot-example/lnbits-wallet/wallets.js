// Which person may use which wallet. Written only by the operator, never from chat.
//
// wallets.json (mode 0600):
//   { "npub1alice...": { "label": "Alice", "invoiceKey": "<LNbits invoice/read key>" } }
//
// Each Nostr identity gets at most one wallet, and each wallet at most one identity, so a
// command can only ever reach the sender's own wallet. Keys live in a private field: they
// are not enumerable, not in JSON and never logged.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { generateSecretKey, nip19, nip44 } from 'nostr-tools';
import { ConfigurationError, HEX } from './vendor/runtime.js';

// Per person AND wallet: a wallet moved to someone else starts with its own baseline too.
export const walletRef = (owner, key) =>
  createHash('sha256').update(`anagram-lnbits-wallet:${owner}:${key}`).digest('hex').slice(0, 32);

const NEVER = new AbortController().signal;

// LNbits wallet keys are 32 lowercase hex characters (a UUID without dashes).
export const LNBITS_KEY = /^[a-f0-9]{32}$/;

// Any 64 hex characters decode, but only a point on the curve can receive encrypted messages:
// anything else would make every reply or notification to that person fail.
const probe = generateSecretKey();
function onCurve(id) {
  try {
    nip44.v2.utils.getConversationKey(probe, id);
    return true;
  } catch {
    return false;
  }
}

function pubkey(value, index) {
  const text = String(value).trim();
  let id;
  if (HEX.test(text)) id = text;
  else
    try {
      const decoded = nip19.decode(text.replace(/^nostr:/, ''));
      if (decoded.type === 'npub') id = decoded.data;
    } catch {
      /* Reported below. */
    }
  if (!id)
    throw new ConfigurationError(
      `Wallet entry ${index + 1} is not keyed by an npub or hex public key.`,
    );
  if (!onCurve(id))
    throw new ConfigurationError(
      `Wallet entry ${index + 1} is not a valid Nostr public key (check for a typo).`,
    );
  return id;
}

export class Wallets {
  #keys = new Map();
  constructor(entries = []) {
    this.labels = new Map();
    this.disabled = new Map();
    const seen = new Set();
    for (const [index, [owner, { label, invoiceKey }]] of entries.entries()) {
      const id = pubkey(owner, index);
      if (this.#keys.has(id))
        throw new ConfigurationError(`Wallet entry ${index + 1} repeats an identity.`);
      if (typeof invoiceKey !== 'string' || !LNBITS_KEY.test(invoiceKey))
        throw new ConfigurationError(
          `Wallet entry ${index + 1} needs "invoiceKey": the wallet's 32-character invoice/read key.`,
        );
      if (seen.has(invoiceKey))
        throw new ConfigurationError(
          `Wallet entry ${index + 1} reuses another entry's key. Link each wallet to one identity.`,
        );
      seen.add(invoiceKey);
      const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : '';
      this.#keys.set(id, invoiceKey);
      this.labels.set(id, name);
    }
  }
  get size() {
    return this.#keys.size;
  }
  owners() {
    return [...this.#keys.keys()];
  }
  // Listed in wallets.json: may talk to the bot, even if their link was switched off.
  linked(pubkey) {
    return this.#keys.has(pubkey);
  }
  // Linked with a key the bot may still use (not switched off at runtime).
  has(pubkey) {
    return this.#keys.has(pubkey) && !this.disabled.has(pubkey);
  }
  // The only way to read a key. Callers pass it straight to the LNbits client.
  keyFor(pubkey) {
    return this.has(pubkey) ? this.#keys.get(pubkey) : undefined;
  }
  label(pubkey) {
    return this.labels.get(pubkey) ?? '';
  }
  // The same interface as the registry in database mode (registry.js), where people can have
  // several wallets. Here a person has exactly one, and a connection id is the person. Only
  // the operator changes links in this file, so nothing here can be managed from chat.
  get manageable() {
    return false;
  }
  ids() {
    return this.owners();
  }
  refs() {
    return this.owners().flatMap((owner) => {
      const key = this.keyFor(owner);
      return key ? [walletRef(owner, key)] : [];
    });
  }
  // Holds what wallet work needs. valid(): still usable. gone(): never here (links in this
  // file change only at startup). ref: when given, only the wallet a menu was made for.
  lease(pubkey, ref) {
    const key = this.keyFor(pubkey);
    if (!key || (ref && ref !== walletRef(pubkey, key))) return undefined;
    return {
      id: pubkey,
      owner: pubkey,
      ref: walletRef(pubkey, key),
      kind: 'lnbits',
      label: this.label(pubkey),
      key,
      signal: NEVER,
      gone: () => false,
      valid: () => this.keyFor(pubkey) === key,
    };
  }
  leaseById(id) {
    return this.lease(id);
  }
  // Why a menu made for ref cannot be used: 'ok', 'off' (switched off) or 'stale' (relinked).
  menuState(pubkey, ref) {
    const key = this.keyFor(pubkey);
    if (!key) return 'off';
    return ref === walletRef(pubkey, key) ? 'ok' : 'stale';
  }
  // Used when LNbits reveals that a configured key is an admin key, which can spend.
  disable(pubkey, reason) {
    this.disabled.set(pubkey, reason);
  }
  toJSON() {
    return { wallets: this.size };
  }
}

// Reads the operator's file. It must be private to this user, like an SSH key.
export function loadWallets(file) {
  if (!file) throw new ConfigurationError('WALLETS_FILE is required (see wallets.example.json).');
  let stat, data;
  try {
    stat = statSync(file);
  } catch {
    throw new ConfigurationError('WALLETS_FILE does not exist or cannot be read.');
  }
  if (!stat.isFile()) throw new ConfigurationError('WALLETS_FILE must be a regular file.');
  if (stat.mode & 0o077)
    throw new ConfigurationError('WALLETS_FILE must be private: run chmod 600 on it.');
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Never echo the file: it contains keys.
    throw new ConfigurationError('WALLETS_FILE is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new ConfigurationError('WALLETS_FILE must be a JSON object keyed by npub.');
  for (const [index, value] of Object.values(data).entries())
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ConfigurationError(`Wallet entry ${index + 1} must be an object.`);
  return new Wallets(Object.entries(data));
}
