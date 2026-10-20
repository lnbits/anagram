import { test, expect } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

for (const [width, height] of [
  [1280, 844],
  [390, 844],
  [320, 844],
  [320, 568],
]) {
  test(`group invitation banner preserves usable login at ${width}x${height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    const picture = 'https://images.example.org/group.png';
    const event = finalizeEvent(
      {
        kind: 34550,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['d', 'lounge'],
          ['anagram-room', '1'],
          [
            'name',
            width === 320 ? 'Short name' : 'LNbits (ADMINS DO NOT DM | WATCH OUT FOR SCAMS)',
          ],
          ['image', picture],
          ['relay', 'wss://nos.lol'],
        ],
      },
      key,
    );
    await page.setViewportSize({ width, height });
    await page.route(picture, (route) =>
      route.fulfill({ path: 'static/anagram.png', contentType: 'image/png' }),
    );
    await page.routeWebSocket('wss://**', (socket) => {
      socket.onMessage((raw) => {
        const [type, id] = JSON.parse(String(raw));
        if (type === 'REQ') {
          socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }
      });
    });
    const naddr = nip19.naddrEncode({
      kind: 34550,
      pubkey,
      identifier: 'lounge',
      relays: ['wss://nos.lol'],
    });
    await page.goto('/');
    await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
    const originalCard = await page.locator('.auth-card').boundingBox();
    await page.goto(`/public/${naddr}`);
    const banner = page.getByTestId('auth-link-banner');
    await expect(banner).toHaveText(
      width === 320 ? 'Join the chat: Short name' : 'Join the chat: LNbits (ADMINS ...',
    );
    await expect(banner).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(banner).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(banner.locator('img')).toHaveAttribute('src', picture);
    await expect(page.getByTestId('auth-create-account-button')).toBeEnabled();
    const card = await page.locator('.auth-card').boundingBox();
    expect(card!.y).toBe(originalCard!.y);
    expect(card!.height).toBe(originalCard!.height);
    if (height === 568) {
      await expect(banner).toBeHidden();
      await expect(page.getByTestId('auth-create-account-button')).toBeInViewport();
      await page.getByTestId('auth-open-key-button').click();
      await expect(page.getByTestId('auth-private-key-input')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/public/${naddr}$`));
      expect(errors).toEqual([]);
      return;
    }
    const bounds = await banner.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(card!.y);
    const pictureBounds = await banner.locator('img').boundingBox();
    const nameBounds = await banner.locator('.name').boundingBox();
    expect(pictureBounds!.y).toBeGreaterThanOrEqual(0);
    const prefixBounds = await banner.locator('.prefix').boundingBox();
    expect(prefixBounds!.x + prefixBounds!.width).toBeLessThan(nameBounds!.x);
    expect(nameBounds!.x + nameBounds!.width).toBeLessThan(pictureBounds!.x);
    expect(nameBounds!.y + nameBounds!.height).toBeLessThan(card!.y);
    expect(Math.abs(pictureBounds!.y + pictureBounds!.height / 2 - card!.y / 2)).toBeLessThan(2);
    expect(Math.abs(nameBounds!.y + nameBounds!.height / 2 - card!.y / 2)).toBeLessThan(2);
    expect(pictureBounds!.width).toBe(28);
    expect(pictureBounds!.x + pictureBounds!.width).toBeLessThanOrEqual(width - 20);
    expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(2);
    await page.screenshot({ path: `test-results/auth-link-banner-${width}.png` });
    await page.getByTestId('auth-open-key-button').click();
    await expect(page.getByTestId('auth-private-key-input')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/public/${naddr}$`));
    expect(errors).toEqual([]);
  });
}

test('profile banner escapes names; missing metadata does not block login; home has no banner', async ({
  page,
}) => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ display_name: '<b>Alice</b>', picture: 'javascript:alert(1)' }),
    },
    key,
  );
  await page.routeWebSocket('wss://**', (socket) => {
    socket.onMessage((raw) => {
      const [type, id, filter] = JSON.parse(String(raw));
      if (
        type === 'REQ' &&
        filter.authors?.[0] === pubkey &&
        socket.url().startsWith('wss://purplepag.es/')
      ) {
        socket.send(JSON.stringify(['EVENT', id, event]));
        socket.send(JSON.stringify(['EOSE', id]));
      }
    });
  });
  await page.goto(`/chats/${pubkey}`);
  await expect(page.getByTestId('auth-link-banner')).toContainText('Chat with: <b>Alice</b>');
  await expect(page.getByTestId('auth-link-banner').locator('b, img')).toHaveCount(0);
  await page.goto(`/chats/${getPublicKey(generateSecretKey())}`);
  await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
  await expect(page.getByTestId('auth-link-banner')).toHaveCount(0);
  const missingGroup = nip19.naddrEncode({
    kind: 34550,
    pubkey,
    identifier: 'missing',
    relays: [],
  });
  await page.goto(`/public/${missingGroup}`);
  await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
  await expect(page.getByTestId('auth-link-banner')).toHaveCount(0);
  await page.getByTestId('auth-create-account-button').click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
  await expect(page.getByTestId('auth-link-banner')).toHaveCount(0);
});
