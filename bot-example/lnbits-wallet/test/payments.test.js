// /send and /payments: what the design for outgoing payments promises, against a mock NWC wallet.
// No real or synthetic Lightning payment happens anywhere here.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { decodeInvoice, hrpValues, InvoiceError } from '../bolt11.js';
import { disallowedBy } from '../bot.js';
import { menuKeyboard } from '../buttons.js';
import { loadConfig } from '../config.js';
import { Ledger, ledgerFile } from '../ledger.js';
import { SEND_TEXT } from '../send.js';
import { NwcClient } from '../nwc.js';
import { DB_FILE, Store } from '../store.js';
import { BotTransport } from '../vendor/bot.js';
import { sign } from '../vendor/runtime.js';
import {
  BOT_CONTROL_KIND,
  keyboardFromTags,
  parseKeyboard,
} from '../vendor/botKeyboardProtocol.ts';
import { alice, bob, defer, repliesFor, sendDM, settle, setup } from './helpers.js';
import { relay } from './relay.js';
import { nwcService } from './nwc-server.js';
import {
  CHARSET,
  encode,
  field,
  fixture,
  hashed,
  lastMessage,
  payButton,
  polymod,
  press,
  preview,
  toWords,
  until,
} from './send-helpers.js';

const A = getPublicKey(alice);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const payCount = (wallet) => wallet.requests.filter((r) => r.method === 'pay_invoice').length;
const answers = (bot, key = alice) =>
  repliesFor(bot, key).filter((m) => m.kind === BOT_CONTROL_KIND);
const data = (message) =>
  keyboardFromTags(message.tags)
    .inline_keyboard.flat()
    .flatMap((b) => b.callback_data ?? []);
const paidRow = (wallet, text, hash, sats = 1000) => ({
  type: 'outgoing',
  state: 'settled',
  invoice: text,
  payment_hash: hash,
  amount: sats * 1000,
  fees_paid: 2000,
  description: '',
  created_at: 1,
  settled_at: 2,
  preimage: wallet.preimages.get(text).toString('hex'),
});
// A payment that stays open after its first request: the wallet gives no useful answer.
async function unanswered(t, options = {}) {
  const context = await fixture(t, { checkDelays: [0.01], ...options });
  const { bot, invoice, wallet } = context;
  const text = invoice(options.invoice);
  await sendDM(bot, alice, `/send ${text}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => bot.state.sends[0].state === 'unknown', 'the checks to run out');
  await settle(bot);
  wallet.errors = {};
  return { ...context, text, record: bot.state.sends[0] };
}

// ---- Invoices ---------------------------------------------------------------------------

function signedInvoice({ tamper = false, otherNode = false } = {}) {
  const pair = () => generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const signer = pair();
  const named = otherNode ? pair() : signer;
  const jwk = named.publicKey.export({ format: 'jwk' });
  const y = Buffer.from(jwk.y, 'base64url');
  const node = Buffer.concat([
    Buffer.from([y[y.length - 1] & 1 ? 3 : 2]),
    Buffer.from(jwk.x, 'base64url'),
  ]);
  const prefix = 'lnbc10n';
  const stamp = Math.floor(Date.now() / 1000);
  const numberWords = (n, length) =>
    Array.from({ length }, (_, i) => Math.floor(n / 32 ** (length - 1 - i)) % 32);
  const body = [
    ...numberWords(stamp, 7),
    ...field(1, toWords(randomBytes(32))),
    ...field(13, toWords(Buffer.from(tamper ? 'tampered' : 'hello'))),
    ...field(19, toWords(node)),
  ];
  const signedBody = tamper
    ? [
        ...numberWords(stamp, 7),
        ...body.slice(7, 7 + 55),
        ...field(13, toWords(Buffer.from('hello'))),
        ...field(19, toWords(node)),
      ]
    : body;
  const packed = (words) => {
    const out = [];
    let value = 0;
    let bits = 0;
    for (const word of words) {
      value = (value << 5) | word;
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        out.push((value >> bits) & 255);
      }
      value &= (1 << bits) - 1;
    }
    if (bits) out.push((value << (8 - bits)) & 255);
    return Buffer.from(out);
  };
  const signature = signData('sha256', Buffer.concat([Buffer.from(prefix), packed(signedBody)]), {
    key: signer.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const data = [...body, ...toWords(Buffer.concat([signature, Buffer.from([0])])).slice(0, 104)];
  const mod = polymod([...hrpValues(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return {
    text: `${prefix}1${[...data, ...checksum].map((w) => CHARSET[w]).join('')}`,
    node: node.toString('hex'),
  };
}

test('a named destination is shown only if the invoice was signed by it', () => {
  const good = signedInvoice();
  assert.equal(decodeInvoice(good.text).destination, good.node);
  for (const bad of [signedInvoice({ otherNode: true }), signedInvoice({ tamper: true })])
    assert.throws(
      () => decodeInvoice(bad.text),
      (error) => error instanceof InvoiceError && error.code === 'signature',
    );
  assert.equal(decodeInvoice(encode()).destination, undefined, 'none stated');
});

test('the preview says what is known: wallet, expiry and destination, and never guesses', async (t) => {
  const { bot, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000, memo: 'lunch' })}`);
  const card = preview(bot);
  assert.match(card.content, /from Spending\?/);
  assert.match(card.content, /The invoice says: lunch/);
  assert.match(card.content, /Pays node: not stated in the invoice/);
  assert.match(card.content, /Invoice expires: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(card.content, /routing fee.*known only afterwards/);
  const signed = signedInvoice();
  await sendDM(bot, alice, '/cancel');
  await sendDM(bot, alice, `/send ${signed.text}`);
  assert.ok(preview(bot).content.includes(`Pays node: ${signed.node}`));
  assert.ok(parseKeyboard(keyboardFromTags(preview(bot).tags)));
});

test('expired, nearly expired, malformed, zero-amount and other-network invoices', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  const said = async (text) => {
    await sendDM(bot, alice, `/send ${text}`);
    return lastMessage(bot).content;
  };
  const time = Math.floor(Date.now() / 1000);
  assert.match(await said(invoice({ timestamp: time - 7200, expiry: 3600 })), /has expired/);
  assert.match(await said(invoice({ timestamp: time, expiry: 20 })), /has expired/, 'too close');
  assert.match(await said('lnbc1notaninvoice'), /not a valid Lightning invoice/);
  assert.match(await said(encode({ corrupt: true })), /not a valid Lightning invoice/);
  assert.match(await said(encode({ hrp: 'lnbc' })), /has no amount/);
  assert.match(await said(encode({ hrp: 'lntb20n' })), /another network/);
  assert.match(await said(signedInvoice({ otherNode: true }).text), /signature does not match/);
  assert.equal(bot.state.sends.length, 0);
  assert.equal(payCount(wallet), 0);
});

test('an invoice for another network than the wallet is refused', async (t) => {
  const { bot, invoice, registry } = await fixture(t);
  registry.lease(A).key.network = 'tb';
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /another network/);
  assert.equal(bot.state.sends.length, 0);
});

test('a /send over an hour old is not acted on', async (t) => {
  const { bot, invoice } = await fixture(t);
  bot.state.startedAt = 0;
  bot.state.authorized.users[A] = 0;
  await sendDM(bot, alice, `/send ${invoice()}`, [], Math.floor(Date.now() / 1000) - 3700);
  assert.match(lastMessage(bot).content, /over an hour old/);
  assert.equal(bot.state.sends.length, 0);
});

// ---- Pressing ---------------------------------------------------------------------------

test('many presses at once, and from a second device, pay once', async (t) => {
  const { bot, invoice, wallet, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  wallet.mode = 'late';
  wallet.delayMs = 40;
  for (let i = 0; i < 8; i++) press(bot, alice, card, payButton(card));
  await settle(bot);
  await until(() => bot.state.sends[0].state === 'paid', 'the payment');
  await settle(bot);
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(payments.length, 1);
  assert.equal(payCount(wallet), 1);
});

test('the same press replayed by a relay runs once; later it is simply too old', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  const message = press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(payCount(wallet), 1);
  for (let i = 0; i < 5; i++) bot.buttonRequest(message);
  await settle(bot);
  assert.equal(payCount(wallet), 1);
  const later = { ...message, created_at: message.created_at - 400 };
  bot.buttonRequest(later);
  await settle(bot);
  assert.equal(payCount(wallet), 1);
});

test('a new payment waits while the last one may still be on its way', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { checkDelays: [30] });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'uncertain');
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /still being checked/);
  assert.equal(bot.state.sends.length, 1);
});

test('a preview cannot be paid after a restart: its invoice was only in memory', async (t) => {
  const { bot, invoice, registry, dir, wallet } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  await bot.close();
  const next = setup(t, { wallets: registry, lnbits: bot.lnbits, dir, send: {} });
  next.bot.flush = async () => {};
  next.bot.sends.recover();
  assert.equal(next.bot.state.sends[0].state, 'cancelled');
  press(next.bot, alice, card, payButton(card));
  await settle(next.bot);
  assert.match(answers(next.bot).at(-1).content, /already cancelled/);
  assert.equal(payCount(wallet), 0);
});

test('no invoice, description or preimage reaches the disk, at any step', async (t) => {
  const { bot, invoice, dir, wallet } = await fixture(t);
  const text = invoice({ memo: 'private description text' });
  const state = () => readFileSync(join(dir, 'state.json'), 'utf8');
  const clean = () => {
    const saved = state();
    for (const secret of [
      text,
      'private description text',
      wallet.preimages.get(text).toString('hex'),
      wallet.clientSecret,
    ])
      assert.ok(!saved.includes(secret));
  };
  await sendDM(bot, alice, `/send ${text}`);
  clean();
  let onDisk;
  wallet.pay = (params) => {
    clean();
    onDisk = JSON.parse(state()).sends[0].state;
    return { preimage: wallet.preimages.get(params.invoice).toString('hex') };
  };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  clean();
  assert.equal(onDisk, 'sending', 'on disk before the wallet is asked');
  assert.equal(bot.state.sends[0].state, 'paid');
});

test('even a press that got past the card checks acts only on its own person and wallet', async (t) => {
  const { bot, invoice, wallet, registry } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const [record] = bot.state.sends;
  const ref = record.id.slice(0, 12);
  const answered = [];
  const say = bot.say.bind(bot);
  bot.say = (request, text, ...rest) => {
    answered.push(text);
    return say(request, text, ...rest);
  };
  const lease = registry.lease(A);
  const press2 = (sender, used) =>
    bot.sends.press(
      { sender, lease: used, plain: true, message: { id: 'e'.repeat(64), pubkey: sender } },
      'ok',
      ref,
    );
  await press2(getPublicKey(bob), lease);
  await press2(A, { ...lease, id: 'f'.repeat(32) });
  assert.equal(record.state, 'prepared');
  assert.equal(payCount(wallet), 0);
  await press2(A, { ...lease, spends: false });
  assert.equal(record.state, 'cancelled', 'a wallet that cannot spend ends it');
  assert.match(answered.at(-1), /connected for receiving only/);
  assert.equal(payCount(wallet), 0);
});

test('messages about money have no copy for the bot, and carry no secret', async (t) => {
  const { bot, invoice, wallet, logs } = await fixture(t);
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  // Every wrap the bot queued for its own key, read with that key.
  assert.equal(repliesFor(bot, bot.key).filter((m) => /Pay |Paid /.test(m.content)).length, 0);
  const everything = [...repliesFor(bot, alice).map((m) => m.content), ...logs].join('\n');
  assert.ok(!everything.includes(wallet.clientSecret));
  assert.ok(!everything.includes(wallet.preimages.get(text).toString('hex')));
});

test('state from an experimental release loses what should not have been kept', async (t) => {
  const { bot, invoice, registry, dir } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  bot.state.sends[0].invoice = 'lnbc-old';
  bot.state.sends[0].memo = 'old memo';
  bot.save();
  await bot.close();
  const next = setup(t, { wallets: registry, lnbits: bot.lnbits, dir, send: {} });
  assert.equal(next.bot.state.sends[0].invoice, undefined);
  assert.equal(next.bot.state.sends[0].memo, undefined);
});

// ---- What the wallet is asked first ------------------------------------------------------

test('the wallet is asked right before paying, and any doubt stops it', async (t) => {
  const { bot, invoice, wallet, payments } = await fixture(t);
  const attempt = async (prepare) => {
    const text = invoice();
    await sendDM(bot, alice, `/send ${text}`);
    prepare(decodeInvoice(text).paymentHash, text);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
    return lastMessage(bot).content;
  };
  assert.match(
    await attempt((hash, text) => wallet.transactions.unshift(paidRow(wallet, text, hash))),
    /already knows this invoice/,
  );
  assert.match(
    await attempt((hash, text) =>
      wallet.transactions.unshift({ ...paidRow(wallet, text, hash), state: 'pending' }),
    ),
    /already knows this invoice/,
  );
  assert.match(
    await attempt((hash, text) =>
      wallet.transactions.unshift({ ...paidRow(wallet, text, hash), type: 'incoming' }),
    ),
    /already knows this invoice/,
    'its own invoice',
  );
  assert.match(
    await attempt(() => {
      wallet.errors = { lookup_invoice: 'INTERNAL' };
    }),
    /could not check with your wallet/,
  );
  wallet.errors = {};
  assert.match(
    await attempt(() => {
      wallet.budget = { total_budget: 100_000_000, used_budget: 99_500_000 };
    }),
    /more than is left/,
  );
  assert.match(
    await attempt(() => {
      wallet.errors = { get_budget: 'INTERNAL' };
    }),
    /could not check with your wallet/,
  );
  assert.equal(payments.length, 0);
  assert.equal(payCount(wallet), 0);
  assert.ok(bot.state.sends.every((r) => r.state === 'cancelled'));
  wallet.errors = {};
  wallet.budget = { total_budget: 100_000_000, used_budget: 0 };
  assert.match(
    await attempt((hash, text) =>
      wallet.transactions.unshift({ ...paidRow(wallet, text, hash), state: 'failed' }),
    ),
    /already knows this invoice/,
    'even failed: NIP-47 lets a wallet call a timeout a failure',
  );
  assert.equal(payCount(wallet), 0);
});

test('a failed payment can be tried again; anything that may have paid cannot', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  const text = invoice();
  const tryIt = async () => {
    await sendDM(bot, alice, `/send ${text}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
  };
  wallet.errors = { pay_invoice: 'INSUFFICIENT_BALANCE' };
  await tryIt();
  assert.equal(bot.state.sends[0].state, 'failed');
  assert.match(lastMessage(bot).content, /does not have enough funds.*Nothing was paid/);
  wallet.errors = {};
  await tryIt();
  assert.equal(bot.state.sends[1].state, 'paid');
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
  assert.equal(payCount(wallet), 2);
});

test('an Unknown payment blocks its invoice from every wallet of the person', async (t) => {
  const { bot, text, wallet, registry, local } = await unanswered(t);
  const other = await nwcService(local.url);
  defer(t, () => other.close());
  other.methods = [...other.methods, 'get_budget', 'pay_invoice'];
  other.budget = { total_budget: 100_000_000 };
  const second = registry.connect({
    owner: A,
    kind: 'nwc',
    label: 'Second',
    origin: `nwc:${other.walletPubkey}`,
    secret: { ...other.secret, scope: 'spend' },
  });
  registry.select(A, second.id);
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
  assert.equal(payCount(wallet), 1);
  assert.equal(payCount(other), 0);
});

// ---- The relay ---------------------------------------------------------------------------

test('a payment goes on one relay, and never on another, even if that one refuses it', async (t) => {
  const first = await relay();
  const second = await relay();
  defer(t, () => first.close());
  defer(t, () => second.close());
  const wallet = await nwcService(first.url);
  defer(t, () => wallet.close());
  wallet.methods = [...wallet.methods, 'pay_invoice'];
  wallet.pay = () => ({ preimage: '00'.repeat(32) });
  const client = new NwcClient({ timeoutMs: 600, trustedRelays: [first.url, second.url] });
  const secret = { ...wallet.secret, relays: [first.url, second.url], scope: 'spend' };
  const requests = (fixture) =>
    [...fixture.events.values()].filter((event) => event.kind === 23194).length;
  await client.pay(secret, 'lnbc1example', { timeoutMs: 400 }).catch(() => {});
  assert.equal(requests(first) + requests(second), 1, 'on exactly one relay');

  // Both refuse: nothing goes further, and that proves nothing about the payment.
  first.reject = true;
  second.reject = true;
  const before = requests(first) + requests(second);
  const refused = await client.pay(secret, 'lnbc1example', { timeoutMs: 300 }).catch((e) => e);
  assert.equal(refused.definite, false, 'not told that nothing was paid');
  assert.equal(requests(first) + requests(second), before);
  // Whichever relay was ready first refused: the other was not asked.
  assert.ok(first.connections.length && second.connections.length);
});

test('a relay refusing a payment leaves it open, and its invoice blocked', async (t) => {
  const { bot, invoice, local, wallet } = await fixture(t, { checkDelays: [30] });
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  const card = preview(bot);
  bot.wallets.lease(A).client.verify = async () => {};
  bot.wallets.lease(A).client.budget = async () => ({ totalMsat: 1e9, usedMsat: 0 });
  bot.wallets.lease(A).client.lookupPayment = async () => null;
  local.reject = true;
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'uncertain');
  assert.ok(!/Nothing was paid/.test(lastMessage(bot).content));
  assert.equal(payCount(wallet), 0);
  local.reject = false;
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
});

test('other requests still go on every relay', async (t) => {
  const first = await relay();
  const second = await relay();
  defer(t, () => first.close());
  defer(t, () => second.close());
  const wallet = await nwcService(first.url);
  defer(t, () => wallet.close());
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [first.url, second.url] });
  const secret = { ...wallet.secret, relays: [first.url, second.url] };
  wallet.mode = 'silent';
  await client.request(secret, 'get_balance').catch(() => {});
  const seen = (fixture) =>
    [...fixture.events.values()].filter((event) => event.kind === 23194).length;
  assert.equal(seen(first), 1);
  assert.equal(seen(second), 1);
});

test('a relay cannot confirm a payment: only the wallet, with its signature and proof', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { checkDelays: [30] });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.pay = () => ({ preimage: 'ab'.repeat(32) });
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'uncertain', 'a preimage that proves nothing');
  assert.equal(bot.state.sends[0].error, 'bad_proof');
});

// ---- Reconciling -------------------------------------------------------------------------

test('Refresh settles an Unknown payment, only with proof, and never pays', async (t) => {
  const { bot, wallet, text, record } = await unanswered(t);
  await sendDM(bot, alice, '/payments');
  const list = lastMessage(bot);
  assert.match(list.content, /1\. 1,000 sats · Unknown ·/);
  const detail = data(list).find((d) => /^pm:0:/.test(d));
  const refresh = async (row, view) => {
    wallet.transactions = row ? [row] : [];
    press(bot, alice, list, detail, view ? { view } : {});
    await settle(bot);
    return answers(bot).at(-1);
  };
  const hash = record.paymentHash;
  const good = paidRow(wallet, text, hash);

  // Nothing yet, or nothing that proves it.
  for (const row of [
    null,
    { ...good, preimage: '' },
    { ...good, preimage: 'ab'.repeat(32) },
    { ...good, amount: 999000 },
    { ...good, type: 'incoming' },
    { ...good, state: 'pending' },
    { ...good, state: 'failed' }, // the invoice can still be paid
  ]) {
    const shown = await refresh(row);
    assert.match(shown.content, /Status: Unknown/, JSON.stringify(row?.state));
    assert.equal(record.state, 'unknown');
  }
  // A lookup that fails says so, and changes nothing.
  wallet.errors = { lookup_invoice: 'INTERNAL' };
  assert.match((await refresh(good)).content, /could not check it/);
  assert.equal(record.state, 'unknown');
  wallet.errors = {};

  const shown = await refresh(good);
  assert.match(shown.content, /went through\.\nStatus: Confirmed/);
  assert.match(shown.content, /Routing fee: 2 sats/);
  assert.ok(shown.content.includes(`Payment hash: ${hash}`));
  assert.equal(record.feesMsat, 2000);
  assert.equal(payCount(wallet), 1, 'never a second request');
});

test('a failed row is believed only once the invoice cannot be paid at all', async (t) => {
  const { bot, wallet, text, record } = await unanswered(t);
  wallet.transactions = [{ ...paidRow(wallet, text, record.paymentHash), state: 'failed' }];
  await sendDM(bot, alice, '/payments');
  assert.equal(record.state, 'unknown');
  record.invoiceExpires = Math.floor(Date.now() / 1000) - 120;
  await sendDM(bot, alice, '/payments');
  assert.equal(record.state, 'failed');
  assert.match(lastMessage(bot).content, /· Failed ·/);
});

test('an uncertain payment is checked by itself, and told when it settles', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { checkDelays: [0.02, 0.02, 0.02] });
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  wallet.errors = { pay_invoice: 'OTHER' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const hash = bot.state.sends[0].paymentHash;
  wallet.errors = {};
  wallet.transactions = [paidRow(wallet, text, hash)];
  await until(() => bot.state.sends[0].state === 'paid', 'the check');
  await settle(bot);
  assert.match(lastMessage(bot).content, /^Paid 1,000 sats\. Routing fee: 2 sats/);
  assert.equal(payCount(wallet), 1);
});

test('stopped before the request left: nothing was sent, so nothing can have been paid', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.silent = ['pay_invoice'];
  bot.wallets.lease(A).client.lookupPayment = async () => null;
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => bot.state.sends[0].state === 'sending', 'the payment to start');
  await bot.close();
  assert.equal(payCount(wallet), 0);
  assert.equal(bot.state.sends[0].state, 'failed');
});

test('restart during a payment: never sent again, then settled from the wallet', async (t) => {
  const { bot, invoice, wallet, registry, dir } = await fixture(t);
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  const card = preview(bot);
  wallet.silent = ['pay_invoice'];
  press(bot, alice, card, payButton(card));
  await until(() => payCount(wallet) === 1, 'the request to reach the wallet');
  assert.equal(bot.state.sends[0].state, 'sending');
  const hash = bot.state.sends[0].paymentHash;
  await bot.close();
  wallet.silent = [];
  wallet.transactions = [paidRow(wallet, text, hash)];
  const before = payCount(wallet);
  const next = setup(t, {
    wallets: registry,
    lnbits: bot.lnbits,
    dir,
    send: { checkDelays: [0.02] },
  });
  next.bot.flush = async () => {};
  next.bot.sends.recover();
  assert.ok(['uncertain', 'unknown'].includes(next.bot.state.sends[0].state));
  await until(() => next.bot.state.sends[0].state === 'paid', 'the check');
  await settle(next.bot);
  assert.equal(payCount(wallet), before, 'not sent again');
});

// ---- /payments ---------------------------------------------------------------------------

async function paid(bot, invoice, sats) {
  await sendDM(bot, alice, `/send ${invoice({ sats })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
}

test('/payments lists what was sent, with details, and is separate from /invoices', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { perHour: 100, dailySats: 1000000 } });
  await sendDM(bot, alice, '/payments');
  assert.match(lastMessage(bot).content, /No payments sent from here yet from Spending/);
  for (let i = 1; i <= 7; i++) await paid(bot, invoice, i * 100);
  await sendDM(bot, alice, '/payments');
  const card = lastMessage(bot);
  assert.match(card.content, /^Payments sent \(Spending\) 1–5 of 7, newest first:/);
  assert.match(card.content, /1\. 700 sats · Confirmed · .* UTC · fee 3 sats/);
  assert.match(card.content, /Invoices you received are under \/invoices/);
  assert.ok(parseKeyboard(keyboardFromTags(card.tags)));
  assert.ok(data(card).includes('pm:1'));
  press(bot, alice, card, 'pm:1');
  await settle(bot);
  const older = answers(bot).at(-1);
  assert.match(older.content, /6–7 of 7/);
  assert.ok(data(older).includes('pm:0'));
  await sendDM(bot, alice, '/invoices');
  assert.match(lastMessage(bot).content, /No invoices made here yet/, 'not mixed together');
});

test('a cancelled request is not a payment', async (t) => {
  const { bot, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  await sendDM(bot, alice, '/cancel');
  await sendDM(bot, alice, '/payments');
  assert.match(lastMessage(bot).content, /No payments sent/);
});

test('nobody else sees or reaches a payment', async (t) => {
  const { bot, wallet, record, registry, local } = await unanswered(t);
  const theirs = await nwcService(local.url);
  defer(t, () => theirs.close());
  registry.connect({
    owner: getPublicKey(bob),
    kind: 'nwc',
    label: 'Bob',
    origin: `nwc:${theirs.walletPubkey}`,
    secret: { ...theirs.secret, scope: 'receive' },
  });
  await sendDM(bot, alice, '/payments');
  const card = lastMessage(bot);
  await sendDM(bot, bob, '/payments');
  const own = lastMessage(bot, bob);
  assert.match(own.content, /No payments sent/);
  const asked = wallet.requests.length;
  const ref = record.id.slice(0, 12);
  press(bot, bob, card, `pm:0:${ref}`);
  press(bot, bob, own, `pm:0:${ref}`);
  press(bot, bob, card, `s:ok:${ref}`);
  await settle(bot);
  assert.ok(!repliesFor(bot, bob).some((m) => /1,000 sats/.test(m.content)));
  assert.equal(wallet.requests.length, asked);
});

test('a disconnect ends a wallet’s payments too; connecting it again does not bring them back', async (t) => {
  const { bot, wallet, record, registry, connection } = await unanswered(t);
  await sendDM(bot, alice, '/payments');
  const card = lastMessage(bot);
  const asked = wallet.requests.length;
  registry.revoke(connection.id, 'user');
  press(bot, alice, card, `pm:0:${record.id.slice(0, 12)}`);
  await settle(bot);
  assert.equal(wallet.requests.length, asked, 'its secret is not used');
  const again = registry.connect({
    owner: A,
    kind: 'nwc',
    label: 'Again',
    origin: `nwc:${wallet.walletPubkey}`,
    secret: { ...wallet.secret, scope: 'spend' },
  });
  assert.notEqual(again.ref, connection.ref);
  await sendDM(bot, alice, '/payments');
  assert.match(lastMessage(bot).content, /No payments sent from here yet from Again/);
  press(bot, alice, card, `pm:0:${record.id.slice(0, 12)}`);
  await settle(bot);
  assert.match(answers(bot).at(-1).content, /no longer linked to you/);
  // It still counts: it may have been paid.
  assert.equal(record.state, 'unknown');
});

test('disconnected while waiting for the wallet’s answers: nothing is paid', async (t) => {
  const { bot, invoice, wallet, registry, connection, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  wallet.forge = (_request, method) => {
    if (method === 'get_budget') registry.revoke(connection.id, 'user');
  };
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'cancelled');
  assert.equal(payments.length, 0);
  assert.equal(payCount(wallet), 0);
});

// ---- Asking and pasting ------------------------------------------------------------------

test('the menu offers Send and Payments only when sending is on', () => {
  const buttons = (options) =>
    menuKeyboard([1000], options)
      .inline_keyboard.flat()
      .map((b) => b.text);
  assert.ok(!buttons({}).includes('Send'));
  assert.ok(!buttons({}).includes('Payments'));
  assert.ok(buttons({ sending: true }).includes('Send'));
  assert.ok(buttons({ sending: true }).includes('Payments'));
  assert.ok(parseKeyboard(menuKeyboard([1, 2, 3, 4], { sending: true, manageable: true })));
});

test('a pasted invoice is the same as /send; the Send button waits for one', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  await sendDM(bot, alice, invoice({ sats: 321 }));
  assert.match(preview(bot).content, /^Pay 321 sats/);
  assert.equal(payCount(wallet), 0, 'a paste alone pays nothing');
  await sendDM(bot, alice, '/cancel');

  await sendDM(bot, alice, '/menu');
  const menu = lastMessage(bot);
  assert.ok(data(menu).includes('s:ask'));
  press(bot, alice, menu, 's:ask');
  await settle(bot);
  const asked = answers(bot).at(-1);
  assert.match(asked.content, /Paste the Lightning invoice to pay from Spending/);
  await sendDM(bot, alice, 'not an invoice');
  assert.match(lastMessage(bot).content, /not a Lightning invoice/);
  await sendDM(bot, alice, invoice({ sats: 654 }));
  assert.match(preview(bot).content, /^Pay 654 sats/);
  assert.equal(bot.awaiting.size, 0);
  assert.equal(payCount(wallet), 0);
});

test('a receive-only wallet is told it cannot send, however it is asked', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { spend: false });
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /connected for receiving only/);
  await sendDM(bot, alice, invoice());
  assert.match(lastMessage(bot).content, /connected for receiving only/);
  await sendDM(bot, alice, '/menu');
  press(bot, alice, lastMessage(bot), 's:ask');
  await settle(bot);
  assert.match(answers(bot).at(-1).content, /connected for receiving only/);
  assert.equal(payCount(wallet), 0);
});

// ---- Connections that offer only part of NIP-47 ------------------------------------------

test('a wallet offering only part of NIP-47 is usable for what it offers', async (t) => {
  const { wallet, client } = await fixture(t);
  wallet.methods = ['get_info', 'pay_invoice', 'lookup_invoice', 'get_budget'];
  const secret = { ...wallet.secret, scope: 'spend' };
  const seen = await client.inspect(secret);
  assert.deepEqual(seen.methods, wallet.methods);
  assert.equal(seen.budget.totalMsat, 100_000_000);
  assert.deepEqual(secret.methods, wallet.methods, 'noted on the credential');
  assert.equal(secret.network, 'bc');
  const asked = wallet.requests.length;
  await assert.rejects(client.wallet(secret), (e) => e.code === 'not_offered');
  await assert.rejects(client.payments(secret, 5), (e) => e.code === 'not_offered');
  await assert.rejects(
    client.createInvoice(secret, { sats: 1, memo: '', expiry: 60 }),
    (e) => e.code === 'not_offered',
  );
  assert.deepEqual(await client.incoming(secret), { payments: [], rows: 0, malformed: 0 });
  assert.ok(
    wallet.requests.slice(asked).every((r) => r.method === 'get_info'),
    'not even asked',
  );
});

test('without a limit in the wallet: refused when connecting and when paying, with no way around it', async (t) => {
  const { wallet, bot, invoice, payments, local } = await fixture(t);
  const secret = { ...wallet.secret, scope: 'spend' };
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const hashes = () => wallet.requests.filter((r) => r.method === 'lookup_invoice').length;
  for (const lacking of [
    () => (wallet.budget = { total_budget: 0, used_budget: 0 }),
    () => (wallet.budget = {}),
    () => (wallet.budget = undefined),
    () => (wallet.methods = wallet.methods.filter((m) => m !== 'get_budget')),
  ]) {
    lacking();
    wallet.publishInfo();
    await assert.rejects(client.inspect(secret), (e) => e.code === 'budget');
    const before = hashes();
    await sendDM(bot, alice, `/send ${invoice()}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
    assert.equal(hashes(), before, 'stopped at the limit, before anything else');
    assert.match(answers(bot).at(-1).content, /could not confirm a spending limit/);
    assert.equal(payments.length, 0);
    assert.ok(wallet.requests.every((r) => r.method !== 'pay_invoice'));
    wallet.methods = [...new Set([...wallet.methods, 'get_budget'])];
  }
  assert.throws(
    () =>
      loadConfig({
        LNBITS_URL: 'https://l.example',
        SEND_ENABLED: 'true',
        SEND_ALLOW_NO_WALLET_LIMIT: 'true',
      }),
    /no longer exists/,
  );
});

test('what the configuration does not allow is off, also after a ledger fault', async (t) => {
  const context = await fixture(t);
  const { registry, connection, root } = context;
  assert.equal(registry.leaseById(connection.id).spends, true);
  const policy = disallowedBy({ nwc: true, send: false });
  assert.equal(policy({ kind: 'nwc' }, { scope: 'spend' }), 'configuration');
  assert.equal(policy({ kind: 'nwc' }, { scope: 'receive' }), undefined);
  assert.equal(policy({ kind: 'lnbits' }, {}), undefined);
  assert.equal(disallowedBy({ nwc: false, send: true })({ kind: 'nwc' }, {}), 'configuration');
  assert.equal(
    disallowedBy({ nwc: true, send: true })({ kind: 'nwc' }, { scope: 'spend' }),
    undefined,
  );
  registry.disallowed = policy;
  // A ledger fault rebuilds every connection.
  const path = ledgerFile(join(root, 'secrets'));
  chmodSync(path, 0o644);
  registry.check();
  chmodSync(path, 0o600);
  registry.check();
  assert.equal(registry.broken, false);
  assert.equal(registry.leaseById(connection.id), undefined, 'still off');
  assert.equal(registry.connection(connection.id).disabled, 'configuration');
});

test('switched off while the wallet is being asked: nothing is paid', async (t) => {
  const { bot, invoice, wallet, registry, connection, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  wallet.forge = (_request, method) => {
    if (method === 'lookup_invoice') registry.disable(connection.id, 'configuration');
  };
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(payments.length, 0);
  assert.equal(bot.state.sends[0].state, 'cancelled');
});

test('previews cannot push out what blocks an invoice or counts against the limit', async (t) => {
  const { bot, text, record, invoice, wallet } = await unanswered(t, {
    limits: { perHour: 100000, dailySats: 1500 },
  });
  const time = Math.floor(Date.now() / 1000);
  // Far more than the caps, of every kind that may be evicted.
  for (let i = 0; i < 6000; i++)
    bot.state.sends.push({
      ...record,
      id: i.toString(16).padStart(32, '0'),
      paymentHash: i.toString(16).padStart(64, '0'),
      state: i % 2 ? 'cancelled' : 'failed',
      error: undefined,
      createdAt: time - 3 * 3600,
      updatedAt: time - 3 * 3600,
    });
  const before = record.id;
  // Another record makes it prune.
  bot.state.sends = bot.state.sends.slice(1).concat(bot.state.sends[0]);
  bot.sends.expireOld();
  await sendDM(bot, alice, `/send ${invoice({ sats: 400 })}`);
  bot.sends.cancelOpen(A);
  assert.ok(
    bot.state.sends.some((r) => r.id === before),
    'the Unknown one is still there',
  );
  assert.ok(bot.state.sends.length <= 5000 + 2);
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
  assert.equal(payCount(wallet), 1);
});

test('past the cap of records that must be kept, new payments stop rather than evict', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  const time = Math.floor(Date.now() / 1000);
  const base = {
    requester: A,
    msat: 1,
    createdAt: time,
    updatedAt: time,
    checks: 0,
    state: 'paid',
  };
  for (let i = 0; i < 300; i++)
    bot.state.sends.push({
      ...base,
      id: i.toString(16).padStart(32, '0'),
      paymentHash: i.toString(16).padStart(64, '0'),
      ref: 'a'.repeat(32),
      invoiceExpires: time + 3600,
    });
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /cannot take more payments/);
  assert.equal(payCount(wallet), 0);
});

test('an invoice lasting past what records are kept for is refused', async (t) => {
  const { bot, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice({ expiry: 91 * 86400, expiryWords: 6 })}`);
  assert.match(lastMessage(bot).content, /lasts unusually long/);
});

test('a failure only a later lookup reported keeps its hash blocked', async (t) => {
  const { bot, wallet, text, record } = await unanswered(t);
  wallet.transactions = [{ ...paidRow(wallet, text, record.paymentHash), state: 'failed' }];
  record.invoiceExpires = Math.floor(Date.now() / 1000) - 120;
  await sendDM(bot, alice, '/payments');
  assert.equal(record.state, 'failed');
  // Another invoice, with the same hash and more time to run.
  const same = encode({ hash: Buffer.from(record.paymentHash, 'hex') });
  await sendDM(bot, alice, `/send ${same}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
  assert.equal(payCount(wallet), 1);
});

test('routing fees count toward the daily limit', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { dailySats: 1003, perHour: 100 } });
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(bot.state.sends[0].feesMsat, 3000);
  await sendDM(bot, alice, `/send ${invoice({ sats: 1 })}`);
  assert.match(lastMessage(bot).content, /would go over/);
});

test('a wallet’s error text cannot reach the logs', async (t) => {
  const { bot, invoice, wallet, logs } = await fixture(t, { checkDelays: [30] });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'X\nA wallet was disconnected by someone else.' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.ok(!logs.join('\n').includes('disconnected by someone else'));
  assert.equal(bot.state.sends[0].error, 'OTHER');
});

test('a wallet whose list leaves out get_info can still be re-checked', async (t) => {
  const { wallet, client } = await fixture(t);
  const secret = { ...wallet.secret, scope: 'spend', methods: ['get_balance'] };
  await client.verify(secret);
  wallet.methods = [...wallet.methods, 'pay_keysend'];
  client.checked.clear();
  await assert.rejects(client.verify(secret), (e) => e.code === 'admin_key');
});

test('the message about an Unknown payment fits a wallet that is gone', async (t) => {
  const { bot, invoice, wallet, registry, connection } = await fixture(t, {
    checkDelays: [0.02],
  });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  const card = preview(bot);
  wallet.forge = (_request, method) => {
    if (method === 'pay_invoice') setTimeout(() => registry.revoke(connection.id, 'user'), 0);
  };
  press(bot, alice, card, payButton(card));
  await until(() => bot.state.sends[0].state === 'unknown', 'the outcome');
  await settle(bot);
  assert.match(lastMessage(bot).content, /no longer connected.*Check that wallet/);
});

test('the Send question, when cancelled, talks about paying', async (t) => {
  const { bot } = await fixture(t);
  await sendDM(bot, alice, '/menu');
  press(bot, alice, lastMessage(bot), 's:ask');
  await settle(bot);
  await sendDM(bot, alice, '/cancel');
  assert.equal(lastMessage(bot).content, 'Cancelled. Nothing was paid.');
});

test('with sending off, /send and /payments say so, and buttons do nothing', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, alice, '/send lnbc1whatever');
  assert.match(lastMessage(bot).content, /Sending is not available/);
  await sendDM(bot, alice, '/payments');
  assert.match(lastMessage(bot).content, /Sending is not available/);
  await sendDM(bot, alice, `lnbc${'q'.repeat(40)}`);
  assert.ok(!/Pay /.test(lastMessage(bot).content));
  await sendDM(bot, alice, '/help');
  const before = repliesFor(bot, alice).length;
  press(bot, alice, lastMessage(bot), 's:ask');
  press(bot, alice, lastMessage(bot), 'pm:0');
  await settle(bot);
  assert.equal(repliesFor(bot, alice).length, before);
});

// ---- Limits ------------------------------------------------------------------------------

test('limits hold at confirmation too, and Unknown counts as spent', async (t) => {
  const { bot, invoice, record } = await unanswered(t, {
    limits: { dailySats: 1500 },
  });
  assert.equal(record.state, 'unknown');
  await sendDM(bot, alice, `/send ${invoice({ sats: 501 })}`);
  assert.match(lastMessage(bot).content, /would go over/);
  await sendDM(bot, alice, `/send ${invoice({ sats: 500 })}`);
  assert.match(preview(bot).content, /^Pay 500 sats/);
});

test('presses and previews cannot be used to flood anything', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { limits: { perHour: 100 } });
  bot.limits.requestsPerHour = 5;
  for (let i = 0; i < 20; i++) await sendDM(bot, alice, `/send ${invoice()}`);
  assert.ok(bot.state.sends.length <= 1, 'one waits at a time');
  assert.equal(payCount(wallet), 0);
  assert.ok(wallet.requests.length === 0, 'and the wallet was not asked');
});

test('previews are capped per hour for one person', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { perHour: 100 } });
  bot.limits.requestsPerHour = 1000;
  for (let i = 0; i < 31; i++) {
    await sendDM(bot, alice, `/send ${invoice()}`);
    await sendDM(bot, alice, `/cancel ${i}`); // the words make each a message of its own
  }
  assert.equal(bot.state.sends.length, 30);
});

const manyRecords = (count, fields) => {
  const time = Math.floor(Date.now() / 1000);
  return Array.from({ length: count }, (_, i) => ({
    id: i.toString(16).padStart(32, 'a'),
    requester: 'b'.repeat(64),
    paymentHash: i.toString(16).padStart(64, 'a'),
    msat: 1000,
    createdAt: time,
    updatedAt: time,
    checks: 0,
    state: 'failed',
    invoiceExpires: time + 3600,
    ...fields,
  }));
};

test('a bot at its cap of evictable records makes room, and still pays', async (t) => {
  const { bot, invoice } = await fixture(t);
  bot.state.sends = manyRecords(5000);
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(preview(bot).content, /^Pay/);
  assert.ok(bot.state.sends.length <= 5000);
});

test('many accounts filling the bot cannot stop someone else paying', async (t) => {
  const { bot, invoice } = await fixture(t);
  // Records nothing may evict, as a crowd of accounts with their own fake wallets could make.
  bot.state.sends = manyRecords(5000, { state: 'paid' });
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(preview(bot).content, /^Pay/, 'someone holding little still can');
  assert.equal(bot.state.sends.filter((r) => r.state === 'paid').length, 5000, 'nothing evicted');
  await sendDM(bot, alice, '/cancel');
  // Someone holding a lot, when the bot is full, cannot add more.
  const time = Math.floor(Date.now() / 1000);
  bot.state.sends.push(
    ...manyRecords(20, {
      requester: A,
      state: 'paid',
      createdAt: time,
      paymentHash: undefined,
    }).map((r, i) => ({
      ...r,
      id: i.toString(16).padStart(32, 'c'),
      paymentHash: i.toString(16).padStart(64, 'c'),
    })),
  );
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /cannot take more payments/);
});

test('an old payment keeps its hash blocked beyond the cap on other records', async (t) => {
  const { bot, invoice, record } = await unanswered(t);
  const time = Math.floor(Date.now() / 1000);
  // Past 24 hours, and its own invoice has expired, so another invoice is all that could pay it.
  Object.assign(record, {
    createdAt: time - 2 * 86400,
    updatedAt: time - 2 * 86400,
    invoiceExpires: time - 86400,
  });
  bot.state.sends.push(
    ...manyRecords(300, {
      requester: A,
      state: 'failed',
      createdAt: time - 3 * 3600,
      updatedAt: time - 3 * 3600,
    }),
  );
  await sendDM(bot, alice, `/send ${invoice({ sats: 5 })}`);
  assert.ok(bot.state.sends.includes(record), 'survived the 200 failed ones being cut');
  await sendDM(bot, alice, '/cancel');
  const again = encode({ hash: Buffer.from(record.paymentHash, 'hex') });
  await sendDM(bot, alice, `/send ${again}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
});

test('a switch-off for gaining power survives a ledger fault, and is re-checked before paying', async (t) => {
  const { bot, invoice, wallet, registry, connection, root, client, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  // The wallet gains a way to spend more than the bot allows, after the last check.
  wallet.methods = [...wallet.methods, 'pay_keysend'];
  client.checked.clear();
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(payments.length, 0);
  assert.equal(bot.state.sends[0].state, 'cancelled');

  registry.disable(connection.id, 'admin key');
  const path = ledgerFile(join(root, 'secrets'));
  chmodSync(path, 0o644);
  registry.check();
  chmodSync(path, 0o600);
  registry.check();
  assert.equal(registry.broken, false);
  assert.equal(registry.leaseById(connection.id), undefined, 'still off');
});

test('a ledger fault says nothing about a payment being checked', async (t) => {
  const { bot, invoice, wallet, registry, root } = await fixture(t, { checkDelays: [0.02, 0.02] });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  const path = ledgerFile(join(root, 'secrets'));
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => bot.state.sends[0].state === 'uncertain', 'the answer');
  chmodSync(path, 0o644);
  registry.check();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(bot.state.sends[0].state, 'uncertain', 'neither settled nor given up');
  assert.ok(!repliesFor(bot, alice).some((m) => /no longer connected/.test(m.content)));
  chmodSync(path, 0o600);
  registry.check();
  await until(() => bot.state.sends[0].state === 'unknown', 'the checks to continue');
});

test('a real fee counts in full, and an absurd one cannot overflow the count', async (t) => {
  const { bot, invoice, wallet } = await fixture(t, { limits: { dailySats: 2500, perHour: 100 } });
  let fee = 5_000_000;
  wallet.pay = (params) => ({
    preimage: wallet.preimages.get(params.invoice).toString('hex'),
    fees_paid: fee,
  });
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  await sendDM(bot, alice, `/send ${invoice({ sats: 500 })}`);
  assert.match(lastMessage(bot).content, /limit of 2,500 sats in 24 hours/, '6,000 sats went out');
  bot.state.sends.length = 0;
  fee = 2 ** 52;
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  bot.state.sends[0].sentAt = bot.state.sends[0].createdAt = nowSeconds() - 86401;
  bot.state.sends[0].invoiceExpires = nowSeconds() - 86401;
  await sendDM(bot, alice, `/send ${invoice({ sats: 500 })}`);
  assert.match(preview(bot).content, /^Pay 500 sats/, 'and stops counting when the window ends');
});

test('words fit what is known: wallets that know an invoice, reported failures, switch-offs', async (t) => {
  const { bot, wallet, text, record } = await unanswered(t);
  wallet.transactions = [{ ...paidRow(wallet, text, record.paymentHash), state: 'failed' }];
  record.invoiceExpires = Math.floor(Date.now() / 1000) - 120;
  await sendDM(bot, alice, '/payments');
  press(bot, alice, lastMessage(bot), `pm:0:${record.id.slice(0, 12)}`);
  await settle(bot);
  const shown = answers(bot).at(-1).content;
  assert.match(shown, /your wallet reports it failed/);
  assert.ok(!/it was not paid/.test(shown), 'it may still have been');
});

test('a hostile relay replaying the wallet’s old signed answer confirms nothing', async (t) => {
  const { bot, invoice, wallet, local, client } = await fixture(t, { checkDelays: [30] });
  // A genuine answer to an earlier request, signed by the wallet, about something else.
  const secret = bot.wallets.lease(A).key;
  await client.wallet(secret);
  const old = [...local.events.values()].filter((e) => e.kind === 23195).at(-1);
  assert.ok(old);
  // Whatever the bot subscribes to from here on, this relay answers with that old event, past
  // any filter.
  wallet.silent = ['pay_invoice'];
  const push = () => {
    for (const [socket, subs] of local.subscriptions)
      for (const id of subs.keys()) socket.send(JSON.stringify(['EVENT', id, old]));
  };
  await sendDM(bot, alice, `/send ${invoice()}`);
  bot.wallets.lease(A).client.pay = ((pay) => (key, text, options) => {
    const running = pay.call(client, key, text, { ...options, timeoutMs: 200 });
    setTimeout(push, 40);
    return running;
  })(client.pay);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'uncertain', 'not settled by it');
});

test('an old answer for another request is not taken for this one, whatever the method', async (t) => {
  const { wallet, local, client } = await fixture(t);
  const secret = { ...wallet.secret };
  const first = await client.request(secret, 'get_balance');
  assert.equal(first.balance, wallet.balance);
  const old = [...local.events.values()].filter((e) => e.kind === 23195).at(-1);
  wallet.mode = 'silent';
  const asked = client.request(secret, 'get_balance', {}, { timeoutMs: 200 });
  setTimeout(() => {
    for (const [socket, subs] of local.subscriptions)
      for (const id of subs.keys()) socket.send(JSON.stringify(['EVENT', id, old]));
  }, 40);
  await assert.rejects(asked, (e) => e.code === 'timeout');
});

// ---- What the third security review found ------------------------------------------------

const flood = (count, fields) =>
  manyRecords(count, {
    requester: getPublicKey(generateSecretKey()),
    msat: 1,
    state: 'paid',
    createdAt: nowSeconds() - 3600,
    updatedAt: nowSeconds() - 3600,
    invoiceExpires: nowSeconds() + 80 * 86400,
    ...fields,
  });

test('other accounts filling the bot never evict someone’s block on a hash', async (t) => {
  const context = await unanswered(t);
  const { bot, wallet, text, record } = context;
  const preimage = wallet.preimages.get(text);
  const again = () => {
    const other = encode({ hash: hashed(preimage), sats: 1000 });
    wallet.preimages.set(other, preimage);
    return other;
  };
  const old = nowSeconds() - 2 * 86400;
  for (const state of ['unknown', 'paid']) {
    Object.assign(record, { state, createdAt: old, updatedAt: old, invoiceExpires: old });
    bot.state.sends = [record];
    for (let i = 0; i < 17; i++) bot.state.sends.push(...flood(300));
    assert.ok(bot.state.sends.length > 5000);
    await sendDM(bot, alice, `/send ${again()}`);
    assert.match(lastMessage(bot).content, /already paid or attempted/, state);
    assert.ok(bot.state.sends.includes(record), `${state}: still on file`);
    // Something else that prunes, too: another invoice from the same person.
    await sendDM(bot, alice, `/send ${context.invoice({ sats: 10 })}`);
    assert.ok(bot.state.sends.includes(record), `${state}: survives a new preview`);
    await sendDM(bot, alice, '/cancel');
    await sendDM(bot, alice, `/send ${again()}`);
    assert.match(lastMessage(bot).content, /already paid or attempted/, state);
  }
  assert.equal(payCount(wallet), 1);
});

test('at the cap, old records go from whoever holds the most, and never the latest of anyone', async (t) => {
  const { bot, invoice } = await fixture(t);
  const old = nowSeconds() - 2 * 86400;
  const stale = { createdAt: old, updatedAt: old, invoiceExpires: old };
  const few = flood(20, stale);
  const some = flood(100, stale);
  const heavy = flood(800, stale);
  const held = [];
  for (let i = 0; i < 14; i++) held.push(...flood(300));
  bot.state.sends = [...few, ...some, ...heavy, ...held, ...flood(100)];
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  const left = new Set(bot.state.sends);
  assert.ok(bot.state.sends.length < 5000 + 2);
  assert.ok(
    few.every((r) => left.has(r)),
    'twenty or fewer: untouched',
  );
  assert.ok(
    some.every((r) => left.has(r)),
    'someone smaller keeps everything',
  );
  assert.ok(
    held.every((r) => left.has(r)),
    'what must be kept stays',
  );
  const remaining = heavy.filter((r) => left.has(r));
  assert.ok(remaining.length < heavy.length);
  assert.equal(remaining[0], heavy[heavy.length - remaining.length], 'the oldest went first');
});

test('a full bot: up to the fair share can pay, and a preview stays payable', async (t) => {
  const { bot, wallet, invoice } = await fixture(t, { limits: { perHour: 100 } });
  const mine = () =>
    flood(19, { requester: A, createdAt: nowSeconds() - 7200, updatedAt: nowSeconds() - 7200 });
  bot.state.sends = [...mine()];
  for (let i = 0; i < 17; i++) bot.state.sends.push(...flood(300));
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.match(lastMessage(bot).content, /^Paid 10 sats/);
  assert.equal(payCount(wallet), 1);
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  assert.match(lastMessage(bot).content, /cannot take more payments/, 'twenty held, and one more');
});

test('the thirtieth preview of an hour can be paid', async (t) => {
  const { bot, wallet, invoice } = await fixture(t, { limits: { perHour: 100 } });
  bot.state.sends = flood(29, {
    requester: A,
    state: 'cancelled',
    updatedAt: nowSeconds() - 60,
    createdAt: nowSeconds() - 60,
  });
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(payCount(wallet), 1);
});

test('the daily window runs from when a payment was sent, not from its preview', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { dailySats: 1500, perHour: 100 } });
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const [record] = bot.state.sends;
  assert.ok(record.sentAt >= record.createdAt);
  // The preview long ago, sent within the day.
  record.createdAt = nowSeconds() - 86500;
  record.invoiceExpires = nowSeconds() - 86500;
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  assert.match(lastMessage(bot).content, /limit of 1,500 sats in 24 hours/);
  record.sentAt = nowSeconds() - 86401;
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  assert.match(preview(bot).content, /^Pay 1,000 sats/);
});

test('the hourly limit counts when a payment was sent, not when it was last looked at', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { perHour: 1 } });
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const [record] = bot.state.sends;
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  assert.match(lastMessage(bot).content, /limit of payments per hour/);
  // Sent long ago, and only just settled by a Refresh: nothing new was spent.
  record.sentAt = nowSeconds() - 3601;
  record.updatedAt = nowSeconds();
  await sendDM(bot, alice, `/send ${invoice({ sats: 1000 })}`);
  assert.match(lastMessage(bot).content, /^Pay 1,000 sats/);
});

test('a failure only a lookup reported is not called "nothing was paid", and proof corrects it', async (t) => {
  const context = await unanswered(t);
  const { bot, wallet, text, record } = context;
  const card = preview(bot);
  const row = paidRow(wallet, text, record.paymentHash);
  wallet.transactions = [{ ...row, state: 'failed' }];
  record.invoiceExpires = nowSeconds() - 120;
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(record.state, 'failed');
  assert.equal(record.error, 'lookup');
  press(bot, alice, card, payButton(card));
  await settle(bot);
  const stale = answers(bot).at(-1).content;
  assert.match(stale, /wallet reports/);
  assert.doesNotMatch(stale, /Nothing was paid/);
  // A failed row again changes nothing, and an unproven settled row neither.
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(record.state, 'failed');
  wallet.transactions = [{ ...row, preimage: '00'.repeat(32) }];
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(record.state, 'failed');
  wallet.transactions = [row];
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(record.state, 'paid');
  assert.equal(record.error, undefined);
  assert.equal(payCount(wallet), 1);
});

test('a wallet’s certain refusal stays final, whatever a lookup later says', async (t) => {
  const { bot, wallet, invoice } = await fixture(t);
  const text = invoice();
  wallet.errors = { pay_invoice: 'INSUFFICIENT_BALANCE' };
  await sendDM(bot, alice, `/send ${text}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const [record] = bot.state.sends;
  assert.equal(record.state, 'failed');
  wallet.transactions = [paidRow(wallet, text, record.paymentHash)];
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(record.state, 'failed');
});

test('the outcome reaches the person’s own relays after their only wallet is disconnected', async (t) => {
  const { bot, wallet, registry, connection, invoice } = await fixture(t, { checkDelays: [0.02] });
  bot.net.query = async () => [sign(alice, 10050, [['relay', 'wss://alice-inbox.example/']])];
  bot.inboxes?.clear?.();
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.silent = ['pay_invoice'];
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => wallet.requests.some((r) => r.method === 'pay_invoice'), 'the payment');
  registry.revoke(connection.id, 'user');
  await settle(bot);
  await until(() => bot.state.sends[0].state === 'unknown', 'Unknown');
  await settle(bot);
  const notices = bot.state.outbox.filter((item) => {
    try {
      return /no longer connected|do not know yet/.test(unwrapEvent(item.event, alice).content);
    } catch {
      return false;
    }
  });
  assert.ok(notices.length >= 1);
  for (const item of notices) assert.ok(item.relays.includes('wss://alice-inbox.example/'));
});

test('/cancel, and the Cancel button on a question, also cancel a payment waiting', async (t) => {
  const { bot, wallet, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  bot.awaiting.set(A, { at: nowSeconds(), kind: 'send' });
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /Cancelled\. Nothing was paid/);
  assert.equal(bot.state.sends[0].state, 'cancelled');
  assert.equal(bot.awaiting.has(A), false);
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(payCount(wallet), 0);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const second = preview(bot);
  await sendDM(bot, alice, '/menu');
  const menu = lastMessage(bot);
  press(bot, alice, menu, 's:ask');
  await settle(bot);
  press(bot, alice, menu, 'inv:cancel', { view: answers(bot).at(-1).id });
  await settle(bot);
  assert.equal(bot.state.sends[1].state, 'cancelled');
  press(bot, alice, second, payButton(second));
  await settle(bot);
  assert.equal(payCount(wallet), 0);
});

test('an operator’s finished revocation stops a press at once, without waiting for the poll', async (t) => {
  const { bot, wallet, registry, connection, invoice, root } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const ledger = Ledger.open(join(root, 'secrets'), registry.keyring);
  const store = new Store(join(root, DB_FILE));
  defer(t, () => store.close());
  const row = store.connection(connection.id);
  ledger.append({ connection: row.id, ref: row.ref, actor: 'operator' });
  store.revoke(row.id, 'operator');
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(payCount(wallet), 0);
  assert.equal(bot.state.sends[0].state, 'cancelled');
  assert.equal(registry.connection(row.id), undefined);
});

test('wallets are watched before anything from the relays can be read', async (t) => {
  const { bot, registry } = await fixture(t);
  const order = [];
  const watching = registry.startWatching;
  registry.startWatching = function (...args) {
    order.push('watching');
    return watching.apply(this, args);
  };
  const start = BotTransport.prototype.start;
  BotTransport.prototype.start = async function () {
    order.push('reading');
  };
  t.after(() => {
    BotTransport.prototype.start = start;
    registry.stopWatching();
  });
  await bot.start();
  assert.deepEqual(order, ['watching', 'reading']);
});

test('gaining a power is noticed at the next payment, and switches the connection off', async (t) => {
  const { bot, wallet, registry, connection, client, invoice } = await fixture(t);
  await client.verify({ ...wallet.secret, scope: 'spend' }); // recently checked
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.methods = [...wallet.methods, 'pay_keysend'];
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(payCount(wallet), 0);
  assert.equal(registry.connection(connection.id).disabled, 'admin key');
  assert.equal(registry.lease(A), undefined);
  assert.equal(bot.state.sends[0].state, 'cancelled');
});

test('a wallet switched off is not called disconnected', async (t) => {
  const { bot, wallet, registry, connection, invoice } = await fixture(t, { checkDelays: [0.2] });
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => bot.state.sends[0].state === 'uncertain', 'uncertain');
  registry.disable(connection.id, 'admin key');
  await until(() => bot.state.sends[0].state === 'unknown', 'Unknown');
  await settle(bot);
  const told = repliesFor(bot, alice).at(-1).content;
  assert.match(told, /switched off here/);
  assert.doesNotMatch(told, /no longer connected/);
});

test('Refresh settles every row of a page, and stops asking a wallet that does not answer', async (t) => {
  const { bot, wallet, invoice } = await fixture(t, { checkDelays: [0.01] });
  const texts = [];
  for (let i = 0; i < 5; i++) {
    const text = invoice({ sats: 10 + i });
    texts.push(text);
    wallet.errors = { pay_invoice: 'INTERNAL' };
    await sendDM(bot, alice, `/send ${text}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await until(() => bot.state.sends.at(-1).state === 'unknown', 'Unknown');
    await settle(bot);
    wallet.errors = {};
  }
  wallet.silent = ['lookup_invoice'];
  const asked = () => wallet.requests.filter((r) => r.method === 'lookup_invoice').length;
  const before = asked();
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.equal(asked(), before + 1, 'one unanswered lookup is enough');
  assert.match(lastMessage(bot).content, /could not check some/);
  wallet.silent = [];
  wallet.transactions = bot.state.sends.map((r, i) => ({
    ...paidRow(wallet, texts[i], r.paymentHash, r.msat / 1000),
  }));
  await sendDM(bot, alice, '/payments');
  await settle(bot);
  assert.ok(bot.state.sends.every((r) => r.state === 'paid'));
  assert.doesNotMatch(lastMessage(bot).content, /could not check/);
});

// ---- What the review of those fixes found ------------------------------------------------

test('a database too busy to apply a revocation stops the press, whatever the ledger says', async (t) => {
  const { bot, wallet, registry, connection, invoice, root } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const ledger = Ledger.open(join(root, 'secrets'), registry.keyring);
  ledger.append({ connection: connection.id, ref: connection.ref, actor: 'operator' });
  const other = new DatabaseSync(join(root, DB_FILE));
  other.exec('BEGIN IMMEDIATE');
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  other.exec('ROLLBACK');
  other.close();
  assert.equal(payCount(wallet), 0);
  assert.equal(bot.state.sends[0].state, 'cancelled');
  registry.check();
  assert.equal(registry.connection(connection.id), undefined);
});

test('old Unknown records of someone filling the bot go before anyone else’s old records', async (t) => {
  const { bot, invoice } = await fixture(t);
  const old = nowSeconds() - 2 * 86400;
  const stale = { createdAt: old, updatedAt: old, invoiceExpires: old };
  const victim = flood(100, stale);
  const attackers = [];
  for (let i = 0; i < 17; i++) attackers.push(...flood(300, { ...stale, state: 'unknown' }));
  bot.state.sends = [...victim, ...attackers];
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  assert.match(preview(bot).content, /^Pay 10 sats/);
  const left = new Set(bot.state.sends);
  assert.ok(victim.every((r) => left.has(r)));
  assert.ok(attackers.some((r) => !left.has(r)));
});

test('a person’s own old Unknown records never lock them out', async (t) => {
  const { bot, wallet, invoice } = await fixture(t);
  const old = nowSeconds() - 2 * 86400;
  bot.state.sends = flood(300, {
    requester: A,
    state: 'unknown',
    createdAt: old,
    updatedAt: old,
    invoiceExpires: old,
  });
  await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(payCount(wallet), 1);
});

test('a limit without a reading of what is used of it is not accepted', async (t) => {
  const { bot, wallet, invoice, local } = await fixture(t);
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const secret = { ...wallet.secret, scope: 'spend' };
  for (const used of ['999', 999.5, -1, undefined]) {
    wallet.budget = { total_budget: 1_000_000, used_budget: used };
    await assert.rejects(client.inspect(secret), (e) => e.code === 'bad_response');
    await sendDM(bot, alice, `/send ${invoice({ sats: 10 })}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
    assert.equal(payCount(wallet), 0);
    assert.match(answers(bot).at(-1).content, /could not check with your wallet/);
  }
});

test('cancelling says nothing about what went before; waiting says nothing new was sent', async (t) => {
  const { bot, record, invoice } = await unanswered(t);
  const cancelling = (state) => {
    record.state = state;
    bot.awaiting.set(A, { kind: 'send' });
    return bot.cancelAll(A);
  };
  assert.match(cancelling('unknown'), /Nothing new was sent\. An earlier payment may still have/);
  assert.match(cancelling('uncertain'), /An earlier payment may still have/);
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.equal(lastMessage(bot).content, SEND_TEXT.busy);
  assert.doesNotMatch(SEND_TEXT.busy, /Nothing was paid/);
  assert.equal(cancelling('paid'), 'Cancelled. Nothing was paid.');
});

test('what was shown running out while the wallet is asked stops the payment', async (t) => {
  for (const expire of [
    (record) => (record.previewExpires = nowSeconds() - 1),
    (record) => (record.invoiceExpires = nowSeconds() + 5),
  ]) {
    const { bot, wallet, invoice } = await fixture(t);
    await sendDM(bot, alice, `/send ${invoice()}`);
    const card = preview(bot);
    const [record] = bot.state.sends;
    // Called right after the last answer from the wallet.
    const { check } = bot.wallets;
    bot.wallets.check = function () {
      expire(record);
      return check?.call(this);
    };
    press(bot, alice, card, payButton(card));
    await settle(bot);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.error, 'expired');
    assert.equal(payCount(wallet), 0);
  }
});

test('a press that ran out while waiting is told, by message, and pays nothing', async (t) => {
  const { bot, wallet, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  const [record] = bot.state.sends;
  // Time passes while the wallet is asked: the check runs right after its last answer.
  const { check } = bot.wallets;
  let pressed;
  bot.wallets.check = function () {
    pressed.expires = nowSeconds();
    return check?.call(this);
  };
  const pressing = bot.sends.press.bind(bot.sends);
  bot.sends.press = (first, ...rest) => {
    pressed = first.button.request;
    return pressing(first, ...rest);
  };
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(record.state, 'cancelled');
  assert.equal(payCount(wallet), 0);
  assert.equal(
    repliesFor(bot, alice).filter((r) => r.kind === 14 && r.content === SEND_TEXT.stalePreview)
      .length,
    1,
  );
});

test('a record cancelled while a late press tells the person does not stop the bot', async (t) => {
  const { bot, wallet, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  const [record] = bot.state.sends;
  const { check } = bot.wallets;
  let pressed;
  bot.wallets.check = function () {
    pressed.expires = nowSeconds();
    return check?.call(this);
  };
  const pressing = bot.sends.press.bind(bot.sends);
  bot.sends.press = (first, ...rest) => {
    pressed = first.button.request;
    return pressing(first, ...rest);
  };
  // Someone's disconnect, or another person's /send, lands while the relays are being looked up.
  const { inbox } = bot;
  let during;
  bot.inbox = async function (...args) {
    if (record.state === 'prepared' || during === undefined) {
      during = record.state;
      bot.sends.cancelOpen(A);
    }
    return inbox.apply(this, args);
  };
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(bot.stopped, false, 'the bot goes on');
  assert.equal(record.state, 'cancelled');
  assert.equal(during, 'cancelled', 'settled before anything was awaited');
  assert.equal(payCount(wallet), 0);
});

test('nothing about a wallet is readable with the bot key', async (t) => {
  const { bot, invoice, connection } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, alice, `/send ${invoice({ memo: 'private' })}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.ok(repliesFor(bot, alice).length >= 3);
  // A notification too.
  await bot.announce(bot.wallets.leaseById(connection.id), 'Received: 1 sat', () => {});
  await settle(bot);
  assert.ok(repliesFor(bot, alice).some((r) => r.content === 'Received: 1 sat'));
  assert.deepEqual(repliesFor(bot, bot.key), []);
});
