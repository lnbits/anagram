// Turns message text into a command and a price quote into reply text.
import { currencies } from './price.js';

export const HELP =
  'Ask for the Bitcoin price with "price" or "btc", optionally followed by a currency, for example "price EUR".';
export const UNAVAILABLE = 'The Bitcoin price is temporarily unavailable. Please try again soon.';

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
// Anagram's mention picker inserts nostr:npub1...; these are removed before parsing.
const MENTION = /(?:nostr:)?(?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+/gi;

// "price", "price eur", "/btc JPY" and "@bot price?" are commands. Anything else is help.
export function parseCommand(content) {
  const words = String(content)
    .slice(0, 1000)
    .replace(MENTION, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/[?!.,:;]+$/, ''))
    .filter(Boolean);
  const name = words[0]?.toLowerCase().replace(/^[/!]/, '');
  if (!['price', 'btc', 'bitcoin'].includes(name) || words.length > 2) return { type: 'help' };
  if (words.length === 1) return { type: 'price' };
  if (!/^[a-z]{3}$/i.test(words[1])) return { type: 'help' };
  return { type: 'price', currency: words[1].toUpperCase() };
}

export function formatPrice(currency, value) {
  const amount = value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `BTC: ${SYMBOLS[currency] ?? ''}${amount} ${currency}`;
}

// Anagram inline keyboard (see README, "Buttons"): one small button per currency the
// provider offers, the default currency first, at most two rows of four. Pressing a button
// asks for that currency; the button data is the same "price:EUR" everywhere, so a press
// can never name anything the provider did not return when the reply was written.
export const MAX_BUTTONS = 8;
export const buttonCurrency = (data) =>
  typeof data === 'string' && /^price:[A-Z]{3}$/.test(data) ? data.slice(6) : null;
export function priceKeyboard(prices, defaultCurrency = 'USD') {
  const codes = [...prices.keys()].filter((code) => /^[A-Z]{3}$/.test(code)).sort();
  const ordered = prices.has(defaultCurrency)
    ? [defaultCurrency, ...codes.filter((code) => code !== defaultCurrency)]
    : codes;
  const buttons = ordered
    .slice(0, MAX_BUTTONS)
    .map((code) => ({ text: code, callback_data: `price:${code}`, size: 'small' }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { inline_keyboard: rows };
}

// feed.get() never throws, so a provider failure becomes a friendly message here.
// Returns { text, keyboard, priced }: the keyboard is null when there is no price to switch
// between, and priced marks a reply that really answers the command with a price. Returns
// null when the bot should stay silent: help is only for messages that start a
// conversation, so two bots that answer everything cannot reply to each other forever.
export async function priceReply(content, feed, defaultCurrency = 'USD', { help = true } = {}) {
  const command = parseCommand(content);
  if (command.type === 'help') return help ? { text: HELP, keyboard: null } : null;
  const quote = await feed.get();
  if (!quote) return { text: UNAVAILABLE, keyboard: null };
  const keyboard = priceKeyboard(quote.prices, defaultCurrency);
  const currency = command.currency ?? defaultCurrency;
  const value = quote.prices.get(currency);
  if (value === undefined)
    return {
      text: `Unsupported currency ${currency}. Available: ${currencies(quote.prices)}.`,
      keyboard,
    };
  const text = formatPrice(currency, value);
  if (!quote.stale) return { text, keyboard, priced: true };
  const minutes = Math.floor(quote.ageSeconds / 60);
  const age = minutes < 1 ? 'less than a minute ago' : `${minutes} min ago`;
  return {
    text: `${text}\nStale price from ${age}: the price provider is not responding.`,
    keyboard,
    priced: true,
  };
}
