// /balance and /history end to end through the bot, against a local mock LNbits.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { LNbitsClient } from '../lnbits.js';
import { Wallets } from '../wallets.js';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  last,
  linked,
  mallory,
  npub,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { closedPort, lnbitsServer, payment } from './lnbits-server.js';

const ADMIN_KEY = 'ad000000000000000000000000000003';
// LNbits requests other than the payment-notification scans a started bot makes itself.
const walletCalls = (server) =>
  server.requests.filter((r) => r.path !== '/api/v1/payments/paginated').length;

async function mockLNbits(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: {
      name: 'alice-in-lnbits',
      balance: 2_100_500,
      payments: [
        payment({
          amount: 2_100_000,
          memo: 'salary https://evil.example',
          time: '2026-10-30T18:00:00+00:00',
        }),
        payment({ amount: 500, memo: 'tip', time: '2026-10-31T18:00:00+00:00' }),
      ],
    },
    [BOB_KEY]: { name: 'bob-in-lnbits', balance: 42_000, payments: [] },
    [ADMIN_KEY]: { name: 'spendable', balance: 1, payments: [], admin: true },
  });
  defer(t, () => server.close());
  return server;
}
function walletBot(t, server, options = {}) {
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 500, ...options.client });
  return { lnbits, ...setup(t, { lnbits, ...options }) };
}
const secretsAbsent = (bot, logs, dir) => {
  const everything = [
    logs.join('\n'),
    readFileSync(`${dir}/state.json`, 'utf8'),
    ...repliesFor(bot, alice).map((r) => r.content),
    ...repliesFor(bot, bob).map((r) => r.content),
  ].join('\n');
  for (const secret of [ALICE_KEY, BOB_KEY, ADMIN_KEY])
    assert.ok(!everything.includes(secret), 'key leaked');
};

test('/balance answers each person from their own wallet only', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs, dir } = walletBot(t, server);
  await sendDM(bot, alice, '/balance');
  assert.equal(last(bot, alice).content, 'Balance (Alice test wallet): 2,100.5 sats');
  await sendDM(bot, bob, 'balance');
  assert.equal(last(bot, bob).content, 'Balance (Bob test wallet): 42 sats');
  assert.deepEqual(
    server.requests.map((r) => r.key),
    [ALICE_KEY, BOB_KEY],
  );
  // The LNbits wallet name is not shown: only the operator's label.
  assert.ok(!repliesFor(bot, alice).some((r) => r.content.includes('alice-in-lnbits')));
  secretsAbsent(bot, logs, dir);
});

test('cross-wallet attempts still reach only the sender’s wallet; strangers reach nothing', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs, dir } = walletBot(t, server);
  await sendDM(bot, alice, `/balance ${npub(bob)}`);
  await sendDM(bot, alice, '/history 5 bob');
  await sendDM(bot, alice, `/balance ${BOB_KEY}`);
  assert.ok(
    server.requests.every((r) => r.key === ALICE_KEY),
    'never Bob’s key',
  );
  assert.match(last(bot, alice).content, /never accept keys in chat/);
  const before = server.requests.length;
  for (const text of ['/balance', '/history', `/balance ${npub(alice)}`, 'help'])
    await sendDM(bot, mallory, text);
  assert.equal(server.requests.length, before, 'a stranger causes no LNbits request');
  assert.equal(repliesFor(bot, mallory).length, 0);
  secretsAbsent(bot, logs, dir);
});

test('/history: bounded, newest first, sanitized, with an admin-key check first', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = walletBot(t, server, { limits: { historyDefault: 1 } });
  await sendDM(bot, alice, '/history');
  assert.equal(
    last(bot, alice).content,
    'Last 1 settled payment (Alice test wallet):\n+0.5 sats · 2026-10-31 18:00 UTC · tip',
  );
  await sendDM(bot, alice, '/history 20');
  assert.match(last(bot, alice).content, /\+2,100 sats · 2026-10-30 18:00 UTC · salary \(link\)$/);
  assert.deepEqual(
    server.requests.map((r) => [r.path, r.query.limit]),
    [
      ['/api/v1/wallet', undefined],
      // One row more than shown tells the Older button whether there is an older page.
      ['/api/v1/payments', '2'],
      ['/api/v1/payments', '20'],
    ],
  );
  await sendDM(bot, bob, '/history');
  assert.equal(last(bot, bob).content, 'No settled payments yet in Bob test wallet.');
  await sendDM(bot, bob, '/history 50');
  assert.equal(last(bot, bob).content, 'Usage: /history or /history 1-20');
});

test('an admin key is switched off and never used again', async (t) => {
  const server = await mockLNbits(t);
  const wallets = new Wallets([[npub(alice), { label: 'Alice', invoiceKey: ADMIN_KEY }]]);
  const { bot, logs, dir } = walletBot(t, server, { wallets });
  await sendDM(bot, alice, '/history');
  assert.match(last(bot, alice).content, /uses a key that can spend/);
  assert.deepEqual(
    server.requests.map((r) => r.path),
    ['/api/v1/wallet'],
    'history was never fetched',
  );
  assert.ok(logs.some((l) => /Switched off the wallet link for npub1.*admin key/.test(l)));
  await sendDM(bot, alice, '/balance');
  assert.equal(repliesFor(bot, alice).length, 2, 'a second, separate reply');
  assert.equal(
    last(bot, alice).content,
    'Your wallet link is switched off. Please ask the bot operator to check it.',
  );
  assert.equal(server.requests.length, 1, 'the admin key was not used again');
  await sendDM(bot, alice, '/help');
  assert.match(last(bot, alice).content, /^LNbits wallet bot/, 'other commands still work');
  secretsAbsent(bot, logs, dir);
});

test('rejected, unreachable, slow and malformed LNbits never crash the bot', async (t) => {
  const server = await mockLNbits(t);
  const wallets = new Wallets([
    [npub(alice), { label: 'Alice', invoiceKey: 'c'.repeat(32) }], // reset or wrong key
    [npub(bob), { label: 'Bob', invoiceKey: BOB_KEY }],
  ]);
  const { bot, logs, dir } = walletBot(t, server, { wallets });
  await sendDM(bot, alice, '/balance');
  assert.match(last(bot, alice).content, /did not accept the key linked to your wallet/);
  assert.ok(logs.some((l) => /LNbits balance for npub1\S+ failed \(rejected 404\)\./.test(l)));

  server.next = () => 'handled'; // hangs past the 500 ms timeout
  await sendDM(bot, bob, '/balance');
  assert.match(last(bot, bob).content, /not reachable right now/);
  server.next = (_r, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"balance": "lots"}');
    return 'handled';
  };
  await sendDM(bot, bob, '/balance');
  assert.match(last(bot, bob).content, /unexpected response/);
  server.next = undefined;
  await sendDM(bot, bob, '/balance');
  assert.equal(last(bot, bob).content, 'Balance (Bob): 42 sats', 'recovers once LNbits does');
  assert.equal(bot.stopped, false);
  secretsAbsent(bot, logs, dir);

  const down = setup(t, {
    lnbits: new LNbitsClient({ url: await closedPort() }),
    wallets: linked(),
  });
  await sendDM(down.bot, alice, '/balance');
  assert.match(last(down.bot, alice).content, /not reachable right now/);
  assert.equal(down.bot.stopped, false);
});

test('concurrent requests from several people get their own answers, in order', async (t) => {
  const server = await mockLNbits(t);
  server.next = (record, req, res) => {
    // Answer in a random order to shake out any mix-up between people.
    setTimeout(() => {
      const wallet = server.wallets[record.key];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: wallet.name, balance: wallet.balance }));
    }, Math.random() * 40);
    return 'handled';
  };
  const { bot, lnbits } = walletBot(t, server, { client: { maxConcurrent: 2 } });
  const messages = [];
  for (let i = 0; i < 6; i++) messages.push(dm(alice, '/balance', bot), dm(bob, '/balance', bot));
  await Promise.all(messages.map((m) => bot.directMessage(m, { tags: [] })));
  await settle(bot);
  const forAlice = repliesFor(bot, alice);
  const forBob = repliesFor(bot, bob);
  assert.equal(forAlice.length, 6);
  assert.equal(forBob.length, 6);
  assert.ok(forAlice.every((r) => r.content === 'Balance (Alice test wallet): 2,100.5 sats'));
  assert.ok(forBob.every((r) => r.content === 'Balance (Bob test wallet): 42 sats'));
  // Each reply answers the message it belongs to, in the order they were sent.
  const asked = messages.filter((m) => m.pubkey === getPublicKey(alice)).map((m) => m.id);
  assert.deepEqual(
    forAlice.map((r) => r.tags.find((tag) => tag[0] === 'e')[1]),
    asked,
  );
  assert.equal(lnbits.active, 0);
});

test('a handled /balance is not repeated after a restart; startup checks the links', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'wallet-restart');
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 500 });
  const first = setup(t, { dir, lnbits });
  const message = dm(alice, '/balance', first.bot);
  await first.bot.directMessage(message, { tags: [] });
  await settle(first.bot);
  // Not started, so the signed reply is still in the durable outbox.
  const queued = first.bot.state.outbox.map((item) => item.event.id);
  assert.equal(queued.length, 1);
  await first.bot.close();
  const calls = walletCalls(server);

  const wallets = new Wallets([
    [npub(alice), { label: 'Alice', invoiceKey: ALICE_KEY }],
    [npub(bob), { label: 'Bob', invoiceKey: ADMIN_KEY }],
  ]);
  const second = setup(t, { dir, lnbits, wallets });
  await second.bot.start();
  await second.bot.checking;
  assert.ok(second.logs.includes('LNbits accepted 1 of 2 wallet link(s).'));
  assert.ok(second.logs.some((l) => /Switched off .*admin key/.test(l)));
  assert.equal(second.bot.wallets.has(getPublicKey(bob)), false);
  const afterCheck = walletCalls(server);
  assert.equal(afterCheck, calls + 2, 'one check per link');
  await second.bot.directMessage(message, { tags: [] });
  await settle(second.bot);
  assert.equal(walletCalls(server), afterCheck, 'the old message caused no new LNbits call');
  // start() published the first run's reply unchanged, and nothing new was queued.
  assert.deepEqual(
    second.net.sent.filter((e) => e.kind === 1059).map((e) => e.id),
    queued,
  );
  assert.equal(second.bot.state.outbox.length, 0);
});

test('stopping during a hung LNbits request finishes promptly without a reply', async (t) => {
  const server = await mockLNbits(t);
  server.next = () => 'handled'; // never answers
  const { bot } = walletBot(t, server, { client: { timeoutMs: 10000 } });
  await bot.directMessage(dm(alice, '/balance', bot), { tags: [] });
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  await bot.close();
  assert.ok(Date.now() - started < 1000, `close took ${Date.now() - started} ms`);
  assert.equal(repliesFor(bot, alice).length, 0, 'no misleading error reply while stopping');
});
