import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openAppRelaysSettings,
  reloadAndWaitForApp,
} from './helpers';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve('e2e/fixtures/call-tone.wav')}`,
      '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
    ],
  },
});
test.describe.configure({ mode: 'serial' });
const aliceAccount = {
  privateKey: '7171717171717171717171717171717171717171717171717171717171717171',
  displayName: 'Alice Calls',
};
const bobAccount = {
  privateKey: '7272727272727272727272727272727272727272727272727272727272727272',
  displayName: 'Bob Calls',
};

// Check decoded, audible samples in both directions, rather than container time alone.
async function expectAudible(page: Page, selector = '[data-testid="call-remote-audio"]') {
  await expect
    .poll(
      () =>
        page.evaluate(async (selector) => {
          const element = document.querySelector<HTMLAudioElement>(selector);
          if (!element || element.paused || element.muted || !element.src.startsWith('blob:'))
            return false;
          const scope = window as unknown as {
            callAudioTest?: { context: AudioContext; analyser: AnalyserNode; sourceUrl: string };
          };
          if (!scope.callAudioTest || scope.callAudioTest.sourceUrl !== element.src) {
            const previous = scope.callAudioTest;
            scope.callAudioTest = undefined;
            if (previous && previous.context.state !== 'closed') await previous.context.close();
            const context = new AudioContext();
            const analyser = context.createAnalyser();
            // Capture a copy instead of diverting playback through Web Audio, which bypasses setSinkId.
            const captured = (
              element as HTMLAudioElement & { captureStream(): MediaStream }
            ).captureStream();
            if (!captured.getAudioTracks().length) {
              await context.close();
              return false;
            }
            context.createMediaStreamSource(captured).connect(analyser);
            const silent = context.createGain();
            silent.gain.value = 0;
            analyser.connect(silent).connect(context.destination);
            scope.callAudioTest = { context, analyser, sourceUrl: element.src };
          }
          await scope.callAudioTest.context.resume();
          const samples = new Float32Array(2048);
          scope.callAudioTest.analyser.getFloatTimeDomainData(samples);
          return samples.some((value) => Math.abs(value) > 0.003);
        }, selector),
      { timeout: 15_000 }
    )
    .toBe(true);
}

async function chooseCustomCallRelay(page: Page) {
  await openAppRelaysSettings(page);
  await page.getByTestId('settings-relays-iroh-tab').click();
  await page.getByTestId('iroh-new-relay').fill('https://localhost:7004/');
  await page.getByTestId('iroh-add-relay').click();
  await expect(page.getByTestId('iroh-new-relay')).toHaveValue('');
  await page.getByTestId('iroh-mode-custom').click();
  await expect(page.getByTestId('iroh-mode-custom')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('iroh-new-relay')).toBeEnabled();
}

test('video and audio calls carry real media over Iroh, support mute and survive navigation', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, aliceAccount, { callMedia: true });
  const bob = await bootstrapUser(browser, bobAccount, { callMedia: true });
  const publicAddressRequests: string[] = [];
  for (const user of [alice, bob]) {
    user.page.on('request', (request) => {
      if (new URL(request.url()).hostname === 'dns.iroh.link')
        publicAddressRequests.push(request.url());
    });
  }
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await navigateToChat(bob.page, alice.session.publicKey);
    await chooseCustomCallRelay(alice.page);
    await reloadAndWaitForApp(alice.page);
    await navigateToChat(alice.page, bob.session.publicKey);
    const selectedRelaySockets: string[] = [];
    alice.page.on('websocket', (socket) => {
      if (new URL(socket.url()).hostname === 'localhost') selectedRelaySockets.push(socket.url());
    });
    const beforeAlice = await alice.page.locator('.thread-message-entry').count();
    const beforeBob = await bob.page.locator('.thread-message-entry').count();
    await alice.page.getByTestId('thread-video-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    expect(
      (await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).hasLocalStream
    ).toBe(false);
    await bob.page.getByTestId('call-accept-video').click();
    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('call-status')).toHaveText(/\d+:\d{2}/);
      await expect
        .poll(() =>
          user.page.getByTestId('call-remote-media').evaluate((node) => {
            const video = node as HTMLVideoElement;
            return video.videoWidth > 0 && video.currentTime > 0;
          })
        )
        .toBe(true);
    }
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    const oldCameraUrl = await bob.page.getByTestId('call-remote-media').getAttribute('src');
    await alice.page.getByTestId('call-camera-menu').click();
    await alice.page.getByTestId('call-camera-source-0').click();
    await expect(bob.page.getByTestId('call-remote-media')).not.toHaveAttribute(
      'src',
      oldCameraUrl!
    );
    await expect
      .poll(() =>
        bob.page
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await expectAudible(bob.page);
    await alice.page.getByTestId('call-microphone').click();
    await alice.page.getByTestId('call-camera').click();
    const muted = await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot());
    expect(muted.audioEnabled).toEqual([false]);
    expect(muted.videoEnabled).toEqual([]);
    expect(muted.session?.cameraMuted).toBe(true);
    await alice.page.getByTestId('call-microphone').click();
    await alice.page.getByTestId('call-camera').click();
    await alice.page.getByLabel('Minimize call').click();
    await expect(alice.page.getByTestId('call-compact')).toBeVisible();
    await expect(alice.page.getByTestId('call-panel')).not.toBeVisible();
    await alice.page.evaluate(() => {
      location.hash = '/contacts';
    });
    await expect(alice.page.getByTestId('call-compact')).toBeVisible();
    await alice.page.getByLabel('Return to call').click();
    await alice.page.getByTestId('call-hangup').click();
    await expect(alice.page.getByTestId('call-status')).toHaveText('Call ended');
    await expect(bob.page.getByTestId('call-status')).toHaveText('Call ended');
    expect(
      (await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot())).hasLocalStream
    ).toBe(false);
    expect(
      (await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).hasLocalStream
    ).toBe(false);
    await alice.page.getByTestId('call-dismiss').click();
    await bob.page.getByTestId('call-dismiss').click();
    await navigateToChat(alice.page, bob.session.publicKey);
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    await bob.page.getByTestId('call-accept').click();
    await expect
      .poll(async () => {
        const snapshot = await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot());
        return { phase: snapshot.session?.phase, failureDetail: snapshot.failureDetail };
      })
      .toEqual({ phase: 'active', failureDetail: '' });
    await expect(alice.page.getByTestId('call-status')).toHaveText(/\d+:\d{2}/);
    expect(
      (await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot())).videoEnabled
    ).toEqual([]);
    await expect
      .poll(() =>
        bob.page
          .getByTestId('call-remote-audio')
          .evaluate((node) => (node as HTMLAudioElement).currentTime)
      )
      .toBeGreaterThan(0);
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    await alice.page.getByTestId('call-microphone-menu').click();
    await alice.page.getByTestId('call-microphone-default').click();
    await expectAudible(bob.page);
    await alice.page.getByTestId('call-speaker-menu').click();
    if (await alice.page.getByTestId('call-speaker-source-0').count()) {
      await alice.page.getByTestId('call-speaker-source-0').click();
      await expect
        .poll(() =>
          alice.page
            .getByTestId('call-remote-audio')
            .evaluate((node) => (node as HTMLAudioElement).sinkId)
        )
        .not.toBe('');
      await alice.page.getByTestId('call-speaker-menu').click();
    }
    await alice.page.getByTestId('call-speaker-default').click();
    await expectAudible(alice.page);
    // An audio call can become video, and each peer can independently stop its camera.
    await alice.page.getByTestId('call-camera').click();
    await expect
      .poll(() =>
        bob.page
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await bob.page.getByTestId('call-camera').click();
    await expect
      .poll(() =>
        alice.page
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await alice.page.getByTestId('call-camera').click();
    await bob.page.getByTestId('call-camera').click();
    await expect(bob.page.getByTestId('call-remote-media')).toHaveCount(0);
    await expect(alice.page.getByTestId('call-remote-media')).toHaveCount(0);
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    await bob.page.getByTestId('call-hangup').click();
    await expect(alice.page.getByTestId('call-status')).toHaveText('Call ended');
    await alice.page.getByTestId('call-dismiss').click();
    await bob.page.getByTestId('call-dismiss').click();
    await expect(alice.page.locator('.thread-message-entry')).toHaveCount(beforeAlice + 2);
    await expect(bob.page.locator('.thread-message-entry')).toHaveCount(beforeBob + 2);
    expect(publicAddressRequests).toEqual([]);
    expect(selectedRelaySockets.length).toBeGreaterThan(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('call history survives reload, offers redial and does not restore ringing', async ({
  browser,
}) => {
  const alice = await bootstrapUser(
    browser,
    {
      ...aliceAccount,
      privateKey: '7373737373737373737373737373737373737373737373737373737373737373',
    },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    {
      ...bobAccount,
      privateKey: '7474747474747474747474747474747474747474747474747474747474747474',
    },
    { callMedia: true }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    await bob.page.getByTestId('call-decline').click();
    await expect(alice.page.getByTestId('call-status')).toHaveText('Call declined');
    await alice.page.getByTestId('call-dismiss').click();
    await bob.page.getByTestId('call-dismiss').click();
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(bob.page.getByTestId('message-call-history')).toHaveCount(1);
    await expect(bob.page.getByTestId('message-call-history')).toContainText('Declined');
    await expect(alice.page.getByTestId('message-call-history')).toHaveCount(1);
    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(bob.page.getByTestId('call-panel')).not.toBeVisible();
    await expect(bob.page.getByTestId('message-call-history')).toHaveCount(1);
    await alice.page.getByTestId('message-call-again').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    await alice.page.getByTestId('call-hangup').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Call cancelled');
    await alice.page.getByTestId('call-dismiss').click();
    await bob.page.getByTestId('call-dismiss').click();
    await expect(alice.page.getByTestId('message-call-history')).toHaveCount(2);
    await expect(bob.page.getByTestId('message-call-history')).toHaveCount(2);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('unsupported browsers and busy devices report the actual problem before negotiating', async ({
  browser,
}) => {
  const alice = await bootstrapUser(
    browser,
    { privateKey: '75'.repeat(32), displayName: 'Capability Alice' },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: '76'.repeat(32), displayName: 'Capability Bob' },
    { callMedia: true }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await alice.page.evaluate(() => {
      const original = MediaRecorder.isTypeSupported;
      Object.defineProperty(window, 'restoreCallCodecSupport', {
        value: () => {
          MediaRecorder.isTypeSupported = original;
        },
      });
      MediaRecorder.isTypeSupported = () => false;
    });
    await alice.page.getByTestId('thread-audio-call').click();
    const unsupported = alice.page
      .getByRole('alert')
      .filter({ hasText: 'This browser cannot run Iroh calls' });
    await expect(unsupported).toBeVisible();
    await expect(unsupported).toContainText('Chrome, Edge, or Firefox');
    expect(
      (await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot())).session
    ).toBeNull();
    expect((await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).session).toBeNull();
    await unsupported.locator('..').getByRole('button', { name: 'Close', exact: true }).click();
    await alice.page.evaluate(async () => {
      (window as unknown as { restoreCallCodecSupport(): void }).restoreCallCodecSupport();
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (status.state !== 'granted') throw new Error('Test microphone permission is not granted');
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Device is busy', 'NotReadableError');
      };
    });
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(alice.page.getByRole('alert')).toContainText('could not be opened');
    await expect(alice.page.getByRole('alert')).not.toContainText('denied');
    expect((await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).session).toBeNull();
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('a peer with no responding call client ends negotiation after ten seconds', async ({
  browser,
}) => {
  const alice = await bootstrapUser(
    browser,
    { privateKey: '77'.repeat(32), displayName: 'Timeout Alice' },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: '78'.repeat(32), displayName: 'Timeout Bob' },
    { callMedia: true }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await bob.context.close();
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(alice.page.getByTestId('call-status')).toContainText('No call response', {
      timeout: 20_000,
    });
    const snapshot = await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot());
    expect(snapshot.session?.endReason).toBe('unsupported');
    expect(snapshot.hasLocalStream).toBe(false);
    await expectNoUnexpectedBrowserErrors([alice]);
  } finally {
    await alice.context.close();
  }
});

test('blocked audio playback has its own recovery action and works in the mobile call panel', async ({
  browser,
}) => {
  const alice = await bootstrapUser(
    browser,
    { privateKey: '79'.repeat(32), displayName: 'Playback Alice' },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: '7a'.repeat(32), displayName: 'Playback Bob' },
    { callMedia: true }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await bob.page.setViewportSize({ width: 390, height: 844 });
    await alice.page.evaluate(() => {
      const scope = window as unknown as { blockCallAudio: boolean };
      scope.blockCallAudio = true;
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.tagName === 'AUDIO' && this.src.startsWith('blob:') && scope.blockCallAudio)
          return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
        return original.call(this);
      };
      const element = document.querySelector<HTMLAudioElement>('[data-testid="call-remote-audio"]');
      if (element) element.autoplay = false;
    });
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    await bob.page.getByTestId('call-accept').click();
    await expect(alice.page.getByTestId('call-play-audio')).toBeVisible();
    await expect(alice.page.getByTestId('call-status')).toHaveText(/\d+:\d{2}/);
    await expect(alice.page.getByRole('alert')).toHaveCount(0);
    expect(
      (await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot())).hasLocalStream
    ).toBe(true);
    await alice.page.evaluate(() => {
      (window as unknown as { blockCallAudio: boolean }).blockCallAudio = false;
    });
    await alice.page.getByTestId('call-play-audio').click();
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    await bob.page.getByTestId('call-camera').click();
    await expect
      .poll(() =>
        alice.page
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await bob.page.getByTestId('call-hangup').click();
    await expect(alice.page.getByTestId('call-status')).toHaveText('Call ended');
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('video invitations can be answered with audio and screen sharing stays separate from the camera', async ({
  browser,
}) => {
  const alice = await bootstrapUser(
    browser,
    { privateKey: '81'.repeat(32), displayName: 'Screen Alice' },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: '82'.repeat(32), displayName: 'Screen Bob' },
    { callMedia: true }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await alice.page.getByTestId('thread-video-call').click();
    await bob.page.getByTestId('call-accept').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText(/\d+:\d{2}/);
    expect(
      (await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).videoEnabled
    ).toEqual([]);
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    // Deterministic screen content; native screen selection is exercised separately in Electron.
    await alice.page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    });
    const popupPromise = alice.page.waitForEvent('popup');
    await alice.page.getByTestId('call-share-screen').click();
    const popup = await popupPromise;
    await expect
      .poll(() =>
        bob.page
          .getByTestId('call-screen-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        bob.page
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    await expectAudible(bob.page);
    await expect(popup.getByTestId('call-screen-media')).toBeVisible();
    const receiverWindowPromise = bob.page.waitForEvent('popup');
    await bob.page.getByTestId('call-open-window').click();
    const receiverWindow = await receiverWindowPromise;
    for (const id of ['call-screen-media', 'call-remote-media']) {
      await expect
        .poll(() =>
          receiverWindow.getByTestId(id).evaluate((node) => {
            const canvas = node as HTMLCanvasElement;
            return canvas
              .getContext('2d')
              ?.getImageData(0, 0, canvas.width, canvas.height)
              .data.some((value, index) => index % 4 !== 3 && value > 0);
          })
        )
        .toBe(true);
    }
    await expectAudible(bob.page);
    await receiverWindow.close();
    await popup.close();
    await expect(alice.page.getByTestId('call-screen-media')).toBeVisible();
    await alice.page.getByTestId('call-share-screen').click();
    await expect(bob.page.getByTestId('call-screen-media')).toHaveCount(0);
    await expectAudible(alice.page);
    await expectAudible(bob.page);
    await alice.page.getByTestId('call-hangup').click();
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('three users join a shared call link, exchange Iroh media, share screens and leave cleanly', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(
    browser,
    { privateKey: '83'.repeat(32), displayName: 'Room Alice' },
    { callMedia: true }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: '84'.repeat(32), displayName: 'Room Bob' },
    { callMedia: true }
  );
  const charlie = await bootstrapUser(
    browser,
    { privateKey: '85'.repeat(32), displayName: 'Room Charlie' },
    { callMedia: true }
  );
  try {
    await chooseCustomCallRelay(alice.page);
    await alice.page.goto('/#/chats');
    await alice.page.getByTestId('start-new-chat-button').click();
    const chatPage = alice.page;
    const callTabPromise = alice.context.waitForEvent('page');
    await chatPage.getByTestId('start-call-room').click();
    alice.page = await callTabPromise;
    const selectedRelaySockets: string[] = [];
    alice.page.on('websocket', (socket) => {
      if (new URL(socket.url()).hostname === 'localhost') selectedRelaySockets.push(socket.url());
    });
    await expect(chatPage.getByTestId('start-new-chat-button')).toBeVisible();
    await expect(chatPage.getByTestId('room-panel')).toHaveCount(0);
    await alice.page.getByTestId('room-create-audio').click();
    await expect(alice.page.getByTestId('room-status')).toHaveText('Call is open');
    await expect(alice.page.getByTestId('room-link')).toHaveCount(0);
    await alice.page.getByTestId('room-invite').click();
    await expect(alice.page.getByTestId('room-link-hidden')).toBeVisible();
    await expect(alice.page.getByTestId('room-link')).toHaveCount(0);
    await alice.page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          sessionStorage.setItem('e2e-copied-invite', text);
        },
      });
    });
    await alice.page.getByTestId('room-copy-link').click();
    const link = await alice.page.evaluate(() => sessionStorage.getItem('e2e-copied-invite'));
    expect(link).toContain('#/call/');
    if (!link) throw new Error('Invite was not copied');
    await expect(alice.page.getByTestId('room-link')).toHaveCount(0);
    await alice.page.getByTestId('room-toggle-link').click();
    await expect(alice.page.getByTestId('room-link')).toHaveValue(link);
    await alice.page.getByTestId('room-invite-close').click();
    await alice.page.getByTestId('room-invite').click();
    await expect(alice.page.getByTestId('room-link-hidden')).toBeVisible();
    await expect(alice.page.getByTestId('room-link')).toHaveCount(0);
    await alice.page.getByTestId('room-invite-close').click();
    // Neither guest needs an existing accepted DM with the host or with each other.
    for (const guest of [bob, charlie]) {
      await guest.page.goto(link);
      await guest.page.getByTestId('room-join-audio').click();
      await expect(guest.page.getByTestId('room-status')).toHaveText('Call is open');
    }
    for (const user of [alice, bob, charlie]) {
      for (const other of [alice, bob, charlie].filter((other) => other !== user)) {
        await expectAudible(user.page, `[data-testid="room-audio-${other.session.publicKey}"]`);
      }
    }
    await alice.page.getByTestId('room-camera').click();
    await expect
      .poll(() =>
        bob.page
          .getByTestId(`room-peer-${alice.session.publicKey}`)
          .locator('video')
          .evaluate((node) => (node as HTMLVideoElement).videoWidth)
      )
      .toBeGreaterThan(0);
    const peerCamera = bob.page
      .getByTestId(`room-peer-${alice.session.publicKey}`)
      .locator('video');
    const oldCameraUrl = await peerCamera.getAttribute('src');
    await alice.page.getByTestId('room-camera-menu').click();
    await alice.page.getByTestId('room-camera-source-0').click();
    await expect(peerCamera).not.toHaveAttribute('src', oldCameraUrl!);
    await expect
      .poll(() => peerCamera.evaluate((node) => (node as HTMLVideoElement).videoWidth))
      .toBeGreaterThan(0);
    await expectAudible(bob.page, `[data-testid="room-audio-${alice.session.publicKey}"]`);
    await charlie.page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    });
    await charlie.page.getByTestId('room-share-screen').click();
    for (const user of [alice, bob])
      await expect
        .poll(() =>
          user.page
            .getByTestId('call-screen-media')
            .evaluate((node) => (node as HTMLVideoElement).videoWidth)
        )
        .toBeGreaterThan(0);
    for (const size of [
      { width: 1440, height: 900 },
      { width: 800, height: 500 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await bob.page.setViewportSize(size);
      await expect
        .poll(() =>
          bob.page.getByTestId('room-panel').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const controls = node.querySelector('.room-controls')?.getBoundingClientRect();
            const media = node.querySelector('.call-stage')?.getBoundingClientRect();
            return (
              rect.width >= innerWidth - 2 &&
              rect.bottom <= innerHeight + 1 &&
              controls.bottom <= innerHeight + 1 &&
              media.height > 0 &&
              node.scrollHeight <= node.clientHeight + 1 &&
              node.scrollWidth <= node.clientWidth + 1
            );
          })
        )
        .toBe(true);
    }
    await bob.page.setViewportSize({ width: 1440, height: 960 });
    const popupPromise = charlie.page.waitForEvent('popup');
    await charlie.page.getByTestId('room-open-window').click();
    const popup = await popupPromise;
    await popup.setViewportSize({ width: 800, height: 500 });
    await expect
      .poll(() =>
        popup.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth
        )
      )
      .toBe(true);
    await popup.close();
    await charlie.page.getByTestId('room-share-screen').click();
    await charlie.page.getByTestId('room-leave').click();
    await expect(bob.page.getByTestId(`room-peer-${charlie.session.publicKey}`)).toHaveCount(0);
    await expectAudible(bob.page, `[data-testid="room-audio-${alice.session.publicKey}"]`);
    expect(selectedRelaySockets.length).toBeGreaterThan(0);
    await alice.page.getByTestId('room-leave').click();
    await expect(bob.page.getByTestId('room-status')).toHaveText('Call ended');
    await expect(bob.page.locator('audio[src^="blob:"]')).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob, charlie]);
  } finally {
    await disposeUsers(alice, bob, charlie);
  }
});
