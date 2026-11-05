// The test harness itself: no network beyond loopback, and safe temporary directories.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { lookup } from 'node:dns';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { Network, now } from '../vendor/runtime.js';
import { PREFIX, removeOwned, tempDir } from './tmp.js';
import { relay } from './relay.js';

test('the network guard is active in every test process', () => {
  assert.equal(globalThis.__anagramNoNetwork, true);
});

test('public hosts are refused for fetch, DNS and relay sockets; loopback works', async (t) => {
  const refused = (e) => /no-network/.test(e.cause?.message ?? e.message);
  await assert.rejects(fetch('https://relay.damus.io/'), refused);
  await assert.rejects(fetch('https://1.1.1.1/'), refused);
  const error = await new Promise((resolve) => lookup('nos.lol', resolve));
  assert.match(error.message, /no-network/);
  // The bot's default relays: a query returns nothing because no socket can open.
  const net = new Network(['wss://relay.damus.io', 'wss://nos.lol']);
  assert.deepEqual(await net.query([], { kinds: [0], limit: 1 }), []);
  net.close();

  const local = await relay();
  const loopback = new Network([local.url]);
  t.after(async () => {
    loopback.close();
    await local.close();
  });
  await loopback.publish(
    finalizeEvent({ kind: 1, tags: [], content: 'x', created_at: now() }, generateSecretKey()),
    [],
  );
  assert.equal(local.events.size, 1);
});

test('temporary directories live in the OS temp directory and cleanup refuses foreign paths', (t) => {
  const dir = tempDir(t, 'isolation');
  assert.equal(dirname(dir), realpathSync(tmpdir()));
  assert.ok(basename(dir).startsWith(PREFIX));

  // Right prefix, but not created through tempDir(): never removed by the harness.
  const foreign = mkdtempSync(join(realpathSync(tmpdir()), `${PREFIX}foreign-`));
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  try {
    assert.throws(() => removeOwned(foreign), /Refusing to remove/);
    assert.ok(existsSync(foreign));
    assert.throws(() => removeOwned(link), /Refusing to remove/);
    assert.ok(existsSync(dir), 'the link target is untouched');
  } finally {
    // Exactly the two entries this test made: an empty directory and a symlink (not followed).
    rmdirSync(foreign);
    unlinkSync(link);
  }
});
