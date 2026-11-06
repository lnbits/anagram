// Inline buttons: Anagram's inline keyboard protocol (docs/bot-keyboards.md in the Anagram
// repository). vendor/botKeyboardProtocol.ts is its validator, identical to the app's copy.
//
// A card is a reply that carries a keyboard tag. Pressing a callback button sends the bot an
// encrypted kind 21118 request; the bot answers privately, and the answer replaces the
// card's text for that person only. Copy buttons never reach the bot. Clients without
// buttons see the same text as before, and every action is also a command.
//
// state.cards[cardId] = { owner, ref, at, data: [callback data], views: [{ id, data }] }
//   owner: the person the card was sent to. ref: walletRef() of the wallet it was made
//   for, so a relinked wallet's old menus stop working. views: the bot's latest answers on
//   the card, whose own buttons are valid too. Only callback data is kept: never copy
//   texts, so no invoice text is stored.
// state.callbacks[`${sender}:${requestId}`] = { fingerprint, expires, delivery }
//   The exact encrypted answer to one request, so a retry gets the same answer and never
//   repeats its effect. fingerprint: the request's rumor id; the same id with different
//   contents is refused.
import { HEX } from './vendor/runtime.js';
import { MAX_COPY_TEXT_BYTES } from './vendor/botKeyboardProtocol.ts';
import { formatMsat, walletName } from './commands.js';

export const MAX_PAGES = 10; // history pages reachable with buttons
const KEEP_CARDS = 30 * 86400;
const MAX_CARDS = 5000;
const CARDS_PER_OWNER = 100;
const VIEWS_PER_CARD = 8;
const MAX_CALLBACKS = 2000;
const REF = /^[a-f0-9]{32}$/;

export const EMPTY = { inline_keyboard: [] };
// The ref of a card about the person's account (their list of wallets), not about one wallet.
export const ACCOUNT_REF = '0'.repeat(32);

// The short reference of an invoice request on its "Check status" button (no key, no id
// LNbits knows): the first 12 hex digits of the request's random op.
export const statusRef = (record) => record.op.replace(/-/g, '').slice(0, 12);

const menuRow = () => [
  { text: 'Refresh balance', callback_data: 'bal' },
  { text: 'History', callback_data: 'hist:0' },
];
const CUSTOM = { text: '⚡ Custom', callback_data: 'inv:custom' };
// The preset amounts and Custom: a row holds four buttons at most. Presets off: neither.
const presetRows = (presets) => {
  const amounts = presets.map((sats) => ({
    text: `⚡ ${formatMsat(sats * 1000)}`,
    callback_data: `inv:${sats}`,
  }));
  if (!amounts.length) return [];
  return amounts.length < 4 ? [[...amounts, CUSTOM]] : [amounts, [CUSTOM]];
};
const rows = (...list) => ({ inline_keyboard: list.filter((row) => row.length) });

// Balance, history and the invoice amounts. With wallet management, a way to the wallets.
export const menuKeyboard = (presets, { manageable = false, sending = false } = {}) =>
  rows(
    menuRow(),
    ...presetRows(presets),
    sending
      ? [
          { text: 'Send', callback_data: 's:ask' },
          { text: 'Payments', callback_data: 'pm:0' },
        ]
      : [],
    [
      { text: 'Invoices', callback_data: 'iv:0' },
      ...(manageable ? [{ text: 'Wallets', callback_data: 'w:list' }] : []),
    ],
  );
// Under a payment notification: the two things people want next.
export const noticeKeyboard = () => rows(menuRow());
// While the bot waits for an amount.
export const waitingKeyboard = () => rows([{ text: 'Cancel', callback_data: 'inv:cancel' }]);

// One page of history. page 0 is the newest.
export function historyKeyboard(page, more, presets) {
  const paging = [
    ...(more && page + 1 < MAX_PAGES ? [{ text: 'Older', callback_data: `hist:${page + 1}` }] : []),
    ...(page > 0 ? [{ text: 'Newer', callback_data: `hist:${page - 1}` }] : []),
  ];
  return rows(paging, menuRow(), ...presetRows(presets));
}

// An unpaid invoice: copy it (on the device, nothing is sent), or ask LNbits about it.
export function invoiceKeyboard(bolt11, record) {
  const copy =
    Buffer.byteLength(bolt11) <= MAX_COPY_TEXT_BYTES
      ? [{ text: 'Copy invoice', copy_text: { text: bolt11 } }]
      : [];
  return rows(
    [...copy, { text: 'Check status', callback_data: `st:${statusRef(record)}` }],
    menuRow(),
  );
}

// /invoices: a list page or one invoice of it. Nothing here names a wallet: that is the card's.
export const MAX_INVOICE_PAGES = 40;
export const INVOICE_VIEW = /^iv:([0-9]{1,2})(?::([a-f0-9]{12}))?$/;
const listData = (page) => `iv:${page}`;
// A number per invoice on the page, then paging, Refresh, and the usual ways on.
export function invoicesKeyboard(records, page, more) {
  const numbers = records.map((record, index) => ({
    text: String(index + 1),
    callback_data: `${listData(page)}:${statusRef(record)}`,
  }));
  const paging = [
    ...(more && page + 1 < MAX_INVOICE_PAGES
      ? [{ text: 'Older', callback_data: listData(page + 1) }]
      : []),
    ...(page > 0 ? [{ text: 'Newer', callback_data: listData(page - 1) }] : []),
  ];
  return rows(
    numbers.slice(0, 4),
    numbers.slice(4),
    paging,
    [{ text: 'Refresh', callback_data: listData(page) }],
    menuRow(),
  );
}
// One invoice: copy it while it can be paid, refresh it, or go back to its page.
export function invoiceDetailKeyboard(record, page, bolt11) {
  const copy =
    bolt11 && Buffer.byteLength(bolt11) <= MAX_COPY_TEXT_BYTES
      ? [{ text: 'Copy invoice', copy_text: { text: bolt11 } }]
      : [];
  return rows(
    [...copy, { text: 'Refresh', callback_data: `${listData(page)}:${statusRef(record)}` }],
    [{ text: 'All invoices', callback_data: listData(page) }],
    menuRow(),
  );
}

// Button text is limited; a long name is shortened for the button only.
const short = (text, max = 28) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};
const WALLET_ID = /^[a-f0-9]{32}$/;
// One row per wallet: use it (unless it is in use) and disconnect it.
export function walletsKeyboard(wallets, { connectable = false } = {}) {
  return {
    inline_keyboard: [
      // A card holds eight rows. More wallets than that can only be left by an older setting.
      ...wallets.slice(0, 7).map((wallet) => {
        const name = short(walletName(wallet));
        if (!WALLET_ID.test(wallet.id)) throw new RangeError('Invalid wallet id.');
        return [
          ...(wallet.active ? [] : [{ text: `Use ${name}`, callback_data: `w:use:${wallet.id}` }]),
          { text: `Disconnect ${name}`, callback_data: `w:del:${wallet.id}` },
        ];
      }),
      ...(connectable ? [[{ text: 'Connect a wallet', callback_data: 'w:new' }]] : []),
    ],
  };
}
export const confirmKeyboard = (id) =>
  rows(
    [{ text: 'Yes, disconnect', callback_data: `w:delok:${id}` }],
    [{ text: 'Keep it', callback_data: 'w:list' }],
  );
export const WALLET_ACTION = /^w:(?:list|new|(use|del|delok):([a-f0-9]{32}))$/;
// The link to the connection page. It goes in a button: Anagram opens it only when pressed.
export const connectKeyboard = (url) => rows([{ text: 'Open connection page', url }]);

// Every callback a keyboard offers: what a press on it may ask for.
export const callbacks = (keyboard) =>
  keyboard.inline_keyboard.flat().flatMap((b) => (b.callback_data ? [b.callback_data] : []));

const strings = (list) =>
  Array.isArray(list) &&
  list.length <= 32 &&
  list.every((d) => typeof d === 'string' && d.length >= 1 && d.length <= 64);
const validCard = (c) =>
  c !== null &&
  typeof c === 'object' &&
  HEX.test(c.owner) &&
  REF.test(c.ref) &&
  Number.isSafeInteger(c.at) &&
  strings(c.data) &&
  Array.isArray(c.views) &&
  c.views.length <= VIEWS_PER_CARD &&
  c.views.every((v) => v && HEX.test(v.id) && strings(v.data));
const validCallback = (c) =>
  c !== null &&
  typeof c === 'object' &&
  HEX.test(c.fingerprint) &&
  Number.isSafeInteger(c.expires) &&
  c.delivery &&
  typeof c.delivery.event === 'object' &&
  Array.isArray(c.delivery.relays);

export class Buttons {
  constructor(state, clock = () => Math.floor(Date.now() / 1000)) {
    state.cards ??= {};
    state.callbacks ??= {};
    const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (
      !plain(state.cards) ||
      !plain(state.callbacks) ||
      !Object.entries(state.cards).every(([id, c]) => HEX.test(id) && validCard(c)) ||
      !Object.values(state.callbacks).every(validCallback)
    )
      throw new Error('Invalid button records in state.json. Restore it from backup.');
    this.state = state;
    this.clock = clock;
  }
  card(id) {
    return Object.hasOwn(this.state.cards, id) ? this.state.cards[id] : undefined;
  }
  // The callbacks valid on the card itself, or on one of the bot's answers on it.
  allowed(card, view) {
    return view ? card.views.find((v) => v.id === view)?.data : card.data;
  }
  addCard(id, { owner, ref, keyboard }) {
    this.state.cards[id] = { owner, ref, at: this.clock(), data: callbacks(keyboard), views: [] };
    this.prune();
  }
  addView(card, id, keyboard) {
    card.views.push({ id, data: callbacks(keyboard) });
    while (card.views.length > VIEWS_PER_CARD) card.views.shift();
  }
  answered(key) {
    return Object.hasOwn(this.state.callbacks, key) ? this.state.callbacks[key] : undefined;
  }
  // false: too many answers kept; the request is dropped (the person can press again).
  remember(key, entry) {
    this.prune();
    if (Object.keys(this.state.callbacks).length >= MAX_CALLBACKS) return false;
    this.state.callbacks[key] = entry;
    return true;
  }
  get full() {
    this.prune();
    return Object.keys(this.state.callbacks).length >= MAX_CALLBACKS;
  }
  // Answers are kept five minutes past their request's expiry (requests live five minutes);
  // cards a month, at most CARDS_PER_OWNER per person and MAX_CARDS in all, oldest first.
  prune() {
    const time = this.clock();
    for (const [key, entry] of Object.entries(this.state.callbacks))
      if (entry.expires < time - 300) delete this.state.callbacks[key];
    const cards = Object.entries(this.state.cards)
      .filter(([, c]) => c.at >= time - KEEP_CARDS)
      .sort(([, a], [, b]) => a.at - b.at);
    const perOwner = new Map();
    for (const [, c] of cards) perOwner.set(c.owner, (perOwner.get(c.owner) ?? 0) + 1);
    const kept = cards.filter(([, c]) => {
      const count = perOwner.get(c.owner);
      if (count <= CARDS_PER_OWNER) return true;
      perOwner.set(c.owner, count - 1);
      return false;
    });
    this.state.cards = Object.fromEntries(kept.slice(-MAX_CARDS));
  }
}
