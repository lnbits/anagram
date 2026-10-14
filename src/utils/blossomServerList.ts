import { normalizeBlossomServerUrl } from '#src/utils/blossomServer.ts';

// BUD-03 / NIP-B7: a replaceable kind 10063 event lists the Blossom servers that hold
// the author's files, one "server" tag per server.
export const BLOSSOM_SERVER_LIST_TAG = 'server';

export function normalizeBlossomServerUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const serverUrls: string[] = [];
  for (const entry of value) {
    const serverUrl = normalizeBlossomServerUrl(entry);
    if (serverUrl && !serverUrls.includes(serverUrl)) {
      serverUrls.push(serverUrl);
    }
  }

  return serverUrls;
}

// Tag order is the author's preference order, so it is preserved: the first entry is the
// server the author publishes first.
export function blossomServerUrlsFromTagsValue(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  return normalizeBlossomServerUrls(
    tags
      .filter(
        (tag): tag is unknown[] =>
          Array.isArray(tag) && tag[0] === BLOSSOM_SERVER_LIST_TAG && typeof tag[1] === 'string',
      )
      .map((tag) => tag[1]),
  );
}
