// SSRF protections: which addresses can be reached for a URL a person typed.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { guardedFetch, guardedLookup, GuardError, Origins, publicOrigin } from '../net-guard.js';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { ALICE_KEY, defer } from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const refused = (reason) => (error) => error instanceof GuardError && error.reason === reason;

test('only a public-looking https origin passes', () => {
  assert.equal(publicOrigin('https://Legend.lnbits.example'), 'https://legend.lnbits.example/');
  assert.equal(publicOrigin('https://l.example:443/prefix/'), 'https://l.example/prefix/');
  const cases = {
    invalid: ['', 'not a url', 'lnbits.example'],
    https: ['http://l.example', 'ftp://l.example', 'file:///etc/passwd', 'gopher://l.example'],
    parts: ['https://user:pw@l.example', 'https://l.example/?a=1', 'https://l.example/#x'],
    port: ['https://l.example:8080', 'https://l.example:22'],
    address: [
      'https://127.0.0.1',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://2130706433', // 127.0.0.1 as one number; URL normalizes it
      'https://0x7f.1',
      'https://8.8.8.8',
    ],
    host: [
      'https://localhost',
      'https://intranet',
      'https://foo.localhost',
      'https://printer.local',
      'https://db.internal',
      'https://nas.lan',
      'https://l.example.',
      'https://1.0.0.127.in-addr.arpa',
    ],
  };
  for (const [reason, urls] of Object.entries(cases))
    for (const url of urls) assert.throws(() => publicOrigin(url), refused(reason), url);
});

const resolving =
  (...addresses) =>
  (host, options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

test('a name resolving to any private address is refused, whatever else it returns', async () => {
  const check = (resolver, options = {}) =>
    new Promise((resolve) =>
      guardedLookup({ resolve: resolver })('x.example', options, (error, address) =>
        resolve(error ?? address),
      ),
    );
  assert.equal(await check(resolving('93.184.216.34')), '93.184.216.34');
  assert.deepEqual(await check(resolving('93.184.216.34'), { all: true }), [
    { address: '93.184.216.34', family: 4 },
  ]);
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ]) {
    assert.ok((await check(resolving(address))) instanceof GuardError, address);
    assert.ok((await check(resolving('93.184.216.34', address))) instanceof GuardError, address);
  }
  assert.ok((await check(resolving())) instanceof GuardError, 'no address at all');
});

test('DNS rebinding finds nothing: the connection uses the checked answer, no second lookup', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"balance":1}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  defer(t, () => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  let lookups = 0;
  // Public the first time, private for anyone asking again.
  const rebinding = (host, options, callback) => {
    lookups++;
    callback(null, [{ address: lookups === 1 ? '127.0.0.1' : '10.0.0.9', family: 4 }]);
  };
  const lookup = guardedLookup({ resolve: rebinding, allowed: (a) => a === '127.0.0.1' });
  const fetch = guardedFetch({ lookup, request: http.request, port });
  const client = new LNbitsClient({ url: 'https://localhost/', timeoutMs: 1000, fetch });
  assert.deepEqual(await client.wallet(ALICE_KEY), { balanceMsat: 1 });
  assert.equal(lookups, 1);
  assert.equal(seen[0], 'localhost', 'the name is what the server sees');
  assert.equal(new URL(client.socketURL(ALICE_KEY)).protocol, 'wss:');
});

test('a refused address reaches nothing and counts as certainly not sent', async () => {
  const client = new LNbitsClient({
    url: 'https://private.example/',
    timeoutMs: 1000,
    fetch: guardedFetch({ lookup: guardedLookup({ resolve: resolving('127.0.0.1') }) }),
  });
  await assert.rejects(
    client.createInvoice(ALICE_KEY, {
      sats: 1,
      memo: '',
      expiry: 60,
      externalId: 'alw-00000000-0000-4000-8000-000000000000',
    }),
    (error) => error instanceof LNbitsError && error.code === 'unavailable' && error.definite,
  );
});

test('redirects are not followed and are an unexpected answer', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  defer(t, () => new Promise((resolve) => server.close(resolve)));
  const fetch = guardedFetch({
    lookup: guardedLookup({ resolve: resolving('127.0.0.1'), allowed: () => true }),
    request: http.request,
    port: server.address().port,
  });
  const client = new LNbitsClient({ url: 'https://localhost/', timeoutMs: 1000, fetch });
  await assert.rejects(client.wallet(ALICE_KEY), (error) => error.code === 'bad_response');
});

test('a slow server times out, and a huge answer is refused', async (t) => {
  let mode = 'hang';
  const server = http.createServer((req, res) => {
    if (mode === 'huge') {
      res.writeHead(200);
      res.end(Buffer.alloc(300 * 1024, 32));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  defer(t, () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const fetch = guardedFetch({
    lookup: guardedLookup({ resolve: resolving('127.0.0.1'), allowed: () => true }),
    request: http.request,
    port: server.address().port,
  });
  const client = new LNbitsClient({ url: 'https://localhost/', timeoutMs: 100, fetch });
  await assert.rejects(client.wallet(ALICE_KEY), (error) => error.code === 'timeout');
  mode = 'huge';
  const patient = new LNbitsClient({ url: 'https://localhost/', timeoutMs: 2000, fetch });
  await assert.rejects(patient.wallet(ALICE_KEY), (error) => error.code === 'bad_response');
});

test('the policy: only LNBITS_URL by default; listed origins; "*" adds public servers', async (t) => {
  const server = await lnbitsServer({});
  defer(t, () => server.close());
  const only = new Origins({ defaultUrl: 'https://main.example' });
  assert.equal(only.check(' https://main.example/ '), 'https://main.example/');
  assert.throws(() => only.check('https://other.example'), refused('not_allowed'));
  assert.throws(() => only.check('not a url'), refused('invalid'));

  const listed = new Origins({
    defaultUrl: 'https://main.example',
    allowHttp: true,
    allowed: `https://second.example, ${server.url}`,
  });
  assert.equal(listed.check('https://second.example'), 'https://second.example/');
  assert.equal(listed.check(server.url), server.url, 'the operator may list a private one');
  assert.throws(() => listed.check('https://third.example'), refused('not_allowed'));

  const open = new Origins({ defaultUrl: 'https://main.example', allowed: '*' });
  assert.equal(open.check('https://any.example/'), 'https://any.example/');
  for (const url of [
    'http://any.example',
    'https://127.0.0.1',
    'https://localhost',
    'https://any.example:8080',
  ])
    assert.throws(() => open.check(url), GuardError, url);
  const client = open.client('https://any.example/');
  assert.equal(open.client('https://any.example/'), client, 'one client per origin');
  assert.equal(typeof client.socketOptions.lookup, 'function', 'sockets go through the guard too');
});
