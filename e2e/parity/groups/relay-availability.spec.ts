import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  createGroup,
  disposeUsers,
  addGroupMemberAndPublish,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  rotateGroupEpoch,
  openRequests,
  acceptFirstRequest,
  E2E_RELAY_URL_TWO,
  E2E_DUAL_RELAY_URLS,
} from '../helpers';

test('private owner can invite, rotate and send when a recovery replica stops responding', async ({
  browser,
}) => {
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.availableOwner, {
    relayUrls: E2E_DUAL_RELAY_URLS,
  });
  const member = await bootstrapUser(browser, TEST_ACCOUNTS.availableMember);
  let stalled = false;
  let recoveryReads = 0;
  let attemptedWrites = 0;
  try {
    await owner.page.routeWebSocket(E2E_RELAY_URL_TWO, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (
          frame[0] === 'REQ' &&
          frame
            .slice(2)
            .some((filter: Record<string, unknown>) =>
              (filter['#t'] as string[] | undefined)?.includes('anagram-group-recovery-v1'),
            )
        ) {
          recoveryReads++;
          if (stalled) return;
        }
        if (
          stalled &&
          frame[0] === 'EVENT' &&
          frame[1].tags.some(
            (tag: string[]) => tag[0] === 't' && tag[1] === 'anagram-group-recovery-v1',
          )
        ) {
          attemptedWrites++;
          socket.send(
            JSON.stringify(['OK', frame[1].id, false, 'error: recovery replica unavailable']),
          );
          return;
        }
        server.send(raw);
      });
    });
    await owner.page.reload();
    const group = await createGroup(owner.page, { name: 'Available private group', about: '' });
    await owner.page.getByRole('tab', { name: 'Recovery', exact: true }).click();
    await expect(owner.page.getByText(/We recommend one owner per group/)).toBeVisible();
    const urls = await owner.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      return (await useNostrStore().groupRecovery.secretFor(group)).recovery_state!.relays;
    }, group);
    expect(urls).toEqual(E2E_DUAL_RELAY_URLS);
    stalled = true;
    await addGroupMemberAndPublish(owner.page, member.session.publicKey);
    expect(attemptedWrites).toBeGreaterThan(0);
    await openRequests(member.page, { publicKey: group });
    await acceptFirstRequest(member.page, { publicKey: group });
    await navigateToChat(owner.page, group);
    await navigateToChat(member.page, group);
    const before = recoveryReads;
    await sendMessage(owner.page, 'Owner sends with an unavailable recovery replica', {
      chatId: group,
    });
    await waitForThreadMessage(member.page, 'Owner sends with an unavailable recovery replica', {
      chatId: group,
    });
    expect(recoveryReads).toBe(before);
    await rotateGroupEpoch(owner.page, group, [member.session.publicKey]);
    await sendMessage(owner.page, 'New epoch still works', { chatId: group });
    await waitForThreadMessage(member.page, 'New epoch still works', { chatId: group });
    await owner.page.reload();
    await navigateToChat(owner.page, group);
    await sendMessage(owner.page, 'Still working after reload', { chatId: group });
    await waitForThreadMessage(member.page, 'Still working after reload', { chatId: group });
    expect(owner.browserErrors).toEqual([]);
    expect(member.browserErrors).toEqual([]);
  } finally {
    await disposeUsers(owner, member);
  }
});
