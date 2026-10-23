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
    navigator.mediaDevices.enumerateDevices = async () =>
      ['default', 'built-in', 'built-in', 'headset'].map(
        (deviceId) =>
          ({
            deviceId,
            kind: 'audioinput',
            label: 'Microphone',
            groupId: 'same-group',
          }) as MediaDeviceInfo,
      );
  });
  await page.getByTestId('call-accept').click();
  await page.getByTestId('call-microphone-menu').click();
  const menu = page.locator('[data-call-device-menu]');
  await expect(menu.getByRole('button')).toHaveCount(3);
  await expect(menu.getByRole('button').first()).toHaveText('System default');
  await page.getByTestId('call-microphone-source-1').click();
  expect(await page.evaluate(() => (window as any).__microphone)).toBe('headset');
});

test('call avatars follow participant profiles and speaking rings follow live audio levels', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://call-profile.example/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#326a99"/></svg>',
    }),
  );
  await setup(page);
  await page.evaluate(() => (window as any).__testCall.dismiss());
  const peer = 'b'.repeat(64),
    quiet = 'c'.repeat(64);
  await page.evaluate(
    async ({ peer, quiet }) => {
      const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const { rememberPublicProfile } = await import('/src/lib/state/publicProfiles.ts');
      const { registerCallStream } = await import('/src/services/callStreamRegistry.ts');
      const nostr = useNostrStore();
      const retained = new Map<string, number>();
      const retain = nostr.retainVisibleProfileTarget;
      nostr.retainVisibleProfileTarget = (key: string) => {
        retained.set(key, (retained.get(key) ?? 0) + 1);
        const release = retain(key);
        return () => {
          retained.set(key, retained.get(key)! - 1);
          release();
        };
      };
      rememberPublicProfile(
        peer,
        { name: 'Profile peer', picture: 'https://call-profile.example/peer.svg' },
        1,
      );
      // Synthetic speech: a tone whose gain the test switches on and off.
      const audio = new AudioContext();
      const tone = () => {
        const gain = audio.createGain();
        gain.gain.value = 0;
        const oscillator = audio.createOscillator();
        const output = audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(output);
        oscillator.start();
        return { gain, stream: output.stream };
      };
      const local = tone(),
        remote = tone();
      const canvas = document.createElement('canvas');
      canvas.getContext('2d')!.fillRect(0, 0, 300, 150);
      const own = {
        pubkey: nostr.getLoggedInPublicKeyHex()!,
        sessionId: 'local-speaking',
        name: 'Host',
        relays: [],
      };
      const member = (pubkey: string, name: string) => ({
        pubkey,
        sessionId: `${name}-session`,
        name,
        relays: [],
      });
      const rooms = useCallRoomStore();
      const remoteUrl = registerCallStream(remote.stream).url;
      const tile = (pubkey: string, name: string, audioUrl = '') => ({
        ...member(pubkey, name),
        phase: 'active',
        microphoneMuted: false,
        audioUrl,
        videoUrl: '',
        screenUrl: '',
      });
      // UI fixture only: no call transport or signalling is replaced in production.
      Object.defineProperty(rooms, 'participants', {
        configurable: true,
        writable: true,
        value: [tile(peer, 'Guest', remoteUrl), tile(quiet, 'Quiet guest')],
      });
      rooms.localStream = new MediaStream([
        ...local.stream.getAudioTracks(),
        ...canvas.captureStream(5).getVideoTracks(),
      ]);
      rooms.cameraMuted = true;
      rooms.microphoneMuted = false;
      rooms.session = {
        own,
        members: [own, member(peer, 'Guest'), member(quiet, 'Quiet guest')],
        phase: 'active',
        revision: 1,
        link: {
          id: 'speaking-ui',
          host: own.pubkey,
          secret: '',
          relays: [],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
      (window as any).__speech = {
        retained,
        own: own.pubkey,
        local: local.gain.gain,
        remote: remote.gain.gain,
        remoteUrl,
        rooms,
        // Participants are a fixture property; a session update re-reads them.
        leaveQuiet() {
          rooms.participants = rooms.participants.filter((entry: any) => entry.pubkey !== quiet);
          rooms.session = { ...rooms.session };
        },
      };
    },
    { peer, quiet },
  );
  const speech = (expression: string) => page.evaluate(`window.__speech.${expression}`);
  const retained = (key: string) =>
    page.evaluate((key) => (window as any).__speech.retained.get(key) ?? 0, key);
  const local = page.getByTestId('room-local');
  const remote = page.getByTestId(`room-peer-${peer}`);
  const silent = page.getByTestId(`room-peer-${quiet}`);

  // Cameras off: real profile pictures, initials as the fallback, no generic icon.
  await expect(remote.locator('.call-person .avatar img')).toHaveAttribute(
    'src',
    'https://call-profile.example/peer.svg',
  );
  await expect
    .poll(() => remote.locator('.avatar img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(silent.locator('.call-person .avatar')).toHaveText('QG');
  await expect(local.locator('.call-person .avatar')).toBeVisible();
  // Visible participants are hydrated once each; the account's own profile already is.
  expect(await retained(peer)).toBe(1);
  expect(await retained(quiet)).toBe(1);
  expect(await retained(await speech('own'))).toBe(0);
  await speech('leaveQuiet()');
  await expect(silent).toHaveCount(0);
  expect(await retained(quiet)).toBe(0);
  expect(await retained(peer)).toBe(1);

  // Gallery view: rings follow speech and clear after a pause.
  await expect(page.locator('.room-tile--speaking')).toHaveCount(0);
  await speech('remote.value = 0.5');
  await expect(remote).toHaveClass(/room-tile--speaking/);
  await expect(local).not.toHaveClass(/room-tile--speaking/);
  // Gallery tiles are not promoted, so the active speaker marks no tile.
  await expect(page.locator('.room-tile--speaker')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/call-room-speaking.png' });
  await speech('remote.value = 0');
  await expect(remote).not.toHaveClass(/room-tile--speaking/);
  await speech('local.value = 0.5');
  await expect(local).toHaveClass(/room-tile--speaking/);
  // The ring stays on the tile when its camera turns on.
  await speech('rooms.cameraMuted = false');
  await expect(local.locator('video')).toBeVisible();
  await expect(local).toHaveClass(/room-tile--speaking/);
  await speech('rooms.microphoneMuted = true');
  await expect(local).not.toHaveClass(/room-tile--speaking/);
  await speech('rooms.cameraMuted = true');

  // Speaker view still promotes the person speaking, and the ring works beside a shared screen.
  await page.getByTestId('room-view-toggle').click();
  await expect(page.locator('.room-grid--speaker')).toHaveCount(1);
  await expect(local).toHaveClass(/room-tile--speaker/);
  await speech('remote.value = 0.5');
  await expect(remote).toHaveClass(/room-tile--speaker/);
  await expect(remote).toHaveClass(/room-tile--speaking/);
  await speech('rooms.localScreenStream = new MediaStream()');
  await expect(page.locator('.room-grid--sharing')).toHaveCount(1);
  await expect(remote).toHaveClass(/room-tile--speaking/);
  await speech('remote.value = 0');
  await expect(remote).not.toHaveClass(/room-tile--speaking/);
  await speech('rooms.localScreenStream = null');

  // Leaving releases every retained profile.
  await speech('rooms.session = null');
  await expect(page.getByTestId('room-panel')).toHaveCount(0);
  expect(await retained(peer)).toBe(0);

  // Direct calls: the caller's avatar rings while they speak, not while they are muted.
  await page.evaluate((peer) => {
    const call = (window as any).__testCall;
    call.remoteMediaUrl = (window as any).__speech.remoteUrl;
    call.session = {
      id: 'speaking-direct',
      peerPubkey: peer,
      peerName: 'Guest',
      direction: 'incoming',
      mode: 'audio',
      phase: 'active',
      startedAt: new Date().toISOString(),
      microphoneMuted: false,
      cameraMuted: true,
      mediaVersion: 2,
      peerConfirmed: true,
    };
  }, peer);
  const avatar = page.locator('.call-peer-avatar');
  await expect(avatar.locator('.avatar img')).toBeVisible();
  expect(await retained(peer)).toBe(1);
  await expect(avatar).not.toHaveClass(/call-speaking/);
  await speech('remote.value = 0.5');
  await expect(avatar).toHaveClass(/call-speaking/);
  await page.screenshot({ path: 'test-results/call-direct-speaking.png' });

  // Beside the local camera the header avatar is hidden; the peer keeps one on stage.
  const stageAvatar = page.getByTestId('call-remote-avatar');
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    const canvas = document.createElement('canvas');
    canvas.getContext('2d')!.fillRect(0, 0, 300, 150);
    (window as any).__speech.camera = () => canvas.captureStream(5);
    call.localStream = (window as any).__speech.camera();
    call.session = { ...call.session, cameraMuted: false };
  });
  await expect(page.locator('.call-panel__local video')).toBeVisible();
  await expect(avatar).toBeHidden();
  await expect(stageAvatar.locator('.avatar img')).toBeVisible();
  await expect(stageAvatar).toHaveClass(/call-speaking/);
  await speech('remote.value = 0');
  await expect(stageAvatar).not.toHaveClass(/call-speaking/);
  // Max fill keeps its layout: the local camera alone fills the stage.
  const fillsStage = (selector: string) =>
    page.evaluate((selector) => {
      const media = document.querySelector(selector)!.getBoundingClientRect();
      const stage = document.querySelector('[data-testid="call-stage"]')!.getBoundingClientRect();
      return Math.abs(media.width - stage.width) < 2 && Math.abs(media.height - stage.height) < 2;
    }, selector);
  await page.getByTestId('call-max-fill').click();
  await expect(stageAvatar).toHaveCount(0);
  await expect(page.locator('.call-panel__remote')).toHaveCount(0);
  await expect.poll(() => fillsStage('.call-panel__local')).toBe(true);
  await page.getByTestId('call-max-fill').click();
  await expect(stageAvatar).toBeVisible();
  expect(await fillsStage('.call-panel__local')).toBe(false);

  // The same while only a screen is shared.
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = { ...call.session, cameraMuted: true };
    call.localScreenStream = (window as any).__speech.camera();
  });
  await expect(page.getByTestId('call-screen-media')).toBeVisible();
  await expect(page.locator('.call-panel__local')).toHaveCount(0);
  await expect(stageAvatar).toBeVisible();
  await speech('remote.value = 0.5');
  await expect(stageAvatar).toHaveClass(/call-speaking/);
  await page.screenshot({ path: 'test-results/call-direct-sharing-speaking.png' });
  // In Max fill the shared screen takes the whole stage, without a camera column.
  await page.getByTestId('call-max-fill').click();
  await expect(stageAvatar).toHaveCount(0);
  await expect(page.locator('.call-stage__cameras')).toBeHidden();
  await expect.poll(() => fillsStage('.call-stage__screen')).toBe(true);
  await page.getByTestId('call-max-fill').click();
  await expect(stageAvatar).toHaveClass(/call-speaking/);

  // The presentation window follows the ring without rebuilding its mirror.
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('call-open-window').click();
  const popup = await popupPromise;
  const mirrored = popup.locator('main > [data-testid="call-stage"]');
  const popupAvatar = popup.getByTestId('call-remote-avatar');
  await expect(popupAvatar).toHaveClass(/call-speaking/);
  await mirrored.evaluate((node) => ((node as any).__mirror = true));
  await speech('remote.value = 0');
  await expect(popupAvatar).not.toHaveClass(/call-speaking/);
  await speech('remote.value = 0.5');
  await expect(popupAvatar).toHaveClass(/call-speaking/);
  expect(await mirrored.evaluate((node) => (node as any).__mirror)).toBe(true);

  // Remote video replaces the stage avatar and carries the ring; the window mirrors it in place.
  await page.evaluate(async () => {
    const { registerCallStream } = await import('/src/services/callStreamRegistry.ts');
    const call = (window as any).__testCall;
    call.remoteVideoUrl = registerCallStream((window as any).__speech.camera()).url;
  });
  const remoteFrame = page.locator('.call-panel__remote', {
    has: page.getByTestId('call-remote-media'),
  });
  await expect(stageAvatar).toHaveCount(0);
  await expect(remoteFrame).toHaveClass(/call-speaking/);
  await expect(popupAvatar).toHaveCount(0);
  await expect(popup.locator('.call-panel__remote.call-speaking canvas')).toBeVisible();
  expect(await mirrored.evaluate((node) => (node as any).__mirror)).toBe(true);
  await speech('remote.value = 0');
  await expect(remoteFrame).not.toHaveClass(/call-speaking/);
  await expect(popup.locator('.call-panel__remote.call-speaking')).toHaveCount(0);
  await page.getByTestId('call-return-presentation').click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.localScreenStream = null;
    call.remoteVideoUrl = '';
  });
  await expect(avatar).toBeVisible();
  await speech('remote.value = 0.5');
  await expect(avatar).toHaveClass(/call-speaking/);

  // Speech state is dropped, not held, when its audio goes away mid-word, and
  // it does not return when silent audio comes back within the hold window.
  const stopped = { timeout: 300 };
  await page.evaluate(() => ((window as any).__testCall.remoteMediaUrl = ''));
  await expect(avatar).not.toHaveClass(/call-speaking/, stopped);
  await speech('remote.value = 0');
  await page.evaluate(() => {
    (window as any).__testCall.remoteMediaUrl = (window as any).__speech.remoteUrl;
  });
  await page.waitForTimeout(250);
  await expect(avatar).not.toHaveClass(/call-speaking/);
  // The same when metering stops and resumes with the overlay minimized.
  await speech('remote.value = 0.5');
  await expect(avatar).toHaveClass(/call-speaking/);
  await page.getByTestId('call-minimize').click();
  await expect(avatar).not.toHaveClass(/call-speaking/, stopped);
  await speech('remote.value = 0');
  await page.getByTestId('call-restore').click();
  await page.waitForTimeout(250);
  await expect(avatar).not.toHaveClass(/call-speaking/);

  await speech('remote.value = 0.5');
  await expect(avatar).toHaveClass(/call-speaking/);
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = { ...call.session, remoteMicrophoneMuted: true };
  });
  await expect(avatar).not.toHaveClass(/call-speaking/);
  // Hanging up mid-speech clears the ring on the ended screen.
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = { ...call.session, remoteMicrophoneMuted: false };
  });
  await expect(avatar).toHaveClass(/call-speaking/);
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.session = { ...call.session, phase: 'ended', endReason: 'hangup' };
  });
  await expect(avatar).toBeVisible();
  await expect(avatar).not.toHaveClass(/call-speaking/, stopped);
  await speech('remote.value = 0');
  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.remoteMediaUrl = '';
    call.session = null;
  });
  await expect(page.getByTestId('call-panel')).toHaveCount(0);
  expect(await retained(peer)).toBe(0);
  expect(errors).toEqual([]);
});

test('speaking meters release their own captures and never divert playback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.evaluate(async () => {
    (window as any).__testCall.dismiss();
    const { registerCallStream } = await import('/src/services/callStreamRegistry.ts');
    const audio = new AudioContext();
    const gain = audio.createGain();
    gain.gain.value = 0.5;
    const oscillator = audio.createOscillator();
    oscillator.connect(gain);
    oscillator.start();
    const output = () => {
      const destination = audio.createMediaStreamDestination();
      gain.connect(destination);
      return destination.stream;
    };
    // Element capture stands in for MediaSource playback; each call is a new stream.
    const captures: MediaStream[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', {
      configurable: true,
      value() {
        const stream = output();
        captures.push(stream);
        return stream;
      },
    });
    const registered = output();
    (window as any).__meters = {
      captures,
      gain: gain.gain,
      registered,
      registeredUrl: registerCallStream(registered).url,
      firefox() {
        Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', {
          configurable: true,
          value: undefined,
        });
        (window as any).__mozCaptures = 0;
        Object.defineProperty(HTMLMediaElement.prototype, 'mozCaptureStream', {
          configurable: true,
          value() {
            (window as any).__mozCaptures++;
            return output();
          },
        });
      },
    };
    const call = (window as any).__testCall;
    // An unregistered URL takes the element-capture path, like MediaSource audio.
    call.remoteMediaUrl =
      'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
    call.session = {
      id: 'meter-captures',
      peerPubkey: 'd'.repeat(64),
      peerName: 'Capture peer',
      direction: 'incoming',
      mode: 'audio',
      phase: 'active',
      startedAt: new Date().toISOString(),
      microphoneMuted: false,
      cameraMuted: true,
      mediaVersion: 2,
      peerConfirmed: true,
    };
  });
  const avatar = page.locator('.call-peer-avatar');
  // Captures made so far, and how many of them still hold live tracks.
  const captures = () =>
    page.evaluate(() => {
      const streams: MediaStream[] = (window as any).__meters.captures;
      const live = streams.filter((stream) =>
        stream.getTracks().some((track) => track.readyState === 'live'),
      );
      return { made: streams.length, live: live.length };
    });
  const setMuted = (muted: boolean) =>
    page.evaluate((muted) => {
      const call = (window as any).__testCall;
      call.session = { ...call.session, remoteMicrophoneMuted: muted };
    }, muted);

  // Captured audio is metered; each stop ends that capture, so restarts never accumulate.
  await expect(avatar).toHaveClass(/call-speaking/);
  expect((await captures()).live).toBe(1);
  const first = (await captures()).made;
  for (let cycle = 0; cycle < 3; cycle++) {
    await setMuted(true);
    await expect(avatar).not.toHaveClass(/call-speaking/);
    await expect.poll(async () => (await captures()).live).toBe(0);
    await setMuted(false);
    await expect(avatar).toHaveClass(/call-speaking/);
    expect((await captures()).live).toBe(1);
  }
  expect((await captures()).made).toBeGreaterThan(first);

  // A stream registered by the call is metered but never stopped by the meter.
  await page.evaluate(() => {
    (window as any).__testCall.remoteMediaUrl = (window as any).__meters.registeredUrl;
  });
  await expect.poll(async () => (await captures()).live).toBe(0);
  await expect(avatar).toHaveClass(/call-speaking/);
  await setMuted(true);
  await expect(avatar).not.toHaveClass(/call-speaking/);
  expect(
    await page.evaluate(() =>
      (window as any).__meters.registered
        .getTracks()
        .map((track: MediaStreamTrack) => track.readyState),
    ),
  ).toEqual(['live']);

  // Firefox only offers mozCaptureStream, which takes playback from the speakers:
  // that path plays normally and is not metered.
  await page.evaluate(() => {
    (window as any).__meters.firefox();
    (window as any).__testCall.remoteMediaUrl =
      'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
  });
  await setMuted(false);
  await page.waitForTimeout(400);
  await expect(avatar).not.toHaveClass(/call-speaking/);
  expect(await page.evaluate(() => (window as any).__mozCaptures)).toBe(0);
  const remoteAudio = page.getByTestId('call-remote-audio');
  await expect(remoteAudio).toHaveJSProperty('muted', false);
  expect(await remoteAudio.evaluate((audio: HTMLAudioElement) => audio.src)).toMatch(
    /^data:audio\/wav/,
  );

  await page.evaluate(() => {
    const call = (window as any).__testCall;
    call.remoteMediaUrl = '';
    call.session = null;
  });
  await expect(page.getByTestId('call-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('speaking meters follow the recording window and document visibility', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.evaluate(() => (window as any).__testCall.dismiss());
  const first = 'e'.repeat(64),
    second = 'f'.repeat(64);
  await page.evaluate(
    async ({ first, second }) => {
      const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const { registerCallStream } = await import('/src/services/callStreamRegistry.ts');
      // Only the speaking meters read streams through Web Audio here: count their live sources.
      const sources = new Set<AudioNode>();
      const create = AudioContext.prototype.createMediaStreamSource;
      AudioContext.prototype.createMediaStreamSource = function (stream) {
        const node = create.call(this, stream);
        sources.add(node);
        const disconnect = node.disconnect.bind(node) as () => void;
        (node as any).disconnect = () => {
          sources.delete(node);
          disconnect();
        };
        return node;
      };
      // The test decides whether this document is hidden.
      let hidden = false;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      const audio = new AudioContext();
      const tone = () => {
        const gain = audio.createGain();
        gain.gain.value = 0;
        const oscillator = audio.createOscillator();
        const output = audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(output);
        oscillator.start();
        return { gain, stream: output.stream };
      };
      const local = tone(),
        one = tone(),
        two = tone();
      const nostr = useNostrStore();
      const own = {
        pubkey: nostr.getLoggedInPublicKeyHex()!,
        sessionId: 'local-meters',
        name: 'Host',
        relays: [],
      };
      const member = (pubkey: string, name: string) => ({
        pubkey,
        sessionId: `${name}-session`,
        name,
        relays: [],
      });
      const tile = (pubkey: string, name: string, stream: MediaStream) => ({
        ...member(pubkey, name),
        phase: 'active',
        microphoneMuted: false,
        audioUrl: registerCallStream(stream).url,
        videoUrl: '',
        screenUrl: '',
      });
      const rooms = useCallRoomStore();
      // UI fixture only: no call transport or signalling is replaced in production.
      Object.defineProperty(rooms, 'participants', {
        configurable: true,
        writable: true,
        value: [tile(first, 'First', one.stream), tile(second, 'Second', two.stream)],
      });
      rooms.localStream = new MediaStream(local.stream.getAudioTracks());
      rooms.cameraMuted = true;
      rooms.microphoneMuted = false;
      rooms.session = {
        own,
        members: [own, member(first, 'First'), member(second, 'Second')],
        phase: 'active',
        revision: 1,
        link: {
          id: 'meter-lifecycle',
          host: own.pubkey,
          secret: '',
          relays: [],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
      (window as any).__lifecycle = {
        sources,
        rooms,
        first: one.gain.gain,
        second: two.gain.gain,
        hide(value: boolean) {
          hidden = value;
          document.dispatchEvent(new Event('visibilitychange'));
        },
      };
    },
    { first, second },
  );
  const run = (expression: string) => page.evaluate(`window.__lifecycle.${expression}`);
  const live = () => page.evaluate(() => (window as any).__lifecycle.sources.size);
  const firstTile = page.getByTestId(`room-peer-${first}`);
  // The local microphone and both peers are metered while the call is on screen.
  await expect.poll(live).toBe(3);

  // Hidden with no recording window: every meter stops, and speech is not shown.
  await run('hide(true)');
  await expect.poll(live).toBe(0);
  await run('first.value = 0.5');
  await page.waitForTimeout(300);
  await expect(firstTile).not.toHaveClass(/room-tile--speaking/);
  // Back in the foreground the meters restart once each and pick up the speech.
  await run('hide(false)');
  await expect.poll(live).toBe(3);
  await expect(firstTile).toHaveClass(/room-tile--speaking/);
  await run('first.value = 0');
  await expect(firstTile).not.toHaveClass(/room-tile--speaking/);
  // Repeated transitions never accumulate meters.
  for (let cycle = 0; cycle < 3; cycle++) {
    await run('hide(true)');
    await expect.poll(live).toBe(0);
    await run('hide(false)');
    await expect.poll(live).toBe(3);
  }

  // Recording window open, overlay minimized and this document hidden: the window
  // still shows who speaks, and speaker view still switches.
  await page.getByTestId('room-view-toggle').click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('room-open-window').click();
  const popup = await popupPromise;
  await page.getByTestId('room-minimize').click();
  await expect(page.getByTestId('room-compact')).toBeVisible();
  await run('hide(true)');
  await page.waitForTimeout(250);
  expect(await live()).toBe(3);
  const mirroredFirst = popup.getByTestId(`room-peer-${first}`);
  const mirroredSecond = popup.getByTestId(`room-peer-${second}`);
  await run('first.value = 0.5');
  await expect(mirroredFirst).toHaveClass(/room-tile--speaking/);
  await expect(mirroredFirst).toHaveClass(/room-tile--speaker/);
  await run('first.value = 0');
  await run('second.value = 0.5');
  await expect(mirroredSecond).toHaveClass(/room-tile--speaking/);
  await expect(mirroredSecond).toHaveClass(/room-tile--speaker/);
  await expect(mirroredFirst).not.toHaveClass(/room-tile--speaker/);
  await run('second.value = 0');
  await expect(mirroredSecond).not.toHaveClass(/room-tile--speaking/);
  await run('hide(false)');
  expect(await live()).toBe(3);

  // Closing the window while minimized stops every meter; restoring restarts them.
  await popup.close();
  await expect.poll(live).toBe(0);
  await page.getByTestId('room-restore').click();
  await expect.poll(live).toBe(3);
  await run('first.value = 0.5');
  await expect(firstTile).toHaveClass(/room-tile--speaking/);
  await run('first.value = 0');

  // Leaving the call releases every meter.
  await run('rooms.session = null');
  await expect(page.getByTestId('room-panel')).toHaveCount(0);
  await expect.poll(live).toBe(0);
  expect(errors).toEqual([]);
});
