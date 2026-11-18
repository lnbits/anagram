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
  // Firefox has no Remote Playback API; absence also means it is not disabled.
  expect(
    await page
      .getByTestId('call-remote-audio')
      .evaluate((audio) => Boolean((audio as HTMLAudioElement).disableRemotePlayback)),
  ).toBe(false);
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
  await expect
    .poll(() =>
      page
        .getByTestId('call-panel')
        .evaluate((panel) => window.innerWidth === 390 && panel.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
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

test('new hosted group calls display and copy unique links after the previous call closes', async ({
  page,
  context,
  browserName,
}) => {
  await setup(page);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  } else {
    // These engines cannot grant clipboard-read through Playwright. Exercise the
    // copy action and exact link value; Chromium covers the real OS clipboard.
    await page.evaluate(() => {
      let text = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            text = value;
          },
          readText: async () => text,
        },
      });
    });
  }
  await page.evaluate(() => {
    (window as any).__testCall.dismiss();
    // Replace capture only; use the real room store, creation, cleanup and link generation.
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  });
  const create = async () => {
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'Create or join a call' }).click();
    await page.getByTestId('room-create-audio').click();
    await page.getByTestId('room-invite').click();
    await page.getByTestId('room-toggle-link').click();
    const link = await page.getByTestId('room-link').inputValue();
    await page.getByTestId('room-copy-link').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await page.getByTestId('room-invite-close').click();
    return link;
  };
  const first = await create();
  await page.getByTestId('room-leave').click();
  await page.getByTestId('room-dismiss').click();
  const second = await create();
  expect(second).not.toBe(first);
  const decode = (link: string) =>
    JSON.parse(Buffer.from(link.split('/call/').at(-1)!, 'base64url').toString());
  expect(decode(second).id).not.toBe(decode(first).id);
  expect(decode(second).secret).not.toBe(decode(first).secret);
  await page.getByTestId('room-leave').click();
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

for (const width of [390, 1280]) {
  test(`caller identity, photo fallback and phone controls survive peer changes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
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
    await page.screenshot({ path: `test-results/call-${width}-incoming.png` });
    await page.getByTestId('call-accept').click();
    expect(await page.evaluate(() => (window as any).__answerMode)).toBe('audio');
    await page.getByTestId('call-hangup').click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => {
      (window as any).__testCall.session = {
        id: 'outgoing-peer',
        peerPubkey: 'a'.repeat(64),
        peerName: 'Test contact',
        direction: 'outgoing',
        mode: 'audio',
        phase: 'outgoing',
        cameraMuted: true,
        peerConfirmed: true,
      };
    });
    await expect(page.locator('.call-peer-avatar')).toBeVisible();
    await expect(page.getByTestId('call-hangup')).toHaveAccessibleName('Cancel');
    await page.screenshot({ path: `test-results/call-${width}-outgoing.png` });
    await page.getByTestId('call-hangup').click();
    await expect(page.getByTestId('call-status')).toHaveText('Call ended');
    await page.getByTestId('call-dismiss').click();
    await page.evaluate(() => {
      const call = (window as any).__testCall;
      call.session = {
        id: 'another-peer',
        peerPubkey: 'b'.repeat(64),
        peerName: 'A very long caller name '.repeat(10),
        direction: 'incoming',
        mode: 'video',
        phase: 'incoming',
        cameraMuted: true,
      };
    });
    await page.setViewportSize(
      width < 600 ? { width: 320, height: 568 } : { width: 640, height: 480 },
    );
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
}

test('group-call shared names use saved local CSS in the call and recording window', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.evaluate(() => (window as any).__testCall.dismiss());
  const lobby = async () => {
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'Create or join a call' }).click();
  };
  await lobby();
  const ownFields = page.locator('.group-call-name-fields');
  await ownFields.getByLabel('Custom name', { exact: true }).fill('Host <b>local</b>');
  await ownFields.getByRole('switch', { name: 'Custom name CSS' }).check();
  await expect(ownFields.getByLabel('CSS', { exact: true })).toHaveValue(/#ed24ff/);
  const css =
    '.customname { position: fixed; left: 12px; bottom: 12px; color: rgb(255, 0, 128); font-size: 24px; } .customname::before { content: "★ "; }';
  await ownFields.getByLabel('CSS', { exact: true }).fill(css);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await lobby();
  await expect(ownFields.getByLabel('Custom name', { exact: true })).toHaveValue(
    'Host <b>local</b>',
  );
  await expect(ownFields.getByRole('switch', { name: 'Custom name CSS' })).toBeChecked();
  await expect(ownFields.getByLabel('CSS', { exact: true })).toHaveValue(css);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const peer = 'b'.repeat(64);
  await page.evaluate(async (peer) => {
    const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
    const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
    const nostr = useNostrStore();
    const own = {
      pubkey: nostr.getLoggedInPublicKeyHex()!,
      sessionId: 'local-ui',
      name: 'Host <b>local</b>',
      relays: [],
    };
    const guest = { pubkey: peer, sessionId: 'peer-ui', name: 'Guest shared name', relays: [] };
    nostr.fetchUserProfileFromRelays = async (key: string) =>
      ({ nip05: key === peer ? 'guest@example.com' : 'host@example.com' }) as any;
    nostr.sendRoomSignal = async () => {};
    const rooms = useCallRoomStore();
    // UI fixture only: no call transport or signalling is replaced in production.
    Object.defineProperty(rooms, 'participants', {
      configurable: true,
      writable: true,
      value: [
        {
          ...guest,
          phase: 'active',
          microphoneMuted: false,
          audioUrl: '',
          videoUrl: '',
          screenUrl: '',
        },
      ],
    });
    rooms.localStream = new MediaStream();
    rooms.cameraMuted = true;
    rooms.session = {
      own,
      members: [own, guest],
      phase: 'active',
      revision: 1,
      link: {
        id: 'name-ui',
        host: own.pubkey,
        secret: '',
        relays: [],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    (window as any).__testRoomNames = rooms;
  }, peer);
  const controlsOpened = page.waitForEvent('popup');
  await page.getByTestId('room-open-controls').click();
  const groupControls = await controlsOpened;
  await groupControls.getByTestId('room-microphone').click();
  await expect(page.getByTestId('room-microphone')).toHaveAttribute('aria-pressed', 'true');
  await expect(groupControls.locator('video,audio')).toHaveCount(0);
  await groupControls.close();
  const local = page.getByTestId('room-local');
  await expect(local.locator('.customname')).toHaveText('Host <b>local</b>');
  await expect(local.locator('.customname b')).toHaveCount(0);
  await expect(local.locator('.customname')).toHaveCSS('color', 'rgb(255, 0, 128)');
  const remote = page.getByTestId(`room-peer-${peer}`);
  await expect(remote.locator('.customname')).toHaveText('Guest shared name');
  await expect(remote.locator('.customname')).toHaveCSS('color', 'rgb(255, 0, 128)');
  await page.getByTestId('room-edit-names').click();
  const editor = page.getByRole('dialog', { name: 'Name and styling', exact: true });
  await expect(editor.getByLabel('Custom name', { exact: true })).toHaveCount(1);
  await editor.getByLabel('Custom name', { exact: true }).fill('Host renamed');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(local.locator('.customname')).toHaveText('Host renamed');
  const styling = editor.locator('.group-call-name-fields');
  await expect(styling).toHaveCount(1);
  await styling.getByLabel('CSS', { exact: true }).fill(css.replace('255, 0, 128', '0, 255, 0'));
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(remote.locator('.customname')).toHaveText('Guest shared name');
  await expect(remote.locator('.customname')).toHaveCSS('color', 'rgb(0, 255, 0)');
  await expect(local.locator('.customname')).toHaveCSS('color', 'rgb(0, 255, 0)');
  expect(
    await page.evaluate(() =>
      (window as any).__testRoomNames.session.members.map((member: any) => member.name),
    ),
  ).toEqual(['Host renamed', 'Guest shared name']);
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('room-open-window').click();
  const popup = await popupPromise;
  await expect(popup.locator('.customname')).toHaveCount(2);
  await expect(popup.getByTestId(`room-peer-${peer}`).locator('.customname')).toHaveCSS(
    'color',
    'rgb(0, 255, 0)',
  );
  await page.getByTestId('room-edit-names').click();
  await styling.getByLabel('CSS', { exact: true }).fill(css);
  await expect(popup.getByTestId(`room-peer-${peer}`).locator('.customname')).toHaveCSS(
    'color',
    'rgb(255, 0, 128)',
  );
  const exampleCss = await page.evaluate(
    async () => (await import('/src/lib/state/groupCallNames.ts')).DEFAULT_CUSTOM_NAME_CSS,
  );
  await styling.getByRole('button', { name: 'Reset to default', exact: true }).click();
  await expect(styling.getByLabel('CSS', { exact: true })).toHaveValue(exampleCss);
  await expect(editor.getByLabel('Custom name', { exact: true })).toHaveValue('Host renamed');
  const expectFittedNames = async () => {
    for (const view of [page, popup]) {
      for (const id of ['room-local', `room-peer-${peer}`]) {
        await expect
          .poll(() =>
            view.getByTestId(id).evaluate((node) => {
              const frame = node.querySelector('.room-tile__content')!.getBoundingClientRect();
              const name = node
                .querySelector('[data-testid="custom-call-name"]')
                ?.shadowRoot?.querySelector<HTMLElement>('.customname');
              if (!name) return 'missing';
              const label = name.getBoundingClientRect();
              const scale = label.height / name.offsetHeight;
              const gap = 16 * scale;
              const tile = node.getBoundingClientRect();
              const ratio = Number(
                (node.querySelector('.room-tile__content') as HTMLElement).dataset.videoRatio,
              );
              const fill = !!node.closest('.room-grid--fill');
              const width = fill ? tile.width : Math.min(tile.width, tile.height * ratio);
              const height = fill ? tile.height : width / ratio;
              const fits =
                Math.abs(frame.width - width) < 1 &&
                Math.abs(frame.height - height) < 1 &&
                scale > 0 &&
                scale <= 1.01 &&
                label.height <= frame.height * 0.1 + 1 &&
                label.width <= frame.width * 0.8 + 1 &&
                Math.abs(label.left - frame.left - gap) < 1 &&
                Math.abs(frame.bottom - label.bottom - gap) < 1 &&
                (Math.abs(scale - 1) < 0.01 ||
                  Math.abs(label.height - frame.height * 0.1) < 1 ||
                  Math.abs(label.width - frame.width * 0.8) < 1);
              return fits ? 'ok' : JSON.stringify({ frame, label, scale });
            }),
          )
          .toBe('ok');
      }
    }
  };
  // Before any camera video, both placeholders use a landscape video frame.
  for (const view of [page, popup]) {
    for (const id of ['room-local', `room-peer-${peer}`]) {
      await expect(view.getByTestId(id).locator('.room-tile__content')).toHaveAttribute(
        'data-video-ratio',
        String(16 / 9),
      );
    }
  }
  await expectFittedNames();
  // Oversized designs and long names must fit without rewriting the saved CSS.
  const largeCss = exampleCss.replace('font: 600 28px', 'font: 600 80px');
  await styling.getByLabel('CSS', { exact: true }).fill(largeCss);
  await editor.getByLabel('Custom name', { exact: true }).fill('W'.repeat(70));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expectFittedNames();
  await expect(styling.getByLabel('CSS', { exact: true })).toHaveValue(largeCss);
  expect(
    await page.evaluate(() => {
      const account = (window as any).__testRoomNames.session.own.pubkey;
      return JSON.parse(localStorage.getItem(`ui-group-call-name:${account}`)!).css;
    }),
  ).toBe(largeCss);
  await styling.getByRole('button', { name: 'Reset to default', exact: true }).click();
  await editor.getByLabel('Custom name', { exact: true }).fill('Host renamed');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('room-max-fill').click();
  await expectFittedNames();
  await page.getByTestId('room-view-toggle').click();
  await expectFittedNames();
  await page.setViewportSize({ width: 900, height: 844 });
  await popup.setViewportSize({ width: 1800, height: 900 });
  await expectFittedNames();
  const thumbnailScale = (view: Page) =>
    view
      .getByTestId(`room-peer-${peer}`)
      .locator('.customname')
      .evaluate((node) => node.getBoundingClientRect().height / (node as HTMLElement).offsetHeight);
  expect(await thumbnailScale(page)).toBeLessThan(await thumbnailScale(popup));
  // Exercise speaker promotion/demotion styling without a live audio connection.
  await page.evaluate((peer) => {
    document.querySelector('[data-testid="room-local"]')!.classList.remove('room-tile--speaker');
    document
      .querySelector(`[data-testid="room-peer-${peer}"]`)!
      .classList.add('room-tile--speaker');
  }, peer);
  await expectFittedNames();
  await page.evaluate((peer) => {
    document.querySelector('[data-testid="room-local"]')!.classList.add('room-tile--speaker');
    document
      .querySelector(`[data-testid="room-peer-${peer}"]`)!
      .classList.remove('room-tile--speaker');
  }, peer);
  await page.setViewportSize({ width: 390, height: 844 });
  await popup.setViewportSize({ width: 1000, height: 650 });
  await expectFittedNames();
  await page.getByTestId('room-more').click();
  await page.getByTestId('room-view-toggle').click();
  await expectFittedNames();
  // A local share exercises the shared screen/camera layout without live capture.
  await page.evaluate(() => {
    (window as any).__testRoomNames.localScreenStream = new MediaStream();
  });
  for (const view of [page, popup]) {
    await expect(view.locator('.call-stage__screen')).toHaveCount(1);
    await expect(view.locator('.call-stage__screen .customname')).toHaveCount(0);
    await expect(view.locator('.call-stage__screen figcaption')).toHaveText('Host renamed');
  }
  await expectFittedNames();
  await page.setViewportSize({ width: 1280, height: 844 });
  await popup.setViewportSize({ width: 1800, height: 900 });
  await expectFittedNames();
  await page.getByTestId('room-max-fill').click();
  await expectFittedNames();
  await page.screenshot({ path: 'test-results/call-screen-thumbnail-names.png' });
  await page.evaluate(() => {
    (window as any).__testRoomNames.localScreenStream = null;
  });
  await expect(page.locator('.call-stage__screen')).toHaveCount(0);
  await expectFittedNames();
  // Real video dimensions expose letterboxing that camera-off fixtures cannot.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    const draw = () => {
      context.fillStyle = '#286dac';
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    draw();
    const fixture = window as any;
    fixture.__nameCameraCanvas = canvas;
    fixture.__nameCameraTimer = setInterval(draw, 100);
    fixture.__testRoomNames.localStream = canvas.captureStream(10);
    fixture.__testRoomNames.cameraMuted = false;
  });
  const expectVideoName = async (ratio: number, fill = false) => {
    for (const view of [page, popup]) {
      const tile = view.getByTestId('room-local');
      await expect(tile.locator('.room-tile__content')).toHaveAttribute(
        'data-video-ratio',
        String(ratio),
      );
      await expect
        .poll(async () => {
          const bounds = await tile.boundingBox();
          const label = await tile.locator('.customname').boundingBox();
          if (!bounds || !label) return Infinity;
          const width = fill ? bounds.width : Math.min(bounds.width, bounds.height * ratio);
          const height = fill ? bounds.height : width / ratio;
          const naturalHeight = await tile
            .locator('.customname')
            .evaluate((node) => (node as HTMLElement).offsetHeight);
          const gap = (16 * label.height) / naturalHeight;
          return Math.max(
            Math.abs(label.x - (bounds.x + (bounds.width - width) / 2 + gap)),
            Math.abs(label.y + label.height - (bounds.y + (bounds.height + height) / 2 - gap)),
            Math.max(0, label.height - height * 0.1),
            Math.max(0, label.width - width * 0.8),
          );
        })
        .toBeLessThan(1);
    }
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await popup.setViewportSize({ width: 900, height: 1100 });
  await expectVideoName(640 / 360);
  await expectFittedNames();
  await page.screenshot({ path: 'test-results/call-name-inside-video.png' });
  await page.evaluate(() => {
    const canvas = (window as any).__nameCameraCanvas as HTMLCanvasElement;
    canvas.width = 360;
    canvas.height = 640;
  });
  await expectVideoName(360 / 640);
  await page.evaluate(() => ((window as any).__testRoomNames.cameraMuted = true));
  await expect(page.getByTestId('room-local').locator('.call-person')).toBeVisible();
  // Muting the camera preserves its last frame and the name's exact position.
  await expectVideoName(360 / 640);
  await expectFittedNames();
  await page.evaluate(() => ((window as any).__testRoomNames.cameraMuted = false));
  await expectVideoName(360 / 640);
  await popup
    .getByTestId('room-local')
    .locator('canvas')
    .evaluate((canvas) => {
      (window as any).__retainedCallCanvas = canvas;
    });
  await page.getByTestId('room-max-fill').click();
  await expectVideoName(360 / 640, true);
  expect(
    await popup
      .getByTestId('room-local')
      .locator('canvas')
      .evaluate((canvas) => (window as any).__retainedCallCanvas === canvas),
  ).toBe(true);
  await page.getByTestId('room-max-fill').click();
  await page.evaluate(() => {
    const fixture = window as any;
    clearInterval(fixture.__nameCameraTimer);
    fixture.__testRoomNames.localStream
      .getTracks()
      .forEach((track: MediaStreamTrack) => track.stop());
    fixture.__testRoomNames.cameraMuted = true;
  });
  await expectFittedNames();
  await page.getByTestId('room-edit-names').click();
  await styling.getByRole('switch', { name: 'Custom name CSS' }).uncheck();
  await expect(popup.getByTestId(`room-peer-${peer}`).locator('.customname')).toHaveCount(0);
  await expect(popup.getByTestId(`room-peer-${peer}`)).toContainText('Guest shared name');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await editor.evaluate((node) => node.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await popup.close();
  expect(errors).toEqual([]);
});

test('custom name styling accepts CSS only and cannot load resources or style the page', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route('https://css-resource.invalid/**', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { customCallNameCss } = await import('/src/utils/customCallNameCss.ts');
    const { DEFAULT_CUSTOM_NAME_CSS } = await import('/src/lib/state/groupCallNames.ts');
    const source = `@import "https://css-resource.invalid/import.css";
      @font-face { font-family: Evil; src: url(https://css-resource.invalid/font.woff); }
      body { background: red; }
      :host { position: fixed; }
      .customname { color: rgb(1, 2, 3); background-image: url(https://css-resource.invalid/image); --asset: url(https://css-resource.invalid/variable); border-image-source: var(--asset); cursor: url(https://css-resource.invalid/cursor), auto; }
      .customname::before { content: "safe"; background: image-set("https://css-resource.invalid/set" 1x); }
      .customname span { background-image: u\\72l(https://css-resource.invalid/escaped); }
      </style><script>window.__cssExecuted = true</script>`;
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = customCallNameCss(source);
    const label = document.createElement('div');
    label.className = 'customname';
    label.textContent = '<img src=x onerror=alert(1)>';
    root.append(style, label);
    return {
      safe: style.textContent,
      color: getComputedStyle(label).color,
      defaultCss: customCallNameCss(DEFAULT_CUSTOM_NAME_CSS),
      executed: Boolean((window as any).__cssExecuted),
      children: label.children.length,
    };
  });
  expect(result.safe).not.toMatch(/url\(|image-set|@import|font-face|:host|body|var\(/i);
  expect(result.color).toBe('rgb(1, 2, 3)');
  expect(result.defaultCss).toContain('box-shadow');
  expect(result.defaultCss).toContain('.customname::after');
  expect(result.executed).toBe(false);
  expect(result.children).toBe(0);
  expect(requests).toEqual([]);
});

test('duplicate controls stay live while the main tray is hidden and close without ending the call', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.getByTestId('call-accept').click();
  const open = async () => {
    const opened = page.waitForEvent('popup');
    await page.getByTestId('call-open-controls').click();
    const popup = await opened;
    popup.on('pageerror', (error) => errors.push(error.message));
    return popup;
  };
  let popup = await open();
  await expect(popup.getByTestId('call-microphone')).toBeVisible();
  await expect(popup.locator('audio,video,canvas')).toHaveCount(0);
  await popup.getByTestId('call-microphone').click();
  await expect(page.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('call-microphone').click();
  await expect(popup.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'false');
  await popup.getByTestId('call-speaker').click();
  await expect(page.getByTestId('call-remote-audio')).toHaveJSProperty('muted', true);
  await popup.getByTestId('call-hide-controls').click();
  await expect(page.getByTestId('call-controls-tray')).toHaveClass(/--hidden/);
  await expect(popup.getByTestId('call-microphone')).toBeVisible();
  await popup.getByTestId('call-microphone').click();
  await expect(page.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'true');
  await popup.getByTestId('call-microphone-menu').click();
  await expect(popup.getByTestId('call-microphone-default')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(popup.getByTestId('call-microphone-default')).toHaveCount(0);
  await popup.getByTestId('call-microphone-menu').click();
  await popup.getByTestId('call-microphone-default').click();
  expect(await page.evaluate(() => (window as any).__microphone)).toBe('');
  await popup.getByTestId('call-camera').click();
  await expect(page.locator('video[aria-label="Your camera"]')).toBeVisible();
  await expect(popup.getByTestId('call-camera')).toHaveAttribute('aria-pressed', 'true');
  await popup.getByTestId('call-open-controls').click();
  expect(page.context().pages()).toHaveLength(2);
  await popup.close();
  expect(await page.evaluate(() => (window as any).__testCall.session.phase)).toBe('active');
  await page.getByTestId('call-controls-edge').click();
  await page.getByTestId('call-hide-controls').click();
  popup = await open();
  // Ending the call closes this window during the click itself.
  await popup
    .getByTestId('call-hangup')
    .click({ noWaitAfter: true })
    .catch((error) => {
      if (!popup.isClosed() || !String(error).includes('has been closed')) throw error;
    });
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByTestId('call-dismiss')).toBeVisible();
  expect(errors).toEqual([]);
});

test('microphone menu keeps system default first and removes only redundant entries', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).__enumerations = 0;
    navigator.mediaDevices.enumerateDevices = async () => {
      (window as any).__enumerations++;
      return ['default', 'built-in', 'built-in', 'headset'].map(
        (deviceId) =>
          ({
            deviceId,
            kind: 'audioinput',
            label: 'Microphone',
            groupId: 'same-group',
          }) as MediaDeviceInfo,
      );
    };
  });
  await page.getByTestId('call-accept').click();
  await page.getByTestId('call-microphone-menu').click();
  const menu = page.locator('[data-call-device-menu]');
  await expect(menu.getByRole('button')).toHaveCount(3);
  await expect(menu.getByRole('button').first()).toHaveText('System default');
  await page.getByTestId('call-microphone-source-1').click();
  expect(await page.evaluate(() => (window as any).__microphone)).toBe('headset');
  // Call state changes that keep the same local stream do not re-enumerate devices.
  const enumerations = await page.evaluate(() => (window as any).__enumerations);
  expect(enumerations).toBeGreaterThan(0);
  await page.getByTestId('call-microphone').click();
  await expect(page.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('call-microphone').click();
  await expect(page.getByTestId('call-microphone')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as any).__enumerations)).toBe(enumerations);
});
