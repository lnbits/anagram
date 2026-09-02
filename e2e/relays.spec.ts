import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  E2E_DUAL_RELAY_URLS,
  E2E_RELAY_URL,
  E2E_RELAY_URL_HANG,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openAppRelaysSettings,
  pauseRelayService,
  reloadAndWaitForApp,
  removeRelayFromSettings,
  sendMessage,
  TEST_ACCOUNTS,
  unpauseRelayService,
  waitForThreadMessage,
} from './helpers';

test.describe.configure({ mode: 'serial' });

test('editing app relays survives hard reload and direct messages still arrive on the remaining relay', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.relaySettingsAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.relaySettingsBob, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });

  try {
    const afterRelayEditMessage = `after-app-relay-edit-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);

    await openAppRelaysSettings(alice.page);
    const appRelayPanel = alice.page.getByTestId('settings-relays-app-panel');
    await expect(appRelayPanel).toContainText(E2E_DUAL_RELAY_URLS[0]);
    await expect(appRelayPanel).toContainText(E2E_DUAL_RELAY_URLS[1]);
    await removeRelayFromSettings(alice.page, E2E_DUAL_RELAY_URLS[0]);

    await reloadAndWaitForApp(alice.page);
    await openAppRelaysSettings(alice.page);
    await expect(appRelayPanel).not.toContainText(E2E_DUAL_RELAY_URLS[0]);
    await expect(appRelayPanel).toContainText(E2E_DUAL_RELAY_URLS[1]);

    await navigateToChat(bob.page, alice.session.publicKey);
    await sendMessage(bob.page, afterRelayEditMessage, {
      chatId: alice.session.publicKey,
    });
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, afterRelayEditMessage, {
      chatId: bob.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('pending outbound message survives reload and auto-replays after relay recovery', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.pendingAlice, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.pendingBob, {
    relayUrls: [E2E_RELAY_URL],
  });

  try {
    const pendingMessage = `pending-reload-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await pauseRelayService('relay-two');

    await navigateToChat(alice.page, bob.session.publicKey);
    await sendMessage(alice.page, pendingMessage, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, pendingMessage, {
      chatId: alice.session.publicKey,
    });
    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: [/127\.0\.0\.1:7001/i, /relay-two/i, /websocket/i],
    });
  } finally {
    await unpauseRelayService('relay-two').catch(() => undefined);
    await disposeUsers(alice, bob);
  }
});

test('an unresponsive extra relay does not block startup, send, or receive', async ({
  browser,
}) => {
  const hangErrorPatterns = [
    /127\.0\.0\.1:65534/i,
    /7002/i,
    /websocket/i,
    /timeout/i,
    /failed to connect/i,
    /not enough relays received the event/i,
  ];

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.slowRelayAlice, {
    relayUrls: [E2E_RELAY_URL, E2E_RELAY_URL_HANG],
  });
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.slowRelayBob, {
    relayUrls: [E2E_RELAY_URL],
  });

  try {
    await establishAcceptedDirectChat(alice, bob);

    const reloadStartedAt = Date.now();
    await reloadAndWaitForApp(alice.page);
    expect(Date.now() - reloadStartedAt).toBeLessThan(8_000);

    const liveMessage = `slow-relay-live-${Date.now()}`;
    await navigateToChat(alice.page, bob.session.publicKey);
    const sendStartedAt = Date.now();
    await sendMessage(alice.page, liveMessage, {
      chatId: bob.session.publicKey,
      attempts: 1,
      timeoutMs: 1_000,
    });
    expect(Date.now() - sendStartedAt).toBeLessThan(2_000);

    await navigateToChat(bob.page, alice.session.publicKey);
    await waitForThreadMessage(bob.page, liveMessage, {
      chatId: alice.session.publicKey,
      attempts: 1,
      timeoutMs: 12_000,
    });

    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: hangErrorPatterns,
    });
  } finally {
    await disposeUsers(alice, bob);
  }
});
