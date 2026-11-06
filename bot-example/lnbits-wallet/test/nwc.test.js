// NWC connections against a local mock wallet service, over a real local relay.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, nip44, finalizeEvent } from 'nostr-tools';
import { ConnectService } from '../connect.js';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { Origins } from '../net-guard.js';
import { WALLET_TEXT } from '../commands.js';
import { nwcClientFor } from '../bot.js';
import { loadConfig } from '../config.js';
import { NwcClient, NwcError, parseConnection } from '../nwc.js';
import { ConfigurationError } from '../vendor/runtime.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { externalId } from '../invoices.js';
import { alice, bob, defer, dm, repliesFor, sendDM, settle, setup, tempDir } from './helpers.js';
import { relay } from './relay.js';
import { nwcService } from './nwc-server.js';

async function world(t, options) {
  const local = await relay();
  defer(t, () => local.close());
  const wallet = await nwcService(local.url, options);
  defer(t, () => wallet.close());
  const client = new NwcClient({ timeoutMs: 800, trustedRelays: [local.url] });
  return { local, wallet, client };
}

test('connection strings are parsed strictly, and never echoed', () => {
  const key = 'a'.repeat(64);
  const secret = '1'.repeat(64);
  const good = `nostr+walletconnect://${key}?relay=wss%3A%2F%2Frelay.example&secret=${secret}`;
  assert.deepEqual(parseConnection(good), {
    walletPubkey: key,
    clientSecret: secret,
    relays: ['wss://relay.example/'],
  });
  for (const bad of [
    '',
    'hello',
    `nostr+walletauth://${key}?relay=wss%3A%2F%2Fr.example&secret=${secret}`,
    `https://${key}?relay=wss%3A%2F%2Fr.example&secret=${secret}`,
    `nostr+walletconnect://short?relay=wss%3A%2F%2Fr.example&secret=${secret}`,
    `nostr+walletconnect://${key}?relay=wss%3A%2F%2Fr.example&secret=short`,
    `nostr+walletconnect://${key}?relay=wss%3A%2F%2Fr.example`,
  ])
    assert.throws(
      () => parseConnection(bad),
      (error) =>
        error instanceof NwcError && error.code === 'format' && !error.message.includes(secret),
      bad,
    );
  for (const relayUrl of [
    'ws://r.example',
    'wss://127.0.0.1',
    'wss://localhost',
    'wss://10.0.0.1',
    'https://r.example',
  ])
    assert.throws(
      () =>
        parseConnection(
          `nostr+walletconnect://${key}?relay=${encodeURIComponent(relayUrl)}&secret=${secret}`,
        ),
      (error) => error.code === 'relay',
      relayUrl,
    );
  const many = ['a', 'b', 'c', 'd', 'e'].map((x) => `relay=wss%3A%2F%2F${x}.example`).join('&');
  assert.equal(
    parseConnection(`nostr+walletconnect://${key}?${many}&secret=${secret}`).relays.length,
    3,
  );
});

test('the client talks NIP-44 and maps balance, invoices and history', async (t) => {
  const { wallet, client } = await world(t);
  assert.deepEqual(await client.wallet(wallet.secret), { balanceMsat: 5_000_000 });
  const request = wallet.requests.at(-1);
  assert.equal(request.tags.find((x) => x[0] === 'encryption')[1], 'nip44_v2');
  assert.ok(request.tags.some((x) => x[0] === 'expiration'));

  const invoice = await client.createInvoice(wallet.secret, { sats: 21, memo: 'tea', expiry: 600 });
  assert.equal(invoice.amountMsat, 21000);
  assert.deepEqual(wallet.requests.at(-1).params, {
    amount: 21000,
    description: 'tea',
    expiry: 600,
  });
  assert.equal(invoice.status, 'pending');
  const found = await client.findInvoices(wallet.secret, 'ignored', {
    paymentHash: invoice.paymentHash,
  });
  assert.equal(found[0].bolt11, invoice.bolt11);
  assert.deepEqual(
    await client.findInvoices(wallet.secret, 'ignored', {}),
    [],
    'no hash, no search',
  );
  assert.deepEqual(
    await client.findInvoices(wallet.secret, 'x', { paymentHash: 'ab'.repeat(32) }),
    [],
  );

  wallet.settle(7, 'coffee');
  wallet.transactions.unshift({ ...wallet.settle(9, 'sent'), type: 'outgoing', fees_paid: 2000 });
  wallet.transactions.splice(1, 1);
  const rows = await client.payments(wallet.secret, 10);
  assert.deepEqual(
    rows.map((r) => r.amountMsat),
    [-9000, 7000],
  );
  assert.equal(rows[0].feeMsat, 2000);
  const incoming = await client.incoming(wallet.secret);
  assert.deepEqual(
    incoming.payments.map((p) => p.memo),
    ['coffee'],
  );
  assert.equal(incoming.rows, 1);
  assert.ok(incoming.payments[0].settledAt > 1e12, 'milliseconds, like LNbits');
});

test('only a signed answer from the wallet, for this request, counts', async (t) => {
  const { wallet, client } = await world(t);
  const stranger = generateSecretKey();
  const clientPub = getPublicKey(Buffer.from(wallet.clientSecret, 'hex'));
  // A relay or stranger answers first with a huge balance: it must be ignored.
  const key = nip44.v2.utils.getConversationKey(stranger, clientPub);
  const local = wallet.relayUrl;
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(local);
  await new Promise((r) => socket.once('open', r));
  defer(t, () => socket.terminate());
  wallet.forge = (request, method) => {
    const event = finalizeEvent(
      {
        kind: 23195,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', clientPub],
          ['e', request.id],
        ],
        content: nip44.v2.encrypt(
          JSON.stringify({
            result_type: method,
            result: { balance: 999_000, methods: [] },
            error: null,
          }),
          key,
        ),
      },
      stranger,
    );
    socket.send(JSON.stringify(['EVENT', event]));
  };
  assert.deepEqual(await client.wallet(wallet.secret), { balanceMsat: 5_000_000 });
});

test('answers about another request or method are ignored; silence is a timeout', async (t) => {
  const { wallet, client } = await world(t);
  wallet.forge = (request) => {
    wallet.answer(
      { ...request, id: 'f'.repeat(64) },
      { result_type: 'get_balance', result: { balance: 1 }, error: null },
    );
    wallet.answer(
      request,
      { result_type: 'get_info', result: { balance: 2 }, error: null },
      { type: 'make_invoice' },
    );
  };
  wallet.errors = {};
  assert.deepEqual((await client.request(wallet.secret, 'get_balance')).balance, 5_000_000);
  wallet.forge = null;
  wallet.mode = 'silent';
  await assert.rejects(
    client.request(wallet.secret, 'get_balance'),
    (error) => error instanceof LNbitsError && error.code === 'timeout' && !error.definite,
  );
});

test('wallet errors and unreachable relays map to the same failures as LNbits', async (t) => {
  const { wallet, client } = await world(t);
  for (const [code, expected] of [
    ['UNAUTHORIZED', 'rejected'],
    ['RESTRICTED', 'rejected'],
    ['NOT_IMPLEMENTED', 'refused'],
    ['QUOTA_EXCEEDED', 'refused'],
    ['RATE_LIMITED', 'busy'],
    ['INTERNAL', 'unavailable'],
    ['OTHER', 'unavailable'],
  ]) {
    wallet.errors = { get_balance: code };
    await assert.rejects(
      client.request(wallet.secret, 'get_balance'),
      (error) => error.code === expected,
      code,
    );
  }
  wallet.errors = {};
  await assert.rejects(
    client.request({ ...wallet.secret, relays: ['ws://127.0.0.1:9/'] }, 'get_balance'),
    (error) => error.code === 'unavailable' && error.definite,
  );
  const aborted = new AbortController();
  wallet.mode = 'silent';
  const pending = client.request(wallet.secret, 'get_balance', {}, { signal: aborted.signal });
  setTimeout(() => aborted.abort(), 50);
  await assert.rejects(pending, (error) => error.code === 'unavailable');
});

test('malformed answers are refused; an invoice for another amount is never shown', async (t) => {
  const { wallet, client } = await world(t);
  wallet.mode = 'wrong-amount';
  await assert.rejects(
    client.createInvoice(wallet.secret, { sats: 5, memo: '', expiry: 60 }),
    (error) => error.code === 'mismatch',
  );
  wallet.mode = 'ok';
  wallet.balance = -1;
  await assert.rejects(client.wallet(wallet.secret), (error) => error.code === 'bad_response');
  wallet.transactions = [{ type: 'incoming', state: 'settled', amount: 'lots', payment_hash: 'x' }];
  const read = await client.incoming(wallet.secret);
  assert.equal(read.malformed, 1, 'skipped and counted');
  await assert.rejects(client.payments(wallet.secret, 5), (error) => error.code === 'bad_response');
});

test('inspection refuses spending, missing methods and missing encryption', async (t) => {
  const { wallet, client } = await world(t);
  assert.equal((await client.inspect(wallet.secret)).alias, 'Test wallet');
  const base = [...wallet.methods];
  for (const extra of [
    'pay_invoice',
    'multi_pay_invoice',
    'pay_keysend',
    'multi_pay_keysend',
    'sign_message',
    'create_connection',
  ]) {
    wallet.methods = [...base, extra];
    await assert.rejects(client.inspect(wallet.secret), (e) => e.code === 'spending', extra);
  }
  // A wallet need not offer everything, but has to be good for something.
  wallet.methods = ['get_info', 'make_invoice'];
  assert.deepEqual((await client.inspect(wallet.secret)).methods, ['get_info', 'make_invoice']);
  wallet.methods = ['get_info', 'lookup_invoice'];
  await assert.rejects(client.inspect(wallet.secret), (e) => e.code === 'methods');

  const local = await relay();
  defer(t, () => local.close());
  const old = await nwcService(local.url, { encryption: 'nip04' });
  defer(t, () => old.close());
  const strict = new NwcClient({ timeoutMs: 500, trustedRelays: [local.url] });
  await assert.rejects(strict.inspect(old.secret), (e) => e.code === 'encryption');
  const none = await nwcService(local.url, { info: false });
  defer(t, () => none.close());
  await assert.rejects(strict.inspect(none.secret), (e) => e.code === 'unavailable');
});

test('a connection that gains spending power later is switched off', async (t) => {
  const { wallet, client } = await world(t);
  assert.deepEqual(await client.wallet(wallet.secret), { balanceMsat: 5_000_000 });
  const fresh = new NwcClient({ timeoutMs: 800, trustedRelays: [wallet.relayUrl] });
  wallet.methods = [...wallet.methods, 'pay_invoice'];
  await assert.rejects(fresh.wallet(wallet.secret), (error) => error.code === 'admin_key');
});

test('relays the operator did not list go through the address guard', async (t) => {
  const { wallet } = await world(t);
  const lookup = () => {};
  const seen = [];
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    seen.push(Array.isArray(args[0]) ? args[0][0] : args[0]);
    return connect.apply(this, args);
  };
  t.after(() => (net.Socket.prototype.connect = connect));
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [], lookup });
  await assert.rejects(
    client.request({ ...wallet.secret, relays: ['wss://relay.example/'] }, 'get_balance'),
    (error) => error.code === 'unavailable',
  );
  assert.equal(seen.at(-1).host, 'relay.example');
  assert.equal(seen.at(-1).lookup, lookup);
});

test('no relay on this computer is reachable unless it is listed, localhost included', async (t) => {
  const { wallet, local } = await world(t);
  const here = new URL(local.url);
  const others = [
    local.url,
    `ws://localhost:${here.port}/`,
    `wss://localhost:${here.port}/`,
    `wss://127.0.0.1:${here.port}/`,
    `ws://[::1]:${here.port}/`,
    `ws://127.0.0.2:${here.port}/`,
    'ws://192.168.1.1:7791/',
    'ws://relay.local:7791/',
  ];
  const connection = (relay) =>
    `nostr+walletconnect://${wallet.walletPubkey}?relay=${encodeURIComponent(relay)}&secret=${wallet.clientSecret}`;
  for (const relay of others) {
    assert.throws(
      () => parseConnection(connection(relay)),
      (e) => e.code === 'relay',
      relay,
    );
    const seen = local.connections.length;
    await assert.rejects(
      new NwcClient({ timeoutMs: 300 }).request(
        { ...wallet.secret, relays: [relay] },
        'get_balance',
      ),
      (error) => error.code === 'unavailable',
    );
    assert.equal(local.connections.length, seen, `${relay} was not even connected to`);
  }
  // Listed: exactly that address, and no other port or name for it.
  const trustedRelays = [local.url];
  assert.deepEqual(parseConnection(connection(local.url), { trustedRelays }).relays, [local.url]);
  for (const relay of others.slice(1))
    assert.throws(
      () => parseConnection(connection(relay), { trustedRelays }),
      (e) => e.code === 'relay',
    );
  assert.throws(
    () =>
      parseConnection(connection(`ws://127.0.0.1:${Number(here.port) + 1}/`), { trustedRelays }),
    (e) => e.code === 'relay',
  );
  const listed = new NwcClient({ timeoutMs: 800, trustedRelays });
  assert.ok(await listed.request(wallet.secret, 'get_balance'));
  // Stored while listed, and no longer listed: refused, and for a payment nothing was sent.
  const unlisted = new NwcClient({ timeoutMs: 300 });
  const seen = local.connections.length;
  await assert.rejects(
    unlisted.pay({ ...wallet.secret, scope: 'spend' }, 'lnbc1'),
    (error) => error.code === 'unavailable' && error.definite === true,
  );
  assert.equal(local.connections.length, seen);
});

test('the test relay list is off unless set, and accepts nothing but this computer by number', () => {
  const env = { LNBITS_URL: 'https://l.example', NWC_ENABLED: 'true' };
  assert.deepEqual(loadConfig(env).connect.nwcTestRelays, []);
  assert.deepEqual(loadConfig({ LNBITS_URL: 'https://l.example' }).connect.nwcTestRelays, []);
  const page = { CONNECT_PUBLIC_URL: 'http://127.0.0.1:8787' };
  const relays = (NWC_LOCAL_TEST_RELAYS, extra = {}) =>
    loadConfig({ ...env, ...page, NWC_LOCAL_TEST_RELAYS, ...extra }).connect.nwcTestRelays;
  assert.deepEqual(relays('ws://127.0.0.1:7791'), ['ws://127.0.0.1:7791/']);
  assert.deepEqual(relays(' ws://127.0.0.1:7791/ , ws://[::1]:7792 '), [
    'ws://127.0.0.1:7791/',
    'ws://[::1]:7792/',
  ]);
  for (const bad of [
    '*',
    'localhost',
    'ws://localhost:7791',
    'wss://relay.damus.io',
    'ws://192.168.1.10:7791',
    'ws://10.0.0.1:7791',
    'ws://[fe80::1]:7791',
    'ws://[::ffff:7f00:1]:7791',
    'ws://127.0.0.1.evil.example:7791',
    'ws://127.0.0.1:7791@evil.example',
    'ws://user:pass@127.0.0.1:7791',
    'ws://127.0.0.1:7791/?x=1',
    'ws://127.0.0.1:7791/#x',
    'http://127.0.0.1:7791',
    'ws://127.0.0.1:1,ws://127.0.0.1:2,ws://127.0.0.1:3,ws://127.0.0.1:4',
  ])
    assert.throws(() => relays(bad), ConfigurationError, bad);
  // Never by accident in a real deployment.
  const listed = { NWC_LOCAL_TEST_RELAYS: 'ws://127.0.0.1:7791' };
  assert.throws(
    () => loadConfig({ LNBITS_URL: 'https://l.example', ...page, ...listed }),
    /needs NWC_ENABLED/,
  );
  for (const CONNECT_PUBLIC_URL of [
    'https://connect.example',
    'http://127.0.0.1.evil.example',
    'http://127.0.0.1:80@evil.example',
    'not a url',
    '',
  ])
    assert.throws(() => loadConfig({ ...env, ...listed, CONNECT_PUBLIC_URL }), /on this computer/);
  const local = loadConfig({ ...env, ...listed, CONNECT_PUBLIC_URL: 'http://127.0.0.1:8787' });
  // The bot's own client gets the list, and nothing else does.
  assert.deepEqual([...nwcClientFor(local).trusted], ['ws://127.0.0.1:7791/']);
  assert.deepEqual([...nwcClientFor(loadConfig(env)).trusted], []);
});

// ---- Through the bot ---------------------------------------------------------------------

async function botWorld(t, { nwcEnabled = true, sending = false } = {}) {
  const base = await world(t);
  const root = tempDir(t, 'nwc');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const registry = new Registry({
    store: db,
    keyring,
    ledger,
    clientFor: () => base.client,
  });
  const lnbits = new LNbitsClient({ url: 'https://lnbits.test/', timeoutMs: 300 });
  const origins = new Origins({ defaultUrl: 'https://lnbits.test/', defaultClient: lnbits });
  let bot;
  const service = new ConnectService({
    publicUrl: 'https://connect.test',
    port: 0,
    origins,
    nwc: nwcEnabled ? base.client : undefined,
    registry,
    sending,
    sendCode: (owner, details) => bot.sendConnectCode(owner, details),
    finished: (owner, connection) => bot.connectFinished(owner, connection),
  });
  const ctx = setup(t, {
    wallets: registry,
    lnbits,
    connect: service,
    ...(sending ? { send: {} } : {}),
    checkDelays: [0.02],
    notifications: { periodicMs: 40, triggerDelayMs: 5, recheckMs: 10 },
  });
  bot = ctx.bot;
  bot.flush = async () => {};
  const port = await service.listen();
  defer(t, () => service.close());
  defer(t, () => db.close());
  const call = (path, { body = {}, cookie, csrf } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            host: 'connect.test',
            origin: 'https://connect.test',
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text), text }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const page = async (owner) => {
    const token = new URL(service.issue(owner)).hash.slice(1);
    const opened = await call('/c/session', { body: { token } });
    const cookie = opened.headers['set-cookie'][0].split(';')[0];
    return {
      opened,
      send: (path, body) => call(path, { body, cookie, csrf: opened.data.csrf }),
    };
  };
  const lastCode = (key) => {
    const text = repliesFor(bot, key)
      .filter((r) => /Your code/.test(r.content))
      .at(-1)?.content;
    return /: ([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(text ?? '')?.[1];
  };
  return { ...base, registry, db, bot, page, lastCode, ...ctx, root };
}
const A = getPublicKey(alice);

test('NWC through the page, then balance, invoices, status and notifications', async (t) => {
  const { wallet, bot, page, lastCode, registry, db } = await botWorld(t);
  const browser = await page(A);
  assert.deepEqual(
    browser.opened.data.kinds.map((k) => k.id),
    ['lnbits', 'nwc'],
  );
  const form = await browser.send('/c/nwc', { connection: wallet.uri });
  assert.equal(form.status, 200, form.text);
  assert.equal(form.data.name, 'Test wallet');
  assert.equal(db.all().length, 0, 'nothing stored before the code');
  await settle(bot);
  assert.equal((await browser.send('/c/code', { code: lastCode(alice) })).status, 200);
  assert.equal(db.active()[0].kind, 'nwc');
  assert.ok(!Buffer.from(db.active()[0].secret).toString('latin1').includes(wallet.clientSecret));
  assert.equal(registry.lease(A).key.walletPubkey, wallet.walletPubkey);

  await sendDM(bot, alice, '/balance');
  assert.match(repliesFor(bot, alice).at(-1).content, /Balance \(Test wallet\): 5,000 sats/);
  await sendDM(bot, alice, '/invoice 21 tea');
  assert.match(repliesFor(bot, alice).at(-1).content, /^Invoice for 21 sats/);
  const record = bot.state.invoices.at(-1);
  assert.equal(record.state, 'created');
  assert.ok(externalId(record));
  await sendDM(bot, alice, '/history');
  assert.match(repliesFor(bot, alice).at(-1).content, /No settled payments/);

  await bot.start();
  for (let i = 0; i < 200 && !bot.state.payments[registry.lease(A).ref]; i++)
    await new Promise((r) => setTimeout(r, 10));
  wallet.settle(9, 'hello nwc');
  for (let i = 0; i < 200 && !repliesFor(bot, alice).some((r) => /hello nwc/.test(r.content)); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.match(repliesFor(bot, alice).at(-1).content, /Received \(Test wallet\): \+9 sats/);
});

test('the page refuses connections that can spend, and never keeps them', async (t) => {
  const { wallet, page, db, bot, lastCode } = await botWorld(t);
  const browser = await page(A);
  wallet.methods = [...wallet.methods, 'pay_invoice'];
  const answer = await browser.send('/c/nwc', { connection: wallet.uri });
  assert.equal(answer.status, 400);
  assert.match(answer.data.message, /more than receive/);
  assert.ok(!answer.text.includes(wallet.clientSecret));
  await settle(bot);
  assert.equal(lastCode(alice), undefined);
  assert.equal(db.all().length, 0);
  assert.match(
    (await browser.send('/c/nwc', { connection: 'nonsense' })).data.message,
    /connection string/,
  );
});

test('with NWC off the option is not offered and the route refuses', async (t) => {
  const { wallet, page } = await botWorld(t, { nwcEnabled: false });
  const browser = await page(A);
  assert.deepEqual(
    browser.opened.data.kinds.map((k) => k.id),
    ['lnbits'],
  );
  assert.equal((await browser.send('/c/nwc', { connection: wallet.uri })).status, 404);
});

test('one NWC connection can belong to one person; a lost invoice answer is not retried', async (t) => {
  const { wallet, page, bot, lastCode, registry } = await botWorld(t);
  const first = await page(A);
  await first.send('/c/nwc', { connection: wallet.uri });
  await settle(bot);
  await first.send('/c/code', { code: lastCode(alice) });
  const second = await page(getPublicKey(bob));
  assert.match(
    (await second.send('/c/nwc', { connection: wallet.uri })).data.message,
    /already connected/,
  );

  await sendDM(bot, alice, '/balance');
  wallet.mode = 'silent';
  const before = wallet.requests.filter((r) => r.method === 'make_invoice').length;
  await bot.directMessage(dm(alice, '/invoice 5', bot), { tags: [] });
  for (let i = 0; i < 300 && bot.state.invoices.at(-1)?.state !== 'failed'; i++)
    await new Promise((r) => setTimeout(r, 10));
  await settle(bot);
  assert.equal(bot.state.invoices.at(-1).state, 'failed');
  assert.equal(
    wallet.requests.filter((r) => r.method === 'make_invoice').length,
    before + 1,
    'once',
  );
  assert.match(repliesFor(bot, alice).at(-1).content, /did not confirm your invoice/);
  assert.ok(registry.linked(A));

  wallet.mode = 'ok';
  await sendDM(bot, alice, '/invoice 5');
  assert.match(
    repliesFor(bot, alice).at(-1).content,
    /^Invoice for 5 sats/,
    'not blocked afterwards',
  );
});

test('disconnecting an NWC wallet stops it at once and it never reconnects by itself', async (t) => {
  const { wallet, page, bot, lastCode, registry, db } = await botWorld(t);
  const browser = await page(A);
  await browser.send('/c/nwc', { connection: wallet.uri });
  await settle(bot);
  await browser.send('/c/code', { code: lastCode(alice) });
  const lease = registry.lease(A);
  registry.revoke(lease.id, 'user');
  assert.equal(lease.valid(), false);
  assert.equal(db.connection(lease.id).secret, null);
  await sendDM(bot, alice, '/balance');
  assert.equal(registry.linked(A), false);
});

test('connecting to spend: named as such, permissions shown, acknowledged, and stored sealed', async (t) => {
  const { wallet, page, bot, lastCode, registry, db, root } = await botWorld(t, { sending: true });
  wallet.methods = ['get_info', 'pay_invoice', 'lookup_invoice', 'get_budget', 'get_balance'];
  wallet.budget = { total_budget: 5_000_000, used_budget: 1_000_000 };
  const browser = await page(A);
  const kinds = browser.opened.data.kinds;
  assert.deepEqual(
    kinds.map((k) => k.label),
    [
      'LNbits wallet (receive only)',
      'Nostr Wallet Connect, receive only',
      'Nostr Wallet Connect, can send payments',
    ],
  );
  // The acknowledgement is the server's to enforce, not just the page's.
  const refused = await browser.send('/c/nwc', { connection: wallet.uri, spend: true });
  assert.equal(refused.status, 400);
  assert.match(refused.data.message, /understand this connection can spend/);
  await settle(bot);
  assert.equal(lastCode(alice), undefined, 'not even a code');

  const answer = await browser.send('/c/nwc', {
    connection: wallet.uri,
    spend: true,
    acknowledged: true,
    label: 'Pocket',
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.data.permissions, [
    'Read basic details of the wallet connection',
    'Pay Lightning invoices, after you confirm each one in your chat',
    'Check the status of an invoice or payment',
    'Read the spending limit set in your wallet',
    'Read your balance',
  ]);
  assert.match(answer.data.limit, /5,000 sats, of which 1,000 sats is used/);
  assert.ok(!answer.text.includes(wallet.clientSecret));
  await settle(bot);
  assert.match(repliesFor(bot, alice).at(-1).content, /Nostr Wallet Connect, can send payments/);
  assert.equal(db.all().length, 0, 'nothing is stored before the code');

  assert.equal((await browser.send('/c/code', { code: lastCode(alice) })).status, 200);
  await settle(bot);
  assert.match(repliesFor(bot, alice).at(-1).content, /CAN SEND PAYMENTS/);
  const lease = registry.lease(A);
  assert.equal(lease.spends, true);
  assert.deepEqual(lease.key.methods, wallet.methods);
  const raw = readFileSync(join(root, DB_FILE)).toString('latin1');
  assert.ok(!raw.includes(wallet.clientSecret), 'sealed');
  assert.ok(!raw.includes('pay_invoice'), 'what it can do is sealed with it');
  const logged = JSON.stringify(bot.state);
  assert.ok(!logged.includes(wallet.clientSecret));

  await sendDM(bot, alice, '/wallets');
  assert.match(repliesFor(bot, alice).at(-1).content, /Pocket \[can spend\]/);
});

test('connecting to receive shows permissions too, and never offers a limit', async (t) => {
  const { wallet, page } = await botWorld(t, { sending: true });
  const browser = await page(A);
  const answer = await browser.send('/c/nwc', { connection: wallet.uri });
  assert.equal(answer.status, 200);
  assert.ok(answer.data.permissions.includes('Create invoices to receive'));
  assert.ok(!answer.data.permissions.some((p) => /Pay/.test(p)));
  assert.equal(answer.data.limit, undefined);
});

test('a spending connection is refused when sending is off, or it cannot be looked up', async (t) => {
  const off = await botWorld(t);
  const browser = await off.page(A);
  off.wallet.methods = [...off.wallet.methods, 'pay_invoice', 'get_budget'];
  off.wallet.budget = { total_budget: 1000 };
  const refused = await browser.send('/c/nwc', {
    connection: off.wallet.uri,
    spend: true,
    acknowledged: true,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.data.message, /more than receive/);

  const on = await botWorld(t, { sending: true });
  on.wallet.methods = ['get_info', 'pay_invoice', 'get_budget'];
  on.wallet.budget = { total_budget: 1000 };
  const second = await on.page(A);
  const lacking = await second.send('/c/nwc', {
    connection: on.wallet.uri,
    spend: true,
    acknowledged: true,
  });
  assert.equal(lacking.status, 400);
  assert.match(lacking.data.message, /cannot do everything/);
});

test('leaving an NWC wallet says to delete the connection in the wallet too', () => {
  assert.match(WALLET_TEXT.disconnected({ kind: 'nwc', label: 'x' }), /delete this connection/);
  assert.match(WALLET_TEXT.disconnected({ kind: 'lnbits', label: 'x' }), /invoice key in LNbits/);
});
