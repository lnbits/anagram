import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DEFAULT_PRICE_URL,
  defaultCurrency,
  httpGet,
  MAX_PRICE_AGE_SECONDS,
  parseCacheSeconds,
  parsePrices,
  PriceFeed,
  priceURL,
} from '../price.js';
import { priceReply } from '../commands.js';
import { ConfigurationError } from '../runtime.js';

const GOOD = '{"time":1700000000,"USD":67123,"EUR":58234,"JPY":10123456}';

// A feed with a fake clock and a fake provider. Nothing here touches the network.
function setup(responses, options = {}) {
  const state = { time: 1_000_000, calls: 0, logs: [] };
  const queue = [...responses];
  const feed = new PriceFeed({
    now: () => state.time,
    log: (line) => state.logs.push(line),
    fetchText: async (url) => {
      state.calls++;
      state.url = url;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
    ...options,
  });
  return { feed, state };
}

test('valid responses become a currency map and ignore non-currency fields', () => {
  const prices = parsePrices(GOOD);
  assert.deepEqual(
    [...prices],
    [
      ['USD', 67123],
      ['EUR', 58234],
      ['JPY', 10123456],
    ],
  );
});

test('invalid or nonsensical responses are rejected', () => {
  for (const bad of [
    'not json',
    'null',
    '[]',
    '"USD"',
    '{}',
    '{"time":1}',
    '{"usd":67123}',
    '{"USD":0}',
    '{"USD":-5}',
    '{"USD":"67123"}',
    '{"USD":null}',
    '{"USD":1e12}',
    '{"USD":1e999}',
    '{"USD":67123,"EUR":-1}', // One bad price rejects the whole response.
  ])
    assert.throws(() => parsePrices(bad), undefined, bad);
});

test('the provider receives exactly the configured URL', async () => {
  const { feed, state } = setup([GOOD]);
  await feed.get();
  assert.equal(state.url, DEFAULT_PRICE_URL);
  assert.equal(DEFAULT_PRICE_URL, 'https://mempool.space/api/v1/prices');
});

test('successful prices are cached for 60 seconds', async () => {
  const { feed, state } = setup([GOOD]);
  const first = await feed.get();
  assert.equal(first.stale, false);
  assert.equal(first.prices.get('USD'), 67123);
  state.time += 59_000;
  const second = await feed.get();
  assert.equal(state.calls, 1);
  assert.equal(second.ageSeconds, 59);
  assert.equal(second.stale, false);
  state.time += 2_000;
  await feed.get();
  assert.equal(state.calls, 2);
});

test('PRICE_CACHE_SECONDS controls the cache and zero disables it', async () => {
  const short = setup([GOOD], { cacheSeconds: 5 });
  await short.feed.get();
  short.state.time += 6_000;
  await short.feed.get();
  assert.equal(short.state.calls, 2);
  const none = setup([GOOD], { cacheSeconds: 0 });
  await none.feed.get();
  const again = await none.feed.get();
  assert.equal(none.state.calls, 2);
  assert.equal(again.stale, false);
  for (const good of [0, 300]) assert.ok(new PriceFeed({ cacheSeconds: good }));
  for (const bad of [-1, 301, 600, 3600, 3601, 1.5, NaN, Infinity, '60', null])
    assert.throws(() => new PriceFeed({ cacheSeconds: bad }), ConfigurationError);
  assert.throws(() => new PriceFeed({ cacheSeconds: 60, staleSeconds: 30 }), ConfigurationError);
});

// Regression: a cache longer than the stale window kept prices "fresh" that were too old
// to show, so the provider was never asked again and every reply was "unavailable".
test('the longest allowed cache always yields a price, never a cached-but-unusable one', async () => {
  const { feed, state } = setup([GOOD, new Error('down')], { cacheSeconds: 300 });
  await feed.get();
  state.time += 299_000;
  const cached = await feed.get();
  assert.equal(state.calls, 1);
  assert.equal(cached.stale, false);
  state.time += 1_000; // 300s: the cache has expired, so the provider is asked again.
  const fallback = await feed.get();
  assert.equal(state.calls, 2);
  assert.equal(fallback.stale, true, 'a failed refresh still shows the 300s-old price');
  assert.equal(fallback.ageSeconds, 300);
  assert.equal(await priceReply('price', feed).then((t) => t.startsWith('BTC: $67,123')), true);
});

test('PRICE_CACHE_SECONDS from the environment accepts only whole seconds from 0 to 300', () => {
  for (const unset of [undefined, '', '  ']) assert.equal(parseCacheSeconds(unset), 60);
  assert.equal(parseCacheSeconds('0'), 0);
  assert.equal(parseCacheSeconds(' 300 '), MAX_PRICE_AGE_SECONDS);
  assert.equal(parseCacheSeconds('045'), 45);
  for (const bad of ['301', '600', '3600', '-1', '1.5', '1e2', '0x10', 'abc', 'Infinity', '60s'])
    assert.throws(() => parseCacheSeconds(bad), ConfigurationError, bad);
});

test('PRICE_DEFAULT_CURRENCY must be offered by the provider; USD stays the default', async () => {
  assert.equal(await defaultCurrency(undefined, setup([GOOD]).feed), 'USD');
  assert.equal(await defaultCurrency(' eur ', setup([GOOD]).feed), 'EUR');
  for (const bad of ['euro', 'US', '€', '1EU'])
    await assert.rejects(defaultCurrency(bad, setup([GOOD]).feed), /three-letter code/, bad);
  await assert.rejects(
    defaultCurrency('GBP', setup([GOOD]).feed),
    (error) =>
      error instanceof ConfigurationError &&
      error.message ===
        'PRICE_DEFAULT_CURRENCY GBP is not offered by the price provider. Available: EUR, JPY, USD.',
  );
});

test('an unreachable provider cannot prove PRICE_DEFAULT_CURRENCY wrong, so startup only warns', async () => {
  const warnings = [];
  const { feed } = setup([new Error('down')]);
  assert.equal(await defaultCurrency('GBP', feed, (line) => warnings.push(line)), 'GBP');
  assert.deepEqual(warnings, [
    'Could not check PRICE_DEFAULT_CURRENCY GBP: the price provider is not responding.',
  ]);
});

test('concurrent requests share one provider call', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { feed, state } = setup([async () => (await gate, GOOD)]);
  const pending = Array.from({ length: 10 }, () => feed.get());
  release();
  const results = await Promise.all(pending);
  assert.equal(state.calls, 1);
  assert.ok(results.every((quote) => quote.prices.get('USD') === 67123 && !quote.stale));
});

test('a failed provider serves a stale price for up to five minutes, clearly marked', async () => {
  const { feed, state } = setup([GOOD, new Error('offline')]);
  await feed.get();
  state.time += 120_000;
  const stale = await feed.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.ageSeconds, 120);
  assert.equal(stale.prices.get('USD'), 67123);
  assert.match(state.logs[0], /Price provider request failed: offline/);
  state.time += 180_000; // Now 300 seconds old: still allowed.
  assert.equal((await feed.get()).stale, true);
  state.time += 1_000; // 301 seconds old: too old to show.
  assert.equal(await feed.get(), null);
});

test('no cached price and a failing provider yields null instead of throwing', async () => {
  const { feed } = setup([new Error('offline')]);
  assert.equal(await feed.get(), null);
});

test('an invalid response never replaces a good cache', async () => {
  const { feed, state } = setup([GOOD, '{"USD":-1}']);
  await feed.get();
  state.time += 61_000;
  const quote = await feed.get();
  assert.equal(quote.stale, true);
  assert.equal(quote.prices.get('USD'), 67123);
});

test('after a failure the provider is not retried for ten seconds', async () => {
  const { feed, state } = setup([new Error('offline'), GOOD]);
  assert.equal(await feed.get(), null);
  state.time += 9_000;
  assert.equal(await feed.get(), null);
  assert.equal(state.calls, 1, 'an outage must not stall every message');
  state.time += 2_000;
  assert.equal((await feed.get()).prices.get('USD'), 67123);
  assert.equal(state.calls, 2);
});

test('PRICE_URL requires HTTPS and public hosts unless local use is allowed', () => {
  assert.equal(
    priceURL('https://mempool.example/api/v1/prices'),
    'https://mempool.example/api/v1/prices',
  );
  for (const bad of [
    'not a url',
    'http://mempool.example/prices',
    'ftp://mempool.example/prices',
    'file:///etc/passwd',
    'https://user:secret@mempool.example/prices',
    'https://mempool.example/prices#frag',
    'https://127.0.0.1/prices',
    'https://10.0.0.5/prices',
    'https://169.254.169.254/latest',
    'https://[::1]/prices',
    'https://localhost/prices',
    'https://printer.local/prices',
  ])
    assert.throws(() => priceURL(bad), ConfigurationError, bad);
  assert.equal(priceURL('http://127.0.0.1:3000/prices', true), 'http://127.0.0.1:3000/prices');
  assert.equal(priceURL('http://localhost:3000/prices', true), 'http://localhost:3000/prices');
  assert.throws(() => priceURL('http://user:secret@127.0.0.1/', true), ConfigurationError);
  assert.throws(() => priceURL('ftp://127.0.0.1/', true), ConfigurationError);
});

// Real sockets, local mock provider.
async function provider(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/prices`;
  return { url, server, close: () => server.closeAllConnections() || server.close() };
}

test('httpGet returns a 200 body and fails closed on every other outcome', async (t) => {
  const mock = await provider((request, response) => {
    if (request.url === '/prices') {
      assert.equal(request.headers.accept, 'application/json');
      response.end(GOOD);
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
    } else if (request.url === '/error') response.writeHead(500).end('nope');
    else if (request.url === '/huge') response.end('x'.repeat(200_000));
    else if (request.url === '/stall') response.write('{"USD":'); // Never finishes.
    // Any other path never answers.
  });
  t.after(mock.close);
  const base = mock.url.replace('/prices', '');
  const get = (path, timeout = 2000) => httpGet(base + path, { allowLocal: true, timeout });
  assert.equal(await get('/prices'), GOOD);
  await assert.rejects(get('/redirect'), /HTTP 302/);
  await assert.rejects(get('/error'), /HTTP 500/);
  await assert.rejects(get('/huge'), /too large/);
  await assert.rejects(get('/stall', 150), /./);
  const started = Date.now();
  await assert.rejects(get('/silence', 150), /./);
  assert.ok(Date.now() - started < 1500, 'the timeout covers a silent provider');
});

test('private destinations are refused at connection time unless allowed', async (t) => {
  const mock = await provider((request, response) => response.end(GOOD));
  t.after(mock.close);
  // A name that resolves to a private address is the DNS rebinding case.
  const byName = mock.url.replace('127.0.0.1', 'localhost');
  await assert.rejects(httpGet(byName, { allowLocal: false }), /Non-public/);
  assert.equal(await httpGet(byName, { allowLocal: true }), GOOD);
});

test('PriceFeed fetches through the real transport and survives a dead provider', async (t) => {
  const mock = await provider((request, response) => response.end(GOOD));
  t.after(mock.close);
  const feed = new PriceFeed({ url: mock.url, allowHttp: true, log() {} });
  assert.equal((await feed.get()).prices.get('EUR'), 58234);
  mock.close();
  const dead = new PriceFeed({ url: mock.url, allowHttp: true, log() {} });
  assert.equal(await dead.get(), null);
});

test('a provider that rejects with a non-Error value still cannot make get() throw', async () => {
  for (const value of [null, undefined, 'text', 42]) {
    const { feed, state } = setup([() => Promise.reject(value)]);
    assert.equal(await feed.get(), null, String(value));
    assert.match(state.logs[0], /^Price provider request failed: /);
  }
});

test('the response size limit counts bytes, not characters', async (t) => {
  // 30,000 three-byte characters: under 64K characters but about 90 KB on the wire.
  const mock = await provider((request, response) => response.end(`"${'€'.repeat(30000)}"`));
  t.after(mock.close);
  await assert.rejects(httpGet(mock.url, { allowLocal: true }), /too large/);
});
