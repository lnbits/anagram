// Disconnecting while the bot is doing something: slow LNbits answers, queued replies,
// notifications and reconnects. Each case is a row of the race table in the M7.1 design.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEventHash, getPublicKey } from 'nostr-tools';
import { Keyring } from '../keyring.js';
import { Ledger, ledgerFile } from '../ledger.js';
import { LNbitsClient } from '../lnbits.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { BOT_CONTROL_KIND, keyboardFromTags } from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const ORIGIN = 'https://lnbits.test/';
const SECOND_KEY = 'c0ffee00000000000000000000000004';

async function fixture(
  t,
  {
    limits = {},
    notifications = { periodicMs: 40, triggerDelayMs: 5, recheckMs: 20, backoffMs: [20, 40] },
  } = {},
) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 42_000, payments: [] },
    [SECOND_KEY]: { name: 'c', balance: 7_000, payments: [] },
  });
  defer(t, () => server.close());
  const root = tempDir(t, 'revocation');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const store = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, store.getMeta('store_id'));
  const registry = new Registry({ store, keyring, ledger });
  const link = (key = alice, invoiceKey = ALICE_KEY, label = 'Main') =>
    registry.connect({ owner: getPublicKey(key), label, origin: ORIGIN, secret: { invoiceKey } });
  const wallet = link();
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 2000 });
  const ctx = setup(t, {
    wallets: registry,
    lnbits,
    limits,
    notifications,
    checkDelays: [0.03, 0.03],
  });
  defer(t, () => store.close());
  return { server, registry, wallet, link, db: store, root, ...ctx };
}
const hold = (server, match) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const held = [];
  const reached = new Promise((resolve) => {
    server.next = (record, req, res) => {
      if (!match(record)) return undefined;
      held.push(res);
      resolve();
      gate.then(() => {
        server.next = undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'a', balance: 2_100_000 }));
      });
      return 'handled';
    };
  });
  return { reached, release };
};
const isWallet = (r) => r.path === '/api/v1/wallet';

function press(bot, key, card, data, { view } = {}) {
  const request = {
    op: 'request',
    id: randomBytes(16).toString('hex'),
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
  // Requests reach buttonRequest() directly, after unwrap() has authenticated them.
  bot.buttonRequest(message);
  return request;
}
const cards = (bot, key) => repliesFor(bot, key).filter((r) => keyboardFromTags(r.tags));
const answers = (bot, key) => repliesFor(bot, key).filter((r) => r.kind === BOT_CONTROL_KIND);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(15);
  }
}

test('revoked during /balance: the LNbits request is cancelled and nothing is sent', async (t) => {
  const { bot, registry, wallet, server } = await fixture(t);
  const gate = hold(server, isWallet);
  await bot.directMessage(dm(alice, '/balance', bot), { tags: [] });
  await gate.reached;
  registry.revoke(wallet.id, 'user');
  gate.release();
  await settle(bot);
  assert.deepEqual(repliesFor(bot, alice), []);
  assert.equal(bot.state.outbox.length, 0);
});

test('revoked between the LNbits answer and the outbox write: nothing is queued', async (t) => {
  const { bot, registry, wallet } = await fixture(t);
  const inbox = bot.inbox.bind(bot);
  bot.inbox = async (pubkey) => {
    registry.revoke(wallet.id, 'user'); // the last await before the reply is written
    return inbox(pubkey);
  };
  await sendDM(bot, alice, '/balance');
  assert.deepEqual(repliesFor(bot, alice), []);
});

test('revoked after a reply was queued: the unpublished reply is removed', async (t) => {
  const { bot, registry, wallet, link } = await fixture(t);
  link(bob, BOB_KEY, 'Bob');
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, bob, '/balance');
  assert.ok(repliesFor(bot, alice).length >= 1);
  registry.revoke(wallet.id, 'user');
  assert.deepEqual(repliesFor(bot, alice), []);
  assert.ok(repliesFor(bot, bob).length >= 1, "someone else's reply stays");
});

test('a queued command of a person just disconnected is not run', async (t) => {
  const { bot, registry, wallet, server } = await fixture(t);
  const gate = hold(server, isWallet);
  await bot.directMessage(dm(alice, '/balance', bot), { tags: [] });
  await bot.directMessage(dm(alice, '/invoice 5', bot), { tags: [] });
  await gate.reached;
  registry.revoke(wallet.id, 'user');
  gate.release();
  await settle(bot);
  assert.equal(server.posts.length, 0, 'no invoice asked for');
  assert.deepEqual(repliesFor(bot, alice), []);
});

test('revoked before the invoice POST: LNbits is not asked and nothing is recorded', async (t) => {
  const { bot, registry, wallet, server } = await fixture(t);
  const gate = hold(server, isWallet); // the key check that runs before the first invoice
  await bot.directMessage(dm(alice, '/invoice 5', bot), { tags: [] });
  await gate.reached;
  registry.revoke(wallet.id, 'user');
  gate.release();
  await settle(bot);
  assert.equal(server.posts.length, 0);
  assert.equal(bot.state.invoices.length, 0);
});

test('revoked during the invoice POST: no invoice is shown, and the record goes to review', async (t) => {
  const { bot, registry, wallet, server, logs } = await fixture(t);
  await sendDM(bot, alice, '/balance'); // verified: the next step goes straight to the POST
  const shown = repliesFor(bot, alice).length;
  server.create = 'store-hang';
  await bot.directMessage(dm(alice, '/invoice 5', bot), { tags: [] });
  for (let i = 0; i < 100 && !server.posts.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(server.posts.length, 1);
  registry.revoke(wallet.id, 'user');
  await settle(bot);
  for (let i = 0; i < 100 && bot.state.invoices[0]?.state !== 'review'; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(bot.state.invoices[0].state, 'review');
  assert.ok(repliesFor(bot, alice).length <= shown, 'nothing new for that wallet');
  assert.ok(logs.some((l) => l.includes('needs operator review')));
  assert.equal(server.posts.length, 1, 'never sent twice');
});

test('LNbits answers the POST after the revoke: the invoice is not shown', async (t) => {
  const { bot, registry, wallet, server } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  server.create = 'ok';
  const create = bot.lnbits.createInvoice.bind(bot.lnbits);
  bot.lnbits.createInvoice = async (...args) => {
    const invoice = await create(...args);
    registry.revoke(wallet.id, 'user');
    return invoice;
  };
  await sendDM(bot, alice, '/invoice 5');
  assert.equal(bot.state.invoices[0].state, 'review');
  assert.equal(bot.state.invoices[0].error, 'no_key');
  assert.ok(!JSON.stringify(repliesFor(bot, alice)).includes('lnbc'));
});

test('a stuck request of a disconnected wallet does not hold up the others', async (t) => {
  const { bot, registry, wallet, link, server } = await fixture(t);
  const second = link(alice, SECOND_KEY, 'Second');
  await sendDM(bot, alice, '/balance');
  server.create = 'store-hang';
  await bot.directMessage(dm(alice, '/invoice 5', bot), { tags: [] });
  for (let i = 0; i < 100 && !server.posts.length; i++) await new Promise((r) => setTimeout(r, 5));
  registry.revoke(wallet.id, 'user');
  await settle(bot);
  server.create = 'ok';
  assert.equal(registry.lease(getPublicKey(alice)).id, second.id, 'the other wallet took over');
  await sendDM(bot, alice, '/invoice 7');
  assert.match(repliesFor(bot, alice).at(-1).content, /^Invoice for 7 sats/);
  assert.equal(server.created.at(-1).amount, 7000);
});

test('a retried button press is not answered from memory after a revoke', async (t) => {
  const { bot, registry, wallet, link } = await fixture(t);
  link(alice, SECOND_KEY, 'Second');
  await sendDM(bot, alice, '/balance');
  const card = cards(bot, alice).at(-1);
  const pressed = { message: null };
  const original = bot.buttonRequest.bind(bot);
  bot.buttonRequest = (message) => {
    pressed.message = message;
    original(message);
  };
  press(bot, alice, card, 'bal');
  await settle(bot);
  assert.equal(answers(bot, alice).length, 1);
  bot.state.outbox = [];
  assert.equal(Object.keys(bot.state.callbacks).length, 1);

  registry.revoke(wallet.id, 'user');
  assert.equal(Object.keys(bot.state.callbacks).length, 0, 'stored answers are deleted');
  original(pressed.message);
  await settle(bot);
  assert.deepEqual(
    answers(bot, alice)
      .map((a) => a.content)
      .filter((c) => /Balance/.test(c)),
    [],
  );
});

test('old menus stay stale after the same wallet is reconnected', async (t) => {
  const { bot, registry, wallet, link, server } = await fixture(t);
  link(alice, SECOND_KEY, 'Second'); // keeps the person linked through the disconnect
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, alice, '/invoice 5');
  const old = cards(bot, alice);
  assert.equal(old.length, 2);
  registry.revoke(wallet.id, 'user');
  const again = link(alice, ALICE_KEY, 'Main again');
  assert.notEqual(again.ref, wallet.ref);
  const calls = server.requests.length;
  const invoice = old[1];
  const status = keyboardFromTags(invoice.tags)
    .inline_keyboard.flat()
    .find((b) => b.callback_data?.startsWith('st:'));
  for (const [card, data] of [
    [old[0], 'bal'],
    [old[0], 'hist:0'],
    [old[0], 'inv:1000'],
    [invoice, status.callback_data],
  ]) {
    bot.state.outbox = [];
    press(bot, alice, card, data);
    await settle(bot);
    assert.match(answers(bot, alice).at(-1).content, /no longer linked/, data);
    assert.deepEqual(keyboardFromTags(answers(bot, alice).at(-1).tags).inline_keyboard, []);
  }
  assert.equal(
    server.requests.slice(calls).filter((r) => r.path !== '/api/v1/payments/paginated').length,
    0,
    'no wallet call for stale menus',
  );
  assert.equal(server.posts.length, 1);
});

test('a menu keeps acting on its own wallet after another is selected', async (t) => {
  const { bot, registry, link } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  const card = cards(bot, alice).at(-1);
  const second = link(alice, SECOND_KEY, 'Second');
  assert.equal(registry.select(getPublicKey(alice), second.id), true);
  press(bot, alice, card, 'bal');
  await settle(bot);
  assert.match(answers(bot, alice).at(-1).content, /Balance \(Main\): 2,100 sats/);
  await sendDM(bot, alice, '/balance');
  assert.match(repliesFor(bot, alice).at(-1).content, /Balance \(Second\): 7 sats/);
});

test("nobody can use another person's menu, connection or stale ref", async (t) => {
  const { bot, registry, wallet, link, server } = await fixture(t);
  link(bob, BOB_KEY, 'Bob');
  await sendDM(bot, alice, '/balance');
  const card = cards(bot, alice).at(-1);
  const before = server.requests.length;
  bot.state.outbox = [];
  press(bot, bob, card, 'bal');
  await settle(bot);
  assert.deepEqual(repliesFor(bot, bob), []);
  assert.deepEqual(answers(bot, alice), []);
  assert.equal(registry.lease(getPublicKey(bob), wallet.ref), undefined);
  assert.equal(registry.select(getPublicKey(bob), wallet.id), false);
  assert.equal(
    server.requests.slice(before).filter((r) => r.key === ALICE_KEY && r.path === '/api/v1/wallet')
      .length,
    0,
  );
});

test('notifications: scan racing a revoke writes nothing and sends nothing', async (t) => {
  const { bot, registry, wallet, server } = await fixture(t);
  await bot.start();
  // The first scan is held; the wallet is disconnected while it waits for LNbits.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const incoming = bot.lnbits.incoming.bind(bot.lnbits);
  bot.lnbits.incoming = async (...args) => {
    const result = await incoming(...args);
    await gate;
    return result;
  };
  for (let i = 0; i < 200 && !bot.watcher.watched.size; i++)
    await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  registry.revoke(wallet.id, 'user');
  assert.equal(bot.watcher.watched.size, 0, 'watcher stopped at once');
  assert.equal(bot.state.payments[wallet.ref], undefined);
  release();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bot.state.payments[wallet.ref], undefined, 'not recreated by the running scan');
  assert.equal(server.open(ALICE_KEY), 0, 'socket closed');
  server.settle(ALICE_KEY, { sats: 9 });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(repliesFor(bot, alice), []);
});

test('notifications: a reconnected wallet starts fresh; a payment in between is not announced', async (t) => {
  const { bot, registry, wallet, link, server } = await fixture(t);
  await bot.start();
  for (let i = 0; i < 300 && !bot.state.payments[wallet.ref]; i++)
    await new Promise((r) => setTimeout(r, 5));
  server.settle(ALICE_KEY, { sats: 1, memo: 'before' });
  for (let i = 0; i < 300 && !repliesFor(bot, alice).length; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.match(repliesFor(bot, alice)[0].content, /before/);
  bot.state.outbox = [];

  registry.revoke(wallet.id, 'user');
  server.settle(ALICE_KEY, { sats: 2, memo: 'in the gap' });
  const again = link(alice, ALICE_KEY, 'Main');
  for (let i = 0; i < 300 && !bot.state.payments[again.ref]; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(repliesFor(bot, alice), [], 'the gap payment is in the baseline');
  server.settle(ALICE_KEY, { sats: 3, memo: 'after' });
  for (let i = 0; i < 300 && !repliesFor(bot, alice).length; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.match(repliesFor(bot, alice)[0].content, /after/);
});

test('a revocation from the CLI reaches the running bot within one check', async (t) => {
  const { bot, registry, wallet, db, root } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  const cli = new Store(db.file);
  const keyring = Keyring.load(join(root, 'secrets'));
  Ledger.open(join(root, 'secrets'), keyring).append({
    connection: wallet.id,
    ref: wallet.ref,
    actor: 'operator',
  });
  cli.revoke(wallet.id, 'operator');
  cli.close();
  registry.check();
  assert.equal(registry.linked(getPublicKey(alice)), false);
  assert.deepEqual(repliesFor(bot, alice), [], 'its queued reply went with it');
  await sendDM(bot, alice, '/balance');
  assert.deepEqual(repliesFor(bot, alice), []);
  assert.deepEqual(Object.keys(bot.state.authorized.users), []);
});

test('revoked during a flush: what was not yet published stays unpublished', async (t) => {
  const { bot, registry, wallet, link, net } = await fixture(t);
  link(bob, BOB_KEY, 'Bob');
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, bob, '/balance');
  const aliceEvents = new Set(
    bot.state.outbox.filter((item) => item.connection === wallet.id).map((i) => i.event.id),
  );
  // The first publish is slow: the revocation lands while flush() holds its snapshot.
  const realSent = net.sent;
  let first = true;
  const publish = net.publish;
  net.publish = async (event, ...rest) => {
    if (first) {
      first = false;
      registry.revoke(wallet.id, 'user');
      if (aliceEvents.has(event.id)) return;
    }
    return publish(event, ...rest);
  };
  await bot.flush();
  assert.ok(
    realSent.every((event) => !aliceEvents.has(event.id)),
    'nothing of that wallet went out',
  );
  assert.ok(realSent.length >= 1, "someone else's reply did");
});

test('revoked while the bot was stopped: its queued replies are dropped at the next start', async (t) => {
  const { bot, registry, wallet, link, net } = await fixture(t);
  link(bob, BOB_KEY, 'Bob');
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, bob, '/balance');
  const queued = bot.state.outbox.filter((i) => i.connection === wallet.id).map((i) => i.event.id);
  assert.ok(queued.length);
  // No listener heard this: it happened with no bot running.
  registry.listener = {};
  registry.revoke(wallet.id, 'operator');
  assert.ok(bot.state.outbox.some((i) => i.connection === wallet.id));
  bot.sweepRevoked();
  assert.ok(!bot.state.outbox.some((i) => i.connection === wallet.id));
  assert.ok(bot.state.outbox.length >= 1, 'others stay');
  await bot.flush();
  assert.ok(net.sent.every((event) => !queued.includes(event.id)));
});

test('no key reaches logs, state, events or replies through any of this', async (t) => {
  const { bot, registry, wallet, logs, dir, db } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  await sendDM(bot, alice, '/invoice 5');
  registry.revoke(wallet.id, 'user');
  bot.save();
  const everything = [
    logs.join('\n'),
    readFileSync(`${dir}/state.json`, 'utf8'),
    JSON.stringify(db.all()),
    JSON.stringify(db.audit()),
  ].join('\n');
  assert.ok(!everything.includes(ALICE_KEY));
});

test('a ledger fault loses no wallet, menu, queued reply or payment state', async (t) => {
  const { bot, server, registry, root, net } = await fixture(t);
  await bot.start();
  await bot.checking;
  await wait(120);
  const ledgerPath = ledgerFile(join(root, 'secrets'));
  const before = JSON.stringify(bot.state.payments);
  assert.notEqual(before, '{}');
  await sendDM(bot, alice, '/balance');
  const sent = net.sent.length;
  const queued = { ...bot.state.outbox.at(-1) };

  chmodSync(ledgerPath, 0o644);
  registry.check();
  assert.equal(registry.broken, true);
  assert.equal(JSON.stringify(bot.state.payments), before, 'payment state kept');
  // Nothing goes out, and nothing is read, while the history is unknown.
  bot.state.outbox.push(queued);
  await bot.flush();
  assert.equal(net.sent.length, sent);
  await sendDM(bot, alice, '/balance');
  assert.ok(bot.state.outbox.includes(queued), 'queued replies are kept');
  server.settle(ALICE_KEY, { sats: 55 });

  chmodSync(ledgerPath, 0o600);
  registry.check();
  assert.equal(registry.broken, false);
  await bot.checking;
  await until(
    () => repliesFor(bot, alice).some((m) => /\+55 sats/.test(m.content)),
    'the payment made during the fault',
  );
  assert.equal(
    repliesFor(bot, alice).filter((m) => /baseline/.test(m.content)).length,
    0,
    'no new baseline',
  );
});

test('a flood over the hourly limit costs no disk write and leaves nothing behind', async (t) => {
  const { bot } = await fixture(t, { limits: { requestsPerHour: 2 } });
  await sendDM(bot, alice, '/help');
  await sendDM(bot, alice, '/help');
  await sendDM(bot, alice, '/help'); // the one notice
  const seen = Object.keys(bot.state.seen).length;
  let writes = 0;
  const save = bot.save.bind(bot);
  bot.save = () => {
    writes++;
    save();
  };
  for (let i = 0; i < 50; i++) await bot.directMessage(dm(alice, `/help ${i}`, bot), { tags: [] });
  await settle(bot);
  assert.equal(writes, 0, 'no disk write');
  assert.equal(Object.keys(bot.state.seen).length, seen, 'nothing kept');
});

test('neither a full outbox nor the hourly limit stops someone leaving a wallet', async (t) => {
  const { bot, wallet, registry, db } = await fixture(t, { limits: { requestsPerHour: 1 } });
  await sendDM(bot, alice, '/wallets');
  const list = cards(bot, alice).at(-1);
  await sendDM(bot, alice, '/help'); // over the limit from here on
  await sendDM(bot, alice, '/help');
  const filler = {
    event: { id: 'c'.repeat(64) },
    relays: [],
    queuedAt: Math.floor(Date.now() / 1000),
    retryAt: 2 ** 40,
  };
  bot.state.outbox.push(...Array(1000).fill(filler));
  press(bot, alice, list, 'bal');
  await settle(bot);
  press(bot, alice, list, `w:del:${wallet.id}`);
  await settle(bot);
  const confirm = answers(bot, alice).at(-1);
  assert.match(confirm.content, /^Disconnect Main\?/, 'the first step is answered');
  press(bot, alice, list, `w:delok:${wallet.id}`, { view: confirm.id });
  await settle(bot);
  assert.equal(registry.linked(getPublicKey(alice)), false);
  assert.equal(db.connection(wallet.id).status, 'revoked');
});

test('a revocation reaches the ledger before the database', async (t) => {
  const { registry, wallet, db } = await fixture(t);
  const revoke = db.revoke.bind(db);
  let ledgerHadIt;
  registry.store.revoke = (...args) => {
    ledgerHadIt = registry.ledger.connections.has(wallet.id);
    return revoke(...args);
  };
  registry.revoke(wallet.id, 'user');
  assert.equal(ledgerHadIt, true);
});
