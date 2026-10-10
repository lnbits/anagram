import { parseLinkPreview, previewUrl, type LinkPreview } from '#src/utils/linkPreview.ts';

const cache = new Map<string, { expires: number; result: Promise<LinkPreview | null> }>();
const requests = new Set<AbortController>();
let active = 0;

export function clearLinkPreviews(): void {
  cache.clear();
  for (const controller of requests) controller.abort();
}
const queue: Array<() => void> = [];
const MAX_BYTES = 262144;
async function boundedText(response: Response, html = false): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Preview response too large');
      text += decoder.decode(value, { stream: true });
      if (html && /<\/head\s*>/i.test(text)) break;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
// Keep preview traffic in the browser/webview; never turn this into a server fetcher.
async function previewRequest<T>(
  request: (options: RequestInit) => Promise<T | null>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (typeof window === 'undefined' || signal?.aborted || queue.length >= 30) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  requests.add(controller);
  if (active >= 3) await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  const timer = setTimeout(abort, 6000);
  try {
    if (controller.signal.aborted) return null;
    return await request({
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    requests.delete(controller);
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
async function fetchPreview(url: string): Promise<LinkPreview | null> {
  return previewRequest(async (options) => {
    const parsed = new URL(url);
    // GitHub's page HTML is not CORS-readable, but its public repository API is.
    const repo =
      parsed.hostname === 'github.com' && parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/);
    if (repo) {
      const response = await fetch(`https://api.github.com/repos/${repo[1]}/${repo[2]}`, options);
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const data = JSON.parse(await boundedText(response));
      if (data.private !== false || typeof data.full_name !== 'string') return null;
      const location = parsed.pathname.startsWith(`/${repo[1]}/${repo[2]}/tree/`)
        ? ` at ${decodeURIComponent(parsed.pathname.split('/tree/')[1]).slice(0, 100)}`
        : '';
      return {
        title: `${data.full_name.slice(0, 150)}${location}`,
        description: typeof data.description === 'string' ? data.description.slice(0, 360) : '',
        site: 'GitHub',
        image:
          typeof data.owner?.avatar_url === 'string' ? previewUrl(data.owner.avatar_url) || '' : '',
      };
    }
    const response = await fetch(url, options);
    if (
      !response.ok ||
      !/\btext\/html\b|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')
    ) {
      await response.body?.cancel();
      return null;
    }
    return parseLinkPreview(await boundedText(response, true), url);
  });
}

/** Use the same request policy for thumbnails; a direct img URL would follow redirects. */
export function loadPreviewImage(value: string, signal?: AbortSignal): Promise<Blob | null> {
  const url = previewUrl(value);
  if (!url) return Promise.resolve(null);
  return previewRequest(async (options) => {
    const response = await fetch(url, options);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(type)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) return null;
        chunks.push(new Uint8Array(value).buffer);
      }
      return size ? new Blob(chunks, { type }) : null;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }, signal);
}
export function loadLinkPreview(value: string): Promise<LinkPreview | null> {
  const url = previewUrl(value);
  if (!url || typeof window === 'undefined') return Promise.resolve(null);
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (queue.length >= 30) return Promise.resolve(null);
  const entry = { expires: Date.now() + 30 * 60_000, result: fetchPreview(url) };
  cache.set(url, entry);
  void entry.result.then((result) => {
    if (!result) entry.expires = Date.now() + 60_000;
  });
  while (cache.size > 200) cache.delete(cache.keys().next().value!);
  return entry.result;
}
