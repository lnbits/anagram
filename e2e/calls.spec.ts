import { finishOnboarding } from './auth-helpers';
import { test, expect, chromium, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
test('live Iroh audio, video and group room connect two generated accounts', async ({
  baseURL,
}) => {
  test.skip(
    process.env.ANAGRAM_LIVE_CALL_TEST !== '1',
    'Requires external Iroh relay connectivity; uses fake audio/video capture.',
  );
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--ignore-certificate-errors',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const alice = generateSecretKey(),
    bob = generateSecretKey();
  const one = await browser.newContext({
      permissions: ['microphone', 'camera'],
      ignoreHTTPSErrors: true,
    }),
    two = await browser.newContext({
      permissions: ['microphone', 'camera'],
      ignoreHTTPSErrors: true,
    });
  const a = await one.newPage(),
    b = await two.newPage();
  async function login(page: Page, key: Uint8Array) {
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => {
      // A continuous test microphone makes active-speaker selection measurable.
      if (navigator.mediaDevices) {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const captured = await original(constraints);
          if (!constraints?.audio) return captured;
          captured.getAudioTracks().forEach((track) => track.stop());
          const context = new AudioContext();
          const tone = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0.15;
          const destination = context.createMediaStreamDestination();
          tone.connect(gain);
          gain.connect(destination);
          tone.start();
          await context.resume();
          const track = destination.stream.getAudioTracks()[0];
          track.addEventListener('ended', () => {
            tone.stop();
            void context.close();
          });
          return new MediaStream([track, ...captured.getVideoTracks()]);
        };
      }
      // Synthetic display capture still travels through the actual Iroh media path.
      if (navigator.mediaDevices)
        navigator.mediaDevices.getDisplayMedia = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext('2d')!;
          const timer = setInterval(() => {
            context.fillStyle = '#d64822';
            context.fillRect(0, 0, 640, 360);
            context.fillStyle = '#fff';
            context.font = '32px sans-serif';
            context.fillText('Shared presentation', 80, 180);
          }, 80);
          const stream = canvas.captureStream(12);
          stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
          return stream;
        };
      const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
      localStorage.setItem('relays', relays);
      localStorage.setItem('nip65_relays', relays);
    });
    await page.goto(baseURL!);
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  }
  async function contact(page: Page, pubkey: string) {
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(pubkey));
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  try {
    await login(a, alice);
    await login(b, bob);
    await contact(a, getPublicKey(bob));
    await contact(b, getPublicKey(alice));
    // Call first: neither account advertises an inbox or opts into app-relay delivery.
    await a.getByRole('button', { name: 'Audio call', exact: true }).click();
    await expect(b.getByTestId('call-accept')).toBeVisible({ timeout: 35000 });
    await b.getByTestId('call-accept').click();
    await expect
      .poll(
        async () =>
          a.evaluate(async () => {
            const { useCallStore } = await import('/src/stores/callStore.ts');
            return useCallStore().session?.phase;
          }),
        { timeout: 35000 },
      )
      .toBe('active');
    await expect
      .poll(
        async () =>
          b.evaluate(async () => {
            const { useCallStore } = await import('/src/stores/callStore.ts');
            return useCallStore().session?.phase;
          }),
        { timeout: 35000 },
      )
      .toBe('active');
    await expect
      .poll(
        async () =>
          b.locator('audio').evaluateAll((elements) =>
            elements.map((element) => ({
              buffered: element.buffered.length > 0,
              ready: element.readyState,
              src: Boolean(element.getAttribute('src')),
              paused: element.paused,
              error: element.error?.message,
            })),
          ),
        { timeout: 15000 },
      )
      .toContainEqual(expect.objectContaining({ buffered: true }));
    await a.getByTestId('call-camera').click();
    await expect
      .poll(
        async () =>
          b
            .locator('video[aria-label="Remote camera"]')
            .evaluateAll((elements) => elements.some((element) => element.readyState >= 2)),
        { timeout: 15000 },
      )
      .toBe(true);
    const presentationPromise = a.waitForEvent('popup');
    await a.getByTestId('call-share-screen').click();
    const presentation = await presentationPromise;
    await expect(b.getByTestId('call-screen-media')).toBeVisible();
    await expect
      .poll(() =>
        b
          .getByTestId('call-screen-media')
          .evaluate((node) => (node as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await expect(presentation.getByTestId('call-screen-media')).toHaveCount(1);
    await b.getByTestId('call-max-fill').click();
    await expect(b.getByTestId('call-screen-media')).toHaveCSS('object-fit', 'contain');
    await expect(b.getByTestId('call-remote-media')).toHaveCSS('object-fit', 'cover');
    await a.getByTestId('call-share-screen').click();
    await expect(b.getByTestId('call-screen-media')).toHaveCount(0);
    await presentation.close();
    await a.getByTestId('call-hangup').click();
    await a.getByTestId('call-dismiss').click();
    await expect(a.getByTestId('call-panel')).toBeHidden();
    await b.getByTestId('call-dismiss').click();
    await expect(b.getByTestId('message-call-history')).toHaveCount(1);
    await a.getByTestId('message-composer-input').fill('Call setup');
    await a.getByTestId('message-send-button').click();
    await expect(b.getByTestId('message-bubble').filter({ hasText: 'Call setup' })).toBeVisible();
    await a.getByRole('button', { name: 'Chat options' }).click();
    await a.getByRole('button', { name: 'Create or join a call' }).click();
    await a.getByTestId('room-create-audio').click();
    await expect
      .poll(
        async () =>
          a.evaluate(async () => {
            const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
            return useCallRoomStore().shareLink;
          }),
        { timeout: 15000 },
      )
      .not.toBe('');
    const link = await a.evaluate(async () => {
      const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
      return useCallRoomStore().shareLink;
    });
    await b.getByRole('button', { name: 'Chat options' }).click();
    await b.getByRole('button', { name: 'Create or join a call' }).click();
    await b.getByTestId('room-join-link').fill(link);
    await b.getByTestId('room-join-audio').click();
    await expect
      .poll(
        async () =>
          a.evaluate(async () => {
            const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
            return useCallRoomStore().participants.length;
          }),
        { timeout: 25000 },
      )
      .toBe(1);
    await expect
      .poll(
        async () =>
          b
            .locator('audio')
            .evaluateAll((elements) => elements.some((element) => element.buffered.length > 0)),
        { timeout: 15000 },
      )
      .toBe(true);
    await a.getByTestId('room-invite').click();
    await expect(a.getByTestId('room-link-hidden')).toBeVisible();
    await expect(a.getByTestId('room-link')).toHaveCount(0);
    await a.getByTestId('room-toggle-link').click();
    await expect(a.getByTestId('room-link')).toHaveValue(link);
    await a.getByTestId('room-invite-close').click();
    await a.getByTestId('room-invite').click();
    await expect(a.getByTestId('room-link')).toHaveCount(0);
    await a.getByTestId('room-invite-close').click();
    await b.getByTestId('room-microphone').click();
    await expect(b.getByTestId('room-local-muted')).toBeVisible();
    await expect(a.getByTestId('room-peer-muted')).toBeVisible();
    await b.getByTestId('room-view-toggle').click();
    await expect(b.locator('.room-grid')).toHaveClass(/room-grid--speaker/);
    await expect(b.getByTestId(`room-peer-${getPublicKey(alice)}`)).toHaveClass(
      /room-tile--speaker/,
      { timeout: 15000 },
    );
    await b.getByTestId('room-view-toggle').click();
    await b.getByTestId('room-minimize').click();
    await expect(b.getByTestId('room-panel')).toBeHidden();
    await expect(b.locator('audio').last()).toHaveJSProperty('isConnected', true);
    await b.getByTestId('room-restore').click();
    await a.getByTestId('room-share-screen').click();
    await expect(b.getByTestId('call-screen-media')).toBeVisible();
    await b.setViewportSize({ width: 390, height: 844 });
    expect(
      await b
        .getByTestId('room-panel')
        .evaluate((panel) => panel.scrollWidth <= innerWidth && panel.scrollHeight <= innerHeight),
    ).toBe(true);
    await b.screenshot({ path: 'test-results/call-room-mobile.png' });
    await a.getByTestId('room-share-screen').click();
    await expect(b.getByTestId('call-screen-media')).toHaveCount(0);
    await a.getByTestId('room-leave').click();
    await expect(a.getByTestId('room-dismiss')).toBeVisible();
    await a.getByTestId('room-dismiss').click();
    await expect(a.getByTestId('room-panel')).toBeHidden();
  } finally {
    await browser.close();
  }
});
