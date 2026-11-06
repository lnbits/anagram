// Spending and NWC ship switched off: nothing in the files people copy can turn them on, and only
// an exact setting does.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { ALICE_KEY } from './helpers.js';
import { LONG, world } from './live-bot.js';

const shipped = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const base = { LNBITS_URL: 'https://l.example' };

test('the files people copy leave NWC and sending off', () => {
  for (const name of ['.env.example', 'lnbits-wallet.service', 'wallets.example.json']) {
    const active = shipped(name)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    assert.deepEqual(
      active.filter((line) => /NWC_|SEND_/.test(line)),
      [],
      name,
    );
  }
  const example = Object.fromEntries(
    shipped('.env.example')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const config = loadConfig(example);
  assert.equal(config.send, undefined);
  assert.equal(config.connect.nwc, false);
  assert.deepEqual(config.connect.nwcTestRelays, []);
});

test('only an exact setting turns them on; anything else off or refused', () => {
  for (const off of [undefined, '', ' ', 'false', 'FALSE', '0', 'no']) {
    const config = loadConfig({ ...base, NWC_ENABLED: off, SEND_ENABLED: off });
    assert.equal(config.send, undefined, String(off));
    assert.equal(config.connect.nwc, false, String(off));
  }
  for (const unclear of ['on', 'enabled', 'y', '2', 'maybe']) {
    assert.throws(() => loadConfig({ ...base, NWC_ENABLED: unclear }), /must be true or false/);
    assert.throws(() => loadConfig({ ...base, SEND_ENABLED: unclear }), /must be true or false/);
  }
});

test(
  'a real bot with the release settings offers neither, whatever it is asked',
  LONG,
  async (t) => {
    const w = await world(t, {
      env: {
        NWC_ENABLED: undefined,
        SEND_ENABLED: undefined,
        NWC_LOCAL_TEST_RELAYS: undefined,
      },
      lnbitsWallets: { [ALICE_KEY]: { name: 'Synthetic', balance: 21000000, payments: [] } },
    });
    assert.doesNotMatch(w.output(), /TEST ONLY/);
    const a = w.person();
    const browser = await w.page(a);
    assert.deepEqual(
      browser.kinds.map((kind) => kind.id),
      ['lnbits'],
      'the page offers LNbits only',
    );
    const wallet = await w.wallet();
    const refused = await w.submit(browser, {
      connection: wallet.uri,
      spend: true,
      acknowledged: true,
    });
    assert.notEqual(refused.status, 200);
    assert.match(w.admin('connections', 'list').stdout, /No connections/);

    await w.connectLnbits(a, ALICE_KEY, 'Savings');
    a.say('/send lnbc1');
    await a.next(/Sending is not available/, 'the refusal');
    a.say('/payments');
    await a.next(/Sending is not available/, 'the refusal');
    a.say('/menu');
    const menu = await a.next(/./, 'the menu');
    assert.doesNotMatch(JSON.stringify(menu.tags), /Send|Payments|s:ask|pm:0/);
    assert.deepEqual(wallet.run('status').payRequests, 0);
  },
);
