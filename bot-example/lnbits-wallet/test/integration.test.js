// The failure and recovery tests a person would otherwise run by hand, against a real bot process.
// See live-bot.js for what surrounds it. In-process tests cover each rule; these cover the rules
// still holding when a process dies, a relay goes away or several accounts are at it together.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALICE_KEY, BOB_KEY } from './helpers.js';
import { button, buttons, LONG, pause, until, world } from './live-bot.js';

const pay = (card) => button(card, /^Pay /);
const preview = async (w, who, wallet, sats = 100, options = {}) => {
  const made = wallet.run('invoice', { sats, ...options });
  who.say(`/send ${made.invoice}`);
  return { ...made, card: await who.next(/^Pay /, 'a preview') };
};
const record = (w, hash) => w.state().sends.find((r) => r.paymentHash === hash);
const clean = (status, requests) => {
  assert.equal(status.payRequests, requests);
  assert.deepEqual(status.duplicates, []);
};

test(
  'a burst of presses from two devices, and replays, pay once and tell once',
  LONG,
  async (t) => {
    const w = await world(t);
    const a = w.person();
    const wallet = await w.wallet();
    await w.connectNwc(a, wallet);
    const { card, invoice } = await preview(w, a, wallet);
    const events = [];
    for (let i = 0; i < 12; i++) events.push(a.press(card, pay(card)));
    for (const event of events) w.chat.emit(event);
    await a.next(/^Paid 100 sats/, 'the result');
    await a.next(/message below/, 'the card pointing to it');
    await pause(4500); // Two publishing rounds: anything else queued would be out by now.
    clean(wallet.run('status'), 1);
    assert.equal(wallet.run('status').usedSats, 101);
    assert.equal(a.messages(/^Paid /).length, 1, 'told once');
    assert.equal(a.answers(/^Paid /).length, 0, 'the card does not repeat the result');

    // Pressing again, and the invoice again, afterwards.
    a.press(card, pay(card));
    await a.next(/This was already paid/, 'the answer to a later press');
    a.say(`/send ${invoice}`);
    await a.next(/already paid or attempted/, 'the refusal');
    await pause(500);
    clean(wallet.run('status'), 1);
  },
);

test(
  'killed during a payment: never sent again, settled from the wallet, told once',
  LONG,
  async (t) => {
    const w = await world(t);
    const a = w.person();
    const b = w.person();
    const walletA = await w.wallet();
    const walletB = await w.wallet();
    await w.connectNwc(a, walletA);
    await w.connectNwc(b, walletB);

    walletA.run('mode', { pay: 'lost-unpaid' });
    const pending = await preview(w, a, walletA);
    a.press(pending.card, pay(pending.card));
    await until(() => walletA.run('status').payRequests === 1, 'the request', 15000);
    assert.equal(record(w, pending.paymentHash).state, 'sending', 'saved before it was sent');
    const waiting = await preview(w, b, walletB);

    await w.kill();
    await w.boot();
    assert.equal(record(w, pending.paymentHash).state, 'uncertain');
    assert.equal(record(w, waiting.paymentHash).state, 'cancelled');
    await a.next(/I do not know yet/, 'the notice after the restart');

    // Old buttons, after the crash.
    a.press(pending.card, pay(pending.card));
    await a.next(/still checking this payment/, 'the old Pay of a payment being checked');
    b.press(waiting.card, pay(waiting.card));
    await b.next(/already cancelled/, 'the old Pay of a preview');
    a.say(`/send ${pending.invoice}`);
    await a.next(/already paid or attempted/, 'the refusal');
    const another = walletA.run('invoice', { sats: 100 });
    a.say(`/send ${another.invoice}`);
    await a.next(/still being checked/, 'no new payment meanwhile');

    // Again, with a lookup due: nothing is sent by any number of restarts.
    await w.kill();
    await w.boot();
    await w.kill();
    await w.boot();
    clean(walletA.run('status'), 1);
    clean(walletB.run('status'), 0);

    walletA.run('settle', { hash: pending.paymentHash });
    await a.next(/^Paid 100 sats/, 'the result, from a lookup', 60000);
    assert.equal(record(w, pending.paymentHash).state, 'paid');
    await w.stop();
    await w.boot();
    await pause(1500);
    assert.equal(a.messages(/^Paid /).length, 1, 'not repeated by a restart');
    clean(walletA.run('status'), 1);
    assert.equal(walletA.run('status').usedSats, 101);
  },
);

test('disconnected during a payment; reconnecting brings no old button back', LONG, async (t) => {
  const w = await world(t);
  const a = w.person();
  const wallet = await w.wallet();
  await w.connectNwc(a, wallet, { label: 'Mock' });
  // Asked first: commands wait their turn behind a payment, but saying yes to this does not.
  a.say('/wallets');
  const list = await a.next(/Your wallet/, 'the list');
  a.press(list, button(list, /^Disconnect/));
  const asked = await a.next(/Disconnect Mock\?/, 'the question');
  wallet.run('mode', { pay: 'lost-unpaid' });
  const pending = await preview(w, a, wallet);
  a.press(pending.card, pay(pending.card));
  await until(() => wallet.run('status').payRequests === 1, 'the request', 15000);
  const before = walletRequests(wallet);
  a.press(list, buttons(asked).find((b) => /Yes/.test(b.text)).data, asked);
  await a.next(/I do not know yet|could not confirm/, 'what may have happened', 30000);
  await pause(7000);
  assert.ok(walletRequests(wallet) <= before + 1, 'the wallet is left alone');
  clean(wallet.run('status'), 1);
  const gone = record(w, pending.paymentHash);
  assert.notEqual(gone.state, 'failed', 'it may have gone through');
  assert.notEqual(gone.state, 'paid');

  wallet.run('mode', { pay: 'ok' });
  await w.connectNwc(a, wallet, { label: 'Mock' });
  a.press(pending.card, pay(pending.card));
  await a.next(/no longer|not connected|It will not be sent again|already/, 'the old Pay');
  a.say(`/send ${pending.invoice}`);
  await a.next(/already paid or attempted/, 'still blocked');
  await pause(1000);
  clean(wallet.run('status'), 1);

  // A preview dies with its connection too, and the new connection pays only what it previews.
  const waiting = await preview(w, a, wallet);
  a.say('/wallets');
  const second = await a.next(/Your wallet/, 'the list');
  a.press(second, button(second, /^Disconnect/));
  const again = await a.next(/Disconnect Mock\?/, 'the question');
  a.press(second, buttons(again).find((b) => /Yes/.test(b.text)).data, again);
  await a.next(/Disconnected Mock/, 'the disconnect');
  a.press(waiting.card, pay(waiting.card));
  await pause(1500);
  clean(wallet.run('status'), 1);
  assert.equal(record(w, waiting.paymentHash).state, 'cancelled');
});

const walletRequests = (wallet) => wallet.requests.length;

test("an operator's revocation stops the very next press, and nothing else", LONG, async (t) => {
  const w = await world(t, { lnbitsWallets: walletsFor(ALICE_KEY) });
  const a = w.person();
  await w.connectLnbits(a, ALICE_KEY, 'Keep me');
  const wallet = await w.wallet();
  await w.connectNwc(a, wallet, { label: 'Mock' });
  a.say('/wallets');
  const list = await a.next(/Your wallets/, 'the list');
  a.press(list, button(list, /^Use Mock/));
  await a.next(/Now using Mock/, 'in use');
  const { card } = await preview(w, a, wallet);

  const listed = w.admin('connections', 'list');
  assert.equal(listed.status, 0);
  const rows = listed.stdout.split('\n').filter((row) => /  nwc  /.test(row));
  assert.equal(rows.length, 1, 'only the mock wallet is revoked');
  assert.equal(w.admin('connections', 'revoke', rows[0].split(/\s+/)[0]).status, 0);
  a.press(card, pay(card));
  await pause(4000);
  clean(wallet.run('status'), 0);

  a.say('/balance');
  await a.next(/Balance \(Keep me\)/, 'the other wallet still works');
});

const walletsFor = (key, balance = 21000000) => ({
  [key]: { name: 'Synthetic', balance, payments: [] },
});

test('the wallet relay is down: nothing is lost, nothing is sent twice', LONG, async (t) => {
  const w = await world(t);
  const a = w.person();
  const folder = `${w.dir}/outage`;
  let wallet = await w.wallet({ dir: folder });
  await w.connectNwc(a, wallet);

  // Down before the press: the checks fail, so nothing goes out and it can be tried again.
  const first = await preview(w, a, wallet);
  w.walletRelay.online = false;
  w.walletRelay.disconnect();
  a.press(first.card, pay(first.card));
  await a.next(/Nothing was paid/, 'stopped before paying', 60000);
  assert.equal(record(w, first.paymentHash).sentAt, undefined);
  w.walletRelay.online = true;
  await wallet.close();
  wallet = await w.wallet({ dir: folder });
  clean(wallet.run('status'), 0);
  a.say(`/send ${first.invoice}`);
  const retry = await a.next(/^Pay /, 'a new preview of the same invoice');
  a.press(retry, pay(retry));
  await a.next(/^Paid 100 sats/, 'paid once it is back', 30000);
  clean(wallet.run('status'), 1);

  // The wallet goes away straight after the request: not Failed, and a late restart repeats nothing.
  wallet.run('mode', { pay: 'lost-unpaid' });
  const lost = await preview(w, a, wallet);
  a.press(lost.card, pay(lost.card));
  await until(() => wallet.run('status').payRequests === 2, 'the request', 15000);
  await wallet.close();
  w.walletRelay.online = false;
  w.walletRelay.disconnect();
  await a.next(/I do not know yet/, 'no answer', 80000);
  assert.equal(record(w, lost.paymentHash).state, 'uncertain');
  w.walletRelay.online = true;
  wallet = await w.wallet({ dir: folder });
  await pause(8000);
  assert.notEqual(record(w, lost.paymentHash).state, 'failed');
  const after = wallet.run('status');
  assert.equal(after.payRequests, 2);
  assert.deepEqual(after.duplicates, []);
  wallet.run('settle', { hash: lost.paymentHash });
  await a.next(/^Paid 100 sats/, 'found by a later lookup', 60000);
  assert.equal(wallet.run('status').payRequests, 2);
});

test(
  'a failed row is believed only once the invoice has expired, and blocks it for good',
  LONG,
  async (t) => {
    const w = await world(t);
    const a = w.person();
    const wallet = await w.wallet();
    await w.connectNwc(a, wallet);
    wallet.run('mode', { pay: 'lost-unpaid' });
    const made = Date.now();
    const { card, invoice, paymentHash } = await preview(w, a, wallet, 100, { expiry: 40 });
    a.press(card, pay(card));
    await until(() => wallet.run('status').payRequests === 1, 'the request', 15000);
    wallet.run('settle', { hash: paymentHash, state: 'failed' });
    // The answer is given up on at 60 s and looked up at 65 s. Expired, but only just.
    await a.next(/I do not know yet/, 'no answer', 80000);
    await pause(8000);
    assert.equal(record(w, paymentHash).state, 'uncertain', 'a late settlement is still possible');
    await pause(Math.max(0, made + 105000 - Date.now()));
    a.say('/payments');
    await a.next(/· Failed/, 'failed, from the wallet', 30000);
    assert.equal(record(w, paymentHash).state, 'failed');
    a.say(`/send ${invoice}`);
    await a.next(/already paid or attempted/, 'blocked for good');
    clean(wallet.run('status'), 1);
    assert.equal(wallet.run('status').balanceSats, 100000);
  },
);

test('the chat relay is down: the result arrives afterwards, once', LONG, async (t) => {
  const w = await world(t);
  const a = w.person();
  const wallet = await w.wallet();
  await w.connectNwc(a, wallet);
  wallet.run('mode', { pay: 'lost-paid' });
  const { card, paymentHash } = await preview(w, a, wallet);
  a.press(card, pay(card));
  await until(() => wallet.run('status').payRequests === 1, 'the request', 15000);
  w.chat.online = false;
  w.chat.disconnect();
  await until(() => record(w, paymentHash).state === 'paid', 'the lookup', 90000);
  assert.equal(a.messages(/^Paid /).length, 0, 'nothing could arrive yet');
  w.chat.online = true;
  await a.next(/^Paid 100 sats/, 'the result', 90000);
  // The "I do not know yet" note was queued during the outage, and failed deliveries are retried
  // with a growing delay (vendor/bot.js flush(): 2^attempts seconds, at most 300). After an outage
  // of about a minute that delay can pass a minute, so the note may arrive after the result.
  // Wait for it within that bound, then check that each arrived exactly once.
  await until(() => a.messages(/I do not know yet/).length > 0, 'the queued note', 140000);
  await pause(2000);
  assert.equal(a.messages(/^Paid /).length, 1);
  assert.equal(a.messages(/I do not know yet/).length, 1);
  clean(wallet.run('status'), 1);
});

test('limits and accounting: per payment, daily, hourly and the wallet', LONG, async (t) => {
  const w = await world(t, {
    env: { SEND_MAX_SATS: '1000', SEND_DAILY_SATS: '2500', SEND_PER_HOUR: '3' },
  });
  const a = w.person();
  const wallet = await w.wallet();
  await w.connectNwc(a, wallet);

  a.say(`/send ${wallet.run('invoice', { sats: 1001 }).invoice}`);
  await a.next(/above this bot's limit/, 'over one payment');
  for (let i = 0; i < 2; i++) {
    const { card } = await preview(w, a, wallet, 1000);
    a.press(card, pay(card));
    await a.next(/^Paid 1,000 sats/, 'paid');
  }
  // 2,002 sats so far, with fees: 600 would pass 2,500, and 400 would not.
  a.say(`/send ${wallet.run('invoice', { sats: 600 }).invoice}`);
  await a.next(/go over this bot's limit/, 'over the day');
  const { card } = await preview(w, a, wallet, 400);
  a.press(card, pay(card));
  await a.next(/^Paid 400 sats/, 'paid');
  a.say(`/send ${wallet.run('invoice', { sats: 10 }).invoice}`);
  await a.next(/limit of payments per hour/, 'three in an hour');
  clean(wallet.run('status'), 3);
  assert.equal(wallet.run('status').usedSats, 2403);

  // Another person is not touched by any of it, and their wallet's own limit and funds apply.
  const b = w.person();
  const small = await w.wallet({ budget: 500 });
  await w.connectNwc(b, small, { label: 'Small limit' });
  const refused = await preview(w, b, small, 1000);
  b.press(refused.card, pay(refused.card));
  await b.next(/more than is left of the spending limit/, 'over the wallet limit');
  clean(small.run('status'), 0);
  const poor = await w.wallet({ balance: 100 });
  await w.connectNwc(b, poor, { label: 'Poor' });
  b.say('/wallets');
  const list = await b.next(/Your wallets/, 'the list');
  b.press(list, button(list, /^Use Poor/));
  await b.next(/Now using Poor/, 'in use');
  const failing = await preview(w, b, poor, 200);
  b.press(failing.card, pay(failing.card));
  await b.next(/failed: .*Nothing was paid/, 'no funds');
  b.say(`/send ${failing.invoice}`);
  await b.next(/^Pay /, 'a certain refusal can be tried again');
  assert.equal(poor.run('status').balanceSats, 100);
});

test('three accounts: nobody reaches anyone else, or is told about them', LONG, async (t) => {
  const w = await world(t);
  const [a, b, c] = [w.person(), w.person(), w.person()];
  const walletA = await w.wallet();
  const walletB = await w.wallet();
  await w.connectNwc(a, walletA, { label: 'Wallet of A' });
  await w.connectNwc(b, walletB, { label: 'Wallet of B' });

  const paid = await preview(w, a, walletA);
  a.press(paid.card, pay(paid.card));
  await a.next(/^Paid /, 'paid');
  const waiting = await preview(w, a, walletA);

  // Pressing someone else's card, with its real data, from each kind of stranger.
  b.press(waiting.card, pay(waiting.card));
  c.press(waiting.card, pay(waiting.card));
  await pause(3000);
  assert.equal(record(w, waiting.paymentHash).state, 'prepared');
  clean(walletA.run('status'), 1);
  clean(walletB.run('status'), 0);

  b.say('/payments');
  const history = await b.next(/./, 'an answer');
  assert.doesNotMatch(history.content, /Wallet of A|Confirmed/);
  const shown = c.replies().length;
  c.say('/balance');
  c.say('/payments');
  c.say(`/send ${walletA.run('invoice', { sats: 100 }).invoice}`);
  await pause(2500);
  assert.ok(c.replies().every((m) => !/Wallet of|Pay |Balance/.test(m.content)));
  assert.ok(c.replies().length <= shown + 1, 'at most the one welcome');

  // One wallet connection, one account.
  const browser = await w.page(c);
  const taken = await w.submit(browser, {
    connection: walletA.uri,
    spend: true,
    acknowledged: true,
  });
  assert.equal(taken.status, 400);
  assert.match(taken.data.message, /already connected/);

  // What it pays is still A's to decide.
  a.press(waiting.card, pay(waiting.card));
  await a.next(/^Paid /, 'paid by its owner');
  clean(walletA.run('status'), 2);
  clean(walletB.run('status'), 0);
});

test(
  'receiving: an invoice is created, paid once, survives restarts and outages',
  LONG,
  async (t) => {
    const w = await world(t, {
      lnbitsWallets: { ...walletsFor(ALICE_KEY), ...walletsFor(BOB_KEY) },
    });
    const a = w.person();
    const b = w.person();
    await w.connectLnbits(a, ALICE_KEY, 'Savings');
    await w.connectLnbits(b, BOB_KEY, 'Other');

    a.say('/invoice 250 test');
    await a.next(/lnbc/, 'the invoice');
    a.say('/invoices');
    await a.next(/Pending/, 'pending');
    const invoice = w.lnbits.created.at(-1);

    // Paid while the bot is dead: told once, after it is back.
    await w.kill();
    w.lnbits.settlePending(ALICE_KEY, invoice);
    await w.boot();
    await a.next(/Received.*250 sats/, 'the notification', 60000);
    a.say('/invoices');
    await a.next(/Paid/, 'paid');
    await w.stop();
    await w.boot();
    await pause(3000);
    assert.equal(a.messages(/Received/).length, 1, 'not announced again');
    assert.equal(b.messages(/Received/).length, 0, 'not told to anyone else');

    // LNbits stops answering: never a guess, and back to the truth afterwards.
    a.say('/invoice 300');
    await a.next(/lnbc/, 'another invoice');
    w.lnbits.next = (_request, _req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
      return 'handled';
    };
    a.say('/invoices');
    const blind = await a.next(/Unknown/, 'unknown');
    assert.doesNotMatch(blind.content, /Failed|Expired/);
    w.lnbits.next = undefined;
    a.say('/invoices');
    const seen = await a.next(/Pending/, 'pending again');
    assert.match(seen.content, /Paid/);

    // Expired, from what the wallet says.
    w.lnbits.created.at(-1).status = 'failed';
    w.lnbits.created.at(-1).labels = ['expired'];
    a.say('/invoices');
    await a.next(/Expired/, 'expired');

    // Nobody else sees any of it.
    b.say('/invoices');
    const theirs = await b.next(/./, 'an answer');
    assert.doesNotMatch(theirs.content, /Paid|Pending|Expired/);
  },
);

test(
  'a connection naming any relay not listed is refused, and nothing is stored',
  LONG,
  async (t) => {
    const w = await world(t);
    const a = w.person();
    const wallet = await w.wallet();
    const browser = await w.page(a);
    const named = (relay) =>
      wallet.uri.replace(/relay=[^&]+/, `relay=${encodeURIComponent(relay)}`);
    const attempt = (relay) =>
      w.submit(browser, { connection: named(relay), spend: true, acknowledged: true });

    const external = await attempt('wss://relay.invalid');
    assert.equal(external.status, 400);
    assert.match(external.data.message, /did not answer through the relay/);
    assert.doesNotMatch(external.data.message, /LNbits/);
    await until(
      () => /\[no-network\] blocked connection to relay\.invalid/.test(w.output()),
      'the block',
    );

    // Asking to spend, a connection with too much power is not told to make one that only receives.
    const wide = await w.wallet({ kind: 'extra-power' });
    const tooMuch = await w.submit(browser, {
      connection: wide.uri,
      spend: true,
      acknowledged: true,
    });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.data.message, /can do more than this bot allows/);
    assert.doesNotMatch(tooMuch.data.message, /only read/);

    for (const relay of ['ws://localhost:7791', 'ws://127.0.0.1:1', w.chat.url]) {
      const refused = await attempt(relay);
      assert.equal(refused.status, 400, relay);
      assert.match(refused.data.message, /relay that cannot be used/, relay);
    }
    assert.match(w.admin('connections', 'list').stdout, /No connections/);
    assert.ok(!w.output().includes(wallet.secret ?? 'no secret'));
    assert.doesNotMatch(w.output(), /secret=|nostr\+walletconnect/);
  },
);
