// Turns chat text into a command, and wallet data into reply text. No network access here.
import { MAX_HISTORY } from './lnbits.js';

// "/help", "/HELP please", "balance" and "/history 10" are commands. Anything else is not.
export function parseCommand(text) {
  const words = String(text).trim().slice(0, 200).split(/\s+/).filter(Boolean);
  const name = words[0]?.toLowerCase().replace(/^[/!]/, '');
  if (!name) return null;
  if (['help', 'start'].includes(name)) return { name: 'help' };
  if (name === 'balance') return { name: 'balance' };
  if (['wallets', 'wallet'].includes(name)) return { name: 'wallets' };
  if (name === 'disconnect') return { name: 'disconnect' };
  if (name === 'connect') return { name: 'connect' };
  // An invoice is longer than the words looked at above.
  if (name === 'send')
    return { name: 'send', invoice: /^\S+\s+(\S+)/.exec(String(text).trim())?.[1] ?? '' };
  if (name === 'cancel') return { name: 'cancel' };
  if (name === 'menu') return { name: 'menu' };
  if (name === 'invoices') return { name: 'invoices' };
  if (name === 'payments') return { name: 'payments' };
  if (name === 'history') {
    if (words.length === 1) return { name: 'history' };
    const count = /^[0-9]{1,2}$/.test(words[1]) ? Number(words[1]) : NaN;
    if (words.length === 2 && count >= 1 && count <= MAX_HISTORY) return { name: 'history', count };
    return { name: 'usage', command: 'history' };
  }
  if (name === 'invoice') {
    // "/invoice 1000" or "/invoice 1000 coffee and cake": a whole number of sats, written
    // plainly (no "1e3", "1.5", "1,000" or leading zeros), then an optional memo.
    const match = /^\S+[ \t]+([1-9][0-9]{0,8})(?:[ \t]+([\s\S]*))?$/.exec(String(text).trim());
    if (!match) return { name: 'usage', command: 'invoice' };
    return { name: 'invoice', sats: Number(match[1]), memo: match[2] ?? '' };
  }
  return words[0].startsWith('/') ? { name: 'unknown' } : null;
}

export const USAGE = {
  history: 'Usage: /history or /history 1-20',
  invoice: 'Usage: /invoice <sats> [memo], for example /invoice 1000 coffee',
};

// The memo becomes the invoice description that payers see, so it must be exactly what the
// person wrote: invisible and control characters become spaces, and anything too long is
// refused rather than cut. Returns the memo, or undefined if it cannot be used.
export const MAX_MEMO_CHARS = 100;
export function invoiceMemo(value) {
  const memo = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Lightning descriptions are limited to 639 bytes; stay well inside.
  if ([...memo].length > MAX_MEMO_CHARS || Buffer.byteLength(memo) > 300) return undefined;
  return memo;
}

// Things that must never be sent to a bot: LNbits wallet keys or user ids (32 hex, with or
// without UUID dashes), Nostr private keys and NWC connection secrets. Payment hashes are
// 64 hex and do not match.
const SECRETS = [
  /(?<![a-z0-9])[a-f0-9]{32}(?![a-z0-9])/i,
  /(?<![a-z0-9])[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![a-z0-9])/i,
  /nsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}/i,
  /nostr\+walletconnect:/i,
];
export const looksLikeSecret = (text) => SECRETS.some((pattern) => pattern.test(String(text)));

export const SECRET_WARNING = [
  'That message looks like it contains a wallet key, login id or private key.',
  'I never accept keys in chat and I did not store or use it.',
  'Treat it as exposed: create a new key for that wallet in LNbits (or replace the Nostr key) now.',
  'Wallets are never linked through messages.',
].join('\n');

export function helpText(label, { manageable = false, connectable = false, sending = false } = {}) {
  return [
    `${sending ? 'Lightning wallet bot.' : 'LNbits wallet bot (receive only).'}${label ? ` Linked wallet: ${label}.` : ''}`,
    'Commands:',
    '/menu — buttons for everything below',
    '/balance — your wallet balance',
    `/history [1-${MAX_HISTORY}] — your most recent settled payments`,
    '/invoice <sats> [memo] — a Lightning invoice to receive a payment',
    '/invoices — the invoices made here, and whether they were paid',
    ...(sending
      ? [
          '/send <invoice> — pay an invoice, after you confirm. You can also just paste it',
          '/payments — what you sent, and whether it went through',
        ]
      : []),
    '/cancel — stop something unfinished',
    ...(manageable
      ? [
          ...(connectable ? ['/connect — connect a wallet, on a secure page'] : []),
          '/wallets — your connected wallets, and which one is in use',
          '/disconnect — stop the bot using a wallet',
        ]
      : []),
    '/help — show this message',
    sending
      ? 'I can pay only from a wallet you connected to spend, within the limit set in that wallet. I never ask for wallet keys in chat.'
      : 'I cannot send payments, and I never ask for wallet keys.',
  ].join('\n');
}

// Exact conversion: integer msat to sats, keeping up to three decimals instead of rounding.
// 2100000 -> "2,100 sats", 1 -> "0.001 sats", 1500 -> "1.5 sats".
export function formatMsat(msat) {
  if (!Number.isSafeInteger(msat)) throw new RangeError('Amount must be whole millisatoshis.');
  const sign = msat < 0 ? '-' : '';
  const abs = Math.abs(msat);
  const sats = Math.floor(abs / 1000).toLocaleString('en-US');
  const rest = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  const amount = `${sign}${sats}${rest ? `.${rest}` : ''}`;
  return `${amount} ${abs === 1000 ? 'sat' : 'sats'}`;
}

export const balanceText = (msat, label) =>
  `Balance${label ? ` (${label})` : ''}: ${formatMsat(msat)}`;

// Memos are chosen by whoever wrote the invoice, so they may be hostile. Keep plain words
// only: no control or direction-changing characters, links, Nostr references, key-like
// strings, formatting characters or line breaks; at most 48 characters. Only the start of a
// long value is looked at: the patterns below take quadratic time on hostile text, and a server
// can return a memo of any length.
const MEMO_INPUT_LIMIT = 2000;
export function sanitizeMemo(value) {
  let text = String(value ?? '')
    .slice(0, MEMO_INPUT_LIMIT)
    .toWellFormed()
    .normalize('NFKC')
    .slice(0, MEMO_INPUT_LIMIT)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '(link)')
    .replace(/\bwww\.\S+/gi, '(link)')
    .replace(
      /(?:nostr:)?\b(?:npub|nprofile|nsec|note|nevent|naddr|lnurl|lnbcrt|lnbc|lntb)1[0-9a-z]+/gi,
      '(ref)',
    );
  for (const pattern of SECRETS) text = text.replace(new RegExp(pattern, 'gi'), '(hidden)');
  text = text
    .replace(/[`*_~#<>[\]|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > 48 ? `${chars.slice(0, 47).join('').trimEnd()}…` : text;
}

const when = (time) => {
  const date = new Date(time * 1000);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
};

// offset: how many newer payments come before this page (history buttons page through).
export function historyText(payments, label, offset = 0) {
  if (!payments.length)
    return offset
      ? `No older settled payments${label ? ` in ${label}` : ''}.`
      : `No settled payments yet${label ? ` in ${label}` : ''}.`;
  const lines = payments.map((p) => {
    const amount = `${p.amountMsat > 0 ? '+' : ''}${formatMsat(p.amountMsat)}`;
    const fee = p.amountMsat < 0 && p.feeMsat ? ` (fee ${formatMsat(p.feeMsat)})` : '';
    const memo = sanitizeMemo(p.memo);
    return `${amount}${fee} · ${when(p.time)}${memo ? ` · ${memo}` : ''}`;
  });
  const where = label ? ` (${label})` : '';
  return [
    offset
      ? `Settled payments ${offset + 1}–${offset + payments.length}, newest first${where}:`
      : `Last ${payments.length} settled payment${payments.length === 1 ? '' : 's'}${where}:`,
    ...lines,
  ].join('\n');
}

// What the person is told when LNbits fails. Never includes URLs, keys or server text.
export function failureText(error) {
  switch (error?.code) {
    case 'rejected':
      return 'LNbits did not accept the key linked to your wallet. Please ask the bot operator to check the link.';
    case 'admin_key':
      return 'Your wallet link is switched off: it uses a key that can spend. Please ask the bot operator to link the wallet’s invoice (read) key instead.';
    case 'timeout':
    case 'unavailable':
    case 'busy':
      return 'LNbits is not reachable right now. Please try again in a few minutes.';
    case 'not_offered':
      return 'This wallet connection does not offer that.';
    default:
      return 'LNbits returned an unexpected response. Please try again later.';
  }
}

// Replies are written for an operator-linked LNbits wallet. Someone who connected their own
// wallet does not have an operator to ask, and an NWC wallet is not LNbits.
export function forWallet(text, lease) {
  if (!lease) return text;
  let result = text;
  if (lease.source === 'self')
    result = result.replace(
      'Please ask the bot operator to check the link.',
      'Disconnect it with /wallets and connect it again with /connect.',
    );
  if (lease.kind === 'nwc')
    result = result
      .replace(
        'LNbits did not accept the key linked to your wallet',
        'Your wallet refused this connection',
      )
      .replace(/LNbits is/g, 'Your wallet is')
      .replace(/LNbits/g, 'your wallet')
      .replace(/^your wallet/, 'Your wallet');
  return result;
}

// ---- Invoices ---------------------------------------------------------------------------

const sats = (n) => formatMsat(n * 1000);

// The invoice on a line of its own, so it can be copied whole.
export function invoiceText({ sats: amount, bolt11, minutes, memo, late = false }) {
  const shown = sanitizeMemo(memo);
  return [
    late
      ? `LNbits has now confirmed your invoice for ${sats(amount)} (valid for ${minutes} minutes from when you asked):`
      : `Invoice for ${sats(amount)} (valid for ${minutes} minutes):`,
    bolt11,
    ...(shown ? [`Memo: ${shown}`] : []),
  ].join('\n');
}

export const INVOICE_TEXT = {
  amount: (max) =>
    `The amount must be a whole number of sats from 1 to ${max.toLocaleString('en-US')}.`,
  memo: `The memo can be at most 100 characters. Nothing was created.`,
  hourly: (limit) =>
    `You have asked for ${limit} invoices in the last hour, the limit. Please try again later.`,
  pending: (amount) =>
    `I am still checking your previous invoice request for ${sats(amount)}. I will not create another invoice until I know what happened to it.`,
  review: (amount) =>
    `Your earlier invoice request for ${sats(amount)} needs a check by the bot operator. Until they have checked it I will not create new invoices for you.`,
  uncertain: (amount) =>
    `LNbits did not confirm whether it created your invoice for ${sats(amount)}. I will not create a second one: I am checking with LNbits and will tell you the result.`,
  toReview: (amount) =>
    `I still cannot confirm whether LNbits created your invoice for ${sats(amount)}. I did not create another one. The bot operator has been asked to check; until then I cannot create new invoices for you.`,
  lost: (amount) =>
    `Your wallet did not confirm your invoice for ${sats(amount)}, so I did not show one. Please ask again.`,
  notCreated: (amount) =>
    `LNbits has no invoice for your request for ${sats(amount)}, so nothing can be paid. You can ask for a new one.`,
  lateExpired: (amount) =>
    `LNbits has now confirmed your invoice for ${sats(amount)}, but it is too late to pay it. You can ask for a new one.`,
  tooOld:
    'That request is over an hour old, so I did not create an invoice. Send it again if you still need one.',
  restarted: (amount) =>
    `Your invoice request for ${sats(amount)} was not sent to LNbits because the bot restarted. Nothing was created; please ask again.`,
};

export const MENU_TEXT = (label) => `What would you like to do?${label ? ` (${label})` : ''}`;
export const CUSTOM_TEXT = {
  ask: (label, max) =>
    `How many sats? Send a number, and a note if you like: 2100 coffee.${label ? ` The invoice will be for ${label}.` : ''} Up to ${formatMsat(max * 1000)}. This lasts five minutes; /cancel stops it.`,
  again:
    'I need a whole number of sats, like 2100, or 2100 coffee with a note. Send /cancel to stop.',
  retry: 'Send another amount, or /cancel to stop.',
  cancelled: 'Cancelled. No invoice was created.',
  sent: (amount) => `Your invoice for ${formatMsat(amount * 1000)} is in the message below.`,
};

// ---- Wallet management ------------------------------------------------------------------

// What a person sees for a wallet. Labels are chosen by people, so they get the memo treatment.
export function walletName({ label, origin }) {
  const clean = sanitizeMemo(label);
  if (clean) return clean;
  try {
    return new URL(origin).host || 'Wallet';
  } catch {
    return 'Wallet';
  }
}
export const WALLET_TEXT = {
  list: (wallets) =>
    [
      wallets.length === 1 ? 'Your wallet:' : 'Your wallets:',
      ...wallets.map(
        (w) =>
          `${w.active ? '✓' : '•'} ${walletName(w)}${w.spends ? ' [can spend]' : ''}${w.disabled ? ' [switched off]' : ''}${w.active ? ' (in use)' : ''}`,
      ),
      ...(wallets.length > 1
        ? ['', 'New commands use the wallet in use. Older menus keep showing their own wallet.']
        : []),
    ].join('\n'),
  none: 'You have no wallets connected.',
  noneConnect: 'You have no wallets connected. Send /connect to add one.',
  managed: 'Your wallet link is managed by the bot operator. Please ask them to change it.',
  gone: 'That wallet is not connected any more.',
  selected: (wallet) => `Now using ${walletName(wallet)}. New commands use this wallet.`,
  confirm: (wallet) =>
    [
      `Disconnect ${walletName(wallet)}?`,
      'The bot stops using it right away, and its old menus stop working, even if you connect it again later.',
    ].join('\n'),
  disconnected: (wallet) =>
    [
      `Disconnected ${walletName(wallet)}. The bot no longer uses it.`,
      wallet.kind === 'nwc'
        ? 'To make it useless everywhere, delete this connection in your wallet too. Only your wallet can do that.'
        : 'To make the old key useless everywhere, reset the wallet’s invoice key in LNbits.',
    ].join('\n'),
};

export const CONNECT_TEXT = {
  welcome: [
    'This bot lets you use your Lightning wallet from this chat: see your balance and payments, and create invoices to receive.',
    'You stay in control of your wallet, and you can disconnect it at any time.',
    'To start, send /connect. You will get a private link to a page where you connect your wallet. Never paste wallet keys in this chat.',
  ].join('\n\n'),
  link: 'Open this page to connect a wallet. The link is private, works once and lasts ten minutes. Do not share it.',
  linkPlain: (url) =>
    `Open this page to connect a wallet. The link is private, works once and lasts ten minutes. Do not share it.\n${url}`,
  // minutes: until a link is free again, if that is what stands in the way.
  limit: (minutes) =>
    `You have asked for several links recently. Please try again${minutes ? ` in about ${minutes} minute${minutes === 1 ? '' : 's'}` : ' in a while'}.`,
  off: 'Connecting wallets from chat is not available on this bot. Please ask its operator.',
  code: ({ name, host, code }) =>
    [
      `Your code to connect ${name} (${host}): ${code}`,
      'Type it on the page you opened from /connect. It lasts five minutes.',
      'Nothing is connected until you do. If you did not ask for this, ignore it. Never give this code to anyone: whoever types it connects their wallet to your account.',
    ].join('\n\n'),
  doneSpend: (name) =>
    `${name} is connected, and it CAN SEND PAYMENTS, up to the limit set in your wallet. Every payment asks you to confirm first. Use /wallets to choose it, or to disconnect it. Paste an invoice to pay it, and /payments shows what you sent.`,
  done: (name) =>
    `${name} is connected (receive only): the bot can see its balance and history and create invoices, and cannot spend. Send /menu to start, or /wallets to choose which wallet is in use.`,
};

// ---- Buttons ----------------------------------------------------------------------------

export const BUTTON_TEXT = {
  relinked:
    'This menu belongs to a wallet that is no longer linked to you. Send /balance for a new one.',
  switchedOff: 'Your wallet link is switched off. Please ask the bot operator to check it.',
  limit: 'You have reached the hourly limit for this bot. Please try again later.',
  late: 'This button press reached me too late to create an invoice safely. Nothing was created; please press it again.',
  unknownInvoice:
    'I no longer have a record of this invoice. Send /invoices for the ones I still have, or /history for your payments.',
};

// ---- /invoices --------------------------------------------------------------------------

export const INVOICE_PAGE_SIZE = 5;
const STATUS_WORD = {
  pending: 'Pending',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
  unknown: 'Unknown',
  checking: 'Unknown, still checking',
  review: 'Needs review',
};
// A status a person can read. Unknown also says what was last seen, as that and no more.
const statusWord = ({ status, lastSeen }) =>
  status === 'unknown' && lastSeen
    ? `Unknown (last seen: ${STATUS_WORD[lastSeen]})`
    : STATUS_WORD[status];

// rows: [{ record, view }], view coming from reconcile() in bot.js.
export function invoiceListText(rows, label, { offset, total }) {
  const wallet = sanitizeMemo(label);
  const where = wallet ? ` in ${wallet}` : '';
  if (!rows.length)
    return offset
      ? `No older invoices${where}.`
      : `No invoices made here yet${where}. Send /invoice <sats> [memo] to make one.`;
  const lines = rows.map(({ record, view }, index) => {
    const memo = sanitizeMemo(view.memo);
    return `${index + 1}. ${sats(record.sats)} · ${statusWord(view)} · ${when(record.createdAt)}${memo ? ` · ${memo}` : ''}`;
  });
  const unsure = rows.some(({ view }) => view.status === 'unknown');
  return [
    `Invoices${wallet ? ` (${wallet})` : ''} ${offset + 1}–${offset + rows.length} of ${total}, newest first:`,
    ...lines,
    ...(unsure ? ['Unknown means I could not confirm it with the wallet just now.'] : []),
    'Press a number for details.',
  ].join('\n');
}

// One invoice. The first line says what the wallet says. until: when an unpaid invoice stops
// being payable (seconds). bolt11: only while it can be paid.
export function invoiceDetailText({ record, view, label, until, bolt11 }) {
  const shown = sanitizeMemo(view.memo);
  const what = `Invoice for ${sats(record.sats)}${shown ? ` (${shown})` : ''}`;
  const wallet = sanitizeMemo(label);
  const said = {
    paid: `${what}: paid.`,
    pending: `${what}: not paid yet. It can be paid until ${when(until)}.`,
    expired: `${what}: expired without payment.`,
    failed: `${what}: failed. It was not created, or the wallet gave up on it, so nothing can be paid.`,
    checking: `${what}: I am still checking whether it was created.`,
    review: `${what}: this needs a check by the bot operator.`,
    unknown: `${what}: I could not confirm its status with the wallet just now. Nothing has changed; try Refresh later.`,
  };
  return [
    said[view.status],
    `Status: ${statusWord(view)}`,
    ...(wallet ? [`Wallet: ${wallet}`] : []),
    `Created: ${when(record.createdAt)}`,
    ...(bolt11 ? [bolt11] : []),
  ].join('\n');
}

// Definite failures only: in each case LNbits created nothing.
export function invoiceFailureText(error) {
  switch (error?.code) {
    case 'rejected':
    case 'admin_key':
      return `${failureText(error)} Nothing was created.`;
    case 'refused':
      return 'LNbits refused to create this invoice (for example, the amount is above its limit). Nothing was created.';
    case 'not_offered':
      return 'This wallet connection cannot create invoices. Nothing was created.';
    default:
      return 'LNbits is not reachable right now. Nothing was created; please try again in a few minutes.';
  }
}

// ---- Payment notifications --------------------------------------------------------------

// One message per check: a single payment on one line, several as a list (newest last).
// earlier: payments found but not listed; incomplete: more arrived than one check reads.
export function receivedText(payments, label, { earlier = 0, incomplete = false } = {}) {
  const where = label ? ` (${label})` : '';
  const line = (p) => {
    const memo = sanitizeMemo(p.memo);
    return `+${formatMsat(p.amountMsat)} · ${when(Math.floor(p.settledAt / 1000))}${memo ? ` · ${memo}` : ''}`;
  };
  const notes = [
    ...(earlier
      ? [`…and ${earlier} earlier payment${earlier === 1 ? '' : 's'}. See /history.`]
      : []),
    ...(incomplete ? ['More payments arrived than I could check at once. See /history.'] : []),
  ];
  if (payments.length === 1 && !notes.length) return `Received${where}: ${line(payments[0])}`;
  return [`Received ${payments.length} payments${where}:`, ...payments.map(line), ...notes].join(
    '\n',
  );
}
