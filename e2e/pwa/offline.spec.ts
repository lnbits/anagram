import { test, expect } from '@playwright/test';

test('installs the public app shell, opens deep links offline, and keeps private data out of Cache Storage', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  const response = await page.request.get(manifest!);
  const json = await response.json();
  expect(json.display).toBe('standalone');
  expect(json.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
  for (const icon of json.icons) expect((await page.request.get('/' + icon.src)).ok()).toBe(true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  const before = await page.evaluate(async () => {
    localStorage.setItem('pwa-cache-test', 'private-sentinel');
    const request = indexedDB.open('anagram-pwa-test', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('messages');
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction('messages', 'readwrite');
        tx.objectStore('messages').put('private-message-sentinel', 'test');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    return Promise.all(
      (await caches.keys()).map(async (name) => ({
        name,
        urls: (await (await caches.open(name)).keys()).map((request) => request.url),
      })),
    );
  });
  expect(before).toHaveLength(1);
  expect(before[0].urls.some((url) => url.endsWith('/index.html'))).toBe(true);
  expect(before[0].urls.some((url) => url.endsWith('.wasm'))).toBe(true);
  // Arbitrary same-origin responses are not added to the public asset allowlist.
  await page.evaluate(async () => {
    try {
      await fetch('/private-notes.json');
    } catch {}
  });
  await context.setOffline(true);
  await page.goto('/chats/' + 'a'.repeat(64));
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  const after = await page.evaluate(async () => ({
    marker: localStorage.getItem('pwa-cache-test'),
    urls: (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => request.url),
        ),
      )
    ).flat(),
    value: await new Promise((resolve, reject) => {
      const request = indexedDB.open('anagram-pwa-test');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          read = db.transaction('messages').objectStore('messages').get('test');
        read.onsuccess = () => {
          resolve(read.result);
          db.close();
        };
      };
    }),
  }));
  expect(after.marker).toBe('private-sentinel');
  expect(after.value).toBe('private-message-sentinel');
  expect(after.urls.sort()).toEqual(before[0].urls.sort());
});

test('does not register a web service worker inside Tauri', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} });
  });
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
});

test('saved NIP-17 replies reopen offline from IndexedDB in the production app', async ({
  page,
  context,
}) => {
  const { generateSecretKey, getPublicKey, finalizeEvent, nip59, nip19, matchFilters } =
    await import('nostr-tools');
  const { finishOnboarding } = await import('../auth-helpers');
  const ownKey = generateSecretKey(),
    peerKey = generateSecretKey(),
    own = getPublicKey(ownKey),
    peer = getPublicKey(peerKey);
  const outgoing: string[] = [];
  page.on('request', (request) => outgoing.push(request.url(), request.postData() ?? ''));
  page.on('websocket', (socket) =>
    socket.on('framesent', (frame) => outgoing.push(String(frame.payload))),
  );
  const relay = 'ws://127.0.0.1:49999/';
  const events = [
    finalizeEvent(
      {
        kind: 0,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        content: '{"name":"Offline peer"}',
      },
      peerKey,
    ),
    nip59.wrapEvent(
      { kind: 14, tags: [['p', peer]], content: 'Saved outgoing message' },
      ownKey,
      own,
    ),
    nip59.wrapEvent(
      { kind: 14, tags: [['p', own]], content: 'Saved incoming reply' },
      peerKey,
      own,
    ),
  ];
  await page.routeWebSocket(relay, (socket) =>
    socket.onMessage((raw) => {
      const [verb, id, ...filters] = JSON.parse(String(raw));
      if (verb === 'EVENT') socket.send(JSON.stringify(['OK', id.id, true, '']));
      if (verb !== 'REQ') return;
      for (const event of events.filter((event) => matchFilters(filters, event)))
        socket.send(JSON.stringify(['EVENT', id, event]));
      socket.send(JSON.stringify(['EOSE', id]));
    }),
  );
  await page.addInitScript((relay) => {
    const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
    localStorage.setItem('relays', entries);
    localStorage.setItem('nip65_relays', entries);
  }, relay);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(ownKey));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await page.getByTestId('chat-item').filter({ hasText: 'Offline peer' }).click();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Saved incoming reply' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('chat-data-indexeddb-v2');
        return new Promise<number>((resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              count = db.transaction('messages').objectStore('messages').count();
            count.onsuccess = () => {
              resolve(count.result);
              db.close();
            };
          };
        });
      }),
    )
    .toBe(2);
  expect(outgoing.length).toBeGreaterThan(0);
  for (const value of [
    nip19.nsecEncode(ownKey),
    Buffer.from(ownKey).toString('hex'),
    'Saved outgoing message',
    'Saved incoming reply',
  ])
    expect(outgoing.some((entry) => entry.includes(value))).toBe(false);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  // WebSocket interception must not supply another copy on reload.
  await page.routeWebSocket(relay, (socket) => socket.onMessage(() => {}));
  await page.reload();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Saved incoming reply' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Saved outgoing message' }),
  ).toBeVisible();
  await expect(page.locator('.thread-identity strong')).toHaveText('Offline peer');
  expect(
    await page.evaluate(async () => {
      try {
        await fetch('/index.html?reachability-check', { cache: 'no-store' });
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
});

test('a newly installed worker waits while the existing app is open', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  const original = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
  await page.evaluate(async () => {
    localStorage.setItem('pwa-draft-test', 'keep-this-draft');
    await navigator.serviceWorker.register('/service-worker.js?update-lifecycle-test', {
      type: 'module',
    });
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(original);
  expect(await page.evaluate(() => localStorage.getItem('pwa-draft-test'))).toBe('keep-this-draft');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
});

test('clean-URL redirects do not break repeat visits or offline navigation', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  // The host redirects /index.html to /index, including during precaching.
  expect(
    await page.evaluate(async () => {
      const cache = await caches.open(
        (await caches.keys()).find((name) => name.startsWith('anagram-shell-'))!,
      );
      return (await cache.match('/index.html'))!.redirected;
    }),
  ).toBe(true);
  for (const path of ['/', '/chats', '/']) {
    const response = await page.goto(path);
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  }
  await page.reload();
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await context.setOffline(true);
  await page.goto('/chats/' + 'a'.repeat(64));
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
});

test('cache read failures fall back to the network without breaking navigation', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    caches.open = async () => {
      throw new DOMException('Storage unavailable', 'UnknownError');
    };
  });
  await page.goto('/chats');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
});

test('cache write failures do not discard downloaded public assets', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  const asset = await page.evaluate(async () => {
    const cache = await caches.open(
      (await caches.keys()).find((name) => name.startsWith('anagram-shell-'))!,
    );
    const url = (await cache.keys()).find((request) => request.url.endsWith('.png'))!.url;
    await cache.delete(url);
    return url;
  });
  await context.serviceWorkers()[0].evaluate(() => {
    Cache.prototype.put = async () => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    };
  });
  const downloaded = await page.evaluate(async (asset) => {
    const response = await fetch(asset, { cache: 'reload' });
    return { ok: response.ok, size: (await response.blob()).size };
  }, asset);
  expect(downloaded.ok).toBe(true);
  expect(downloaded.size).toBeGreaterThan(0);
});
