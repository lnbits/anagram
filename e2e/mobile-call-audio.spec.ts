import { test, expect } from '@playwright/test';

test('packet audio resumes after context suspension and closes after its last owner hangs up', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const Original = window.AudioContext;
    let context: AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        context = this;
      }
    };
    try {
      const { prepareCallPacketAudio } = await import('/src/services/callPacketAudio.ts');
      const first = await prepareCallPacketAudio();
      const second = await prepareCallPacketAudio();
      if (!first || !second) throw new Error('Packet audio unavailable');
      (window as any).__callRecovery = { context: context!, first, second };
      await context!.suspend();
    } finally {
      window.AudioContext = Original;
    }
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__callRecovery.context.state))
    .toBe('running');
  await page.evaluate(() => (window as any).__callRecovery.first());
  await expect
    .poll(() => page.evaluate(() => (window as any).__callRecovery.context.state))
    .toBe('running');
  await page.evaluate(() => (window as any).__callRecovery.second());
  await expect
    .poll(() => page.evaluate(() => (window as any).__callRecovery.context.state))
    .toBe('closed');
});

test('remote call playback resumes when returning to the app', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/src/lib/dev/mountFixture.ts');
    const { default: CallAudio } = await import('/src/lib/components/CallAudio.svelte');
    const { registerCallStream } = await import('/src/services/callStreamRegistry.ts');
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const output = context.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await context.resume();
    const target = document.createElement('div');
    document.body.append(target);
    const stream = registerCallStream(output.stream);
    mount(CallAudio, { target, props: { url: stream.url } });
  });
  const playing = () =>
    page.evaluate(
      () =>
        !(document.querySelector('[data-testid="call-remote-audio"]') as HTMLAudioElement).paused,
    );
  await expect.poll(playing).toBe(true);
  await page.evaluate(() => {
    (document.querySelector('[data-testid="call-remote-audio"]') as HTMLAudioElement).pause();
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect.poll(playing).toBe(true);
});

for (const variant of [
  { agent: 'Android', room: false },
  { agent: 'iPhone', room: false },
  { agent: 'Android', room: true },
  { agent: 'iPhone', room: true },
]) {
  const { agent, room } = variant;
  test(`${agent} ${room ? 'group' : 'direct'} call controls default to receiver and explicitly select loudspeaker`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(async ({ agent, room }) => {
      (window as any).isTauri = true;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: agent });
      const writes: unknown[] = [];
      (window as any).__audioWrites = writes;
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command: string, args: unknown) => {
          if (command === 'set_mobile_call_audio') writes.push(args);
          return command === 'plugin:event|listen' ? 1 : null;
        },
      };
      const { mount } = await import('/src/lib/dev/mountFixture.ts');
      const { default: CallOverlay } = await import('/src/lib/components/CallOverlay.svelte');
      const { useCallStore } = await import('/src/stores/callStore.ts');
      const { acquireMobileCallAudio } = await import('/src/services/mobileCallAudio.ts');
      const calls = useCallStore();
      calls.session = {
        id: 'mobile-route',
        peerPubkey: 'a'.repeat(64),
        peerName: 'Caller',
        direction: 'outgoing',
        mode: 'audio',
        phase: 'active',
        startedAt: new Date().toISOString(),
        microphoneMuted: false,
        cameraMuted: true,
        mediaVersion: 2,
        videoAvailable: true,
      };
      calls.localStream = new MediaStream();
      if (room) {
        const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
        const rooms = useCallRoomStore();
        const own = { pubkey: 'b'.repeat(64), sessionId: 'local', name: 'You', relays: [] };
        rooms.session = {
          own,
          members: [own],
          phase: 'active',
          revision: 1,
          link: {
            id: 'mobile-room',
            host: own.pubkey,
            secret: '',
            relays: [],
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        };
        rooms.localStream = new MediaStream();
        rooms.cameraMuted = true;
      }
      (window as any).__releaseAudio = await acquireMobileCallAudio();
      const target = document.createElement('div');
      document.body.append(target);
      mount(CallOverlay, { target });
    }, variant);
    const prefix = room ? 'room' : 'call';
    const loudspeaker = page.getByTestId(`${prefix}-loudspeaker`);
    for (const width of [320, 390]) {
      const height = width === 320 ? 568 : 844;
      await page.setViewportSize({ width, height });
      // Resize can commit between separate boundingBox calls. Sample the viewport
      // and every control in one browser task, then wait for the responsive layout.
      await expect(async () => {
        const layout = await page.evaluate(
          ({ prefix, room }) => {
            const ids = [
              ...['microphone', 'loudspeaker', 'camera', 'more'].map((id) => `${prefix}-${id}`),
              room ? 'room-leave' : 'call-hangup',
            ];
            return {
              width: innerWidth,
              height: innerHeight,
              boxes: ids.map((id) =>
                document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().toJSON(),
              ),
            };
          },
          { prefix, room },
        );
        expect(layout.width).toBe(width);
        expect(layout.height).toBe(height);
        const boxes = layout.boxes.slice(0, 4);
        for (const box of boxes) {
          expect(box).toBeDefined();
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y).toBeCloseTo(boxes[0].y, 0);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        for (let i = 1; i < boxes.length; i++)
          expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x + boxes[i - 1].width);
        const end = layout.boxes[4];
        expect(end).toBeDefined();
        expect(end.width).toBeGreaterThanOrEqual(44);
        expect(end.height).toBeGreaterThanOrEqual(44);
        expect(end.y).toBeGreaterThan(boxes[0].y + boxes[0].height);
        expect(end.y + end.height).toBeLessThanOrEqual(height);
        expect(end.x).toBeGreaterThanOrEqual(0);
        expect(end.x + end.width).toBeLessThanOrEqual(width);
        expect(end.x + end.width / 2).toBeCloseTo(width / 2, 0);
      }).toPass({ timeout: 15000 });
      await expect(page.getByTestId(`${prefix}-open-controls`)).toBeHidden();
      await expect(page.getByTestId(`${prefix}-microphone-menu`)).toBeHidden();
      await page.screenshot({ path: `test-results/${agent}-${prefix}-${width}-controls.png` });
    }
    await page.getByTestId(`${prefix}-more`).click();
    await expect(page.getByTestId(`${prefix}-more`)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`${prefix}-speaker`)).toBeVisible();
    await page.getByTestId(`${prefix}-speaker`).click();
    await expect(page.getByTestId(`${prefix}-speaker`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(`${prefix}-microphone-menu`).click();
    await expect(page.getByTestId(`${prefix}-microphone-default`)).toBeVisible();
    const menu = await page.locator('[data-call-device-menu]').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await page.getByTestId(`${prefix}-more`).click();
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'false');
    await expect(loudspeaker).toHaveAccessibleName('Use loudspeaker');
    await loudspeaker.click();
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'true');
    await expect(loudspeaker).toHaveAccessibleName('Use earpiece or connected headset');
    await loudspeaker.click();
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => (window as any).__releaseAudio());
    await expect
      .poll(() => page.evaluate(() => (window as any).__audioWrites))
      .toEqual([
        { active: true, speaker: false },
        { active: true, speaker: true },
        { active: true, speaker: false },
        { active: false, speaker: false },
      ]);
  });
}
