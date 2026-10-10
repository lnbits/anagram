import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  sendMessage,
  threadMessage,
} from '../helpers';

test('link cards display GitHub and Open Graph metadata, respect media trust, and fit mobile', async ({
  browser,
}, info) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.previewAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.previewBob);
  const github = 'https://github.com/lnbits/anagram/tree/brutal';
  const article = 'https://preview.example.org/article';
  let bobRequests = 0;
  try {
    for (const user of [alice, bob]) {
      await user.page.route('https://api.github.com/repos/lnbits/anagram', (route) => {
        if (user === bob) bobRequests++;
        return route.fulfill({
          json: {
            private: false,
            full_name: 'lnbits/anagram',
            description: 'Private Nostr messaging',
            owner: { avatar_url: 'https://preview.example.org/cover.svg' },
          },
        });
      });
      await user.page.route(article, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<head><meta property="og:title" content="Open Graph title"><meta property="og:description" content="A useful article"><meta property="og:image" content="/cover.svg"></head>',
        }),
      );
      await user.page.route('https://preview.example.org/cover.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>',
        }),
      );
    }
    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, `Here is the branch ${github}`);
    const sent = threadMessage(alice.page, 'Here is the branch');
    const received = threadMessage(bob.page, 'Here is the branch');
    await expect(sent.getByTestId('message-link-preview')).toContainText(
      'lnbits/anagram at brutal',
    );
    await expect(sent.getByTestId('message-link-preview')).toHaveAttribute('href', github);
    await expect(
      received.getByRole('button', { name: 'Load link preview', exact: true }),
    ).toBeVisible();
    expect(bobRequests).toBe(0);
    await received.getByRole('button', { name: 'Load link preview', exact: true }).click();
    await expect(received.getByTestId('message-link-preview')).toContainText(
      'Private Nostr messaging',
    );
    expect(bobRequests).toBe(1);
    await sendMessage(alice.page, `Read this ${article}`);
    const card = threadMessage(alice.page, 'Read this').getByTestId('message-link-preview');
    await expect(card).toContainText('Open Graph title');
    await expect(card.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(100);
    for (const layout of ['bubbles', 'text']) {
      await alice.page.evaluate((layout) => {
        localStorage.setItem('ui-desktop-message-layout', layout);
        window.dispatchEvent(
          new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout } }),
        );
      }, layout);
      for (const width of [1280, 390]) {
        await alice.page.setViewportSize({ width, height: 844 });
        await expect(card).toBeVisible();
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await alice.page.screenshot({ path: info.outputPath(`preview-${layout}-${width}.png`) });
      }
    }
    // Synthetic test-account secrets must never become preview HTTP requests,
    // including percent-encoded raw keys. Nothing here uses a real account key.
    const blockedRequests: string[] = [];
    await alice.page.route('https://preview.example.org/secret/**', (route) => {
      blockedRequests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: '<title>Must not fetch</title>' });
    });
    const key = alice.account.privateKey;
    const encodedKey = [...key].map((char) => `%${char.charCodeAt(0).toString(16)}`).join('');
    await sendMessage(
      alice.page,
      `Secret URL fixture https://preview.example.org/secret/${key} https://preview.example.org/secret/${encodedKey}`,
    );
    await expect(
      threadMessage(alice.page, 'Secret URL fixture').getByTestId('message-link-preview'),
    ).toHaveCount(0);
    await alice.page.route('https://preview.example.org/escaped', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;"><meta property="og:image" content="javascript:alert(1)">',
      }),
    );
    await sendMessage(alice.page, 'Escaped metadata https://preview.example.org/escaped');
    const escapedMessage = threadMessage(alice.page, 'Escaped metadata');
    // Layout/viewport changes can leave the thread scrolled above this message.
    // Link previews intentionally fetch only when their container enters view.
    await escapedMessage.locator('.preview-container').scrollIntoViewIfNeeded();
    const escaped = escapedMessage.getByTestId('message-link-preview');
    await expect(escaped).toContainText('<img src=x onerror=alert(1)>');
    await expect(escaped.locator('img, script')).toHaveCount(0);
    expect(blockedRequests).toEqual([]);
    await alice.page.route('https://preview.example.org/unavailable', (route) => route.abort());
    await sendMessage(alice.page, 'Still clickable https://preview.example.org/unavailable');
    await expect(
      threadMessage(alice.page, 'Still clickable').getByTestId('message-url-link'),
    ).toBeVisible();
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('preview metadata and thumbnails reject private targets and never follow redirects', async ({
  page,
}) => {
  await page.goto('/');
  const privateRequests: string[] = [];
  await page.route(
    /^https:\/\/(?:127\.0\.0\.1|10\.0\.0\.1|169\.254\.169\.254)(?::\d+)?\//,
    (route) => {
      privateRequests.push(route.request().url());
      return route.abort();
    },
  );
  await page.route('https://preview.example.org/redirect-*', (route) =>
    route.fulfill({
      status: 302,
      headers: { location: 'https://127.0.0.1/private', 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('https://preview.example.org/private-image', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'access-control-allow-origin': '*' },
      body: '<title>Safe text</title><meta property="og:image" content="https://169.254.169.254/latest/meta-data">',
    }),
  );
  const results = await page.evaluate(async () => {
    const { loadLinkPreview, loadPreviewImage } =
      await import('/src/services/linkPreviewService.ts');
    return {
      metadataRedirect: await loadLinkPreview('https://preview.example.org/redirect-page'),
      imageRedirect: await loadPreviewImage('https://preview.example.org/redirect-image'),
      local: await loadLinkPreview('https://127.0.0.1/private'),
      localImage: await loadPreviewImage('https://10.0.0.1/private.png'),
      metadata: await loadLinkPreview('https://preview.example.org/private-image'),
    };
  });
  expect(results).toMatchObject({
    metadataRedirect: null,
    imageRedirect: null,
    local: null,
    localImage: null,
    metadata: { title: 'Safe text', image: '' },
  });
  expect(privateRequests).toEqual([]);
});
