import { decodeRoomLink, encodeRoomLink } from '#src/stores/nostr/publicGroups.ts';

/** Recognize invitations locally; never fetch metadata from the pasted host. */
export function publicGroupLinkTarget(value: string): string | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return `/public/${encodeRoomLink(decodeRoomLink(url.href))}`;
  } catch {
    return null;
  }
}
