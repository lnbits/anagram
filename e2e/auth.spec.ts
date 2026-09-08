import NDK, {
  NDKEvent,
  NDKKind,
  NDKNip46Backend,
  NDKPrivateKeySigner,
  NDKRelaySet,
  normalizeRelayUrl,
} from '@nostr-dev-kit/ndk';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  acceptFirstRequest,
  bootstrapExtensionUser,
  bootstrapUser,
  disposeUsers,
  E2E_RELAY_URL,
  E2E_RELAY_URL_TWO,
  expectBrowserStorageToBeEmpty,
  expectNoUnexpectedBrowserErrors,
  logoutFromSettings,
  navigateToChat,
  openDirectChatFromIdentifier,
  openRequests,
  sendMessage,
  TEST_ACCOUNTS,
  waitForThreadMessage,
} from './helpers';

test.describe.configure({ mode: 'serial' });

type TestNip46BunkerBackend = {
  bunkerUrl: string;
  publicKey: string;
  stop: () => void;
};

type DisconnectableRelay = {
  disconnect: () => void;
};

type TestNip46RpcInternals = {
  pool?: {
    relays: Map<string, DisconnectableRelay>;
  };
};

async function seedAuthContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    (relayUrls: string[]) => {
      window.localStorage.setItem(
        'relays',
        JSON.stringify(relayUrls.map((url) => ({ url, read: true, write: true })))
      );
      window.localStorage.setItem('ui-browser-notifications', '0');

      const notificationMock = Object.assign(function NotificationMock() {}, {
        permission: 'denied' as NotificationPermission,
        requestPermission: async (): Promise<NotificationPermission> => 'denied',
      });

      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: notificationMock,
      });
    },
    [E2E_RELAY_URL]
  );
}

async function seedOnboardingProfile(): Promise<NDKPrivateKeySigner> {
  const signer = NDKPrivateKeySigner.generate();
  const ndk = new NDK({ explicitRelayUrls: [E2E_RELAY_URL], signer, enableOutboxModel: false });
  try {
    await ndk.connect(5_000);
    const event = new NDKEvent(ndk, {
      kind: NDKKind.Metadata,
      created_at: Math.floor(Date.now() / 1000) - 400 * 86400,
      tags: [],
      content: JSON.stringify({ name: 'History slider profile' }),
    });
    await event.publish(NDKRelaySet.fromRelayUrls([E2E_RELAY_URL], ndk, false));
    return signer;
  } finally {
    for (const relay of ndk.pool.relays.values()) relay.disconnect();
  }
}

async function loginToConfirmProfile(page: Page, signer: NDKPrivateKeySigner): Promise<void> {
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Login with Key (not recommended)', exact: true }).click();
  await page.getByLabel('Private Key (nsec or hex)', { exact: true }).fill(signer.privateKey);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByTestId('auth-onboarding-relays-next-button').click({ timeout: 30_000 });
  await expect(page.getByText('Confirm profile', { exact: true })).toBeVisible({ timeout: 20_000 });
}

test('Confirm profile offers all history durations and starts the selected restore', async ({
  browser,
}, info) => {
  const signer = await seedOnboardingProfile();
  const context = await browser.newContext();
  await seedAuthContext(context);
  const page = await context.newPage();
  try {
    await page.goto('/#/auth');
    await loginToConfirmProfile(page, signer);
    const slider = page.getByRole('slider', { name: 'Restore message history' });
    const value = page.getByTestId('auth-history-restore-value');
    const warning = page.getByTestId('auth-history-restore-warning');
    await expect(value).toHaveText('3 weeks');
    await expect(warning).toBeHidden();
    const labels = ['1 week', '2 weeks', '3 weeks', '1 month', '2 months', '3 months', '1 year'];
    await expect(slider.locator('.q-slider__marker-labels')).toHaveCount(0);
    const sliderControl = slider.locator('[tabindex="0"]');
    await sliderControl.press('PageDown');
    for (const [index, label] of labels.entries()) {
      if (index > 0) await sliderControl.press('ArrowRight');
      await expect(value).toHaveText(label);
      await expect(slider).toHaveAttribute('aria-valuetext', label);
      if (index > 2) await expect(warning).toContainText('Restoring more history may take longer.');
      else await expect(warning).toBeHidden();
    }
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 850 });
      const panelBox = await page.getByTestId('auth-history-restore').boundingBox();
      const logoutBox = await page.getByTestId('auth-onboarding-logout-button').boundingBox();
      if (!panelBox || !logoutBox) throw new Error('Onboarding controls are missing');
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(logoutBox.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
      await info.attach(`history-slider-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    }
    const confirmedAt = Math.floor(Date.now() / 1000);
    await page.getByTestId('auth-onboarding-continue-button').click();
    await expect(page).toHaveURL(/#\/chats$/, { timeout: 30_000 });
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const value = localStorage.getItem('nostr-private-messages-backfill-state');
            return value ? (JSON.parse(value).floorSince as number) : null;
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(confirmedAt - 365 * 86400);
    const floorSince = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('nostr-private-messages-backfill-state') ?? '{}')
          .floorSince as number
    );
    expect(floorSince).toBeLessThan(confirmedAt - 364 * 86400);
  } finally {
    await context.close();
  }
});

test('Confirm profile logout returns to login and the next login defaults to three weeks', async ({
  browser,
}) => {
  const signer = await seedOnboardingProfile();
  const context = await browser.newContext();
  await seedAuthContext(context);
  const page = await context.newPage();
  try {
    await page.goto('/#/auth');
    await loginToConfirmProfile(page, signer);
    await page
      .getByRole('slider', { name: 'Restore message history' })
      .locator('[tabindex="0"]')
      .press('PageUp');
    await expect(page.getByTestId('auth-history-restore-value')).toHaveText('1 year');
    await page.getByTestId('auth-onboarding-logout-button').click();
    await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await page.evaluate(() =>
        ['nsec', 'npub', 'auth-method'].map((key) => localStorage.getItem(key))
      )
    ).toEqual([null, null, null]);
    // Logout removes relay settings too; reseed the local-only fixture after cleanup.
    await page.reload();
    await loginToConfirmProfile(page, signer);
    await expect(page.getByTestId('auth-history-restore-value')).toHaveText('3 weeks');
    await expect(page.getByTestId('auth-history-restore-warning')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('registration onboarding logout clears the session and opens login', async ({ browser }) => {
  const context = await browser.newContext();
  await seedAuthContext(context);
  const page = await context.newPage();
  try {
    await page.goto('/#/register');
    await page.getByRole('button', { name: 'Login Now', exact: true }).click();
    await page.getByTestId('auth-onboarding-logout-button').click({ timeout: 30_000 });
    await expect(page).toHaveURL(/#\/auth$/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() =>
        ['nsec', 'npub', 'auth-method'].map((key) => localStorage.getItem(key))
      )
    ).toEqual([null, null, null]);
  } finally {
    await context.close();
  }
});

async function startTestNip46BunkerBackend(
  relayUrl = E2E_RELAY_URL
): Promise<TestNip46BunkerBackend> {
  const relayUrls = [normalizeRelayUrl(relayUrl)];
  const ndk = new NDK({
    explicitRelayUrls: relayUrls,
  });
  const signer = new NDKPrivateKeySigner(TEST_ACCOUNTS.nip07Bob.privateKey);
  ndk.signer = signer;
  await ndk.connect(5_000);

  const backend = new NDKNip46Backend(ndk, signer, async () => true, relayUrls);
  await backend.start();
  await new Promise((resolve) => setTimeout(resolve, 250));

  return {
    bunkerUrl: `bunker://${signer.pubkey}?relay=${encodeURIComponent(relayUrls[0] ?? relayUrl)}`,
    publicKey: signer.pubkey,
    stop: () => {
      for (const relay of ndk.pool.relays.values()) {
        relay.disconnect();
      }
      const rpcPool = (backend.rpc as unknown as TestNip46RpcInternals).pool;
      for (const relay of rpcPool?.relays.values() ?? []) {
        relay.disconnect();
      }
    },
  };
}

test('extension login is hidden when the browser has no NIP-07 provider', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('/#/auth');
    expect(await page.evaluate(() => typeof window.nostr)).toBe('undefined');

    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(
      page.getByRole('button', { name: 'Login with Extension', exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Login with Remote Signer', exact: true })
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('generated key login opens profile onboarding before chats', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(
    (relayUrls: string[]) => {
      window.localStorage.setItem(
        'relays',
        JSON.stringify(relayUrls.map((url) => ({ url, read: true, write: true })))
      );
    },
    [E2E_RELAY_URL, E2E_RELAY_URL_TWO]
  );
  const page = await context.newPage();

  try {
    await page.goto('/#/register');
    await expect(page.getByRole('button', { name: 'Login Now', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Login Now', exact: true }).click();

    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('auth-onboarding-logout-button')).toBeVisible();
    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toHaveText('Next');
    await expect(page).toHaveURL(/#\/register$/);

    const secondRelayCheckbox = page.getByRole('checkbox', {
      name: `Use ${E2E_RELAY_URL_TWO} when searching for profile`,
    });
    await expect(secondRelayCheckbox).toBeChecked({ timeout: 10_000 });
    await secondRelayCheckbox.click();
    await expect(secondRelayCheckbox).not.toBeChecked();

    await page.getByTestId('auth-onboarding-relays-next-button').click();
    await expect(page.getByTestId('auth-onboarding-profile-name-input')).toBeVisible();
    await expect(page.getByTestId('auth-onboarding-profile-about-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'Use selected relays for my profile' })
    ).toBeChecked();
    await expect(page.getByTestId('auth-onboarding-profile-start-button')).toBeEnabled();
    await page.getByTestId('auth-onboarding-profile-start-button').click();
    await page
      .getByRole('button', { name: 'Not now', exact: true })
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/#\/chats$/);

    const storedRelayLists = await page.evaluate(() => {
      const appRelaysValue = window.localStorage.getItem('relays');
      const nip65RelaysValue = window.localStorage.getItem('nip65_relays');
      return {
        appRelays: appRelaysValue ? (JSON.parse(appRelaysValue) as Array<{ url: string }>) : [],
        nip65Relays: nip65RelaysValue
          ? (JSON.parse(nip65RelaysValue) as Array<{ url: string }>)
          : [],
      };
    });
    expect(storedRelayLists.appRelays.map((relay) => relay.url)).toEqual([
      new URL(E2E_RELAY_URL).href,
    ]);
    expect(storedRelayLists.nip65Relays.map((relay) => relay.url)).toEqual([
      new URL(E2E_RELAY_URL).href,
    ]);
  } finally {
    await context.close();
  }
});

test('remote signer login generates a nostrconnect QR pairing link', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(
    (relayUrls: string[]) => {
      window.localStorage.setItem(
        'relays',
        JSON.stringify(relayUrls.map((url) => ({ url, read: true, write: true })))
      );
    },
    [E2E_RELAY_URL]
  );
  const page = await context.newPage();

  try {
    await page.goto('/#/auth');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.getByRole('button', { name: 'Login with Remote Signer', exact: true }).click();
    await page.getByText('Nostr Connect', { exact: true }).click();

    await expect(page.getByRole('textbox', { name: 'Pairing relay' })).toHaveValue(E2E_RELAY_URL);
    await page.getByTestId('auth-remote-signer-create-nostrconnect-button').click();

    const uriInput = page.getByRole('textbox', { name: 'nostrconnect://' });
    await expect(uriInput).toBeVisible({ timeout: 10_000 });
    const uri = await uriInput.inputValue();
    const parsedUri = new URL(uri);

    expect(parsedUri.protocol).toBe('nostrconnect:');
    expect(parsedUri.hostname).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedUri.searchParams.get('relay')).toBe(new URL(E2E_RELAY_URL).href);
    expect(parsedUri.searchParams.get('secret')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedUri.searchParams.get('perms')).toContain('sign_event');
    expect(parsedUri.searchParams.get('perms')).toContain('nip44_encrypt');
    expect(parsedUri.searchParams.get('perms')).toContain('nip44_decrypt');

    const qrImage = page.getByTestId('auth-remote-signer-nostrconnect-qr').locator('img');
    await expect(qrImage).toHaveAttribute('src', /^data:image\/png;base64,/);

    await page.getByTestId('auth-remote-signer-cancel-button').click();
    await expect(page.getByTestId('auth-remote-signer-nostrconnect-uri')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('bunker query parameter auto-logs in with a remote signer', async ({ browser }) => {
  const backend = await startTestNip46BunkerBackend();
  const context = await browser.newContext();
  await seedAuthContext(context);
  const page = await context.newPage();

  try {
    await page.goto(`/?bunker=${encodeURIComponent(backend.bunkerUrl)}#/`);

    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).not.toContain('bunker=');
    expect(await page.evaluate(() => window.localStorage.getItem('auth-method'))).toBe('nip46');
    expect(
      await page.evaluate(() => window.localStorage.getItem('nostr-nip46-signer'))
    ).toBeTruthy();

    const session = await page.evaluate(async () => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.getSessionSnapshot();
    });
    expect(session.publicKey).toBe(backend.publicKey);

    await page.getByTestId('auth-onboarding-relays-next-button').click();
    await expect(page.getByTestId('auth-onboarding-profile-name-input')).toBeVisible();
    await page.getByTestId('auth-onboarding-profile-start-button').click();
    await page
      .getByRole('button', { name: 'Not now', exact: true })
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/#\/chats$/);
  } finally {
    backend.stop();
    await context.close();
  }
});

test('invalid bunker query leaves the remote signer form ready to retry', async ({ browser }) => {
  const context = await browser.newContext();
  await seedAuthContext(context);
  const page = await context.newPage();
  const invalidBunkerUrl = 'not-a-bunker-url';

  try {
    await page.goto(`/#/login?bunker=${encodeURIComponent(invalidBunkerUrl)}`);

    await expect(page.getByTestId('auth-remote-signer-bunker-input')).toHaveValue(invalidBunkerUrl);
    await expect(
      page
        .locator('.auth-onboarding-banner--warning')
        .filter({ hasText: 'Enter a valid bunker:// connection string with at least one relay.' })
    ).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.url(), { timeout: 10_000 }).not.toContain('bunker=');
  } finally {
    await context.close();
  }
});

test('logged-in users ignore bunker query parameters with a message', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.nip07Alice);
  const bunkerUrl = `bunker://${'a'.repeat(64)}?relay=${encodeURIComponent(E2E_RELAY_URL)}`;

  try {
    await alice.page.goto(`/#/chats?bunker=${encodeURIComponent(bunkerUrl)}`);
    await expect(alice.page.getByText('A user is already logged in.')).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => alice.page.url(), { timeout: 10_000 }).not.toContain('bunker=');
    await expect.poll(() => alice.page.url(), { timeout: 10_000 }).toMatch(/#\/chats$/);
  } finally {
    await disposeUsers(alice);
  }
});

test('NIP-07 login can establish a direct chat and receive a reply', async ({ browser }) => {
  const alice = await bootstrapExtensionUser(browser, TEST_ACCOUNTS.nip07Alice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.nip07Bob);

  try {
    await alice.page.goto('/#/auth');
    await expect.poll(() => alice.page.url(), { timeout: 10_000 }).toMatch(/#\/chats$/);
    await alice.page.goto('/#/register');
    await expect.poll(() => alice.page.url(), { timeout: 10_000 }).toMatch(/#\/chats$/);

    const openingMessage = `nip07-open-${Date.now()}`;
    const replyMessage = `nip07-reply-${Date.now()}`;

    await openDirectChatFromIdentifier(
      alice.page,
      bob.session.publicKey,
      TEST_ACCOUNTS.nip07Bob.displayName
    );
    await sendMessage(alice.page, openingMessage, {
      chatId: bob.session.publicKey,
    });

    await openRequests(bob.page);
    await acceptFirstRequest(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await sendMessage(bob.page, replyMessage, {
      chatId: alice.session.publicKey,
    });

    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, replyMessage, {
      chatId: bob.session.publicKey,
    });
    await logoutFromSettings(alice.page);
    await expectBrowserStorageToBeEmpty(alice.page);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
