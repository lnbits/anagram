import { test, expect } from '@playwright/test';

const cards = [
  { path: '/', title: 'A Nostr Alternative Gram', card: 'anagram' },
  { path: '/join/chat.html', title: 'Join chat · Anagram', card: 'chat' },
  { path: '/join/call.html', title: 'Join call · Anagram', card: 'call' },
];
for (const card of cards) {
  test(`crawler receives the ${card.card} card without JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      userAgent: 'TelegramBot (like TwitterBot)',
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(`http://127.0.0.1:5189${card.path}`);
      expect(response!.status()).toBe(200);
      await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
        'content',
        card.title,
      );
      await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute(
        'content',
        card.title,
      );
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
        'content',
        'summary_large_image',
      );
      const image = `https://anagram.chat/social/${card.card}-v1.jpg`;
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', image);
      await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', image);
      const asset = await page.request.get(`http://127.0.0.1:5189${new URL(image).pathname}`);
      expect(asset.headers()['content-type']).toBe('image/jpeg');
      expect((await asset.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
      if (card.card === 'anagram')
        await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
          'content',
          'join us!',
        );
      else await expect(page.getByRole('link', { name: 'Open Anagram' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test('share entry pages preserve invitations with and without an offline PWA worker', async ({
  page,
  context,
}) => {
  const token = 'room-capability-test';
  // This is a syntactically valid entry token; the app validates the actual invitation before joining.
  const destinations = [
    { path: '/join/call.html', hash: `#/call/${token}`, expected: `/#/call/${token}` },
    { path: '/join/chat.html', hash: '#/public/naddr1qqqq', expected: '/public/naddr1qqqq' },
  ];
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  for (const offline of [false, true]) {
    if (offline) {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await expect
        .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
        .toBe(true);
      await context.setOffline(true);
    }
    for (const destination of destinations) {
      await page.goto(destination.path + destination.hash);
      await expect(page).toHaveURL(`http://127.0.0.1:5189${destination.expected}`);
      await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
    }
  }
  expect(requests.some((url) => url.includes(token))).toBe(false);
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => request.url),
        ),
      )
    ).flat(),
  );
  expect(cached.some((url) => url.endsWith('/join/call.html'))).toBe(true);
  expect(cached.some((url) => url.includes(token) || url.includes('/public/naddr'))).toBe(false);
});

test('share entry pages never redirect to an arbitrary fragment URL', async ({ page }) => {
  await page.goto('/join/chat.html#https://example.org/');
  await expect(page.getByRole('heading', { name: 'Join chat', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Anagram' })).toHaveAttribute('href', '/');
  await page.goto('/join/call.html#//example.org');
  await expect(page.getByRole('heading', { name: 'Join call', exact: true })).toBeVisible();
});
