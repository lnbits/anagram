// Reads and validates environment variables. Every mistake stops startup with a clear
// message; nothing falls back silently to a less safe setting.
import { nip19 } from 'nostr-tools';
import { ConfigurationError, HEX } from './runtime.js';
import { DEFAULT_OLLAMA_URL, OllamaError, parseEndpoint } from './ollama.js';
import { DEFAULT_API_URL, GitHubError, parseApiBase } from './github.js';
import { roomLink } from './public-groups.js';
import { validRepo } from './intent.js';

export const DEFAULT_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const DEFAULT_NAME = 'GitHub Issue Agent (Example Anagram Bot)';
export const DEFAULT_MODEL = 'llama3.2';

const list = (value, separator = ',') =>
  String(value ?? '')
    .split(separator)
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
export function pubkey(item, label) {
  if (HEX.test(item)) return item;
  try {
    const decoded = nip19.decode(item.replace(/^nostr:/, ''));
    if (decoded.type === 'npub') return decoded.data;
  } catch {
    /* Reported below. */
  }
  throw new ConfigurationError(`${label} is not an npub or hex public key.`);
}
export const pubkeys = (value, name) =>
  list(value).map((item, index) => pubkey(item, `${name} entry ${index + 1}`));

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

// ALLOWED_REPOS=owner/repo,owner/other → canonical names, unique ignoring case.
export function repositories(value) {
  const repos = [];
  for (const [index, repo] of list(value).entries()) {
    if (!validRepo(repo))
      throw new ConfigurationError(`ALLOWED_REPOS entry ${index + 1} is not owner/repo.`);
    if (repos.some((r) => r.toLowerCase() === repo.toLowerCase()))
      throw new ConfigurationError(`ALLOWED_REPOS lists ${repo} twice.`);
    repos.push(repo);
  }
  return repos;
}

// ALLOWED_USERS="npub1a=owner/repo,owner/other; npub1b=*"  (entries separated by ";" or
// new lines). Each repository must be in ALLOWED_REPOS; "*" means all of them.
export function users(value, repos) {
  const result = new Map();
  for (const [index, entry] of list(value, /[;\n]/).entries()) {
    const label = `ALLOWED_USERS entry ${index + 1}`;
    const [who, allowed, extra] = entry.split('=');
    if (extra !== undefined || !who?.trim() || !allowed?.trim())
      throw new ConfigurationError(`${label} must look like npub1...=owner/repo,owner/other.`);
    const key = pubkey(who.trim(), label);
    if (result.has(key)) throw new ConfigurationError(`${label} repeats a user.`);
    const names =
      allowed.trim() === '*'
        ? [...repos]
        : list(allowed).map((repo) => {
            const canonical = repos.find((r) => r.toLowerCase() === repo.toLowerCase());
            if (!canonical)
              throw new ConfigurationError(`${label}: ${repo} is not listed in ALLOWED_REPOS.`);
            return canonical;
          });
    result.set(key, [...new Set(names)]);
  }
  return result;
}

// Fine-grained personal access tokens start with github_pat_. Classic tokens (ghp_) grant
// every repository the account can reach, so they are refused.
export function githubToken(value) {
  const token = String(value ?? '').trim();
  if (!token) throw new ConfigurationError('GITHUB_TOKEN is required (a fine-grained token).');
  if (/^(ghp|gho|ghu|ghs|ghr)_/.test(token))
    throw new ConfigurationError(
      'GITHUB_TOKEN must be a fine-grained personal access token (github_pat_...). Classic tokens are refused.',
    );
  if (!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token))
    throw new ConfigurationError(
      'GITHUB_TOKEN does not look like a fine-grained token (github_pat_...).',
    );
  return token;
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
  const allowLocal = boolean(env, 'GITHUB_ALLOW_LOCAL');
  const githubURL = env.GITHUB_API_URL?.trim() || DEFAULT_API_URL;
  try {
    parseApiBase(githubURL, { allowLocal });
  } catch (error) {
    if (error instanceof GitHubError) throw new ConfigurationError(error.message);
    throw error;
  }
  const repos = repositories(env.ALLOWED_REPOS);
  const maxBodyChars = integer(env, 'MAX_BODY_CHARS', 6000, 500, 60000);
  return {
    name: env.NAME?.trim() || DEFAULT_NAME,
    nsec: env.NSEC ?? '',
    dataDir: env.DATA_DIR?.trim() || '',
    relays: list(env.RELAYS).length ? list(env.RELAYS) : DEFAULT_RELAYS,
    pictureURL: env.PICTURE_URL?.trim() || '',
    nip05: env.NIP05?.trim() || '',
    github: { token: githubToken(env.GITHUB_TOKEN), url: githubURL, allowLocal },
    ollama: {
      url: ollamaURL,
      allowRemote,
      model: env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
      timeoutMs: integer(env, 'OLLAMA_TIMEOUT_SECONDS', 180, 5, 3600) * 1000,
      // Roughly 3 characters per token, plus room for the JSON wrapper and title.
      maxTokens: Math.ceil(maxBodyChars / 3) + 400,
    },
    limits: {
      maxInputChars: integer(env, 'MAX_INPUT_CHARS', 4000, 100, 20000),
      maxBodyChars,
      requestsPerHour: integer(env, 'MAX_REQUESTS_PER_HOUR', 60, 1, 10000),
      modelCallsPerHour: integer(env, 'MAX_MODEL_CALLS_PER_HOUR', 20, 1, 10000),
      issuesPerDay: integer(env, 'MAX_ISSUES_PER_DAY', 10, 1, 1000),
      maxQueue: integer(env, 'MAX_QUEUE', 10, 1, 1000),
    },
    drafts: {
      maxPerUser: integer(env, 'MAX_DRAFTS_PER_USER', 10, 1, 100),
      ttlSeconds: integer(env, 'DRAFT_TTL_HOURS', 24, 1, 168) * 3600,
    },
    repos,
    access: {
      users: users(env.ALLOWED_USERS, repos),
      privateGroups: pubkeys(env.ALLOWED_PRIVATE_GROUPS, 'ALLOWED_PRIVATE_GROUPS'),
      publicGroups: publicGroups(env.ALLOWED_PUBLIC_GROUPS),
    },
  };
}
