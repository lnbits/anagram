import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, nip19 } from 'nostr-tools';
import QRCode from 'qrcode';
import { finishOnboarding } from './auth-helpers';

const npub = nip19.npubEncode('a'.repeat(64));
async function openContact(page: Page) {
  await page.addInitScript(() => {
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(generateSecretKey()));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByTestId('new-chat-button').click();
  await expect(
    page.getByRole('button', { name: 'Create a private group', exact: true }),
  ).toHaveCount(0);
}
async function camera(page: Page, text: string, mode: 'normal' | 'denied' | 'pending' = 'normal') {
  const data = await QRCode.toDataURL(text, { width: 400, margin: 4 });
  await page.evaluate(
    async ({ data, mode }) => {
      const fixture = window as any;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 480;
      const image = new Image();
      image.src = data;
      await image.decode();
      const ctx = canvas.getContext('2d')!;
      const draw = () => {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 480, 480);
        ctx.drawImage(image, 40, 40, 400, 400);
      };
      draw();
      setInterval(draw, 100);
      fixture.cameraMode = mode;
      fixture.cameraTracks = [];
      fixture.cameraRequests = [];
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        fixture.cameraRequests.push(constraints);
        if (fixture.cameraMode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
        const stream = canvas.captureStream(10);
        fixture.cameraTracks.push(...stream.getTracks());
        if (fixture.cameraMode === 'pending')
          await new Promise<void>((resolve) => {
            fixture.allowCamera = resolve;
          });
        return stream;
      };
    },
    { data, mode },
  );
}
async function cameraStopped(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tracks = (window as any).cameraTracks as MediaStreamTrack[];
        return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
      }),
    )
    .toBe(true);
}

for (const [prefix, width] of [
  ['', 1280],
  ['nostr:', 390],
] as const) {
  test(`scans ${prefix || 'bare'}npub camera QR at ${width}px and fills the field`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openContact(page);
    await camera(page, `${prefix}${npub}`);
    await page.getByLabel('Name (optional)').fill('Scanned contact');
    await page.getByRole('button', { name: 'Scan npub QR code', exact: true }).click();
    await expect(page.getByTestId('contact-identifier-input')).toHaveValue(npub);
    await expect(page.getByTestId('npub-scanner')).toHaveCount(0);
    await expect(page.getByLabel('Name (optional)')).toHaveValue('Scanned contact');
    await expect(page.getByRole('button', { name: 'Add contact', exact: true })).toBeEnabled();
    await expect(page.getByTestId('contact-identifier-input')).toBeFocused();
    await cameraStopped(page);
    const requests = await page.evaluate(() => (window as any).cameraRequests);
    expect(requests).toEqual([
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } },
    ]);
    await page.screenshot({ path: `test-results/npub-scanned-${width}.png` });
  });
}

test('unrelated QR leaves the field intact and cancelling or closing stops the camera', async ({
  page,
}) => {
  await openContact(page);
  await camera(page, 'https://example.org/not-a-profile');
  await page.getByTestId('contact-identifier-input').fill('keep-this-value');
  await page.getByRole('button', { name: 'Scan npub QR code', exact: true }).click();
  await expect(page.getByTestId('npub-scanner').getByRole('status')).toContainText('not an npub');
  await expect(page.getByTestId('contact-identifier-input')).toHaveValue('keep-this-value');
  await page.screenshot({ path: 'test-results/npub-scanner-camera.png' });
  await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await cameraStopped(page);
  await expect(page.getByRole('button', { name: 'Scan npub QR code', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Scan npub QR code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).cameraTracks.length)).toBe(2);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByTestId('npub-scanner')).toHaveCount(0);
  await cameraStopped(page);
});

test('camera denial can be retried, and late permission after closing releases the stream', async ({
  page,
}) => {
  await openContact(page);
  await camera(page, npub, 'denied');
  await page.getByRole('button', { name: 'Scan npub QR code', exact: true }).click();
  await expect(page.getByTestId('npub-scanner').getByRole('alert')).toContainText(
    'permission was denied',
  );
  await expect(page.getByTestId('contact-identifier-input')).toHaveValue('');
  await page.evaluate(() => {
    (window as any).cameraMode = 'normal';
  });
  await page.getByRole('button', { name: 'Try camera again', exact: true }).click();
  await expect(page.getByTestId('contact-identifier-input')).toHaveValue(npub);
  await cameraStopped(page);
  await page.evaluate(() => {
    (window as any).cameraMode = 'pending';
  });
  await page.getByRole('button', { name: 'Scan npub QR code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).allowCamera)).toBe('function');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('npub-scanner')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).allowCamera();
  });
  await cameraStopped(page);
});
