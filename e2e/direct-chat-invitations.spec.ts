import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

async function selectedKey(page: Page) {
  return page.evaluate(async () => {
    const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
    return useChatStore().selectedChat?.publicKey;
  });
}

for (const scenario of [
  { format: 'hex', signup: true, width: 1280 },
  { format: 'hex', signup: false, width: 390 },
  { format: 'npub', signup: false, width: 1280 },
  { format: 'nprofile', signup: true, width: 390 },
]) {
  test(`new ${scenario.format} chat opens after ${scenario.signup ? 'signup' : 'login'} at ${scenario.width}px`, async ({
    page,
  }) => {
    const pubkey = getPublicKey(generateSecretKey());
    const id =
      scenario.format === 'hex'
        ? pubkey
        : scenario.format === 'npub'
          ? nip19.npubEncode(pubkey)
          : nip19.nprofileEncode({ pubkey, relays: ['ws://127.0.0.1:7777/'] });
    const target = `/chats/${id}`;
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(() => {
      for (const name of ['relays', 'nip65_relays'])
        localStorage.setItem(
          name,
          JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]),
        );
    });
    // No profile exists for this peer. Preview discovery must not gate navigation.
    await page.routeWebSocket('wss://**', (socket) => {
      socket.onMessage((raw) => {
        const [type, subscription] = JSON.parse(String(raw));
        if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
      });
    });
    await page.goto(target);
    await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
    if (scenario.signup) {
      await page.getByTestId('auth-create-account-button').click();
      await page.getByRole('button', { name: 'Login Now', exact: true }).click();
    } else {
      await page.getByTestId('auth-open-key-button').click();
      await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(generateSecretKey()));
      await page.getByTestId('auth-login-button').click();
    }
    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeEnabled();
    await page.reload();
    await page.getByTestId('auth-onboarding-relays-next-button').click();
    await page
      .getByTestId('auth-onboarding-skip-button')
      .or(page.getByTestId('auth-onboarding-continue-button'))
      .or(page.getByTestId('auth-onboarding-profile-start-button'))
      .click();
    const notifications = page.getByTestId('auth-notifications-skip');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(notifications.or(composer)).toBeVisible();
    if (await notifications.isVisible()) await notifications.click();
    await expect.poll(() => selectedKey(page)).toBe(pubkey);
    await expect(page.locator('.thread-header .identity-open')).toHaveText(pubkey);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.getByTestId('auth-link-banner')).toHaveCount(0);

    // Reloading an existing conversation must not duplicate it.
    await page.reload();
    await expect.poll(() => selectedKey(page)).toBe(pubkey);
    expect(
      await page.evaluate(async (key) => {
        const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
        return useChatStore().chats.filter((chat) => chat.publicKey === key).length;
      }, pubkey),
    ).toBe(1);

    // Client-side links must also create and select a new peer in the mounted shell.
    const next = getPublicKey(generateSecretKey());
    await page.evaluate((key) => {
      const link = document.createElement('a');
      link.href = `/chats/${key}`;
      link.textContent = 'Open linked peer';
      document.body.append(link);
    }, next);
    await page.getByRole('link', { name: 'Open linked peer', exact: true }).click();
    await expect.poll(() => selectedKey(page)).toBe(next);
    await expect(page.getByRole('link', { name: 'Open linked peer', exact: true })).toBeAttached();
    await expect(page.locator('.thread-header .identity-open')).toHaveText(next);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  });
}
