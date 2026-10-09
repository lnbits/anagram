import { finishOnboarding } from './auth-helpers';
import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, nip19 } from 'nostr-tools';

async function setup(page: Page) {
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
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((url) => /\/src\/stores\/callStore\.ts(?:\?|$)/.test(url));
    const { useCallStore } = await import(url!);
    const call = useCallStore();
    (window as any).__testCall = call;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    const draw = () => {
      context.fillStyle = '#286dac';
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#fff';
      context.font = '32px sans-serif';
      context.fillText('Anagram camera preview', 100, 180);
    };
    draw();
    const timer = setInterval(draw, 100);
    const stream = canvas.captureStream(10);
    call.accept = async (mode: string) => {
      (window as any).__answerMode = mode;
      call.localStream = stream;
      call.session = {
        ...call.session,
        phase: 'active',
        startedAt: new Date(Date.now() - 61000).toISOString(),
        cameraMuted: mode === 'audio',
      };
    };
    call.end = async () => {
      call.session = { ...call.session, phase: 'ended', endReason: 'hangup' };
    };
    call.dismiss = () => {
      call.session = null;
      call.localStream = null;
    };
    call.toggleMicrophone = () => {
      call.session = { ...call.session, microphoneMuted: !call.session.microphoneMuted };
    };
    call.toggleCamera = () => {
      call.session = { ...call.session, cameraMuted: !call.session.cameraMuted };
    };
    call.selectMicrophone = async (id: string) => {
      (window as any).__microphone = id;
    };
    call.selectCamera = async (id: string) => {
      (window as any).__camera = id;
    };
    call.reset = () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      call.session = null;
      call.localStream = null;
    };
    call.session = {
      id: 'ui-fixture',
      peerPubkey: 'a'.repeat(64),
      peerName: 'Test contact',
      direction: 'incoming',
      mode: 'video',
      phase: 'incoming',
      startedAt: null,
      microphoneMuted: false,
      cameraMuted: true,
      mediaVersion: 2,
      videoAvailable: true,
      screenAvailable: true,
      peerConfirmed: true,
    };
  });
}

test('original incoming choices, compact call, controls tray, devices and presentation lifecycle', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await expect(page.getByTestId('call-accept')).toHaveText(/Answer with audio/);
  await expect(page.getByTestId('call-accept-video')).toBeVisible();
  await expect(page.getByTestId('call-decline')).toBeVisible();
  await expect(page.getByTestId('call-microphone')).toHaveCount(0);
  await page.getByTestId('call-accept').click();
  expect(await page.evaluate(() => (window as any).__answerMode)).toBe('audio');
  await expect(page.getByTestId('call-status')).toHaveText(/1:\d{2}/);
  await page.getByTestId('call-microphone').click();
  await expect(page.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('call-microphone-menu').click();
  await page.getByTestId('call-microphone-default').click();
  expect(await page.evaluate(() => (window as any).__microphone)).toBe('');
  await page.getByTestId('call-speaker').click();
  await expect(page.getByTestId('call-remote-audio')).toHaveJSProperty('muted', true);
  await page.getByTestId('call-camera').click();
  await expect(page.locator('video[aria-label="Your camera"]')).toBeVisible();
  await page.getByTestId('call-camera-menu').click();
  await page.getByTestId('call-camera-default').click();
  expect(await page.evaluate(() => (window as any).__camera)).toBe('');
  await page.getByTestId('call-max-fill').click();
  await expect(page.getByTestId('call-panel')).toHaveClass(/call-panel--fill/);
  await page
    .getByTestId('call-remote-audio')
    .evaluate((audio) => audio.setAttribute('data-retained', 'yes'));
  await page.getByTestId('call-minimize').click();
  await expect(page.getByTestId('call-panel')).toBeHidden();
  await expect(page.getByTestId('call-compact')).toBeVisible();
  await expect(page.getByTestId('call-remote-audio')).toHaveAttribute('data-retained', 'yes');
  await page.getByTestId('call-restore').click();
  await page.getByTestId('call-hide-controls').click();
  await expect(page.getByTestId('call-controls-tray')).toHaveClass(/--hidden/);
  await page.getByTestId('call-controls-edge').focus();
  await expect(page.getByTestId('call-controls-tray')).not.toHaveClass(/--hidden/);
  await page.getByTestId('call-hide-controls').click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('call-open-window').click();
  const popup = await popupPromise;
  await expect(popup.locator('canvas')).toHaveCount(1);
  await expect(popup.locator('audio,video')).toHaveCount(0);
  await expect(page.locator('video[aria-label="Your camera"]')).toHaveJSProperty(
    'isConnected',
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .getByTestId('call-panel')
      .evaluate((panel) => panel.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/call-ui-mobile.png' });
  await page.getByTestId('call-hangup').click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByTestId('call-dismiss')).toBeVisible();
  await page.getByTestId('call-dismiss').click();
  await expect(page.getByTestId('call-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('video answer, unsupported screen capture, playback recovery and session reset', async ({
  page,
}) => {
  await setup(page);
  await page.getByTestId('call-accept-video').click();
  expect(await page.evaluate(() => (window as any).__answerMode)).toBe('video');
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session.screenAvailable = false;
    const original = HTMLMediaElement.prototype.play;
    (window as any).__playBlocked = true;
    HTMLMediaElement.prototype.play = function () {
      if (this.dataset.testid !== 'call-remote-audio') return original.call(this);
      return (window as any).__playBlocked
        ? Promise.reject(new DOMException('Blocked', 'NotAllowedError'))
        : Promise.resolve();
    };
    call.remoteMediaUrl = URL.createObjectURL(new Blob(['test'], { type: 'audio/webm' }));
  });
  await expect(page.getByTestId('call-share-screen')).toBeDisabled();
  await expect(page.getByTestId('call-play-audio')).toBeVisible();
  await page.evaluate(() => ((window as any).__playBlocked = false));
  await page.getByTestId('call-play-audio').click();
  await expect(page.getByTestId('call-play-audio')).toBeHidden();
  await page.getByTestId('call-minimize').click();
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = { ...call.session, id: 'another-call', phase: 'incoming' };
  });
  await expect(page.getByTestId('call-panel')).toBeVisible();
  await expect(page.getByTestId('call-compact')).toBeHidden();
  await page.getByTestId('call-decline').click();
  await expect(page.getByTestId('call-dismiss')).toBeVisible();
});

test('room lobby validates links and offers audio and video creation', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (window as any).__testCall.dismiss());
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'Create or join a call' }).click();
  await expect(page.getByTestId('room-create-audio')).toBeVisible();
  await expect(page.getByTestId('room-create-video')).toBeVisible();
  await page.getByTestId('room-join-link').fill('not a call link');
  await expect(page.getByTestId('room-join-audio')).toBeDisabled();
  await expect(page.getByTestId('room-join-video')).toBeDisabled();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('custom call relay approval stays in the app and cancels when its endpoint closes', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const { guardCallRelay } = await import('/src/services/callRelayApproval.ts');
    let connected = 0;
    const endpoint = {
      online: async () => {},
      id: () => 'test',
      relay_url: () => '',
      connect: async () => {
        connected++;
      },
      accept: async () => {},
      close: async () => {},
    };
    const guarded = guardCallRelay(endpoint, []);
    (window as any).__approval = guarded;
    (window as any).__approvedConnections = () => connected;
    void guarded.connect('test', 'https://unfamiliar.example/', 'test-call').catch(() => {});
  });
  await expect(page.getByTestId('call-relay-approval')).toContainText(
    'https://unfamiliar.example/',
  );
  expect(await page.evaluate(() => (window as any).__approvedConnections())).toBe(0);
  await page.getByTestId('call-relay-decline').click();
  await expect(page.getByTestId('call-relay-approval')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__approvedConnections())).toBe(0);
  await page.evaluate(() => {
    void (window as any).__approval
      .connect('test', 'https://unfamiliar.example/', 'second')
      .catch(() => {});
  });
  await page.getByTestId('call-relay-allow').click();
  await expect.poll(() => page.evaluate(() => (window as any).__approvedConnections())).toBe(1);
  await page.evaluate(() => {
    void (window as any).__approval
      .connect('test', 'https://unfamiliar.example/', 'third')
      .catch(() => {});
  });
  await expect(page.getByTestId('call-relay-approval')).toBeVisible();
  await page.evaluate(() => (window as any).__approval.close());
  await expect(page.getByTestId('call-relay-approval')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__approvedConnections())).toBe(1);
});

test('mobile caller identity, photo fallback and phone controls survive peer changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://call-profile.example/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#326a99"/><circle cx="150" cy="110" r="55" fill="#c9dce5"/><path d="M50 300Q50 170 150 170Q250 170 250 300" fill="#c9dce5"/></svg>',
    }),
  );
  await setup(page);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/lib\/state\/publicProfiles\.ts(?:\?|$)/.test(url));
    const { rememberPublicProfile } = await import(url!);
    rememberPublicProfile(
      'a'.repeat(64),
      { name: 'Test contact', picture: 'https://call-profile.example/avatar.svg' },
      1,
    );
  });
  await expect(page.getByTestId('call-peer-npub')).toHaveText(nip19.npubEncode('a'.repeat(64)));
  await expect(page.locator('.call-backdrop img')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.call-backdrop img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  for (const id of ['call-accept', 'call-accept-video', 'call-decline']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(60);
    expect(box!.height).toBeGreaterThanOrEqual(60);
    expect(box!.y + box!.height).toBeLessThan(844);
  }
  await page.screenshot({ path: 'test-results/call-mobile-incoming.png' });
  await page.getByTestId('call-accept').click();
  expect(await page.evaluate(() => (window as any).__answerMode)).toBe('audio');
  await page.getByTestId('call-hangup').click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = {
      id: 'another-mobile-peer',
      peerPubkey: 'b'.repeat(64),
      peerName: 'A very long caller name '.repeat(10),
      direction: 'incoming',
      mode: 'video',
      phase: 'incoming',
      cameraMuted: true,
    };
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.locator('.call-backdrop img')).toHaveCount(0);
  await expect(page.getByTestId('call-peer-npub')).toHaveText(nip19.npubEncode('b'.repeat(64)));
  expect(
    await page
      .getByTestId('call-panel')
      .evaluate((panel) => panel.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.getByTestId('call-accept-video').click();
  expect(await page.evaluate(() => (window as any).__answerMode)).toBe('video');
  await expect(page.locator('video[aria-label="Your camera"]')).toBeVisible();
  await page.getByTestId('call-hangup').click();
  await page.getByTestId('call-dismiss').click();
});
