// Turns chat text into a command or a prompt, and model output into safe reply text.
import { nip19 } from 'nostr-tools';

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

// Removes mentions of the bot itself, so "@bot /help" is a command and the prompt is clean.
export function stripMention(content, pubkey) {
  return String(content)
    .replace(MENTION, (match, bech32) => (mentionedKey(bech32) === pubkey ? ' ' : match))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Model output may contain npub/nprofile strings. Shorten them so a reply never mentions,
// and so never triggers, another bot in a group (a cheap guard against bot reply loops).
export function neutralizeMentions(text) {
  return text.replace(MENTION, (match, bech32) =>
    mentionedKey(bech32) ? `${bech32.slice(0, 12)}…${bech32.slice(-4)}` : match,
  );
}

export function shortId(pubkey) {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}

// "/help", "/reset please", "/MODEL" are commands. "/usr/bin" or "what is /reset?" are not.
export function parseCommand(text) {
  const match = /^\/([a-z]+)(?:\s|$)/i.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return ['help', 'reset', 'model'].includes(name) ? name : 'unknown';
}

export function helpText(model) {
  return [
    `I forward your messages to a local AI model (${model}) and reply with its answer.`,
    'Commands:',
    '/help — show this message',
    '/reset — forget this conversation',
    '/model — show the configured model',
    'In groups, mention me to talk to me. I remember recent messages of each conversation until /reset, a period of inactivity, or a restart.',
  ].join('\n');
}

// Applies the output limit on whole characters and marks shortened answers.
export function formatAnswer(text, maxChars, truncated = false) {
  let answer = neutralizeMentions(text.trim());
  const chars = [...answer];
  if (chars.length > maxChars) {
    answer = chars.slice(0, maxChars).join('').trimEnd();
    truncated = true;
  }
  return truncated ? `${answer}…\n[Answer shortened to fit the length limit.]` : answer;
}

// User-facing failure messages. They never include URLs, stack traces or configuration.
export function failureText(error, model) {
  switch (error?.code) {
    case 'model_not_found':
      return `The model "${model}" is not installed on the bot's Ollama server. The bot operator can install it with: ollama pull ${model}`;
    case 'timeout':
      return 'The model took too long to answer. Please try again, perhaps with a shorter question.';
    case 'unavailable':
      return 'The AI model is not reachable right now. Please try again later.';
    default:
      return 'The AI model returned an unexpected response. Please try again.';
  }
}
