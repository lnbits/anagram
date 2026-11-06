// Parsing and formatting: pure functions, no network.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMsat,
  historyText,
  invoiceMemo,
  invoiceText,
  parseCommand,
  sanitizeMemo,
} from '../commands.js';
import { ALICE_KEY } from './helpers.js';

test('msat are converted to sats exactly, never rounded', () => {
  for (const [msat, text] of [
    [0, '0 sats'],
    [1, '0.001 sats'],
    [10, '0.01 sats'],
    [999, '0.999 sats'],
    [1000, '1 sat'],
    [1001, '1.001 sats'],
    [1500, '1.5 sats'],
    [2_100_000, '2,100 sats'],
    [2_100_500, '2,100.5 sats'],
    [-7000, '-7 sats'],
    [-1000, '-1 sat'],
    [Number.MAX_SAFE_INTEGER, '9,007,199,254,740.991 sats'],
  ])
    assert.equal(formatMsat(msat), text, String(msat));
  for (const bad of [1.5, NaN, Infinity, '1000', 2 ** 53])
    assert.throws(() => formatMsat(bad), RangeError);
});

test('commands and their arguments', () => {
  assert.deepEqual(parseCommand('/balance'), { name: 'balance' });
  assert.deepEqual(parseCommand('BALANCE'), { name: 'balance' });
  // Extra words cannot pick a wallet: they are ignored.
  assert.deepEqual(parseCommand('/balance npub1someoneelse'), { name: 'balance' });
  assert.deepEqual(parseCommand('/history'), { name: 'history' });
  assert.deepEqual(parseCommand('/history 3'), { name: 'history', count: 3 });
  assert.deepEqual(parseCommand('history 20'), { name: 'history', count: 20 });
  for (const text of [
    '/history 0',
    '/history 21',
    '/history 99',
    '/history -1',
    '/history 2.5',
    '/history abc',
    '/history 3 4',
    '/history 007',
  ])
    assert.deepEqual(parseCommand(text), { name: 'usage', command: 'history' }, text);
  assert.deepEqual(parseCommand('/pay lnbc1...'), { name: 'unknown' });
  assert.equal(parseCommand('what is my balance?'), null);
});

test('memos are reduced to plain, short text', () => {
  for (const [memo, expected] of [
    ['coffee', 'coffee'],
    [null, ''],
    [undefined, ''],
    ['line one\nline two\r\n', 'line one line two'],
    ['click https://evil.example/claim now', 'click (link) now'],
    ['see www.evil.example', 'see (link)'],
    ['from nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq hi', 'from (ref) hi'],
    ['pay lnbc10u1p3xyz', 'pay (ref)'],
    [`key ${ALICE_KEY}`, 'key (hidden)'],
    ['‮gnp.exe‬', 'gnp.exe'],
    ['zero​width', 'zero width'],
    ['**bold** _x_ `code` [a](b) <script>', 'bold x code a (b) script'],
    ['ｆｕｌｌｗｉｄｔｈ', 'fullwidth'],
  ])
    assert.equal(sanitizeMemo(memo), expected, JSON.stringify(memo));
  const long = sanitizeMemo('x'.repeat(500));
  assert.equal([...long].length, 48);
  assert.ok(long.endsWith('…'));
  assert.equal(
    [...sanitizeMemo('😀'.repeat(60))].length,
    48,
    'counts characters, not UTF-16 units',
  );
});

test('history text: empty, incoming, outgoing with fee, and no extra metadata', () => {
  assert.equal(historyText([], ''), 'No settled payments yet.');
  assert.equal(historyText([], 'Alice'), 'No settled payments yet in Alice.');
  const text = historyText(
    [
      { amountMsat: -7000, feeMsat: 1000, memo: 'tea https://x.example', time: 1793469600 },
      { amountMsat: 2_100_000, feeMsat: 0, memo: '', time: 1793383200 },
    ],
    'Alice',
  );
  assert.equal(
    text,
    [
      'Last 2 settled payments (Alice):',
      '-7 sats (fee 1 sat) · 2026-10-31 18:00 UTC · tea (link)',
      '+2,100 sats · 2026-10-30 18:00 UTC',
    ].join('\n'),
  );
});

test('/invoice: a plain whole number of sats, then the memo exactly as written', () => {
  assert.deepEqual(parseCommand('/invoice 1000'), { name: 'invoice', sats: 1000, memo: '' });
  assert.deepEqual(parseCommand('invoice 21 coffee  and cake'), {
    name: 'invoice',
    sats: 21,
    memo: 'coffee  and cake',
  });
  assert.deepEqual(parseCommand('/invoice 999999999 x'), {
    name: 'invoice',
    sats: 999999999,
    memo: 'x',
  });
  for (const text of [
    '/invoice',
    '/invoice 0',
    '/invoice 01',
    '/invoice -1',
    '/invoice +1',
    '/invoice 1.5',
    '/invoice 1e3',
    '/invoice 1,000',
    '/invoice 0x10',
    '/invoice 1000000000',
    '/invoice ten',
    '/invoice 1000sats',
  ])
    assert.deepEqual(parseCommand(text), { name: 'usage', command: 'invoice' }, text);
});

test('a memo of any length takes bounded time, and its start is still cleaned', () => {
  for (const hostile of ['a.'.repeat(125000), 'www.'.repeat(62500), 'a-'.repeat(125000)]) {
    const begun = performance.now();
    const shown = sanitizeMemo(hostile);
    assert.ok(performance.now() - begun < 500, 'quadratic time on a long memo');
    assert.ok([...shown].length <= 48);
  }
  assert.equal(sanitizeMemo(`https://evil.example/${'x'.repeat(250000)}`), '(link)');
  assert.equal(sanitizeMemo(`${'😀'.repeat(1000)}!`), `${'😀'.repeat(47)}…`);
});

test('invoice memos: cleaned of invisible characters, refused when too long, never cut', () => {
  assert.equal(invoiceMemo(''), '');
  assert.equal(invoiceMemo('  tea \u202E for\ttwo\n'), 'tea for two');
  assert.equal(invoiceMemo('ｃａｆé'), 'café');
  assert.equal(invoiceMemo('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(invoiceMemo('x'.repeat(101)), undefined);
  // 300 UTF-8 bytes at most: 100 × "€" is exactly 300 bytes, 76 emoji are 304 in 76 chars.
  assert.equal(invoiceMemo('€'.repeat(100)), '€'.repeat(100));
  assert.equal(invoiceMemo('😀'.repeat(75)), '😀'.repeat(75));
  assert.equal(invoiceMemo('😀'.repeat(76)), undefined, 'over 300 bytes, under 100 chars');
});

test('invoice text: the BOLT11 invoice alone on its own line, memo shown sanitized', () => {
  const bolt11 = `lnbc10u1${'q'.repeat(200)}`;
  assert.equal(
    invoiceText({ sats: 1000, bolt11, minutes: 60, memo: 'see https://x.example' }),
    `Invoice for 1,000 sats (valid for 60 minutes):\n${bolt11}\nMemo: see (link)`,
  );
  assert.match(
    invoiceText({ sats: 1, bolt11, minutes: 5, memo: '', late: true }),
    /^LNbits has now confirmed your invoice for 1 sat /,
  );
});
