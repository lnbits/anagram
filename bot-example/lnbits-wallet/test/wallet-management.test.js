// /wallets, /disconnect and wallet selection: only ever the sender's own wallets.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getEventHash, getPublicKey } from 'nostr-tools';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { LNbitsClient } from '../lnbits.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { Wallets as FileWallets } from '../wallets.js';
import { BOT_CONTROL_KIND, keyboardFromTags } from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  linked,
  mallory,
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

async function fixture(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    [SECOND_KEY]: { name: 'c', balance: 7_000, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 42_000, payments: [] },
  });
  defer(t, () => server.close());
  const root = tempDir(t, 'management');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const registry = new Registry({ store: db, keyring, ledger });
  const link = (key, invoiceKey, label) =>
    registry.connect({ owner: getPublicKey(key), label, origin: ORIGIN, secret: { invoiceKey } });
  const main = link(alice, ALICE_KEY, 'Main');
  const second = link(alice, SECOND_KEY, 'Second');
  const theirs = link(bob, BOB_KEY, 'Bob wallet');
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 2000 });
  const ctx = setup(t, { wallets: registry, lnbits });
  defer(t, () => db.close());
  return { server, registry, main, second, theirs, db, ...ctx };
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
  return message;
}
const card = (bot, key) =>
  repliesFor(bot, key)
    .filter((r) => r.kind === 14 && keyboardFromTags(r.tags))
    .at(-1);
const answer = (bot, key) =>
  repliesFor(bot, key)
    .filter((r) => r.kind === BOT_CONTROL_KIND)
    .at(-1);
const buttons = (message) => keyboardFromTags(message.tags).inline_keyboard.flat();
const walletsCard = async (bot, key = alice) => {
  await sendDM(bot, key, '/wallets');
  return card(bot, key);
};

test('/wallets lists only your own wallets and marks the one in use', async (t) => {
  const { bot, main, second, theirs } = await fixture(t);
  const list = await walletsCard(bot);
  assert.equal(
    list.content,
    'Your wallets:\n✓ Main (in use)\n• Second\n\nNew commands use the wallet in use. Older menus keep showing their own wallet.',
  );
  const data = buttons(list).map((b) => b.callback_data);
  assert.deepEqual(data, [`w:del:${main.id}`, `w:use:${second.id}`, `w:del:${second.id}`]);
  assert.ok(!JSON.stringify(list).includes(theirs.id));
  assert.ok(!list.content.includes('Bob'));
  assert.ok(!JSON.stringify(repliesFor(bot, alice)).includes(ALICE_KEY));
});

test('selection changes new commands only; old menus keep their wallet', async (t) => {
  const { bot, registry, second } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  const menu = card(bot, alice);
  const list = await walletsCard(bot);
  press(bot, alice, list, `w:use:${second.id}`);
  await settle(bot);
  assert.match(answer(bot, alice).content, /^Now using Second\./);
  assert.match(answer(bot, alice).content, /✓ Second \(in use\)/);
  assert.equal(registry.lease(A).id, second.id);

  await sendDM(bot, alice, '/balance');
  assert.match(
    repliesFor(bot, alice)
      .filter((r) => r.kind === 14)
      .at(-1).content,
    /Balance \(Second\): 7 sats/,
  );
  press(bot, alice, menu, 'bal');
  await settle(bot);
  assert.match(answer(bot, alice).content, /Balance \(Main\): 2,100 sats/);
});

test('disconnect asks first; keeping changes nothing; confirming revokes at once', async (t) => {
  const { bot, registry, main, second, db } = await fixture(t);
  const list = await walletsCard(bot);
  press(bot, alice, list, `w:del:${main.id}`);
  await settle(bot);
  const ask = answer(bot, alice);
  assert.match(ask.content, /^Disconnect Main\?/);
  assert.equal(registry.linked(A), true);
  assert.deepEqual(
    buttons(ask).map((b) => b.callback_data),
    [`w:delok:${main.id}`, 'w:list'],
  );

  press(bot, alice, list, 'w:list', { view: ask.id });
  await settle(bot);
  const kept = answer(bot, alice);
  assert.match(kept.content, /✓ Main/);
  assert.equal(db.connection(main.id).status, 'active');

  press(bot, alice, list, `w:del:${main.id}`, { view: kept.id });
  await settle(bot);
  press(bot, alice, list, `w:delok:${main.id}`, { view: answer(bot, alice).id });
  // Not queued behind anything: done before the lane runs.
  assert.equal(db.connection(main.id).status, 'revoked');
  await settle(bot);
  const done = answer(bot, alice);
  assert.match(done.content, /^Disconnected Main\./);
  assert.match(done.content, /reset the wallet’s invoice key in LNbits/);
  assert.match(done.content, /✓ Second \(in use\)/);
  assert.equal(registry.lease(A).id, second.id, 'the other wallet takes over');
  assert.equal(db.audit().at(-1).actor, 'user');
});

test('a disconnect is not held up by a slow request of the same person', async (t) => {
  const { bot, registry, main, server } = await fixture(t);
  const list = await walletsCard(bot);
  press(bot, alice, list, `w:del:${main.id}`);
  await settle(bot);
  const ask = answer(bot, alice);

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  server.next = (record, req, res) => {
    if (record.path !== '/api/v1/wallet') return undefined;
    gate.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'a', balance: 1 }));
    });
    return 'handled';
  };
  await bot.directMessage(dm(alice, '/balance', bot), { tags: [] });
  await new Promise((r) => setTimeout(r, 30));
  const before = repliesFor(bot, alice).length;
  press(bot, alice, list, `w:delok:${main.id}`, { view: ask.id });
  assert.equal(registry.connection(main.id), undefined, 'revoked while /balance is still waiting');
  release();
  server.next = undefined;
  await settle(bot);
  const after = repliesFor(bot, alice).slice(before);
  assert.ok(
    after.every((r) => !/^Balance/.test(r.content)),
    'the waiting reply never goes out',
  );
  assert.match(answer(bot, alice).content, /^Disconnected Main/);
});

test('disconnecting your last wallet leaves you unlinked, with no way back from old menus', async (t) => {
  const { bot, registry, main, second } = await fixture(t);
  const list = await walletsCard(bot);
  press(bot, alice, list, `w:del:${second.id}`);
  await settle(bot);
  press(bot, alice, list, `w:delok:${second.id}`, { view: answer(bot, alice).id });
  await settle(bot);
  const one = answer(bot, alice);
  assert.match(one.content, /Your wallet:\n✓ Main \(in use\)/);
  press(bot, alice, list, `w:del:${main.id}`, { view: one.id });
  await settle(bot);
  press(bot, alice, list, `w:delok:${main.id}`, { view: answer(bot, alice).id });
  await settle(bot);
  assert.match(answer(bot, alice).content, /You have no wallets connected\./);
  assert.deepEqual(buttons(answer(bot, alice)), []);
  assert.equal(registry.linked(A), false);
  const count = repliesFor(bot, alice).length;
  press(bot, alice, list, `w:use:${main.id}`);
  await sendDM(bot, alice, '/balance');
  assert.equal(repliesFor(bot, alice).length, count, 'no longer answered at all');
});

test("nobody can reach another person's wallet by naming it", async (t) => {
  const { bot, registry, theirs, db } = await fixture(t);
  const list = await walletsCard(bot);
  // Buttons the card does not offer are dropped without an answer, by anyone.
  const silent = repliesFor(bot, alice).length;
  for (const data of [`w:use:${theirs.id}`, `w:del:${theirs.id}`, `w:delok:${theirs.id}`]) {
    press(bot, alice, list, data);
    await settle(bot);
  }
  assert.equal(repliesFor(bot, alice).length, silent);
  // And Bob cannot press Alice's card, or a stranger either.
  for (const key of [bob, mallory]) {
    press(bot, key, list, `w:del:${registry.lease(A).id}`);
    press(bot, key, list, 'w:list');
    await settle(bot);
  }
  assert.deepEqual(repliesFor(bot, bob), []);
  assert.deepEqual(repliesFor(bot, mallory), []);
  assert.equal(db.connection(theirs.id).status, 'active');
  assert.equal(db.connection(registry.lease(A).id).status, 'active');
  // Even a keyboard somehow offering it could not act: the lookup is in the sender's own list.
  assert.equal(bot.ownWallet(A, theirs.id), undefined);
  assert.equal(bot.disconnectNow(A, `w:delok:${theirs.id}`), undefined);
  assert.equal(db.connection(theirs.id).status, 'active');
});

test('two devices: a stale menu and a repeated press are safe', async (t) => {
  const { bot, main, second, db } = await fixture(t);
  const phone = await walletsCard(bot);
  const laptop = await walletsCard(bot);
  press(bot, alice, phone, `w:del:${main.id}`);
  await settle(bot);
  const ask = answer(bot, alice);
  const confirm = press(bot, alice, phone, `w:delok:${main.id}`, { view: ask.id });
  await settle(bot);
  assert.equal(db.connection(main.id).status, 'revoked');

  // The same request again (a relay or Anagram retrying): the same answer, nothing else.
  const audits = db.audit().length;
  bot.state.outbox = [];
  bot.buttonRequest(confirm);
  await settle(bot);
  assert.match(answer(bot, alice).content, /^Disconnected Main/);
  assert.equal(db.audit().length, audits, 'not revoked twice');

  // The other device still shows the old menu.
  press(bot, alice, laptop, `w:del:${main.id}`);
  await settle(bot);
  assert.match(answer(bot, alice).content, /^That wallet is not connected any more\./);
  assert.match(answer(bot, alice).content, /✓ Second/);
  assert.ok(!buttons(answer(bot, alice)).some((b) => b.callback_data.includes(main.id)));
  press(bot, alice, laptop, `w:use:${second.id}`);
  await settle(bot);
  assert.equal(db.owner(A).active, second.id);
});

test('reconnecting the same wallet keeps old wallet menus dead', async (t) => {
  const { bot, registry, main } = await fixture(t);
  await sendDM(bot, alice, '/balance');
  const old = card(bot, alice);
  const list = await walletsCard(bot);
  press(bot, alice, list, `w:del:${main.id}`);
  await settle(bot);
  press(bot, alice, list, `w:delok:${main.id}`, { view: answer(bot, alice).id });
  await settle(bot);
  const again = registry.connect({
    owner: A,
    label: 'Main',
    origin: ORIGIN,
    secret: { invoiceKey: ALICE_KEY },
  });
  registry.select(A, again.id);
  press(bot, alice, old, 'bal');
  await settle(bot);
  assert.match(answer(bot, alice).content, /no longer linked/);
  assert.deepEqual(buttons(answer(bot, alice)), []);
  press(bot, alice, old, 'w:list');
  await settle(bot);
  assert.match(answer(bot, alice).content, /Your wallets/, 'the Wallets button still helps');
});

test('menus offer the way to your wallets, and help describes it', async (t) => {
  const { bot } = await fixture(t);
  await sendDM(bot, alice, '/help');
  const help = repliesFor(bot, alice).at(-1);
  assert.match(help.content, /\/wallets — /);
  assert.match(help.content, /\/disconnect — /);
  assert.ok(buttons(help).some((b) => b.text === 'Wallets' && b.callback_data === 'w:list'));
  await sendDM(bot, alice, '/disconnect');
  assert.match(repliesFor(bot, alice).at(-1).content, /Your wallets/);
});

test('a long or hostile label cannot break the card', async (t) => {
  const { bot, registry } = await fixture(t);
  registry.connect({
    owner: A,
    label: `[click](https://evil.example) npub1${'q'.repeat(58)} ${'long '.repeat(9)}`.slice(0, 64),
    origin: ORIGIN,
    secret: { invoiceKey: 'd'.repeat(32) },
  });
  const list = await walletsCard(bot);
  assert.ok(!list.content.includes('https://'));
  assert.ok(!list.content.includes('npub1'));
  assert.ok(buttons(list).every((b) => Buffer.byteLength(b.text) <= 128));
});

test('in wallets.json mode links are the operator’s: nothing can be changed from chat', async (t) => {
  const { bot } = setup(t, { wallets: linked() });
  assert.ok(new FileWallets([]).manageable === false);
  if (bot.wallets.manageable !== false) return; // database-mode suite: covered above
  await sendDM(bot, alice, '/wallets');
  assert.match(repliesFor(bot, alice).at(-1).content, /managed by the bot operator/);
  await sendDM(bot, alice, '/disconnect');
  assert.match(repliesFor(bot, alice).at(-1).content, /managed by the bot operator/);
  await sendDM(bot, alice, '/help');
  assert.ok(!/\/wallets/.test(repliesFor(bot, alice).at(-1).content));
});
