import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools';
import { formatPrice, HELP, parseCommand, priceReply, UNAVAILABLE } from '../commands.js';

const prices = new Map([
  ['USD', 67123.4],
  ['EUR', 58234],
  ['GBP', 51000],
  ['JPY', 10123456],
  ['CHF', 60000],
]);
const feed = (quote) => ({ get: async () => quote });
const fresh = feed({ prices, ageSeconds: 3, stale: false });
const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));

test('price commands are parsed case-insensitively with an optional currency', () => {
  for (const [input, expected] of [
    ['price', { type: 'price' }],
    ['PRICE', { type: 'price' }],
    ['  price  ', { type: 'price' }],
    ['price?', { type: 'price' }],
    ['/price', { type: 'price' }],
    ['!price', { type: 'price' }],
    ['btc', { type: 'price' }],
    ['bitcoin', { type: 'price' }],
    ['price USD', { type: 'price', currency: 'USD' }],
    ['price eur', { type: 'price', currency: 'EUR' }],
    ['btc JPY', { type: 'price', currency: 'JPY' }],
    ['price\nEUR', { type: 'price', currency: 'EUR' }],
    [`nostr:${npub} price EUR`, { type: 'price', currency: 'EUR' }],
    [`price ${npub}`, { type: 'price' }],
    [
      `price JPY nostr:${nip19.nprofileEncode({ pubkey: '1'.repeat(64) })}`,
      { type: 'price', currency: 'JPY' },
    ],
  ])
    assert.deepEqual(parseCommand(input), expected, input);
});

test('anything else is help, so unrelated text is never treated as a price request', () => {
  for (const input of [
    '',
    '   ',
    'hello',
    'what is the price of bitcoin',
    'priceless',
    'price EUR USD',
    'price 12',
    'price dollars',
    'price ../../etc',
    `nostr:${npub}`,
    undefined,
  ])
    assert.deepEqual(parseCommand(input), { type: 'help' }, String(input));
});

test('prices are formatted with a symbol only when there is an unambiguous one', () => {
  assert.equal(formatPrice('USD', 67123.4), 'BTC: $67,123 USD');
  assert.equal(formatPrice('EUR', 58234), 'BTC: €58,234 EUR');
  assert.equal(formatPrice('GBP', 51000), 'BTC: £51,000 GBP');
  assert.equal(formatPrice('JPY', 10123456), 'BTC: ¥10,123,456 JPY');
  assert.equal(formatPrice('CHF', 60000), 'BTC: 60,000 CHF');
});

test('replies use the default currency, the requested currency, or explain what is wrong', async () => {
  assert.equal(await priceReply('price', fresh), 'BTC: $67,123 USD');
  assert.equal(await priceReply('price', fresh, 'EUR'), 'BTC: €58,234 EUR');
  assert.equal(await priceReply('btc jpy', fresh), 'BTC: ¥10,123,456 JPY');
  assert.equal(await priceReply('hello', fresh), HELP);
});

test('unsupported currencies get a friendly answer listing what is available', async () => {
  const text = await priceReply('price XYZ', fresh);
  assert.equal(text, 'Unsupported currency XYZ. Available: CHF, EUR, GBP, JPY, USD.');
  assert.match(await priceReply('price', fresh, 'XYZ'), /^Unsupported currency XYZ\./);
});

test('stale prices are clearly marked', async () => {
  const stale = (ageSeconds) => feed({ prices, ageSeconds, stale: true });
  assert.equal(
    await priceReply('price', stale(90)),
    'BTC: $67,123 USD\nStale price from 1 min ago: the price provider is not responding.',
  );
  assert.match(await priceReply('price', stale(20)), /Stale price from less than a minute ago/);
  assert.doesNotMatch(await priceReply('price', fresh), /Stale/);
});

test('no usable price gives the unavailable message, and help needs no price', async () => {
  assert.equal(await priceReply('price', feed(null)), UNAVAILABLE);
  assert.equal(await priceReply('price EUR', feed(null)), UNAVAILABLE);
  const never = { get: async () => assert.fail('help must not call the provider') };
  assert.equal(await priceReply('hi', never), HELP);
});
