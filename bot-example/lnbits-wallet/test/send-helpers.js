// What the /send tests share: valid BOLT11 text, and a bot with a mock NWC wallet that can spend.
// No real or synthetic Lightning payment happens anywhere here.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getEventHash, getPublicKey } from 'nostr-tools';
import { hrpValues } from '../bolt11.js';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { LNbitsClient } from '../lnbits.js';
import { NwcClient } from '../nwc.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { BOT_CONTROL_KIND, keyboardFromTags } from '../vendor/botKeyboardProtocol.ts';
import { alice, defer, repliesFor, setup, tempDir } from './helpers.js';
import { relay } from './relay.js';
import { nwcService } from './nwc-server.js';

const A = getPublicKey(alice);
export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// ---- A test encoder for valid BOLT11 text (the signature is random: nothing here checks it) --
export function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) check ^= GEN[i];
  }
  return check;
}
export function toWords(bytes) {
  const words = [];
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((value >> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  if (bits) words.push((value << (5 - bits)) & 31);
  return words;
}
export const numberWords = (n, length) => {
  const words = [];
  for (let i = 0; i < length; i++) {
    words.unshift(n % 32);
    n = Math.floor(n / 32);
  }
  return words;
};
export function field(type, words) {
  return [type, Math.floor(words.length / 32), words.length % 32, ...words];
}
export function encode({
  sats = 1000,
  hrp,
  memo = 'coffee',
  hash = randomBytes(32),
  timestamp = Math.floor(Date.now() / 1000),
  expiry = 3600,
  corrupt = false,
  extra = [],
  expiryWords = 4,
} = {}) {
  const prefix = hrp ?? `lnbc${sats * 10}n`;
  const data = [
    ...numberWords(timestamp, 7),
    ...field(1, toWords(hash)),
    ...(memo === null ? [] : field(13, toWords(Buffer.from(memo)))),
    ...field(6, numberWords(expiry, expiryWords)),
    ...extra,
    ...toWords(randomBytes(65)).slice(0, 104),
  ];
  const mod = polymod([...hrpValues(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  const text = `${prefix}1${[...data, ...checksum].map((w) => CHARSET[w]).join('')}`;
  return corrupt ? `${text.slice(0, -1)}${text.endsWith('q') ? 'p' : 'q'}` : text;
}
export const hashed = (preimage) => createHash('sha256').update(preimage).digest();

export async function fixture(
  t,
  { limits = {}, checkDelays = [0.02, 0.02], spend = true, pay } = {},
) {
  const local = await relay();
  defer(t, () => local.close());
  const wallet = await nwcService(local.url);
  defer(t, () => wallet.close());
  wallet.methods = [...wallet.methods, 'get_budget', ...(spend ? ['pay_invoice'] : [])];
  wallet.budget = { total_budget: 100_000_000, used_budget: 0 };
  const payments = [];
  // The mock wallet proves a payment the way a real one does. No money exists here.
  wallet.pay =
    pay?.(wallet, payments) ??
    ((params) => {
      payments.push(params.invoice);
      const preimage = wallet.preimages.get(params.invoice);
      return { preimage: preimage.toString('hex'), fees_paid: 3000 };
    });
  wallet.preimages = new Map();
  const client = new NwcClient({ timeoutMs: 600, trustedRelays: [local.url] });
  const root = tempDir(t, 'send');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const registry = new Registry({ store: db, keyring, ledger, clientFor: () => client });
  const connection = registry.connect({
    owner: A,
    kind: 'nwc',
    label: 'Spending',
    origin: `nwc:${wallet.walletPubkey}`,
    secret: { ...wallet.secret, scope: spend ? 'spend' : 'receive' },
  });
  const lnbits = new LNbitsClient({ url: 'https://lnbits.test/', timeoutMs: 300 });
  const dir = tempDir(t, 'send-state');
  const ctx = setup(t, {
    wallets: registry,
    lnbits,
    dir,
    send: { maxSats: 10000, dailySats: 25000, perHour: 5, checkDelays, ...limits },
  });
  ctx.bot.flush = async () => {};
  const { bot } = ctx;
  defer(t, () => db.close());
  const invoice = (options = {}) => {
    const preimage = randomBytes(32);
    const text = encode({ hash: hashed(preimage), ...options });
    wallet.preimages.set(text, preimage);
    return text;
  };
  return { wallet, payments, client, registry, connection, invoice, db, local, root, ...ctx, bot };
}
export function press(bot, key, card, data, { id = randomBytes(16).toString('hex'), view } = {}) {
  const request = {
    op: 'request',
    id,
    target: { type: 'dm', chat: bot.pubkey, root: card.id, version: card.id, bot: bot.pubkey },
    data,
    expires: Math.floor(Date.now() / 1000) + 300,
    ...(view ? { view } : {}),
  };
  const message = {
    kind: BOT_CONTROL_KIND,
    pubkey: getPublicKey(key),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', bot.pubkey],
      ['anagram-bot', '1', JSON.stringify(request)],
    ],
    content: '',
  };
  message.id = getEventHash(message);
  bot.buttonRequest(message);
  return message;
}
// The outcome of a press is the message: the card's answer only points to it.
export const lastMessage = (bot, key = alice) =>
  repliesFor(bot, key)
    .filter((r) => !/message below/.test(r.content))
    .at(-1);
export const preview = (bot) =>
  repliesFor(bot, alice)
    .filter((r) => r.kind === 14 && /^Pay /.test(r.content))
    .at(-1);
export const payButton = (card) => keyboardFromTags(card.tags).inline_keyboard[0][0].callback_data;
export const cancelButton = (card) =>
  keyboardFromTags(card.tags).inline_keyboard[1][0].callback_data;
export const until = async (test, what) => {
  for (let i = 0; i < 400; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Waiting for ${what}`);
};
