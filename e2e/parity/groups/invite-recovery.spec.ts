import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  addGroupMembersAndPublish,
  selectGroupInviteMembers,
  openGroupContact,
  navigateInApp,
  reloadAndWaitForApp,
  TEST_ACCOUNTS,
} from '../helpers';

test('existing owner invites from an older local recovery snapshot without losing current members', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.inviteRecoveryOwner);
  const existing = getPublicKey(generateSecretKey());
  const newcomer = getPublicKey(generateSecretKey());
  try {
    const group = await createGroup(owner.page, { name: 'Existing owner group', about: '' });
    const oldBackup = await owner.page.evaluate(async (group) => {
      const { contactsService } = await import('/src/services/contactsService.ts');
      return (await contactsService.getContactByPublicKey(group))!.meta
        .group_private_key_encrypted!;
    }, group);
    await addGroupMembersAndPublish(owner.page, [existing]);
    await navigateInApp(owner.page, '/chats');
    await reloadAndWaitForApp(owner.page);
    // Replay an older encrypted account backup after restarting the owner session.
    // The signed relay journal still contains the existing member's newer revision.
    await owner.page.evaluate(
      async ({ group, oldBackup }) => {
        const { contactsService } = await import('/src/services/contactsService.ts');
        const contact = (await contactsService.getContactByPublicKey(group))!;
        await contactsService.updateContact(contact.id, {
          meta: { ...contact.meta, group_private_key_encrypted: oldBackup },
        });
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        const saved = await useNostrStore().groupRecovery.secretFor(group);
        if (saved.recovery_state!.members.length !== 1)
          throw new Error('Stale backup fixture was not restored');
      },
      { group, oldBackup },
    );
    await openGroupContact(owner.page, group);
    await addGroupMembersAndPublish(owner.page, [newcomer]);
    const state = await owner.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      return (await useNostrStore().groupRecovery.current(group)).recovery_state!;
    }, group);
    expect(state.members.sort()).toEqual([owner.session.publicKey, existing, newcomer].sort());
    expect(state.epoch).toBe(0);

    // A change after opening the form must still reject its stale member list.
    const later = getPublicKey(generateSecretKey());
    const dialog = await selectGroupInviteMembers(owner.page, [later]);
    await owner.page.evaluate(
      async ({ group, members }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        await useNostrStore().publishGroupMemberChanges(group, members);
      },
      { group, members: [owner.session.publicKey, newcomer] },
    );
    await dialog.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed since you opened this form');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Refresh members', exact: true }).click();
    await expect(owner.page.locator(`.member[data-public-key="${existing}"]`)).toHaveCount(0);
    await addGroupMembersAndPublish(owner.page, [later]);
    const finalState = await owner.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      return (await useNostrStore().groupRecovery.current(group)).recovery_state!;
    }, group);
    expect(finalState.members.sort()).toEqual([owner.session.publicKey, newcomer, later].sort());
    expect(finalState.epoch).toBe(1);
  } finally {
    await disposeUsers(owner);
  }
});
