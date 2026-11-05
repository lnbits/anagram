// What survives a restart, and what a restart must not repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey } from 'nostr-tools';
import { State } from '../vendor/runtime.js';
import { alice, defer, dm, fakeNet, repliesFor, settle, setup, tempDir } from './helpers.js';

test('a restart keeps the identity, does not answer twice and republishes the same reply', async (t) => {
  const dir = tempDir(t, 'restart');
  const offline = fakeNet();
  offline.fail = true;
  const first = setup(t, { dir, net: offline });
  const pubkey = first.bot.pubkey;
  const message = dm(alice, '/help', first.bot);
  await first.bot.directMessage(message, { tags: [] });
  await settle(first.bot);
  await first.bot.flush();
  // Relays were down: the signed reply is still in the durable outbox.
  const queued = first.bot.state.outbox.map((item) => item.event.id);
  assert.equal(queued.length, 1);
  const linkedAt = first.bot.state.authorized.users[getPublicKey(alice)];
  await first.bot.close();

  const online = fakeNet();
  const second = setup(t, { dir, net: online });
  assert.equal(second.bot.pubkey, pubkey, 'same Nostr identity');
  assert.equal(second.bot.state.authorized.users[getPublicKey(alice)], linkedAt);
  // Relays resend the old message after a restart: it is not answered again.
  await second.bot.directMessage(message, { tags: [] });
  await settle(second.bot);
  assert.equal(repliesFor(second.bot, alice).length, 1);
  // The failed attempt scheduled a retry a few seconds later; let it be due now.
  for (const item of second.bot.state.outbox) item.retryAt = 0;
  await second.bot.flush();
  assert.deepEqual(
    online.sent.map((event) => event.id),
    queued,
    'identical event ids, so clients see one reply',
  );
  assert.equal(second.bot.state.outbox.length, 0);
});

test('a person removed from the wallet file loses their grant; relinking starts later', async (t) => {
  const dir = tempDir(t, 'relink');
  const first = setup(t, { dir });
  assert.ok(first.bot.state.authorized.users[getPublicKey(alice)]);
  await first.bot.close();
  const { Wallets } = await import('../wallets.js');
  const second = setup(t, { dir, wallets: new Wallets([]) });
  assert.deepEqual(second.bot.state.authorized.users, {});
});

test('two processes cannot share a data directory', (t) => {
  const dir = tempDir(t, 'lock');
  const store = new State(dir);
  defer(t, () => store.close());
  assert.throws(() => new State(dir), /Another bot process owns this data directory/);
});
