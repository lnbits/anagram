// /invoices end to end in database mode, against a local mock LNbits shaped like v1.6.2: what was
// made here, what the wallet says about it now, and who may see any of it.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getEventHash, getPublicKey } from 'nostr-tools';
import { MAX_INVOICE_PAGES, statusRef } from '../buttons.js';
import { belongsTo, Invoices, mayBelongTo } from '../invoices.js';
import { Keyring } from '../keyring.js';
import { Ledger, ledgerFile } from '../ledger.js';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { walletRef } from '../wallets.js';
import {
  BOT_CONTROL_KIND,
  keyboardFromTags,
  parseKeyboard,
} from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const ORIGIN = 'https://lnbits.test/';
const SECOND_KEY = 'c0ffee00000000000000000000000004';
const A = getPublicKey(alice);

async function fixture(t, { limits = {}, dir } = {}) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    [SECOND_KEY]: { name: 'c', balance: 7_000, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 42_000, payments: [] },
  });
  defer(t, () => server.close());
  const root = tempDir(t, 'invoice-history');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const registry = new Registry({ store: db, keyring, ledger });
  const link = (key, invoiceKey, label) =>
    registry.connect({ owner: getPublicKey(key), label, origin: ORIGIN, secret: { invoiceKey } });
  const main = link(alice, ALICE_KEY, 'Main');
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 1000 });
  const ctx = setup(t, {
    wallets: registry,
    lnbits,
    dir: dir ?? join(root, 'data'),
    limits: { invoicesPerHour: 100, requestsPerHour: 1000, ...limits },
  });
  defer(t, () => db.close());
  return { server, registry, main, link, db, lnbits, root, ...ctx };
}
function press(bot, key, card, data, { view, id = randomBytes(16).toString('hex') } = {}) {
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
  return settle(bot);
}
const messages = (bot, key = alice) => repliesFor(bot, key);
const lastCard = (bot, key = alice) =>
  messages(bot, key)
    .filter((m) => keyboardFromTags(m.tags))
    .at(-1);
const answers = (bot, key = alice) => messages(bot, key).filter((m) => m.kind === BOT_CONTROL_KIND);
const buttons = (message) => keyboardFromTags(message.tags).inline_keyboard.flat();
const data = (message) => buttons(message).flatMap((b) => b.callback_data ?? []);
const copyText = (message) => buttons(message).find((b) => b.copy_text)?.copy_text.text;
const list = async (bot, key = alice) => {
  await sendDM(bot, key, '/invoices');
  return lastCard(bot, key);
};
const invoice = (bot, text, key = alice) => sendDM(bot, key, `/invoice ${text}`);
const lookups = (server) =>
  server.requests.filter((r) => r.query.external_id || /payments\/[a-f0-9]{64}$/.test(r.path));

test('an empty list says how to start', async (t) => {
  const { bot } = await fixture(t);
  const card = await list(bot);
  assert.match(card.content, /^No invoices made here yet in Main\. Send \/invoice/);
  assert.ok(parseKeyboard(keyboardFromTags(card.tags)));
});

test('the list shows amount, status, date and memo, newest first, naming the wallet', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000 coffee');
  await invoice(bot, '2000 tea');
  server.created[0].status = 'success';
  const card = await list(bot);
  const lines = card.content.split('\n');
  assert.equal(lines[0], 'Invoices (Main) 1–2 of 2, newest first:');
  assert.match(lines[1], /^1\. 2,000 sats · Pending · \d{4}-\d\d-\d\d \d\d:\d\d UTC · tea$/);
  assert.match(lines[2], /^2\. 1,000 sats · Paid · \d{4}-\d\d-\d\d \d\d:\d\d UTC · coffee$/);
  assert.equal(server.posts.length, 2, 'looking creates nothing');
});

test('pages hold five, cost at most five lookups, and page through everything', async (t) => {
  const { bot, server } = await fixture(t);
  for (let i = 1; i <= 7; i++) await invoice(bot, `${i * 100}`);
  const first = await list(bot);
  assert.match(first.content, /1–5 of 7/);
  assert.match(first.content, /1\. 700 sats/);
  assert.ok(data(first).includes('iv:1'), 'Older');
  assert.ok(!data(first).includes('iv:-1'));
  assert.ok(parseKeyboard(keyboardFromTags(first.tags)), 'a valid keyboard');
  assert.equal(lookups(server).length, 5);
  await press(bot, alice, first, 'iv:1');
  const second = answers(bot).at(-1);
  assert.match(second.content, /6–7 of 7/);
  assert.match(second.content, /2\. 100 sats/);
  assert.ok(!data(second).includes('iv:2'), 'nothing older');
  assert.ok(data(second).includes('iv:0'), 'Newer');
  const count = answers(bot).length;
  await press(bot, alice, first, 'iv:2', { view: second.id });
  assert.equal(answers(bot).length, count, 'a page no button offers gets no answer');
});

test('details show what the wallet says, with the invoice only while it can be paid', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000 coffee');
  const [record] = bot.state.invoices;
  const card = await list(bot);
  const detail = `iv:0:${statusRef(record)}`;
  assert.ok(data(card).includes(detail));
  await press(bot, alice, card, detail);
  const open = answers(bot).at(-1);
  assert.match(open.content, /coffee\): not paid yet/);
  assert.match(open.content, /Status: Pending\nWallet: Main\nCreated: /);
  assert.ok(open.content.includes(server.created[0].bolt11));
  assert.equal(copyText(open), server.created[0].bolt11);
  assert.ok(data(open).includes('iv:0'), 'back to the list');

  server.created[0].status = 'success';
  await press(bot, alice, card, detail, { view: open.id });
  const paid = answers(bot).at(-1);
  assert.match(paid.content, /paid\.\nStatus: Paid/);
  assert.ok(!paid.content.includes(server.created[0].bolt11));
  assert.equal(copyText(paid), undefined);
  assert.equal(record.payment, 'paid');
});

test('Paid and Expired come from the wallet: a socket frame or a clock alone cannot pay', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  const row = server.created[0];
  // A frame only ever starts a look at the history. It changes nothing here.
  server.push(ALICE_KEY, JSON.stringify({ payment: { ...row, status: 'success' } }));
  server.push(row.payment_hash, JSON.stringify({ pending: false }));
  assert.match((await list(bot)).content, /1\. 1,000 sats · Pending/);
  assert.equal(record.payment, 'pending');

  // Past its expiry, LNbits is asked first: it may know of a payment its table does not show.
  record.expiresAt -= 7200;
  server.funding = () => 'success';
  assert.match((await list(bot)).content, /1\. 1,000 sats · Paid/);
  assert.ok(server.requests.some((r) => r.path.endsWith(row.payment_hash)));
});

test('an expired invoice is Expired, whichever way LNbits shows it', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  const row = server.created[0];
  record.expiresAt -= 7200;
  row.expiry = new Date(Date.now() - 1000).toISOString();
  assert.match((await list(bot)).content, /· Expired/);
  assert.equal(row.status, 'failed', 'LNbits marked it when asked');
  assert.deepEqual(row.labels, ['expired']);
  assert.equal(record.payment, 'expired');
  // Now it reads as failed with a label, even with an expiry the bot would not have noticed.
  record.expiresAt += 72000;
  assert.match((await list(bot)).content, /· Expired/);
});

test('LNbits saying failed, without having expired, is Failed', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  server.created[0].status = 'failed';
  assert.match((await list(bot)).content, /· Failed/);
});

test('failures to answer are Unknown, never Failed or Paid, and what was seen stays', async (t) => {
  const { bot, server, logs } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  server.created[0].status = 'success';
  await list(bot);
  assert.equal(record.payment, 'paid');
  for (const failure of [500, 404, 'garbage']) {
    server.next = (request, _req, res) => {
      if (!request.query.external_id) return undefined;
      res.writeHead(failure === 'garbage' ? 200 : failure, { 'content-type': 'application/json' });
      res.end(failure === 'garbage' ? '{"data": 7}' : '{}');
      return 'handled';
    };
    const card = await list(bot);
    assert.match(card.content, /· Unknown \(last seen: Paid\)/, String(failure));
    assert.ok(!/· Paid|· Failed/.test(card.content));
    assert.match(card.content, /could not confirm it/);
  }
  assert.equal(record.payment, 'paid');
  assert.ok(!logs.join('\n').includes(ALICE_KEY));
  server.next = undefined;
  assert.match((await list(bot)).content, /1\. 1,000 sats · Paid/);
});

test('with no answer about an invoice never seen, the status is plainly Unknown', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  bot.state.invoices[0].payment = undefined;
  server.wallets[ALICE_KEY].payments.length = 0; // gone from LNbits
  const card = await list(bot);
  assert.match(card.content, /· Unknown ·/);
  assert.ok(!/Expired|Failed|Paid/.test(card.content.split('\n')[1]));
  await press(
    bot,
    alice,
    card,
    data(card).find((d) => d.startsWith('iv:0:')),
  );
  assert.match(answers(bot).at(-1).content, /could not confirm its status/);
  // A row that went missing after its expiry is no different: LNbits does not delete them.
  bot.state.invoices[0].expiresAt -= 7200;
  assert.match((await list(bot)).content, /· Unknown ·/);
});

test('a wallet that seems to undo a payment is not believed', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  server.created[0].status = 'success';
  await list(bot);
  server.created[0].status = 'pending';
  assert.match((await list(bot)).content, /Unknown \(last seen: Paid\)/);
  assert.equal(bot.state.invoices[0].payment, 'paid');
});

test('an answer with another amount does not settle this invoice', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  server.created[0].amount = 999000;
  server.created[0].status = 'success';
  assert.match((await list(bot)).content, /· Unknown ·/);
  assert.equal(bot.state.invoices[0].payment, undefined);
});

test('requests still being settled say so, and nothing is looked up for them', async (t) => {
  const { bot, server } = await fixture(t);
  server.create = 'hang';
  bot.checkDelays = [60];
  await invoice(bot, '1000');
  let card = await list(bot);
  assert.match(card.content, /· Unknown, still checking/);
  const [record] = bot.state.invoices;
  Object.assign(record, { state: 'review', error: 'mismatch' });
  card = await list(bot);
  assert.match(card.content, /· Needs review/);
  Object.assign(record, { state: 'failed', error: 'not_found' });
  card = await list(bot);
  assert.match(card.content, /· Failed/);
  assert.equal(lookups(server).length, 0);
  await press(
    bot,
    alice,
    card,
    data(card).find((d) => d.startsWith('iv:0:')),
  );
  assert.match(answers(bot).at(-1).content, /nothing can be paid/);
});

test('statuses, and only those, survive a restart; no memo or invoice reaches the disk', async (t) => {
  const { bot, server, dir, registry } = await fixture(t);
  await invoice(bot, '1000 private memo text');
  server.created[0].status = 'success';
  await list(bot);
  const bolt11 = server.created[0].bolt11;
  await bot.close();
  const state = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.ok(!state.includes('private memo text'));
  assert.ok(!state.includes(bolt11));
  assert.ok(!state.includes(ALICE_KEY));
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 1000 });
  const next = setup(t, { wallets: registry, lnbits, dir, limits: { requestsPerHour: 1000 } });
  await next.bot.start();
  const card = await list(next.bot);
  assert.match(card.content, /Paid .* private memo text/);
  assert.equal(next.bot.state.invoices[0].payment, 'paid');
  await next.bot.close();
});

test('nobody else can see or reach an invoice', async (t) => {
  const { bot, server, link } = await fixture(t);
  link(bob, BOB_KEY, 'Bob wallet');
  await invoice(bot, '1000 alice only');
  const [record] = bot.state.invoices;
  const theirs = await list(bot);
  assert.match((await list(bot, bob)).content, /No invoices made here yet in Bob wallet/);
  const before = lookups(server).length;
  // Alice's card, pressed by Bob; and Alice's invoice, named from Bob's own card.
  await press(bot, bob, theirs, `iv:0:${statusRef(record)}`);
  await press(bot, bob, theirs, 'iv:0');
  const own = await list(bot, bob);
  await press(bot, bob, own, `iv:0:${statusRef(record)}`);
  assert.ok(!messages(bot, bob).some((m) => /alice only|1,000 sats/.test(m.content)));
  assert.equal(lookups(server).length, before, 'no lookup was made for any of it');
});

test('several wallets: a list is of one wallet, and an older menu keeps its own', async (t) => {
  const { bot, server, link, registry } = await fixture(t);
  const second = link(alice, SECOND_KEY, 'Second');
  await invoice(bot, '1000 in main');
  const inMain = await list(bot);
  registry.select(A, second.id);
  assert.match((await list(bot)).content, /No invoices made here yet in Second/);
  await invoice(bot, '2000 in second');
  const inSecond = await list(bot);
  assert.match(inSecond.content, /Invoices \(Second\).*\n1\. 2,000 sats .*in second/);
  assert.ok(!inSecond.content.includes('1,000 sats'));
  await press(bot, alice, inMain, 'iv:0');
  const answer = answers(bot).at(-1);
  assert.match(answer.content, /Invoices \(Main\).*\n1\. 1,000 sats .*in main/);
  assert.ok(!answer.content.includes('2,000 sats'));
  // Each wallet's own key, for each wallet's own invoices.
  for (const lookup of lookups(server)) {
    const owner = lookup.key === ALICE_KEY ? 'Main' : 'Second';
    const record = bot.state.invoices.find((r) => `alw-${r.op}` === lookup.query.external_id);
    if (record) assert.equal(record.sats, owner === 'Main' ? 1000 : 2000);
  }
});

test('a disconnect ends all of it, also for the same wallet connected again', async (t) => {
  const { bot, server, main, registry, link } = await fixture(t);
  link(alice, SECOND_KEY, 'Second');
  await invoice(bot, '1000 gone');
  const card = await list(bot);
  await press(
    bot,
    alice,
    card,
    data(card).find((d) => d.startsWith('iv:0:')),
  );
  const detail = answers(bot).at(-1);
  registry.revoke(main.id, 'user');
  const before = lookups(server).length;
  // Queued answers about it went with it.
  assert.ok(!messages(bot).some((m) => /1,000 sats/.test(m.content)));
  await press(bot, alice, card, 'iv:0');
  assert.match(answers(bot).at(-1).content, /no longer linked to you/);
  await press(
    bot,
    alice,
    card,
    data(detail).find((d) => d.startsWith('iv:0:')),
    { view: detail.id },
  );
  assert.match(answers(bot).at(-1).content, /no longer linked to you/);
  assert.match((await list(bot)).content, /No invoices made here yet in Second/);
  assert.equal(lookups(server).length, before, 'its key is not used');

  const again = link(alice, ALICE_KEY, 'Main again');
  registry.select(A, again.id);
  assert.match((await list(bot)).content, /No invoices made here yet in Main again/);
  await press(bot, alice, card, 'iv:0');
  assert.match(answers(bot).at(-1).content, /no longer linked to you/);
});

test('disconnected while the wallet is being asked: nothing is said or recorded', async (t) => {
  const { bot, server, main, registry } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  server.next = (request) => {
    if (request.query.external_id) registry.revoke(main.id, 'user');
  };
  await sendDM(bot, alice, '/invoices');
  assert.ok(!messages(bot).some((m) => /^Invoices/.test(m.content)));
  assert.equal(record.payment, undefined);
});

test('a retried press gets the same answer without asking the wallet again', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  const card = await list(bot);
  const id = randomBytes(16).toString('hex');
  // The same request again is the app retrying. Its rumor is the same, so the fingerprint matches.
  const request = {
    op: 'request',
    id,
    target: { type: 'dm', chat: bot.pubkey, root: card.id, version: card.id, bot: bot.pubkey },
    data: 'iv:0',
    expires: Math.floor(Date.now() / 1000) + 300,
  };
  const message = {
    kind: BOT_CONTROL_KIND,
    pubkey: A,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', bot.pubkey],
      ['anagram-bot', '1', JSON.stringify(request)],
    ],
    content: '',
  };
  message.id = getEventHash(message);
  bot.buttonRequest(message);
  await settle(bot);
  const after = lookups(server).length;
  bot.state.outbox.length = 0;
  bot.buttonRequest(message);
  await settle(bot);
  assert.equal(lookups(server).length, after);
  assert.equal(answers(bot).length, 1);
});

test('presses and /invoices count against the hourly limit', async (t) => {
  const { bot, server } = await fixture(t, { limits: { requestsPerHour: 2 } });
  await invoice(bot, '1000');
  const card = await list(bot);
  const before = lookups(server).length;
  await press(bot, alice, card, 'iv:0');
  assert.match(answers(bot).at(-1).content, /hourly limit/);
  assert.equal(lookups(server).length, before);
});

test('a page beyond what is kept is not offered, and asks nothing', async (t) => {
  const { bot, server } = await fixture(t);
  const card = await list(bot);
  const before = lookups(server).length;
  await press(bot, alice, card, `iv:${MAX_INVOICE_PAGES}`);
  assert.equal(answers(bot).length, 0);
  assert.equal(lookups(server).length, before);
});

test('a record belongs to one exact link; older ones can only be claimed by asking', () => {
  const owner = 'a'.repeat(64);
  const key = 'c'.repeat(32);
  const migrated = { id: 'd'.repeat(32), owner, key, ref: walletRef(owner, key) };
  const reconnected = { id: 'e'.repeat(32), owner, key, ref: 'f'.repeat(32) };
  const nwc = { id: 'e'.repeat(32), owner, key: { walletPubkey: 'x' }, ref: 'f'.repeat(32) };
  const made = (fields) => ({ requester: owner, ...fields });
  assert.equal(belongsTo(made({ ref: migrated.ref }), migrated), true);
  assert.equal(belongsTo(made({ ref: migrated.ref }), reconnected), false);
  // A wallet replaced in wallets.json keeps the person's id as its own, but not its ref.
  const replaced = { ...migrated, ref: 'f'.repeat(32) };
  assert.equal(belongsTo(made({ ref: migrated.ref, connection: migrated.id }), replaced), false);
  assert.equal(belongsTo(made({}), migrated), false, 'an older record belongs to nobody yet');
  assert.equal(belongsTo({ requester: 'b'.repeat(64), ref: migrated.ref }, migrated), false);
  assert.equal(mayBelongTo(made({ connection: migrated.id }), migrated), true);
  assert.equal(mayBelongTo(made({ connection: migrated.id }), reconnected), false);
  assert.equal(mayBelongTo(made({}), migrated), true);
  assert.equal(mayBelongTo(made({}), reconnected), false);
  assert.equal(mayBelongTo(made({}), nwc), false);
  assert.equal(mayBelongTo(made({ noWallet: true }), migrated), false, 'already asked: not there');
  assert.equal(mayBelongTo(made({ ref: migrated.ref }), migrated), false);
  assert.equal(mayBelongTo({ requester: 'b'.repeat(64) }, migrated), false);
});

test('older records appear once their wallet confirms it holds them, and only then', async (t) => {
  const { bot, server, registry } = await fixture(t);
  const main = registry.lease(A);
  await invoice(bot, '1000 mine');
  await invoice(bot, '2000 elsewhere');
  await invoice(bot, '3000 unknown yet');
  const [mine, elsewhere, later] = bot.state.invoices;
  // As an earlier release wrote them, naming this connection and no ref.
  for (const record of [mine, elsewhere, later]) delete record.ref;
  assert.equal(mine.connection, main.id);
  server.wallets[ALICE_KEY].payments = server.wallets[ALICE_KEY].payments.filter(
    (row) => row.external_id !== `alw-${elsewhere.op}`,
  );
  // LNbits cannot answer: nothing is claimed or ruled out, and nothing is shown yet.
  server.next = (request, _req, res) => {
    if (!request.query.external_id) return undefined;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
    return 'handled';
  };
  assert.match((await list(bot)).content, /No invoices made here yet/);
  assert.equal(mine.ref, undefined);
  assert.equal(elsewhere.noWallet, undefined);
  server.next = undefined;

  const card = await list(bot);
  assert.match(card.content, /1–2 of 2/);
  assert.ok(!card.content.includes('2,000 sats'), 'not in this wallet: not shown');
  assert.equal(mine.ref, main.ref);
  assert.equal(elsewhere.noWallet, true);
  // Each is asked about once.
  const asked = lookups(server).filter((r) => r.query.external_id === `alw-${elsewhere.op}`).length;
  await list(bot);
  assert.equal(
    lookups(server).filter((r) => r.query.external_id === `alw-${elsewhere.op}`).length,
    asked,
  );
  assert.equal(later.state, 'created');
});

test('records stay bounded: 90 days, 200 per person, open ones always', () => {
  const time = 2_000_000_000;
  const invoices = new Invoices({}, () => time);
  const add = (requester, state, age = 0) => {
    const record = invoices.add({
      requester,
      messageId: randomBytes(32).toString('hex'),
      sats: 1,
    });
    Object.assign(record, { state, updatedAt: time - age });
    return record;
  };
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const open = add(a, 'review', 365 * 86400);
  const old = add(b, 'created', 91 * 86400);
  const recent = add(b, 'created', 89 * 86400);
  const first = add(a, 'created');
  for (let i = 0; i < 205; i++) add(a, 'created');
  invoices.prune();
  assert.ok(invoices.all.includes(open));
  assert.ok(!invoices.all.includes(old));
  assert.ok(invoices.all.includes(recent));
  assert.ok(!invoices.all.includes(first), 'the oldest of too many');
  const finished = invoices.all.filter((r) => r.requester === a && r.state === 'created');
  assert.equal(finished.length, 200);
});

test('old state with no payment or wallet fields still loads, and new fields are checked', () => {
  const old = {
    op: '00000000-0000-4000-8000-000000000000',
    requester: 'a'.repeat(64),
    messageId: 'b'.repeat(64),
    sats: 1000,
    state: 'created',
    createdAt: 1000,
    updatedAt: 1000,
    checks: 0,
  };
  assert.equal(new Invoices({ invoices: [old] }).all.length, 1);
  for (const bad of [{ payment: 'stolen' }, { ref: 'nope' }, { expiresAt: 'soon' }])
    assert.throws(() => new Invoices({ invoices: [{ ...old, ...bad }] }), /Invalid invoice/);
});

test('payment states move forward only', () => {
  const invoices = new Invoices({});
  const record = {};
  assert.equal(invoices.setPayment(record, 'pending'), true);
  assert.equal(invoices.setPayment(record, 'pending'), false);
  assert.equal(invoices.setPayment(record, 'expired'), true);
  assert.equal(invoices.setPayment(record, 'pending'), false);
  assert.equal(record.payment, 'expired');
  assert.equal(invoices.setPayment(record, 'paid'), true);
  for (const later of ['pending', 'expired', 'failed']) {
    assert.equal(invoices.setPayment(record, later), false);
    assert.equal(record.payment, 'paid');
  }
});

test('confirmInvoice believes only what comes with "details"', async (t) => {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 0, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 0, payments: [] },
  });
  defer(t, () => server.close());
  const client = new LNbitsClient({ url: server.url, timeoutMs: 1000 });
  const { paymentHash } = await client.createInvoice(ALICE_KEY, {
    sats: 5,
    memo: '',
    expiry: 60,
    externalId: `alw-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
  });
  assert.equal((await client.confirmInvoice(ALICE_KEY, paymentHash)).status, 'pending');
  // Another wallet's key gets no details.
  await assert.rejects(
    client.confirmInvoice(BOB_KEY, paymentHash),
    (error) => error instanceof LNbitsError && error.code === 'bad_response',
  );
  await assert.rejects(
    client.confirmInvoice(ALICE_KEY, 'f'.repeat(64)),
    (error) => error instanceof LNbitsError && error.code === 'rejected',
  );
  await assert.rejects(client.confirmInvoice(ALICE_KEY, '../wallet'), RangeError);
  assert.ok(!server.requests.some((r) => r.path.includes('..')));
});

test("a memo LNbits filled in by itself is not shown as the person's", async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  assert.equal(server.created[0].memo, 'LNbits', 'as v1.6.2 does');
  const card = await list(bot);
  assert.match(card.content.split('\n')[1], /UTC$/);
  await press(
    bot,
    alice,
    card,
    data(card).find((d) => d.startsWith('iv:0:')),
  );
  assert.match(answers(bot).at(-1).content, /^Invoice for 1,000 sats: not paid yet/);
});

test('a queued reply goes with a wallet revoked while wallets were suspended', async (t) => {
  const { bot, net, main, registry, root } = await fixture(t);
  const ledgerPath = ledgerFile(join(root, 'secrets'));
  await sendDM(bot, alice, '/invoices');
  assert.equal(bot.state.outbox.filter((item) => item.connection === main.id).length, 1);
  chmodSync(ledgerPath, 0o644);
  registry.check();
  assert.equal(registry.broken, true);
  chmodSync(ledgerPath, 0o600);
  // The operator's CLI, from outside: the ledger first, then the database.
  const other = Ledger.open(join(root, 'secrets'), registry.keyring);
  other.append({ connection: main.id, ref: main.ref, actor: 'operator' });
  registry.check();
  assert.equal(registry.broken, false);
  assert.equal(bot.state.outbox.filter((item) => item.connection === main.id).length, 0);
  await bot.flush();
  assert.equal(net.sent.length, 0, 'nothing about it was published');
});

test('the steps of leaving a wallet have a small limit of their own', async (t) => {
  const { bot, main, registry, db } = await fixture(t, { limits: { requestsPerHour: 1000 } });
  await sendDM(bot, alice, '/wallets');
  const card = lastCard(bot);
  let saves = 0;
  const save = bot.save.bind(bot);
  bot.save = () => {
    saves++;
    save();
  };
  for (let i = 0; i < 60; i++) await press(bot, alice, card, `w:del:${main.id}`);
  assert.equal(answers(bot).length, 20, 'twenty answers, then none');
  const quiet = saves;
  await press(bot, alice, card, `w:del:${main.id}`);
  assert.equal(saves, quiet, 'and no disk write');
  // Over that limit a disconnect still happens: it is the one thing that must.
  const confirm = { view: answers(bot).at(-1).id };
  await press(bot, alice, card, `w:delok:${main.id}`, confirm);
  assert.equal(registry.linked(A), false);
  assert.equal(db.connection(main.id).status, 'revoked');
  assert.equal(answers(bot).length, 0, 'what was queued about it went with it');
});

test('a wallet that contradicts what it said earlier is Unknown, not believed', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  const row = server.created[0];
  row.status = 'failed';
  row.labels = ['expired'];
  assert.match((await list(bot)).content, /· Expired/);
  row.status = 'pending';
  row.labels = [];
  row.expiry = new Date(Date.now() + 3600000).toISOString();
  record.expiresAt = Math.floor(Date.now() / 1000) + 3600;
  assert.match((await list(bot)).content, /· Unknown \(last seen: Expired\)/);
  assert.equal(record.payment, 'expired');
});

test('failed before its expiry stays Failed after it', async (t) => {
  const { bot, server } = await fixture(t);
  await invoice(bot, '1000');
  const [record] = bot.state.invoices;
  server.created[0].status = 'failed';
  assert.match((await list(bot)).content, /· Failed/);
  record.expiresAt -= 7200;
  assert.match((await list(bot)).content, /· Failed/);
});

test('retries of an answered press count against the hourly limit', async (t) => {
  const { bot } = await fixture(t, { limits: { requestsPerHour: 4 } });
  const card = await list(bot);
  const request = {
    op: 'request',
    id: randomBytes(16).toString('hex'),
    target: { type: 'dm', chat: bot.pubkey, root: card.id, version: card.id, bot: bot.pubkey },
    data: 'iv:0',
    expires: Math.floor(Date.now() / 1000) + 300,
  };
  const message = {
    kind: BOT_CONTROL_KIND,
    pubkey: A,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', bot.pubkey],
      ['anagram-bot', '1', JSON.stringify(request)],
    ],
    content: '',
  };
  message.id = getEventHash(message);
  bot.buttonRequest(message);
  await settle(bot);
  let saves = 0;
  const save = bot.save.bind(bot);
  bot.save = () => {
    saves++;
    save();
  };
  for (let i = 0; i < 50; i++) {
    bot.state.outbox.length = 0;
    bot.buttonRequest(message);
  }
  await settle(bot);
  assert.ok(saves <= 4, `${saves} writes for 50 retries`);
});

test("a question about a wallet goes with it, also from another wallet's menu", async (t) => {
  const { bot, net, link, registry } = await fixture(t);
  const second = link(alice, SECOND_KEY, 'Second');
  await sendDM(bot, alice, '/menu');
  const menu = lastCard(bot);
  await press(bot, alice, menu, 'w:list');
  const wallets = answers(bot).at(-1);
  await press(bot, alice, menu, `w:del:${second.id}`, { view: wallets.id });
  assert.match(answers(bot).at(-1).content, /^Disconnect Second\?/);
  registry.revoke(second.id, 'operator');
  assert.ok(!messages(bot).some((m) => /^Disconnect Second/.test(m.content)), 'withdrawn');
  assert.ok(
    !Object.values(bot.state.callbacks).some((entry) => entry.delivery?.connection === second.id),
    'and not kept for a retry',
  );
  await bot.flush();
  assert.ok(net.sent.every((event) => !JSON.stringify(event).includes(second.id)));
});

test('a suspension during a flush holds what that flush had not sent', async (t) => {
  const { bot, net, registry, root } = await fixture(t);
  await sendDM(bot, alice, '/invoices');
  const queued = bot.state.outbox.length;
  const ledgerPath = ledgerFile(join(root, 'secrets'));
  chmodSync(ledgerPath, 0o644);
  registry.check();
  // The transport's publish, as a flush already under way would call it.
  const item = bot.state.outbox[0];
  await assert.rejects(bot.net.publish(item.event, item.relays, bot.key), /suspended/);
  assert.equal(net.sent.length, 0);
  assert.equal(bot.state.outbox.length, queued);
  chmodSync(ledgerPath, 0o600);
  registry.check();
  await bot.net.publish(item.event, item.relays, bot.key);
  assert.equal(net.sent.length, 1);
});

test('a resume the busy database interrupts stays suspended, and cleans up first', async (t) => {
  const { bot, net, main, registry, root, db } = await fixture(t);
  await sendDM(bot, alice, '/invoices');
  const secrets = join(root, 'secrets');
  chmodSync(ledgerFile(secrets), 0o644);
  registry.check();
  chmodSync(ledgerFile(secrets), 0o600);
  Ledger.open(secrets, registry.keyring).append({
    connection: main.id,
    ref: main.ref,
    actor: 'operator',
  });
  const other = new DatabaseSync(db.file);
  other.exec('BEGIN IMMEDIATE');
  registry.store.db.exec('PRAGMA busy_timeout = 20');
  registry.check();
  assert.equal(registry.broken, true, 'not resumed');
  await bot.flush();
  assert.equal(net.sent.length, 0, 'nothing about the revoked wallet goes out');
  other.exec('ROLLBACK');
  other.close();
  registry.check();
  assert.equal(registry.broken, false);
  assert.equal(bot.state.outbox.filter((i) => i.connection === main.id).length, 0);
  await bot.flush();
  assert.equal(net.sent.length, 0);
});

test('at a restart, nothing more is said about a request of a disconnected wallet', async (t) => {
  const { bot, main, registry, dir, server } = await fixture(t);
  const record = bot.invoices.add({
    requester: A,
    messageId: 'd'.repeat(64),
    sats: 4242,
    connection: main.id,
    ref: main.ref,
  });
  bot.invoices.move(record, 'sending');
  bot.save();
  await bot.close();
  registry.connect({
    owner: getPublicKey(bob),
    label: 'x',
    origin: ORIGIN,
    secret: { invoiceKey: BOB_KEY },
  });
  registry.revoke(main.id, 'operator');
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 1000 });
  const next = setup(t, { wallets: registry, lnbits, dir });
  await next.bot.start();
  await settle(next.bot);
  assert.ok(!messages(next.bot).some((m) => /4,242/.test(m.content)));
  assert.equal(next.bot.state.invoices[0].state, 'uncertain', 'still settled by its timers');
  await next.bot.close();
});
