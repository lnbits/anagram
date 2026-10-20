import { nip19 } from '#src/lib/nostr/client.ts';

/** The public identity in a chat URL; excludes requests and secret-key links. */
export function chatLinkTarget(pathname: string): { pubkey: string; relays: string[] } | null {
  if (pathname.length > 8192) return null;
  try {
    const match = /^\/chats\/([^/]+)\/?$/.exec(pathname);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    if (/^[a-f0-9]{64}$/i.test(id)) return { pubkey: id.toLowerCase(), relays: [] };
    const decoded = nip19.decode(id);
    if (decoded.type === 'npub') return { pubkey: decoded.data, relays: [] };
    if (decoded.type === 'nprofile')
      return { pubkey: decoded.data.pubkey, relays: decoded.data.relays.slice(0, 8) };
  } catch {
    // Malformed links must never become local conversations.
  }
  return null;
}
