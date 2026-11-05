// Configuration and the operator's wallet file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { lnbitsURL, loadConfig } from '../config.js';
import { loadWallets, Wallets } from '../wallets.js';
import { ConfigurationError } from '../vendor/runtime.js';
import { ALICE_KEY, BOB_KEY, alice, bob, npub, tempDir } from './helpers.js';

test('LNBITS_URL must be HTTPS without credentials unless local HTTP is allowed', () => {
  assert.equal(lnbitsURL('https://lnbits.example'), 'https://lnbits.example/');
  assert.equal(lnbitsURL('https://example.org/lnbits//'), 'https://example.org/lnbits/');
  assert.equal(lnbitsURL('http://127.0.0.1:5000', true), 'http://127.0.0.1:5000/');
  for (const [value, message] of [
    ['', /LNBITS_URL is required/],
    ['not a url', /valid URL/],
    ['http://127.0.0.1:5000', /must use HTTPS/],
    ['https://user:pass@lnbits.example', /credentials/],
    ['https://lnbits.example/?api-key=x', /query/],
  ])
    assert.throws(
      () => lnbitsURL(value),
      (error) => error instanceof ConfigurationError && message.test(error.message),
    );
});

test('limits and booleans are validated', () => {
  const base = { LNBITS_URL: 'https://lnbits.example' };
  const config = loadConfig(base);
  assert.equal(config.lnbits.timeoutMs, 10000);
  assert.equal(config.limits.historyDefault, 5);
  for (const env of [
    { LNBITS_TIMEOUT_SECONDS: '0' },
    { LNBITS_TIMEOUT_SECONDS: '1e2' },
    { HISTORY_DEFAULT: '21' },
    { MAX_REQUESTS_PER_HOUR: '-1' },
    { LNBITS_ALLOW_HTTP: 'maybe' },
  ])
    assert.throws(() => loadConfig({ ...base, ...env }), ConfigurationError);
});

test('the wallet map links one identity to one wallet and hides keys', () => {
  const wallets = new Wallets([
    [npub(alice), { label: 'Alice', invoiceKey: ALICE_KEY }],
    [getPublicKey(bob), { invoiceKey: BOB_KEY }],
  ]);
  assert.equal(wallets.keyFor(getPublicKey(alice)), ALICE_KEY);
  assert.equal(wallets.keyFor(getPublicKey(bob)), BOB_KEY);
  assert.equal(wallets.label(getPublicKey(bob)), '');
  const shown = `${JSON.stringify(wallets)} ${JSON.stringify(Object.entries(wallets))} ${String(wallets)}`;
  assert.ok(!shown.includes(ALICE_KEY) && !shown.includes(BOB_KEY));
  wallets.disable(getPublicKey(bob), 'admin key');
  assert.equal(wallets.has(getPublicKey(bob)), false);
  assert.equal(wallets.keyFor(getPublicKey(bob)), undefined);
  for (const [entries, message] of [
    [[['npub1bad', { invoiceKey: ALICE_KEY }]], /npub or hex/],
    [[[npub(alice), { invoiceKey: 'short' }]], /invoiceKey/],
    [[[npub(alice), { invoiceKey: ALICE_KEY.toUpperCase() }]], /invoiceKey/],
    [
      [
        [npub(alice), { invoiceKey: ALICE_KEY }],
        [getPublicKey(alice), { invoiceKey: BOB_KEY }],
      ],
      /repeats an identity/,
    ],
    [
      [
        [npub(alice), { invoiceKey: ALICE_KEY }],
        [npub(bob), { invoiceKey: ALICE_KEY }],
      ],
      /reuses another entry's key/,
    ],
  ])
    assert.throws(
      () => new Wallets(entries),
      (error) => message.test(error.message) && !error.message.includes(ALICE_KEY),
    );
});

test('the wallet file must exist, be private and be valid JSON; errors never echo it', (t) => {
  const dir = tempDir(t, 'wallet-file');
  const file = `${dir}/wallets.json`;
  assert.throws(() => loadWallets(''), /WALLETS_FILE is required/);
  assert.throws(() => loadWallets(file), /does not exist/);
  writeFileSync(file, JSON.stringify({ [npub(alice)]: { invoiceKey: ALICE_KEY } }));
  chmodSync(file, 0o644);
  assert.throws(() => loadWallets(file), /chmod 600/);
  chmodSync(file, 0o600);
  assert.equal(loadWallets(file).size, 1);
  writeFileSync(file, `{"${npub(alice)}": {"invoiceKey": "${ALICE_KEY}"`);
  assert.throws(
    () => loadWallets(file),
    (error) => /not valid JSON/.test(error.message) && !error.message.includes(ALICE_KEY),
  );
  writeFileSync(file, '[]');
  assert.throws(() => loadWallets(file), /JSON object keyed by npub/);
  writeFileSync(file, JSON.stringify({ [npub(alice)]: ALICE_KEY }));
  assert.throws(
    () => loadWallets(file),
    (error) => /must be an object/.test(error.message) && !error.message.includes(ALICE_KEY),
  );
});
