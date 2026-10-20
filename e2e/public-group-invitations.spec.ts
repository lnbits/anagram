import { test, expect } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { WebSocket } from 'ws';

const relay = 'ws://127.0.0.1:7777/';
async function invitation() {
  const key = generateSecretKey();
  const owner = getPublicKey(key);
  const slug = `invite-${crypto.randomUUID()}`;
  const created_at = Math.floor(Date.now() / 1000);
  const events = [
    finalizeEvent(
      {
        kind: 34550,
        created_at,
        content: '',
        tags: [
          ['d', slug],
          ['name', 'Invited public group'],
          ['anagram-room', '1'],
          ['relay', relay],
        ],
      },
      key,
    ),
    finalizeEvent(
      {
        kind: 9,
        created_at,
        content: 'Welcome from the invitation',
        tags: [['a', `34550:${owner}:${slug}`]],
      },
      key,
    ),
  ];
  const socket = new WebSocket(relay);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    for (const event of events)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Fixture relay did not acknowledge the event')),
          5000,
        );
        socket.once('message', (raw) => {
          clearTimeout(timer);
          const [type, id, accepted] = JSON.parse(String(raw));
          if (type === 'OK' && id === event.id && accepted) resolve();
          else reject(new Error('Fixture relay rejected the event'));
        });
        socket.send(JSON.stringify(['EVENT', event]));
      });
  } finally {
    socket.close();
  }
  return nip19.naddrEncode({ kind: 34550, pubkey: owner, identifier: slug, relays: [relay] });
}

for (const scenario of [
  { entry: '/join/chat#', signup: true, width: 1280 },
  { entry: '/join/chat/#', signup: false, width: 390 },
  { entry: '/join/chat.html#', signup: true, width: 1280 },
  { entry: '', signup: false, width: 390 },
]) {
  test(`public invitation ${scenario.entry || 'direct'} opens after ${scenario.signup ? 'signup' : 'login'} at ${scenario.width}px`, async ({
    page,
  }) => {
    const naddr = await invitation();
    const target = `/public/${naddr}`;
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript((url) => {
      for (const name of ['relays', 'nip65_relays'])
        localStorage.setItem(name, JSON.stringify([{ url, read: true, write: true }]));
    }, relay);
    await page.goto(`${scenario.entry}${target}`);
    await expect(page.getByTestId('auth-create-account-button')).toBeVisible();
    await expect(page.getByTestId('auth-link-banner').locator('.name')).toHaveText(
      'Invited public ...',
    );
    if (scenario.signup) {
      await page.getByTestId('auth-create-account-button').click();
      await page.getByRole('button', { name: 'Login Now', exact: true }).click();
    } else {
      await page.getByTestId('auth-open-key-button').click();
      await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(generateSecretKey()));
      await page.getByTestId('auth-login-button').click();
    }
    await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeEnabled();
    // Reload during onboarding: the destination must survive account restoration too.
    await page.reload();
    await page.getByTestId('auth-onboarding-relays-next-button').click();
    await page
      .getByTestId('auth-onboarding-skip-button')
      .or(page.getByTestId('auth-onboarding-continue-button'))
      .or(page.getByTestId('auth-onboarding-profile-start-button'))
      .click();
    const notifications = page.getByTestId('auth-notifications-skip');
    const group = page.getByRole('button', { name: 'Public group settings' });
    await expect(notifications.or(group)).toBeVisible();
    if (await notifications.isVisible()) await notifications.click();
    await expect(group).toContainText('Invited public group');
    await expect(page.getByTestId('auth-link-banner')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(
      page.getByTestId('public-message').filter({ hasText: 'Welcome from the invitation' }),
    ).toBeVisible();
    await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
    // Opening the same share link with an existing session must also select the group.
    await page.goto(`/join/chat#${target}`);
    await expect(group).toContainText('Invited public group');
    await expect(page).toHaveURL(new RegExp(`${target}$`));
  });
}
