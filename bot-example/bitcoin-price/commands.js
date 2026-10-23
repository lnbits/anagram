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

// feed.get() never throws, so a provider failure becomes a friendly message here.
// Returns null when the bot should stay silent: help is only for messages that start a
// conversation, so two bots that answer everything cannot reply to each other forever.
export async function priceReply(content, feed, defaultCurrency = 'USD', { help = true } = {}) {
  const command = parseCommand(content);
  if (command.type === 'help') return help ? HELP : null;
  const quote = await feed.get();
  if (!quote) return UNAVAILABLE;
  const currency = command.currency ?? defaultCurrency;
  const value = quote.prices.get(currency);
  if (value === undefined)
    return `Unsupported currency ${currency}. Available: ${currencies(quote.prices)}.`;
  const text = formatPrice(currency, value);
  if (!quote.stale) return text;
  const minutes = Math.floor(quote.ageSeconds / 60);
  const age = minutes < 1 ? 'less than a minute ago' : `${minutes} min ago`;
  return `${text}\nStale price from ${age}: the price provider is not responding.`;
}
