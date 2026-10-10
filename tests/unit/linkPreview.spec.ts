import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseLinkPreview, previewUrl } from '../../src/utils/linkPreview';
import {
  loadLinkPreview,
  loadPreviewImage,
  clearLinkPreviews,
} from '../../src/services/linkPreviewService';

beforeEach(() => vi.stubGlobal('window', {}));

afterEach(() => {
  clearLinkPreviews();
  vi.unstubAllGlobals();
});
describe('link previews', () => {
  it('reads Open Graph metadata, entities and relative images without executing HTML', () => {
    const result = parseLinkPreview(
      `<head><script>"<meta property='og:title' content='Wrong'>"</script>
      <!-- <meta property="og:title" content="Comment"> -->
      <meta content='Anagram &amp; friends' property='og:title'>
      <meta name="description" content="Fallback"><meta property="og:description" content="Public &#x1F310; &quot;chat&quot;">
      <meta property="og:image" content="/cover.png"><meta property="og:site_name" content="Example"></head>`,
      'https://example.org/post',
    );
    expect(result).toEqual({
      title: 'Anagram & friends',
      description: 'Public 🌐 "chat"',
      image: 'https://example.org/cover.png',
      site: 'Example',
    });
  });
  it('uses Twitter/title fallbacks and permits cards without thumbnails', () => {
    expect(parseLinkPreview('<title>Plain &lt;title&gt;</title>', 'https://example.org')).toEqual({
      title: 'Plain <title>',
      description: '',
      image: '',
      site: 'example.org',
    });
    expect(
      parseLinkPreview(
        '<meta name="twitter:title" content="Social card"><meta name="twitter:image" content="javascript:alert(1)">',
        'https://example.org',
      )?.image,
    ).toBe('');
    expect(parseLinkPreview('<p>No metadata</p>', 'https://example.org')).toBeNull();
  });
  it.each([
    '',
    'http://example.org',
    'https://user:secret@example.org',
    'https://localhost',
    'https://localhost.',
    'https://printer.local.',
    'https://127.1',
    'https://0x7f000001',
    'https://127.0.0.1',
    'https://2130706433',
    'https://0177.0.0.1',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]',
    'https://metadata.google.internal',
    'https://router.home.arpa',
    'https://printer.lan',
    'https://[::1]',
    'https://printer.local',
    'https://example.org:444/path',
    'data:text/html,test',
    'javascript:alert(1)',
    'https://example.org/nsec1secret',
    'https://example.org/%6esec1secret',
    'https://example.org/%256esec1secret',
    'https://example.org/%',
    'https://example.org/' + 'a'.repeat(4096),
  ])('does not fetch unsafe target %s', async (value) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(previewUrl(value)).toBeNull();
    expect(await loadLinkPreview(value)).toBeNull();
    expect(await loadPreviewImage(value)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never performs preview or thumbnail requests in a server environment', async () => {
    vi.stubGlobal('window', undefined);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await loadLinkPreview('https://example.org/server')).toBeNull();
    expect(await loadPreviewImage('https://example.org/server.png')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('loads bounded thumbnail blobs without redirects, credentials or referrers', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('image bytes', {
        headers: { 'content-type': 'image/png' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const blob = await loadPreviewImage('https://example.org/cover.png');
    expect(blob?.type).toBe('image/png');
    expect(await blob?.text()).toBe('image bytes');
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.org/cover.png',
      expect.objectContaining({
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    fetcher.mockResolvedValue(
      new Response('<script>bad()</script>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(await loadPreviewImage('https://example.org/fake.png')).toBeNull();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel,
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
    );
    expect(await loadPreviewImage('https://example.org/large.png')).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts thumbnail requests when their component is removed', async () => {
    const aborted = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                aborted();
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = loadPreviewImage('https://example.org/slow.png', controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(aborted).toHaveBeenCalledOnce();
  });
  it('bounds malformed metadata and ignores unterminated script/comment contents', () => {
    const source = 'https://example.org';
    expect(parseLinkPreview('<meta '.repeat(40000), source)).toBeNull();
    expect(parseLinkPreview(`<meta ${'x'.repeat(260000)}>`, source)).toBeNull();
    for (const prefix of ['<!--', '<script>']) {
      expect(
        parseLinkPreview(`${prefix}<meta property="og:title" content="Hidden">`, source),
      ).toBeNull();
    }
    expect(
      parseLinkPreview(
        '<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">',
        source,
      )?.title,
    ).toBe('<img src=x onerror=alert(1)>');
  });
  it('cancels active and queued requests and discards cached URLs on logout', async () => {
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const pending = Array.from({ length: 8 }, (_, i) =>
      loadLinkPreview(`https://example.org/pending-${i}`),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    clearLinkPreviews();
    expect(await Promise.all(pending)).toEqual(Array(8).fill(null));
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<title>New session</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    expect((await loadLinkPreview('https://example.org/pending-0'))?.title).toBe('New session');
  });
  it('does not truncate GitHub JSON at a head tag inside the description', async () => {
    const json = JSON.stringify({
      private: false,
      full_name: 'example/repo',
      description: '</head> text',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of [json.slice(0, -4), json.slice(-4)])
                controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
        ),
      ),
    );
    expect((await loadLinkPreview('https://github.com/example/repo'))?.description).toBe(
      '</head> text',
    );
  });
  it('deduplicates requests and omits credentials and referrers', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('<title>Shared preview</title>', { headers: { 'content-type': 'text/html' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const [a, b] = await Promise.all([
      loadLinkPreview('https://example.org/dedup#one'),
      loadLinkPreview('https://example.org/dedup#two'),
    ]);
    expect(a?.title).toBe('Shared preview');
    expect(b).toEqual(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.org/dedup',
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
  });
  it('renders public GitHub repository metadata and keeps the branch label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            private: false,
            full_name: 'lnbits/anagram',
            description: 'Nostr chat',
            owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
          }),
        ),
      ),
    );
    expect(await loadLinkPreview('https://github.com/lnbits/anagram/tree/brutal')).toEqual({
      title: 'lnbits/anagram at brutal',
      description: 'Nostr chat',
      site: 'GitHub',
      image: 'https://avatars.githubusercontent.com/u/1',
    });
  });
  it('silently falls back to the original link on fetch failure or oversized HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')));
    expect(await loadLinkPreview('https://example.org/cors')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('a'.repeat(262145), { headers: { 'content-type': 'text/html' } }),
        ),
    );
    expect(await loadLinkPreview('https://example.org/huge')).toBeNull();
  });
});
