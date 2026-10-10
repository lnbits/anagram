import { test, expect } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from './parity/helpers';

test('shared Iroh invitation opens the existing join prompt without starting a call', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.socialCall);
  try {
    const link = await user.page.evaluate(async () => {
      const { formatRoomLink } = await import('/src/utils/callRoom.ts');
      return formatRoomLink({
        id: crypto.randomUUID(),
        host: 'a'.repeat(64),
        secret: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        relays: ['ws://127.0.0.1:7777/'],
      });
    });
    expect(new URL(link).pathname).toBe('/join/call.html');
    await user.page.goto(link);
    await expect(user.page.getByTestId('room-join-link')).toHaveValue(new URL(link).hash.slice(1));
    await expect(user.page.getByTestId('room-join-audio')).toBeEnabled();
    await expect(user.page.getByTestId('room-join-video')).toBeEnabled();
    expect(user.browserErrors).toEqual([]);
  } finally {
    await disposeUsers(user);
  }
});

test('public group invitations reuse call buttons in DMs and private groups and open locally', async ({
  browser,
}, info) => {
  const { establishAcceptedDirectChat, createGroup, navigateToChat, sendMessage, threadMessage } =
    await import('./parity/helpers');
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.publicInvitationAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.publicInvitationBob);
  try {
    await alice.page.getByRole('button', { name: 'Chat options' }).click();
    await alice.page.getByRole('button', { name: 'New public group', exact: true }).click();
    const dialog = alice.page.getByRole('dialog', { name: 'New public group' });
    await dialog.getByLabel('Group name', { exact: true }).fill('Invitation lounge');
    await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(alice.page).toHaveURL(/\/public\/naddr/);
    const target = new URL(alice.page.url()).pathname;
    const direct = `http://127.0.0.1:5173${target}`;
    const shared = `https://anagram.chat/join/chat.html#${target}`;
    await alice.page.getByRole('button', { name: 'chats', exact: true }).click();
    await establishAcceptedDirectChat(alice, bob);
    await alice.page.getByTestId('message-composer-input').fill(`Come chat: ${direct}`);
    await alice.page.getByTestId('message-send-button').click();
    const incoming = threadMessage(bob.page, 'Come chat:');
    const button = incoming.getByRole('link', { name: 'Join chat', exact: true });
    await expect(button).toHaveClass(/room-link/);
    await expect(button).toHaveAttribute('href', direct);
    await expect(incoming).not.toContainText('naddr1');
    await button.click();
    await expect(bob.page).toHaveURL(new RegExp(`${target}$`));
    await expect(bob.page.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Invitation lounge',
    );
    expect(new URL(bob.page.url()).port).not.toBe('5173');

    const group = await createGroup(alice.page, {
      name: 'Invitation test group',
      about: 'Shared invite buttons',
    });
    await navigateToChat(alice.page, group);
    await alice.page.getByTestId('message-composer-input').fill(`Public invitation: ${shared}`);
    await alice.page.getByTestId('message-send-button').click();
    const message = threadMessage(alice.page, 'Public invitation:');
    await expect(message.getByRole('link', { name: 'Join chat', exact: true })).toHaveClass(
      /room-link/,
    );
    await expect(message.locator('.link-preview')).toHaveCount(0);
    await message.getByRole('link', { name: 'Join chat', exact: true }).click({ button: 'right' });
    await expect(alice.page.getByTestId('message-link-copy')).toBeVisible();
    await alice.page.keyboard.press('Escape');
    await alice.page.evaluate(async () => {
      const { saveDesktopMessageLayoutPreference } = await import('/src/utils/themeStorage.ts');
      saveDesktopMessageLayoutPreference('bubbles');
    });
    for (const dark of [false, true]) {
      await alice.page.evaluate((dark) => document.body.classList.toggle('body--dark', dark), dark);
      await expect(message.getByRole('link', { name: 'Join chat', exact: true })).toBeVisible();
    }
    await alice.page.setViewportSize({ width: 390, height: 844 });
    await expect(message.getByRole('link', { name: 'Join chat', exact: true })).toBeVisible();
    await alice.page.screenshot({ path: info.outputPath('public-invitation-mobile.png') });
    await message.getByRole('link', { name: 'Join chat', exact: true }).click();
    await expect(alice.page).toHaveURL(new RegExp(`${target}$`));
    await expect(alice.page.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Invitation lounge',
    );
  } finally {
    await disposeUsers(alice, bob);
  }
});
