import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  buttonCurrency,
  formatPrice,
  HELP,
  parseCommand,
  priceKeyboard,
  priceReply,
  UNAVAILABLE,
} from '../commands.js';

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

const text = async (...args) => (await priceReply(...args)).text;

test('replies use the default currency, the requested currency, or explain what is wrong', async () => {
  assert.equal(await text('price', fresh), 'BTC: $67,123 USD');
  assert.equal(await text('price', fresh, 'EUR'), 'BTC: €58,234 EUR');
  assert.equal(await text('btc jpy', fresh), 'BTC: ¥10,123,456 JPY');
  assert.equal(await text('hello', fresh), HELP);
});

test('unsupported currencies get a friendly answer listing what is available', async () => {
  const reply = await priceReply('price XYZ', fresh);
  assert.equal(reply.text, 'Unsupported currency XYZ. Available: CHF, EUR, GBP, JPY, USD.');
  assert.equal(reply.priced, undefined, 'not a price: the command stays visible');
  assert.ok(reply.keyboard, 'the available currencies are offered as buttons');
  assert.match(await text('price', fresh, 'XYZ'), /^Unsupported currency XYZ\./);
});

test('stale prices are clearly marked', async () => {
  const stale = (ageSeconds) => feed({ prices, ageSeconds, stale: true });
  assert.equal(
    await text('price', stale(90)),
    'BTC: $67,123 USD\nStale price from 1 min ago: the price provider is not responding.',
  );
  assert.match(await text('price', stale(20)), /Stale price from less than a minute ago/);
  assert.doesNotMatch(await text('price', fresh), /Stale/);
  assert.equal((await priceReply('price', stale(20))).priced, true);
});

test('no usable price gives the unavailable message, and help needs no price', async () => {
  assert.deepEqual(await priceReply('price', feed(null)), { text: UNAVAILABLE, keyboard: null });
  assert.equal(await text('price EUR', feed(null)), UNAVAILABLE);
  const never = { get: async () => assert.fail('help must not call the provider') };
  assert.deepEqual(await priceReply('hi', never), { text: HELP, keyboard: null });
  assert.equal(await priceReply('hi', never, 'USD', { help: false }), null);
});

test('price replies carry one small button per currency, the default first, eight at most', async () => {
  const reply = await priceReply('price', fresh, 'GBP');
  assert.deepEqual(reply, {
    text: 'BTC: £51,000 GBP',
    priced: true,
    keyboard: {
      inline_keyboard: [
        [
          { text: 'GBP', callback_data: 'price:GBP', size: 'small' },
          { text: 'CHF', callback_data: 'price:CHF', size: 'small' },
          { text: 'EUR', callback_data: 'price:EUR', size: 'small' },
          { text: 'JPY', callback_data: 'price:JPY', size: 'small' },
        ],
        [{ text: 'USD', callback_data: 'price:USD', size: 'small' }],
      ],
    },
  });
  const many = new Map([...'ABCDEFGHIJ'].map((c) => [`${c}${c}${c}`, 1]));
  const rows = priceKeyboard(many, 'ZZZ').inline_keyboard;
  assert.deepEqual(
    rows.flat().map((b) => b.text),
    ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'],
    'an unknown default currency does not get a button and the list is capped',
  );
  assert.deepEqual(priceKeyboard(new Map()), { inline_keyboard: [] });
  assert.equal(buttonCurrency('price:EUR'), 'EUR');
  for (const bad of ['price:eur', 'price:EURO', 'vote:0', 'EUR', '', undefined])
    assert.equal(buttonCurrency(bad), null, String(bad));
});
