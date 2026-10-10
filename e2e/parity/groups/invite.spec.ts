import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  establishAcceptedDirectChat,
  openGroupContact,
  openRequests,
  acceptFirstRequest,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  TEST_ACCOUNTS,
} from '../helpers';

test('invite picker prioritizes contacts, searches relays, accepts public keys and delivers invitations', async ({
  browser,
}) => {
  test.slow();
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.invitePickerOwner);
  const local = await bootstrapUser(browser, TEST_ACCOUNTS.invitePickerLocal);
  const remote = await bootstrapUser(browser, TEST_ACCOUNTS.invitePickerRemote);
  try {
    await establishAcceptedDirectChat(owner, local);
    const group = await createGroup(owner.page, { name: 'Invite picker group', about: '' });
    await navigateToChat(owner.page, group);
    await owner.page.locator('.thread-identity').click();
    const groupDialog = owner.page.locator('.modal[role="dialog"]');
    const title = groupDialog.getByRole('heading', { name: 'Invite picker group' });
    await title.click();
    await expect(groupDialog).toBeVisible();
    const titleBox = await title.boundingBox();
    await owner.page.mouse.move(titleBox!.x + 10, titleBox!.y + 10);
    await owner.page.mouse.down();
    await owner.page.mouse.move(5, 5);
    await owner.page.mouse.up();
    await expect(groupDialog).toBeVisible();
    await owner.page.mouse.move(5, 5);
    await owner.page.mouse.down();
    await owner.page.mouse.move(titleBox!.x + 10, titleBox!.y + 10);
    await owner.page.mouse.up();
    await expect(groupDialog).toBeVisible();
    await owner.page.mouse.click(5, 5);
    await expect(groupDialog).toBeHidden();
    await navigateToChat(owner.page, group);
    await owner.page.locator('.thread-identity').click();
    await owner.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Invite members', exact: true }).click();
    const dialog = owner.page.getByRole('dialog', { name: 'Invite members', exact: true });
    const search = dialog.getByRole('textbox', { name: 'Search people' });
    await expect(search).toBeFocused();
    // Native dialog padding is inside; its backdrop closes only the nested dialog.
    await dialog.click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeVisible();
    await owner.page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    await expect(groupDialog).toBeVisible();
    await owner.page.getByRole('button', { name: 'Invite members', exact: true }).click();
    await search.fill('invitePicker');
    const contact = dialog
      .getByTestId('invite-contact-result')
      .filter({ hasText: 'invitePickerLocal' });
    const stranger = dialog
      .getByTestId('profile-search-result')
      .filter({ hasText: 'invitePickerRemote' });
    await expect(contact).toBeVisible();
    await expect(stranger).toBeVisible();
    await expect(
      dialog.getByTestId('profile-search-result').filter({ hasText: 'invitePickerLocal' }),
    ).toHaveCount(0);
    const contactBox = await contact.boundingBox();
    const remoteBox = await stranger.boundingBox();
    expect(contactBox!.y).toBeLessThan(remoteBox!.y);
    await owner.page.screenshot({ path: test.info().outputPath('invite-desktop.png') });
    await contact.click();
    await expect(dialog.getByRole('button', { name: 'Invite (1)', exact: true })).toBeEnabled();
    await search.fill(remote.session.npub);
    await expect(
      dialog.getByTestId('profile-search-result').filter({ hasText: 'invitePickerRemote' }),
    ).toBeVisible();
    await dialog
      .getByTestId('profile-search-result')
      .filter({ hasText: 'invitePickerRemote' })
      .click();
    await dialog.getByRole('button', { name: 'Remove invitePickerRemote from selection' }).click();
    await search.fill(remote.session.publicKey);
    await expect(
      dialog.getByTestId('profile-search-result').filter({ hasText: 'invitePickerRemote' }),
    ).toBeVisible();
    await search.press('ArrowDown');
    await owner.page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Invite (2)', exact: true })).toBeEnabled();
    // Public keys without metadata must also be selectable.
    const unknown = getPublicKey(generateSecretKey());
    await search.fill(nip19.npubEncode(unknown));
    await dialog
      .getByTestId('profile-search-result')
      .filter({ hasText: unknown.slice(0, 16) })
      .click();
    await dialog
      .getByRole('button', { name: `Remove ${unknown.slice(0, 16)} from selection` })
      .click();
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await owner.page.screenshot({ path: test.info().outputPath('invite-mobile.png') });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await dialog.getByRole('button', { name: 'Invite (2)', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(owner.page.getByTestId('group-details').getByRole('status')).toHaveText(
      'Invitations sent',
    );
    for (const member of [local, remote]) {
      await openRequests(member.page, { publicKey: group });
      await acceptFirstRequest(member.page, { publicKey: group });
    }
    await owner.page.getByRole('button', { name: 'Invite members', exact: true }).click();
    await search.fill('invitePicker');
    await expect(dialog.getByTestId('invite-contact-result')).toHaveCount(0);
    await expect(dialog.getByTestId('profile-search-result')).toHaveCount(0);
    await search.press('Escape');
    await expect(dialog).toBeHidden();
    // The containing group dialog also dismisses at a mobile viewport.
    await expect(groupDialog).toBeVisible();
    await owner.page.mouse.click(5, 5);
    await expect(groupDialog).toBeHidden();
    await navigateToChat(owner.page, group);
    const message = `Picker invitations delivered ${Date.now()}`;
    await sendMessage(owner.page, message, { chatId: group });
    for (const member of [local, remote]) {
      await navigateToChat(member.page, group);
      await waitForThreadMessage(member.page, message, { chatId: group });
    }
    await openGroupContact(remote.page, group);
    await remote.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(
      remote.page.getByRole('button', { name: 'Invite members', exact: true }),
    ).toHaveCount(0);
  } finally {
    await disposeUsers(owner, local, remote);
  }
});
