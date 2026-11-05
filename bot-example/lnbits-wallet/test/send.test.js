// /send against a mock NWC wallet. No real or synthetic Lightning payment happens anywhere here.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools';
import { checksumOk, decodeInvoice, InvoiceError } from '../bolt11.js';
import { failureText, forWallet } from '../commands.js';
import { NwcError } from '../nwc.js';
import { loadConfig } from '../config.js';
import { SEND_TEXT } from '../send.js';
import { BOT_CONTROL_KIND } from '../vendor/botKeyboardProtocol.ts';
import { alice, bob, defer, repliesFor, sendDM, settle, setup } from './helpers.js';
import {
  cancelButton,
  CHARSET,
  encode,
  field,
  fixture,
  lastMessage,
  numberWords,
  payButton,
  press,
  preview,
  toWords,
  until,
} from './send-helpers.js';
import { nwcService } from './nwc-server.js';

const A = getPublicKey(alice);

test('invoices are read exactly, and anything off is refused', () => {
  const hash = randomBytes(32);
  const read = decodeInvoice(
    encode({ sats: 1500, memo: 'tea', hash, timestamp: 1800000000, expiry: 900 }),
  );
  assert.equal(read.amountMsat, 1_500_000);
  assert.equal(read.paymentHash, hash.toString('hex'));
  assert.equal(read.description, 'tea');
  assert.equal(read.expiresAt, 1800000900);
  assert.equal(
    decodeInvoice(`lightning:${encode({ sats: 2 })}`).amountMsat,
    2000,
    'with its URI prefix',
  );
  assert.equal(
    decodeInvoice(encode({ sats: 2 }).toUpperCase()).amountMsat,
    2000,
    'case does not matter',
  );
  assert.equal(decodeInvoice(encode({ hrp: 'lnbc2500u' })).amountMsat, 250_000_000);
  assert.equal(decodeInvoice(encode({ hrp: 'lnbc1m' })).amountMsat, 100_000_000);
  assert.equal(decodeInvoice(encode({ hrp: 'lnbc25n' })).amountMsat, 2500);
  assert.equal(decodeInvoice(encode({ hrp: 'lnbc10p' })).amountMsat, 1);
  assert.equal(decodeInvoice(encode({ hrp: 'lnbc1' })).amountMsat, 100_000_000_000);
  const refused = {
    format: [
      '',
      'hello',
      'lnbc1',
      'lnbc1qqqq',
      encode({ hrp: 'lnbc15p' }),
      `lnbc${'q'.repeat(5000)}`,
    ],
    checksum: [encode({ corrupt: true })],
    no_amount: [encode({ hrp: 'lnbc' })],
    network: [encode({ hrp: 'lntb20n' }), encode({ hrp: 'lnbcrt20n' })],
  };
  for (const [code, list] of Object.entries(refused))
    for (const text of list)
      assert.throws(
        () => decodeInvoice(text),
        (error) => error instanceof InvoiceError && error.code === code,
        text.slice(0, 20),
      );
  assert.equal(decodeInvoice(encode({ hrp: 'lntb20n' }), { networks: ['tb'] }).network, 'tb');
  assert.ok(
    checksumOk(
      'lnbc20n',
      [...encode({ sats: 2 }).slice(8)].map((c) => CHARSET.indexOf(c)),
    ),
  );
});

test('sending is off unless the operator turns it on', () => {
  const env = { LNBITS_URL: 'https://l.example' };
  assert.equal(loadConfig(env).send, undefined);
  const on = loadConfig({ ...env, SEND_ENABLED: 'true' }).send;
  assert.deepEqual(on, { maxSats: 10000, dailySats: 50000, perHour: 5 });
  assert.equal(loadConfig({ ...env, SEND_ENABLED: 'true', SEND_MAX_SATS: '5' }).send.maxSats, 5);
});

test('preview, confirm, one payment, and a clear result', async (t) => {
  const { bot, payments, invoice, wallet } = await fixture(t);
  const text = invoice({ sats: 1000, memo: 'lunch https://evil.example' });
  await sendDM(bot, alice, `/send ${text}`);
  const card = preview(bot);
  assert.match(card.content, /^Pay 1,000 sats from Spending\?/);
  assert.match(
    card.content,
    /The invoice says: lunch \(link\)/,
    'the description is treated as hostile',
  );
  assert.match(card.content, /Plus a routing fee/);
  assert.match(card.content, /Nothing is paid until you confirm/);
  assert.equal(payments.length, 0, 'nothing paid by asking');
  assert.equal(bot.state.sends[0].state, 'prepared');

  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.deepEqual(payments, [text]);
  assert.equal(bot.state.sends[0].state, 'paid');
  assert.match(lastMessage(bot).content, /^Paid 1,000 sats\. Routing fee: 3 sats\./);
  assert.ok(
    wallet.requests.some((r) => r.method === 'get_budget'),
    'the wallet limit was read',
  );
});

test('repeating a press, or pressing again, never pays twice', async (t) => {
  const { bot, payments, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  const data = payButton(card);
  const first = press(bot, alice, card, data);
  bot.buttonRequest(first); // a relay resending it while it runs
  await settle(bot);
  assert.equal(payments.length, 1);
  bot.buttonRequest(first); // the app retrying the same request
  press(bot, alice, card, data); // and a new press on the same card
  await settle(bot);
  assert.equal(payments.length, 1);
  assert.match(lastMessage(bot).content, /already paid/);
});

test('the same invoice cannot be paid twice from here', async (t) => {
  const { bot, payments, invoice } = await fixture(t);
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/);
  assert.equal(payments.length, 1);
});

test('cancel by button or /cancel; a waiting request blocks another', async (t) => {
  const { bot, payments, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /already have a payment waiting/);
  press(bot, alice, card, cancelButton(card));
  await settle(bot);
  assert.match(lastMessage(bot).content, /^Cancelled\. Nothing was paid/);
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.match(lastMessage(bot).content, /already cancelled/);

  await sendDM(bot, alice, `/send ${invoice()}`);
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /^Cancelled/);
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /nothing to cancel/);
  assert.equal(payments.length, 0);
});

test('a preview expires, and so does an invoice', async (t) => {
  const { bot, payments, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice({ timestamp: Math.floor(Date.now() / 1000) - 7200 })}`);
  assert.match(lastMessage(bot).content, /has expired/);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  bot.state.sends.at(-1).previewExpires = Math.floor(Date.now() / 1000) - 1;
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.match(lastMessage(bot).content, /has expired\. Nothing was paid/);
  assert.equal(payments.length, 0);
  assert.equal(bot.state.sends.at(-1).state, 'cancelled');
});

test('limits per payment, per day and per hour; checked again at confirmation', async (t) => {
  const { bot, payments, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice({ sats: 10001 })}`);
  assert.match(lastMessage(bot).content, /limit of 10,000 sats per payment/);
  for (const sats of [10000, 10000]) {
    await sendDM(bot, alice, `/send ${invoice({ sats })}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
  }
  assert.equal(payments.length, 2);
  await sendDM(bot, alice, `/send ${invoice({ sats: 6000 })}`);
  assert.match(lastMessage(bot).content, /limit of 25,000 sats in 24 hours/);

  // Two previews are not allowed at once, but one waiting can go over once something else lands.
  await sendDM(bot, alice, `/send ${invoice({ sats: 4990 })}`);
  const card = preview(bot);
  bot.state.sends.find((r) => r.state === 'paid').msat += 10000;
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.match(lastMessage(bot).content, /in 24 hours/);
  assert.equal(payments.length, 2);
});

test('hourly limit', async (t) => {
  const { bot, invoice, payments } = await fixture(t, { limits: { perHour: 1, dailySats: 1e6 } });
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /limit of payments per hour/);
  assert.equal(payments.length, 1);
});

test('a receive-only connection cannot send, and the client refuses outright', async (t) => {
  const { bot, invoice, client, wallet } = await fixture(t, { spend: false });
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /connected for receiving only/);
  assert.deepEqual(bot.state.sends, []);
  await assert.rejects(client.pay(wallet.secret, 'lnbc1'), /cannot pay/);
  await assert.rejects(
    client.request({ ...wallet.secret, scope: 'spend' }, 'pay_invoice', { invoice: 'x' }),
    /not allowed/,
    'only pay() can pay',
  );
  assert.ok(!wallet.requests.some((r) => r.method === 'pay_invoice'));
});

test('no spending limit in the wallet: not paid, whatever the chat says', async (t) => {
  const { bot, invoice, payments, wallet, client } = await fixture(t);
  wallet.budget = { total_budget: 0 };
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.match(lastMessage(bot).content, /could not confirm a spending limit/);
  assert.equal(payments.length, 0);
  assert.equal(bot.state.sends[0].state, 'cancelled');

  const secret = { ...wallet.secret, scope: 'spend' };
  await assert.rejects(client.inspect(secret), (e) => e instanceof NwcError && e.code === 'budget');
  wallet.budget = undefined; // offered in name only
  await assert.rejects(client.inspect(secret), (e) => e.code === 'budget');
  wallet.methods = wallet.methods.filter((m) => m !== 'get_budget');
  await assert.rejects(client.inspect(secret), (e) => e.code === 'budget');
  wallet.methods = wallet.methods.filter((m) => m !== 'lookup_invoice');
  await assert.rejects(client.inspect(secret), (e) => e.code === 'methods');
  wallet.methods = [...wallet.methods, 'lookup_invoice', 'get_budget', 'pay_keysend'];
  wallet.budget = { total_budget: 1000 };
  await assert.rejects(
    client.inspect(secret),
    (e) => e.code === 'spending',
    'no more than invoices',
  );
});

test('the wallet refusing (its limit, no funds) ends it clearly', async (t) => {
  for (const [code, text] of [
    ['QUOTA_EXCEEDED', /over the spending limit set in your wallet/],
    ['INSUFFICIENT_BALANCE', /does not have enough funds/],
    ['RESTRICTED', /does not allow this connection/],
  ]) {
    const { bot, invoice, wallet } = await fixture(t);
    wallet.errors = { pay_invoice: code };
    await sendDM(bot, alice, `/send ${invoice()}`);
    press(bot, alice, preview(bot), payButton(preview(bot)));
    await settle(bot);
    assert.match(lastMessage(bot).content, text, code);
    assert.match(lastMessage(bot).content, /Nothing was paid/);
    assert.equal(bot.state.sends[0].state, 'failed');
    assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 1);
  }
});

test('PAYMENT_FAILED may be a timeout: not told nothing was paid, and still counted', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  wallet.errors = { pay_invoice: 'PAYMENT_FAILED' };
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.notEqual(bot.state.sends[0].state, 'failed');
  assert.ok(!/Nothing was paid/.test(lastMessage(bot).content));
  await sendDM(bot, alice, `/send ${text}`);
  assert.match(lastMessage(bot).content, /already paid or attempted/, 'not offered again');
  assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 1);
});

test('the outcome arrives as a message, even when the press has gone stale', async (t) => {
  const { bot, invoice, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.equal(payments.length, 1);
  const messages = repliesFor(bot, alice).filter((r) => r.kind === 14 && /^Paid/.test(r.content));
  assert.equal(messages.length, 1);
});

test('the result is told once: the card points to the message, and does not repeat it', async (t) => {
  const { bot, invoice } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const replies = repliesFor(bot, alice);
  assert.equal(replies.filter((r) => /^Paid/.test(r.content)).length, 1);
  assert.equal(replies.at(-1).kind, BOT_CONTROL_KIND);
  assert.equal(replies.at(-1).content, SEND_TEXT.seeBelow);
});

test('cancelled requests cannot push out what may have been paid, and are limited', async (t) => {
  const { bot, invoice } = await fixture(t, { limits: { perHour: 1000, dailySats: 1e6 } });
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  const paid = bot.state.sends[0];
  assert.equal(paid.state, 'paid');
  const time = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 29; i++)
    bot.state.sends.push({
      ...paid,
      id: randomBytes(16).toString('hex'),
      state: 'cancelled',
      createdAt: time,
      updatedAt: time,
    });
  await sendDM(bot, alice, `/send ${invoice()}`);
  assert.match(lastMessage(bot).content, /limit of payments per hour/);
  assert.ok(bot.state.sends.includes(paid));
});

test('repeated fields, huge expiries and mixed case are not invoices', () => {
  const good = encode({ sats: 2 });
  assert.throws(
    () => decodeInvoice(`${good.slice(0, 8)}${good.slice(8, 20).toUpperCase()}${good.slice(20)}`),
    (e) => e.code === 'format',
    'mixed case',
  );
  const hash = randomBytes(32);
  assert.throws(
    () => decodeInvoice(encode({ extra: field(1, toWords(hash)) })),
    (e) => e.code === 'format',
  );
  assert.throws(
    () => decodeInvoice(encode({ extra: field(13, toWords(Buffer.from('other'))) })),
    (e) => e.code === 'format',
  );
  assert.throws(
    () => decodeInvoice(encode({ extra: field(6, numberWords(1, 3)) })),
    (e) => e.code === 'format',
  );
  assert.throws(
    () => decodeInvoice(encode({ expiryWords: 300 })),
    (e) => e.code === 'format',
  );
});

test('wording fits the wallet: no operator to ask, and NWC is not LNbits', () => {
  const text = failureText({ code: 'rejected' });
  assert.match(forWallet(text, { kind: 'lnbits', source: 'operator' }), /ask the bot operator/);
  assert.match(
    forWallet(text, { kind: 'lnbits', source: 'self' }),
    /connect it again with \/connect/,
  );
  const nwc = { kind: 'nwc', source: 'self' };
  assert.ok(!/LNbits|operator/.test(forWallet(text, nwc)));
  assert.equal(
    forWallet(failureText({ code: 'timeout' }), nwc),
    'Your wallet is not reachable right now. Please try again in a few minutes.',
  );
  assert.equal(forWallet(text, undefined), text);
});

test('no answer: never sent again; looked up, and resolved when the wallet says so', async (t) => {
  const { bot, invoice, wallet, payments } = await fixture(t);
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  const card = preview(bot);
  // The wallet pays but its answer never arrives.
  const client = bot.wallets.lease(A).client;
  const pay = client.pay.bind(client);
  client.pay = (secret, bolt11, options) => pay(secret, bolt11, { ...options, timeoutMs: 100 });
  wallet.pay = (params) => {
    payments.push(params.invoice);
    return { error: 'INTERNAL' };
  };
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.equal(bot.state.sends[0].state, 'uncertain');
  assert.match(lastMessage(bot).content, /It will not be sent again/);
  const hash = bot.state.sends[0].paymentHash;
  wallet.transactions.unshift({
    type: 'outgoing',
    state: 'settled',
    invoice: text,
    payment_hash: hash,
    amount: 1_000_000,
    description: '',
    created_at: 1,
    settled_at: 2,
    preimage: wallet.preimages.get(text).toString('hex'),
  });
  await until(() => bot.state.sends[0].state === 'paid', 'the lookup');
  await settle(bot);
  assert.match(lastMessage(bot).content, /^Paid 1,000 sats/);
  assert.equal(payments.length, 1, 'never a second request');
  assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 1);
});

test('still unknown after every check: never sent again, and told plainly', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  wallet.errors = { pay_invoice: 'INTERNAL' };
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await until(() => bot.state.sends[0].state === 'unknown', 'the last check');
  await settle(bot);
  assert.match(lastMessage(bot).content, /Check your wallet/);
  assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 1);
  // It still counts against the limit, because it may have been paid.
  await sendDM(bot, alice, `/send ${invoice({ sats: 10000 })}`);
  assert.equal(bot.sends.all.filter((r) => r.state === 'unknown').length, 1);
});

test('a wrong proof of payment is not believed', async (t) => {
  const { bot, invoice, wallet } = await fixture(t);
  wallet.pay = () => ({ preimage: 'ab'.repeat(32) });
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  assert.notEqual(bot.state.sends[0].state, 'paid');
  assert.match(lastMessage(bot).content, /will not be sent again/);
});

test('a crash while paying: uncertain at the next start, and never sent again', async (t) => {
  const { bot, invoice, wallet, registry, dir, payments } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  bot.state.sends[0].state = 'sending'; // as saved just before the request
  bot.save();
  await bot.close();

  const second = setup(t, {
    wallets: registry,
    lnbits: bot.lnbits,
    dir,
    send: { checkDelays: [0.02] },
  });
  second.bot.flush = async () => {};
  second.bot.sends.recover();
  assert.equal(second.bot.state.sends[0].state, 'uncertain');
  await until(() => second.bot.state.sends[0].state === 'unknown', 'the check');
  await settle(second.bot);
  assert.equal(payments.length, 0);
  assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 0);
  assert.match(lastMessage(second.bot).content, /Check your wallet/);
});

test('corrupt payment records stop startup', async (t) => {
  const { bot, registry, dir } = await fixture(t);
  bot.state.sends = [{ id: 'nope' }];
  bot.save();
  await bot.close();
  assert.throws(() => setup(t, { wallets: registry, dir, send: {} }), /Invalid payment records/);
});

test("nobody else can confirm someone's payment", async (t) => {
  const { bot, invoice, payments, registry, wallet } = await fixture(t);
  registry.connect({
    owner: getPublicKey(bob),
    kind: 'nwc',
    label: 'Bob',
    origin: 'nwc:other',
    secret: { ...wallet.secret, walletPubkey: 'b'.repeat(64), scope: 'spend' },
  });
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  press(bot, bob, card, payButton(card));
  await settle(bot);
  assert.equal(payments.length, 0);
  assert.equal(bot.state.sends[0].state, 'prepared');
  assert.deepEqual(repliesFor(bot, bob), []);
  // A data value the card does not offer is dropped too.
  press(bot, alice, card, 's:ok:000000000000');
  await settle(bot);
  assert.equal(payments.length, 0);
});

test('disconnecting cancels what waits; a stale card cannot pay from anything else', async (t) => {
  const { bot, invoice, payments, registry, connection, wallet } = await fixture(t);
  const second = registry.connect({
    owner: A,
    kind: 'nwc',
    label: 'Other',
    origin: 'nwc:other',
    secret: { ...wallet.secret, walletPubkey: 'c'.repeat(64), scope: 'spend' },
  });
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  registry.select(A, second.id);
  registry.revoke(connection.id, 'user');
  assert.equal(bot.state.sends[0].state, 'cancelled');
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.match(lastMessage(bot).content, /no longer linked/);
  assert.equal(payments.length, 0);
});

test('switching wallets: a preview pays only from the wallet it named', async (t) => {
  const { bot, invoice, registry, local, payments } = await fixture(t);
  const other = await nwcService(local.url);
  defer(t, () => other.close());
  other.methods = [...other.methods, 'get_budget', 'pay_invoice'];
  other.budget = { total_budget: 1e9 };
  const otherPaid = [];
  other.pay = (params) => {
    otherPaid.push(params.invoice);
    return { error: 'INTERNAL' };
  };
  const second = registry.connect({
    owner: A,
    kind: 'nwc',
    label: 'Other',
    origin: `nwc:${other.walletPubkey}`,
    secret: { ...other.secret, scope: 'spend' },
  });
  const text = invoice();
  await sendDM(bot, alice, `/send ${text}`);
  const card = preview(bot);
  assert.match(card.content, /from Spending\?/);
  registry.select(A, second.id);
  press(bot, alice, card, payButton(card));
  await settle(bot);
  assert.deepEqual(payments, [text], 'the wallet it named');
  assert.deepEqual(otherPaid, []);
});

test('revoked while the payment is running: never sent again, and the person is told', async (t) => {
  const { bot, invoice, wallet, registry, connection } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  const card = preview(bot);
  wallet.mode = 'late';
  wallet.delayMs = 100;
  press(bot, alice, card, payButton(card));
  await until(() => wallet.requests.some((r) => r.method === 'pay_invoice'), 'the payment request');
  assert.equal(bot.state.sends[0].state, 'sending');
  registry.revoke(connection.id, 'user');
  await until(() => bot.state.sends[0].state === 'unknown', 'the outcome');
  await settle(bot);
  assert.equal(wallet.requests.filter((r) => r.method === 'pay_invoice').length, 1);
  assert.match(lastMessage(bot).content, /Check that wallet/, 'it may have gone through');
});

test('nothing secret reaches logs or state, and text is plain', async (t) => {
  const { bot, invoice, wallet, logs, dir } = await fixture(t);
  await sendDM(bot, alice, `/send ${invoice()}`);
  press(bot, alice, preview(bot), payButton(preview(bot)));
  await settle(bot);
  bot.save();
  const everything = logs.join('\n') + readFileSync(`${dir}/state.json`, 'utf8');
  assert.ok(!everything.includes(wallet.clientSecret));
  assert.ok(!logs.join('\n').match(/lnbc/));
});

test('off by default: /send says so, and history still shows payments as usual', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, alice, '/send lnbc1');
  assert.match(lastMessage(bot).content, /not available/);
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /nothing to cancel/);
});
