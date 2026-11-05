// Reads and validates environment variables. Every mistake stops startup with a clear
// message; nothing falls back silently to a less safe setting.
import { ConfigurationError } from './vendor/runtime.js';

export const DEFAULT_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const DEFAULT_NAME = 'LNbits Wallet';

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function integer(env, name, fallback, min, max) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ConfigurationError(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

function boolean(env, name) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'no'].includes(raw)) return false;
  if (['true', '1', 'yes'].includes(raw)) return true;
  throw new ConfigurationError(`${name} must be true or false.`);
}

// The LNbits server comes only from the operator. HTTPS unless LNBITS_ALLOW_HTTP is set,
// which is meant for an instance on this computer or a private network.
export function lnbitsURL(value, allowHttp = false) {
  const text = String(value ?? '').trim();
  if (!text) throw new ConfigurationError('LNBITS_URL is required, e.g. https://lnbits.example.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError('LNBITS_URL must be a valid URL.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new ConfigurationError('LNBITS_URL must not contain credentials, a query or a fragment.');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
    throw new ConfigurationError(
      'LNBITS_URL must use HTTPS. Set LNBITS_ALLOW_HTTP=true for a local instance.',
    );
  // Keep a path prefix (LNbits behind a reverse proxy) but always end it with one slash.
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}

// Relays for testing NWC on this computer, listed one by one. Nothing is trusted without being
// listed here, and an address by number is required: "localhost" is a name, and names can change.
const onThisComputer = (url) =>
  /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === '[::1]';
export function localTestRelays(value) {
  const relays = list(value).map((item) => {
    let url;
    try {
      url = new URL(item);
    } catch {
      throw new ConfigurationError('NWC_LOCAL_TEST_RELAYS must be a list of relay addresses.');
    }
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !onThisComputer(url)
    )
      throw new ConfigurationError(
        'NWC_LOCAL_TEST_RELAYS may only list relays on this computer by number, like ws://127.0.0.1:7791.',
      );
    return url.href;
  });
  if (relays.length > 3)
    throw new ConfigurationError('NWC_LOCAL_TEST_RELAYS may list at most 3 relays.');
  return [...new Set(relays)];
}

export function loadConfig(env) {
  const allowHttp = boolean(env, 'LNBITS_ALLOW_HTTP');
  // LNbits' own default cap is 10,000,000 sats per incoming invoice.
  const maxInvoiceSats = integer(env, 'MAX_INVOICE_SATS', 100000, 1, 10000000);
  const nwc = boolean(env, 'NWC_ENABLED');
  const publicUrl = env.CONNECT_PUBLIC_URL?.trim() || '';
  const nwcTestRelays = localTestRelays(env.NWC_LOCAL_TEST_RELAYS);
  if (nwcTestRelays.length && !nwc)
    throw new ConfigurationError('NWC_LOCAL_TEST_RELAYS needs NWC_ENABLED=true.');
  // For a bot under test: its connection page is on the same computer.
  if (nwcTestRelays.length && !(URL.canParse(publicUrl) && onThisComputer(new URL(publicUrl))))
    throw new ConfigurationError(
      'NWC_LOCAL_TEST_RELAYS needs a CONNECT_PUBLIC_URL on this computer. Remove it from a real deployment.',
    );
  if (boolean(env, 'SEND_ALLOW_NO_WALLET_LIMIT'))
    throw new ConfigurationError(
      'SEND_ALLOW_NO_WALLET_LIMIT no longer exists: a wallet must report a spending limit. Remove it.',
    );
  return {
    name: env.NAME?.trim() || DEFAULT_NAME,
    nsec: env.NSEC ?? '',
    dataDir: env.DATA_DIR?.trim() || '',
    walletsFile: env.WALLETS_FILE?.trim() || '',
    secretsDir: env.SECRETS_DIR?.trim() || '',
    // At most 7: each takes a row of /wallets buttons, and a card holds eight rows.
    maxConnections: integer(env, 'MAX_CONNECTIONS_PER_USER', 5, 1, 7),
    maxConnectionsTotal: integer(env, 'MAX_CONNECTIONS_TOTAL', 1000, 1, 100000),
    keyRotationDays: integer(env, 'KEY_ROTATION_DAYS', 30, 1, 3650),
    connect: {
      publicUrl,
      port: integer(env, 'CONNECT_PORT', 8787, 0, 65535),
      allowHttpLocal: boolean(env, 'CONNECT_ALLOW_HTTP_LOCAL'),
      allowedOrigins: env.LNBITS_ALLOWED_ORIGINS?.trim() || '',
      nwc,
      nwcTestRelays,
    },
    relays: list(env.RELAYS).length ? list(env.RELAYS) : DEFAULT_RELAYS,
    pictureURL: env.PICTURE_URL?.trim() || '',
    nip05: env.NIP05?.trim() || '',
    lnbits: {
      url: lnbitsURL(env.LNBITS_URL, allowHttp),
      allowHttp,
      timeoutMs: integer(env, 'LNBITS_TIMEOUT_SECONDS', 10, 1, 120) * 1000,
    },
    // Experimental and off by default: see the README before turning this on.
    send: boolean(env, 'SEND_ENABLED')
      ? {
          maxSats: integer(env, 'SEND_MAX_SATS', 10000, 1, 10000000),
          dailySats: integer(env, 'SEND_DAILY_SATS', 50000, 1, 100000000),
          perHour: integer(env, 'SEND_PER_HOUR', 5, 1, 1000),
        }
      : undefined,
    limits: {
      requestsPerHour: integer(env, 'MAX_REQUESTS_PER_HOUR', 60, 1, 10000),
      historyDefault: integer(env, 'HISTORY_DEFAULT', 5, 1, 20),
      maxInvoiceSats,
      invoiceExpiry: integer(env, 'INVOICE_EXPIRY_MINUTES', 60, 1, 1440) * 60,
      invoicesPerHour: integer(env, 'MAX_INVOICES_PER_HOUR', 10, 1, 1000),
      presets: invoicePresets(env, maxInvoiceSats),
    },
  };
}

export const DEFAULT_PRESETS = [1000, 5000];

// Invoice amounts offered as buttons: up to four distinct whole numbers of sats, each at
// most the invoice limit, or "off". Unset: the defaults that fit under the limit.
export function invoicePresets(env, maxInvoiceSats) {
  const raw = env.INVOICE_PRESETS?.trim();
  if (!raw) return DEFAULT_PRESETS.filter((sats) => sats <= maxInvoiceSats);
  if (['off', 'none'].includes(raw.toLowerCase())) return [];
  const presets = list(raw).map((item) => (/^[1-9][0-9]{0,7}$/.test(item) ? Number(item) : NaN));
  if (
    !presets.length ||
    presets.length > 4 ||
    new Set(presets).size !== presets.length ||
    presets.some((sats) => !Number.isSafeInteger(sats) || sats > maxInvoiceSats)
  )
    throw new ConfigurationError(
      `INVOICE_PRESETS must be "off" or up to four different whole numbers of sats from 1 to MAX_INVOICE_SATS (${maxInvoiceSats}), e.g. 1000,5000,21000.`,
    );
  return presets;
}
