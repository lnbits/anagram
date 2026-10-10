export interface LinkPreview {
  title: string;
  description: string;
  site: string;
  image: string;
}

// Reject explicit local addresses and secret-bearing URLs. Browser network policy
// remains responsible for DNS resolution; a hostname is not proof of a public IP.
export function previewUrl(value: string, base?: string): string | null {
  if (!value.trim() || value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    const hostname = url.hostname.replace(/\.+$/, '');
    // Reject nested encoding rather than letting a server decode hidden secrets.
    const decoded = decodeURIComponent(url.href);
    if (/%[\da-f]{2}|nsec1|bunker:|nostrconnect:/i.test(decoded)) return null;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !hostname.includes('.') ||
      /^[\d.]+$/.test(hostname) ||
      hostname.includes(':') ||
      /\.(localhost|local|localdomain|internal|home|lan|arpa|test|invalid)$/i.test(hostname)
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return (
      { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>
    )[entity.toLowerCase()];
  });
}
const text = (value: string, limit: number) =>
  decode(value).replace(/\s+/g, ' ').trim().slice(0, limit);

/** Read metadata as text only; never insert or execute a remote document. */
export function parseLinkPreview(html: string, source: string): LinkPreview | null {
  const url = previewUrl(source);
  if (!url) return null;
  const head = html
    .slice(0, 262144)
    .split(/<\/head\s*>/i)[0]
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<script\b[^<>]{0,4096}>[\s\S]*?(?:<\/script\s*>|$)/gi, '');
  const values = new Map<string, string>();
  // Bound tags and attribute names so malformed input cannot trigger long rescans.
  for (const tag of head.matchAll(/<meta\b[^<]{0,4096}>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(/([\w:-]{1,64})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
    const key = (attrs.get('property') || attrs.get('name') || '').toLowerCase();
    if (key && !values.has(key)) values.set(key, attrs.get('content') || '');
  }
  const title = text(
    values.get('og:title') ||
      values.get('twitter:title') ||
      head.match(/<title\b[^<>]{0,4096}>([^<]{0,4096})<\/title\s*>/i)?.[1] ||
      '',
    200,
  );
  if (!title) return null;
  return {
    title,
    description: text(
      values.get('og:description') ||
        values.get('twitter:description') ||
        values.get('description') ||
        '',
      360,
    ),
    site: text(values.get('og:site_name') || new URL(url).hostname, 80),
    image:
      previewUrl(
        decode(
          values.get('og:image:secure_url') ||
            values.get('og:image') ||
            values.get('twitter:image') ||
            '',
        ),
        url,
      ) || '',
  };
}
