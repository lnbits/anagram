import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  createGroup,
  confirmGroupBackup,
  disposeUsers,
  addGroupMemberAndPublish,
  openGroupContact,
  navigateToChat,
  sendMessage,
  waitForThreadMessage,
  rotateGroupEpoch,
  openRequests,
  acceptFirstRequest,
  E2E_RELAY_URL,
} from '../helpers';

test('twelve words restore old epochs and co-owner access on a fresh account', async ({
  browser,
}) => {
  test.slow();
  let owner = await bootstrapUser(browser, TEST_ACCOUNTS.seedOwner);
  const member = await bootstrapUser(browser, TEST_ACCOUNTS.seedMember);
  const recovered = await bootstrapUser(browser, TEST_ACCOUNTS.seedRecovered);
  try {
    const group = await createGroup(owner.page, {
      name: 'Recoverable group',
      about: 'Seed recovery',
    });
    await owner.page.getByRole('tab', { name: 'Recovery', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Show ownership backup' }).click();
    const words = await owner.page
      .getByRole('list', { name: 'Recovery words' })
      .locator('strong')
      .allTextContents();
    expect(words).toHaveLength(12);
    await addGroupMemberAndPublish(owner.page, member.session.publicKey);
    await openRequests(member.page, { publicKey: group });
    await acceptFirstRequest(member.page, { publicKey: group });
    await navigateToChat(owner.page, group);
    await sendMessage(owner.page, 'Before the rotation', { chatId: group });
    await rotateGroupEpoch(owner.page, group, [member.session.publicKey]);
    await sendMessage(owner.page, 'After the rotation', { chatId: group });
    await disposeUsers(owner);

    // No original account key, IndexedDB, or self-encrypted account backup.
    await recovered.page.setViewportSize({ width: 390, height: 844 });
    await recovered.page.getByRole('button', { name: 'Chat options' }).click();
    await recovered.page.getByRole('button', { name: 'New private group', exact: true }).click();
    await recovered.page.getByRole('button', { name: 'Restore group', exact: true }).click();
    for (let i = 0; i < 12; i++)
      await recovered.page
        .getByRole('textbox', { name: `Word ${i + 1}`, exact: true })
        .fill(words[i]);
    await recovered.page.getByLabel('Group relays (optional)').fill(E2E_RELAY_URL);
    await recovered.page.getByRole('button', { name: 'Find group', exact: true }).click();
    await expect(recovered.page.getByRole('heading', { name: 'Recoverable group' })).toBeVisible();
    await recovered.page
      .getByRole('checkbox', { name: 'Join this group with my signed-in account' })
      .check();
    await recovered.page.getByRole('button', { name: 'Restore ownership', exact: true }).click();
    await expect(recovered.page.getByRole('dialog')).toBeHidden();
    await navigateToChat(recovered.page, group);
    await waitForThreadMessage(recovered.page, 'Before the rotation', { chatId: group });
    await waitForThreadMessage(recovered.page, 'After the rotation', { chatId: group });
    await sendMessage(recovered.page, 'Recovered owner can reply', { chatId: group });
    await navigateToChat(member.page, group);
    await waitForThreadMessage(member.page, 'Recovered owner can reply', { chatId: group });

    await openGroupContact(recovered.page, group);
    await recovered.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await recovered.page
      .locator(`.member[data-public-key="${owner.session.publicKey}"]`)
      .getByRole('button', { name: 'Remove member', exact: true })
      .click();
    await expect(recovered.page.getByRole('alert')).toContainText('Replace group master');

    await recovered.page.getByRole('tab', { name: 'Recovery', exact: true }).click();
    await recovered.page.getByRole('button', { name: 'Replace group master', exact: true }).click();
    await recovered.page.getByLabel('Members to keep').fill(member.session.publicKey);
    await recovered.page
      .getByRole('checkbox', { name: 'I have reviewed who should keep access' })
      .check();
    await recovered.page.getByRole('button', { name: 'Back up replacement group' }).click();
    const replacementWords = await recovered.page
      .getByRole('list', { name: 'Recovery words' })
      .locator('strong')
      .allTextContents();
    expect(replacementWords.join(' ')).not.toBe(words.join(' '));
    await confirmGroupBackup(recovered.page);
    await recovered.page
      .getByRole('button', { name: 'Create replacement group', exact: true })
      .click();
    await expect(recovered.page).not.toHaveURL(new RegExp(`${group}$`));
    await expect(recovered.page.getByTestId('group-details')).toBeVisible();
    const replacementGroup = recovered.page.url().split('/').at(-1)!;
    await openRequests(member.page, { publicKey: replacementGroup });
    await acceptFirstRequest(member.page, { publicKey: replacementGroup });
    await navigateToChat(recovered.page, replacementGroup);
    await sendMessage(recovered.page, 'Fresh master message', { chatId: replacementGroup });
    await navigateToChat(member.page, replacementGroup);
    await waitForThreadMessage(member.page, 'Fresh master message', { chatId: replacementGroup });
  } finally {
    await disposeUsers(owner, member, recovered);
  }
});

test('mobile group backup requires the saved words before creation and offers a recovery download', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.seedMobile);
  try {
    await user.page.setViewportSize({ width: 390, height: 844 });
    await user.page.getByRole('button', { name: 'Chat options' }).click();
    await user.page.getByRole('button', { name: 'New private group', exact: true }).click();
    await user.page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await user.page.getByLabel('Group name', { exact: true }).fill('Mobile backup');
    await user.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(user.page.getByRole('button', { name: 'Verify backup' })).toBeDisabled();
    const download = user.page.waitForEvent('download');
    await user.page.getByRole('button', { name: 'Download private backup' }).click();
    const backupDownload = await download;
    expect(backupDownload.suggestedFilename()).toMatch(/^anagram-group-.*-PRIVATE.json$/);
    const words = await user.page
      .getByRole('list', { name: 'Recovery words' })
      .locator('strong')
      .allTextContents();
    await user.page
      .getByRole('checkbox', { name: 'I have saved my recovery words somewhere safe' })
      .check();
    await user.page.getByRole('button', { name: 'Verify backup', exact: true }).click();
    const inputs = user.page.getByRole('textbox', { name: /^Word \d+$/ });
    const boxes = await Promise.all([0, 1, 2].map((i) => inputs.nth(i).boundingBox()));
    expect(boxes.every((box) => box && Math.abs(box.y - boxes[0]!.y) < 1)).toBe(true);
    await user.page.screenshot({ path: test.info().outputPath('verify-mobile.png') });
    for (let i = 0; i < 3; i++) await inputs.nth(i).fill('incorrect');
    await user.page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(user.page.getByRole('alert')).toContainText('do not match');
    for (let i = 0; i < 3; i++) {
      const label = await inputs
        .nth(i)
        .evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent || '');
      await inputs.nth(i).fill(words[Number(label.match(/Word (\d+)/)?.[1]) - 1]);
    }
    expect(await user.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await user.page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(user.page.getByRole('dialog')).toBeHidden();
    await expect(user.page).toHaveURL(/\/chats\/[a-f0-9]{64}$/);
    await user.page.goto('/chats');
    await user.page.getByRole('button', { name: 'Chat options' }).click();
    await user.page.getByRole('button', { name: 'New private group', exact: true }).click();
    await expect(user.page.getByLabel('Group name', { exact: true })).toHaveCount(0);
    await user.page.getByRole('button', { name: 'Restore group', exact: true }).click();
    const restoredWords = user.page.getByRole('textbox', { name: /^Word \d+$/ });
    await expect(restoredWords).toHaveCount(12);
    await user.page
      .getByLabel('Recovery file', { exact: true })
      .setInputFiles((await backupDownload.path())!);
    for (let i = 0; i < 12; i++) await expect(restoredWords.nth(i)).toHaveValue(words[i]);
    await restoredWords.nth(0).fill('');
    await expect(user.page.getByRole('button', { name: 'Find group', exact: true })).toBeDisabled();
    await restoredWords.nth(0).evaluate((el, phrase) => {
      const data = new DataTransfer();
      data.setData('text', phrase);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, words.join(' '));
    for (let i = 0; i < 12; i++) await expect(restoredWords.nth(i)).toHaveValue(words[i]);
    expect(await user.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await user.page.screenshot({ path: test.info().outputPath('restore-mobile.png') });
    await user.page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      user.page.getByRole('button', { name: 'Generate new group', exact: true }),
    ).toBeVisible();
  } finally {
    await disposeUsers(user);
  }
});

test('a co-owner cannot reintroduce removed members by rotating a stale membership snapshot', async ({
  browser,
}) => {
  test.slow();
  const owner = await bootstrapUser(browser, TEST_ACCOUNTS.conflictOwner);
  const coowner = await bootstrapUser(browser, TEST_ACCOUNTS.conflictCoowner);
  try {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools');
    const removedMember = getPublicKey(generateSecretKey());
    const group = await createGroup(owner.page, { name: 'Co-owner conflict check', about: '' });
    const phrase = await owner.page.evaluate(
      async ({ group, member }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        const recovery = useNostrStore().groupRecovery;
        await recovery.update(group, [useNostrStore().getLoggedInPublicKeyHex()!, member]);
        return (await recovery.backup(group)).phrase;
      },
      { group, member: removedMember },
    );
    await coowner.page.evaluate(
      async ({ phrase, relay }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        await useNostrStore().groupRecovery.restore(phrase, [relay]);
      },
      { phrase, relay: E2E_RELAY_URL },
    );
    await owner.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      await useNostrStore().groupRecovery.refresh(group);
    }, group);
    await openGroupContact(owner.page, group);
    await owner.page.getByRole('tab', { name: 'Recovery', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Refresh recovery', exact: true }).click();
    await owner.page.getByRole('tab', { name: 'Members', exact: true }).click();
    await expect(
      owner.page.getByRole('button', { name: 'Rotate group keys', exact: true }),
    ).toBeEnabled();
    await expect(owner.page.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
    await coowner.page.evaluate(
      async ({ group, originalOwner }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.ts');
        await useNostrStore().publishGroupMemberChanges(group, [originalOwner]);
      },
      { group, originalOwner: owner.session.publicKey },
    );
    await owner.page.getByRole('button', { name: 'Rotate group keys', exact: true }).click();
    await expect(owner.page.getByRole('alert')).toContainText(/changed|Refresh recovery/);
    const current = await coowner.page.evaluate(async (group) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.ts');
      return (await useNostrStore().groupRecovery.current(group)).recovery_state!.members;
    }, group);
    expect(current).not.toContain(removedMember);
    expect(current).toContain(coowner.session.publicKey);
  } finally {
    await disposeUsers(owner, coowner);
  }
});
