// Deterministic interpretation of chat text. These rules, not the model, decide whether a
// message is a command, a new request or a (refused) natural-language confirmation.
import { nip19 } from 'nostr-tools';

export const COMMANDS = ['help', 'new', 'drafts', 'edit', 'confirm', 'cancel', 'issues', 'who'];

// "/confirm K3P9QX" → { name: 'confirm', args: 'K3P9QX' }. "/usr/bin" is a command too
// ("unknown"), but "what is /help?" is not, because commands must start the message.
export function parseCommand(text) {
  const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: COMMANDS.includes(name) ? name : 'unknown', args: (match[2] ?? '').trim() };
}

// Splits "<ID> rest of the text" for /edit, /confirm, /cancel, /who.
export function splitId(args) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  return match ? { id: match[1], rest: (match[2] ?? '').trim() } : { id: '', rest: '' };
}

// GitHub owner names: 1-39 letters, digits or single hyphens. Repository names: letters,
// digits, ".", "_" and "-", up to 100 characters, not "." or "..".
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export function validRepo(value) {
  if (!REPO.test(value)) return false;
  const name = value.split('/')[1];
  return name !== '.' && name !== '..' && !name.endsWith('.git');
}

const URL_REPO =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/gi;
const BARE_REPO =
  /(?<![\w./@:#-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?![\w/])/g;

// Repository references written by the user, in order, without duplicates.
// explicit: written as a github.com link or after "in/for/to/into/repo", e.g. "in lnbits/anagram".
// Other "a/b" tokens (for example "and/or") are only used if they name an allowed repository.
export function repoRefs(text) {
  const found = new Map();
  const add = (owner, name, explicit, index, length) => {
    const repo = `${owner}/${name.replace(/\.git$/i, '').replace(/[.]+$/, '')}`;
    if (!validRepo(repo)) return;
    const key = repo.toLowerCase();
    const old = found.get(key);
    found.set(key, { repo, explicit: explicit || old?.explicit || false, index, length });
  };
  for (const match of text.matchAll(URL_REPO))
    add(match[1], match[2], true, match.index, match[0].length);
  const withoutUrls = text.replace(URL_REPO, (m) => ' '.repeat(m.length));
  for (const match of withoutUrls.matchAll(BARE_REPO)) {
    const before = withoutUrls.slice(0, match.index);
    add(match[1], match[2], /\b(?:in|for|to|into|repo|repository)\s*:?\s*$/i.test(before));
  }
  return [...found.values()].map(({ repo, explicit }) => ({ repo, explicit }));
}

// Phrases that sound like approval. They never publish; the bot replies with the command.
const APPROVAL =
  /^(?:y|yes|yep|yeah|sure|ok|okay|confirm(?:ed)?|approved?|publish(?: it)?|submit(?: it)?|go ahead|do it|lgtm|looks good)(?:[\s,]+(?:please|thanks|thank you|now))*[\s.!👍✅]*$/iu;
export function confirmationPhrase(text) {
  const clean = text.trim();
  // Short messages that ask to publish ("please confirm", "publish this one") also count.
  return (
    APPROVAL.test(clean) ||
    (clean.split(/\s+/).length <= 5 && /\b(confirm|publish|submit|approve)\b/i.test(clean))
  );
}

// Same mention syntax runtime.js recognizes: nostr:npub1..., npub1..., nprofile1...
const MENTION = /(?:nostr:)?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/gi;
function mentionedKey(bech32) {
  try {
    const decoded = nip19.decode(bech32);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    /* Not a valid mention. */
  }
  return undefined;
}
// Removes mentions of the bot itself, so "@bot /help" is a command and the request is clean.
export function stripMention(content, pubkey) {
  return String(content)
    .replace(MENTION, (match, bech32) => (mentionedKey(bech32) === pubkey ? ' ' : match))
    .replace(/^[\s,:;]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
// Shortens npub/nprofile strings so text the bot sends never mentions (pings) anyone.
export function neutralizeMentions(text) {
  return text.replace(MENTION, (match, bech32) =>
    mentionedKey(bech32) ? `${bech32.slice(0, 12)}…${bech32.slice(-4)}` : match,
  );
}

// The id of the message this one replies to: NIP-17 `e` tag marked `reply` (DMs and
// private groups) or NIP-C7 `q` tag (public groups).
export function replyTarget(message) {
  const tag =
    message.tags.find((t) => t[0] === 'e' && t[3] === 'reply') ??
    message.tags.find((t) => t[0] === 'q');
  return /^[a-f0-9]{64}$/.test(tag?.[1] ?? '') ? tag[1] : undefined;
}
