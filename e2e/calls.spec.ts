import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  reloadAndWaitForApp,
} from './helpers';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
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
    const beforeAlice = await alice.page.locator('.thread-message-entry').count();
    const beforeBob = await bob.page.locator('.thread-message-entry').count();
    await alice.page.getByTestId('thread-video-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    expect(
      (await bob.page.evaluate(() => window.__appE2E__.getCallSnapshot())).hasLocalStream
    ).toBe(false);
    await bob.page.getByTestId('call-accept').click();
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
    await alice.page.getByTestId('call-microphone').click();
    await alice.page.getByTestId('call-camera').click();
    const muted = await alice.page.evaluate(() => window.__appE2E__.getCallSnapshot());
    expect(muted.audioEnabled).toEqual([false]);
    expect(muted.videoEnabled).toEqual([false]);
    await alice.page.getByTestId('call-microphone').click();
    await alice.page.getByTestId('call-camera').click();
    await alice.page.getByLabel('Minimize call').click();
    await expect(alice.page.getByTestId('call-compact')).toBeVisible();
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
          .getByTestId('call-remote-media')
          .evaluate((node) => (node as HTMLVideoElement).currentTime)
      )
      .toBeGreaterThan(0);
    await bob.page.getByTestId('call-hangup').click();
    await expect(alice.page.getByTestId('call-status')).toHaveText('Call ended');
    await alice.page.getByTestId('call-dismiss').click();
    await bob.page.getByTestId('call-dismiss').click();
    await expect(alice.page.locator('.thread-message-entry')).toHaveCount(beforeAlice);
    await expect(bob.page.locator('.thread-message-entry')).toHaveCount(beforeBob);
    expect(publicAddressRequests).toEqual([]);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('declining and cancelling calls leaves no chat messages or restored ringing', async ({
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
    await reloadAndWaitForApp(bob.page);
    await expect(bob.page.getByTestId('call-panel')).not.toBeVisible();
    await alice.page.getByTestId('thread-audio-call').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Incoming call');
    await alice.page.getByTestId('call-hangup').click();
    await expect(bob.page.getByTestId('call-status')).toHaveText('Call cancelled');
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
