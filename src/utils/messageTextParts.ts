import { parseRoomLink } from '#src/utils/callRoom.ts';
import {
  buildNostrMentionTextParts,
  type NostrMentionProfile,
  type NostrMentionTextPart,
} from '#src/utils/nostrMentions.ts';

export type MessageTextPart =
  | NostrMentionTextPart
  | {
      type: 'url';
      key: string;
      text: string;
      href: string;
    };

const WEB_URL_PATTERN = /\b(?:https?:\/\/|anagram:\/\/room\/call\/|www\.)[^\s<>"'`]+/giu;
const SIMPLE_TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/u;
const CLOSING_DELIMITERS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

function countCharacter(value: string, target: string): number {
  return Array.from(value).filter((character) => character === target).length;
}

function trimTrailingUrlPunctuation(candidate: string): string {
  let trimmed = candidate.replace(SIMPLE_TRAILING_PUNCTUATION_PATTERN, '');

  while (trimmed.length > 0) {
    const closingDelimiter = trimmed.at(-1) ?? '';
    const openingDelimiter = CLOSING_DELIMITERS[closingDelimiter];
    if (
      !openingDelimiter ||
      countCharacter(trimmed, closingDelimiter) <= countCharacter(trimmed, openingDelimiter)
    ) {
      break;
    }

    trimmed = trimmed.slice(0, -1).replace(SIMPLE_TRAILING_PUNCTUATION_PATTERN, '');
  }

  return trimmed;
}

function buildHttpHref(value: string): string | null {
  if (value.startsWith('anagram://room/call/')) return parseRoomLink(value) ? value : null;
  const href = /^www\./iu.test(value) ? `https://${value}` : value;

  try {
    const url = new URL(href);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function linkifyTextPart(part: NostrMentionTextPart): MessageTextPart[] {
  if (part.type !== 'text') {
    return [part];
  }

  const parts: MessageTextPart[] = [];
  let cursor = 0;
  let linkIndex = 0;

  for (const match of part.text.matchAll(WEB_URL_PATTERN)) {
    const matchStart = match.index;
    const rawCandidate = match[0];
    const linkText = trimTrailingUrlPunctuation(rawCandidate);
    const href = buildHttpHref(linkText);
    if (!href) {
      continue;
    }

    if (matchStart > cursor) {
      parts.push({
        type: 'text',
        key: `${part.key}-text-${cursor}`,
        text: part.text.slice(cursor, matchStart),
      });
    }

    parts.push({
      type: 'url',
      key: `${part.key}-url-${linkIndex}-${matchStart}`,
      text: linkText,
      href,
    });
    linkIndex += 1;
    cursor = matchStart + linkText.length;
  }

  if (cursor === 0) {
    return [part];
  }

  if (cursor < part.text.length) {
    parts.push({
      type: 'text',
      key: `${part.key}-text-tail-${cursor}`,
      text: part.text.slice(cursor),
    });
  }

  return parts;
}

export function buildMessageTextParts(
  text: string,
  profiles: NostrMentionProfile[] = [],
): MessageTextPart[] {
  return buildNostrMentionTextParts(text, profiles).flatMap(linkifyTextPart);
}

// Remove only duplicate links represented by visible image/video attachments.
// Work on original offsets so captions, mentions and unrelated links stay intact.
export function withoutPreviewMediaUrls(
  text: string,
  attachments: ReadonlyArray<{ url: string; mimeType: string }>,
): string {
  const previewUrls = new Set(
    attachments
      .filter(
        (attachment) =>
          /^https:\/\//.test(attachment.url) && /^(image|video)\//.test(attachment.mimeType),
      )
      .map((attachment) => buildHttpHref(attachment.url))
      .filter((href): href is string => Boolean(href)),
  );
  if (!previewUrls.size) return text;
  let cursor = 0;
  let result = '';
  for (const match of text.matchAll(WEB_URL_PATTERN)) {
    const candidate = trimTrailingUrlPunctuation(match[0]);
    const href = buildHttpHref(candidate);
    if (!href || !previewUrls.has(href)) continue;
    result += text.slice(cursor, match.index);
    cursor = match.index + candidate.length;
  }
  return cursor ? (result + text.slice(cursor)).trim() : text;
}
