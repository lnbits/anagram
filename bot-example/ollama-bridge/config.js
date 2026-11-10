// Reads and validates environment variables. Every mistake stops startup with a clear
// message; nothing falls back silently to a less safe setting.
import { nip19 } from 'nostr-tools';
import { ConfigurationError, HEX } from './runtime.js';
import { DEFAULT_OLLAMA_URL, OllamaError, parseEndpoint } from './ollama.js';
import { roomLink } from './public-groups.js';

export const DEFAULT_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const DEFAULT_NAME = 'Ollama Bridge (Example Anagram Bot)';
export const DEFAULT_MODEL = 'llama3.2';

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function integer(env, name, fallback, min, max) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
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

// Accepts npub1... or 64-character hex public keys.
export function pubkeys(value, name) {
  return list(value).map((item, index) => {
    if (HEX.test(item)) return item;
    try {
      const decoded = nip19.decode(item.replace(/^nostr:/, ''));
      if (decoded.type === 'npub') return decoded.data;
    } catch {
      /* Reported below. */
    }
    throw new ConfigurationError(`${name} entry ${index + 1} is not an npub or hex public key.`);
  });
}

// Accepts naddr1... values or full Anagram share links (quote links in .env: # starts a comment).
export function publicGroups(value) {
  return list(value).map((item, index) => {
    const target = roomLink(item);
    if (!target)
      throw new ConfigurationError(
        `ALLOWED_PUBLIC_GROUPS entry ${index + 1} is not a public group naddr or link.`,
      );
    return { link: item, address: `34550:${target.owner}:${target.slug}` };
  });
}

export function loadConfig(env) {
  const allowRemote = boolean(env, 'OLLAMA_ALLOW_REMOTE');
  const ollamaURL = env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
  try {
    parseEndpoint(ollamaURL, { allowRemote });
  } catch (error) {
    if (error instanceof OllamaError) throw new ConfigurationError(error.message);
    throw error;
  }
  const maxOutputChars = integer(env, 'MAX_OUTPUT_CHARS', 4000, 100, 20000);
  return {
    name: env.NAME?.trim() || DEFAULT_NAME,
    nsec: env.NSEC ?? '',
    dataDir: env.DATA_DIR?.trim() || '',
    relays: list(env.RELAYS).length ? list(env.RELAYS) : DEFAULT_RELAYS,
    pictureURL: env.PICTURE_URL?.trim() || '',
    nip05: env.NIP05?.trim() || '',
    ollama: {
      url: ollamaURL,
      allowRemote,
      model: env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
      timeoutMs: integer(env, 'OLLAMA_TIMEOUT_SECONDS', 120, 5, 3600) * 1000,
      // Roughly 3 characters per token; the character limit below is the hard cap.
      maxTokens: Math.ceil(maxOutputChars / 3),
    },
    systemPrompt: env.SYSTEM_PROMPT?.trim() || '',
    limits: {
      maxInputChars: integer(env, 'MAX_INPUT_CHARS', 4000, 100, 50000),
      maxOutputChars,
      requestsPerHour: integer(env, 'MAX_REQUESTS_PER_HOUR', 30, 1, 10000),
      maxQueue: integer(env, 'MAX_QUEUE', 10, 1, 1000),
    },
    history: {
      maxMessages: integer(env, 'HISTORY_MAX_MESSAGES', 20, 0, 200),
      maxChars: integer(env, 'HISTORY_MAX_CHARS', 8000, 0, 200000),
      idleSeconds: integer(env, 'HISTORY_IDLE_MINUTES', 60, 1, 10080) * 60,
    },
    access: {
      senders: pubkeys(env.ALLOWED_NPUBS, 'ALLOWED_NPUBS'),
      privateGroups: pubkeys(env.ALLOWED_PRIVATE_GROUPS, 'ALLOWED_PRIVATE_GROUPS'),
      publicGroups: publicGroups(env.ALLOWED_PUBLIC_GROUPS),
    },
  };
}
