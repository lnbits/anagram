import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';

// Cache only public, deployment-owned files. Relay traffic, uploaded media,
// profiles, credentials and message data never enter this cache.
const scope = new URL(self.registration.scope);
const prefix = `anagram-shell-${encodeURIComponent(scope.pathname)}-`;
const cacheName = `${prefix}${version}`;
const shell = new URL('index.html', scope).href;
const urls = new Set([
  shell,
  ...immutable.map(({ path }) => new URL(path.replace(/^\//, ''), scope).href),
  ...assets
    .filter(({ path }) => !path.endsWith('.d.ts') && !path.endsWith('.txt'))
    .map(({ path }) => new URL(path.replace(/^\//, ''), scope).href),
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll([...urls].map((url) => new Request(url, { cache: 'reload' })));
      // No skipWaiting: a deployment must not interrupt calls/drafts in open tabs.
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.cache === 'no-store' ||
    url.origin !== scope.origin ||
    request.headers.has('range')
  )
    return;
  if (request.mode === 'navigate') {
    // Serve the HTML belonging to this worker, not a newer deployment's HTML
    // whose hashed chunks may not be cached. Deep links work offline too.
    event.respondWith(
      (async () => {
        // Static invitation pages must keep their redirect script when opened
        // from an installed PWA, including while offline. No invitation data is cached.
        const sharePage = /^\/join\/(chat|call)(?:\.html)?\/?$/.exec(url.pathname);
        const navigationShell = sharePage
          ? new URL(`join/${sharePage[1]}.html`, scope).href
          : shell;
        const saved = await readCached(navigationShell);
        if (!saved) return fetch(request);
        // Hosts such as `serve` redirect /index.html to /index. Cache Storage
        // preserves that redirect flag, but navigation requests use redirect:
        // manual and reject a redirected response with ERR_FAILED. Rebuild the
        // response without redirect metadata, retaining the exact HTML/headers.
        return saved.redirected
          ? new Response(saved.body, {
              status: saved.status,
              statusText: saved.statusText,
              headers: saved.headers,
            })
          : saved;
      })(),
    );
    return;
  }
  url.search = '';
  if (!urls.has(url.href)) return;
  event.respondWith(
    (async () => {
      const saved = await readCached(url.href);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        try {
          const cache = await caches.open(cacheName);
          await cache.put(url.href, response.clone());
        } catch {
          // Quota/storage failures must not discard a successful network response.
        }
      }
      return response;
    })(),
  );
});

async function readCached(url: string): Promise<Response | undefined> {
  try {
    return await (await caches.open(cacheName)).match(url);
  } catch {
    // Cache Storage can be unavailable or evicted independently of the worker.
    return undefined;
  }
}
