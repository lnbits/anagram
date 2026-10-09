import { test, expect, type Page } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS, confirmGroupBackup } from './parity/helpers';

for (const kind of ['private', 'public'] as const) {
  test(`${kind} group owners pin and unpin with a shared card visible to members after reload`, async ({
    browser,
  }, info) => {
    const owner = await bootstrapUser(browser, TEST_ACCOUNTS[`pinOwner${kind}`]);
    const member = await bootstrapUser(browser, TEST_ACCOUNTS[`pinMember${kind}`]);
    const a = owner.page,
      b = member.page;
    const rows = (page: Page) =>
      page.getByTestId(kind === 'private' ? 'message-bubble' : 'public-message');
    const send = async (text: string) => {
      await a
        .getByRole('textbox', {
          name: kind === 'private' ? 'Message' : 'Public message',
          exact: true,
        })
        .fill(text);
      await a.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(rows(a).filter({ hasText: text })).toBeVisible();
    };
    try {
      await a.getByRole('button', { name: 'Chat options' }).click();
      await a.getByRole('button', { name: `New ${kind} group`, exact: true }).click();
      if (kind === 'private') {
        await a.getByRole('button', { name: 'Generate new group', exact: true }).click();
        await a.getByLabel('Group name', { exact: true }).fill('Pinned private group');
        await a.getByLabel('Members', { exact: true }).fill(member.session.npub);
        await a.getByRole('button', { name: 'Continue', exact: true }).click();
        await confirmGroupBackup(a);
        await a.getByRole('button', { name: 'Create group', exact: true }).click();
      } else {
        await a.getByLabel('Group name', { exact: true }).fill('Pinned public group');
        await a.getByRole('button', { name: 'Create public group', exact: true }).click();
      }
      await expect(a.getByRole('dialog')).toBeHidden();
      await send('A useful group announcement');
      if (kind === 'private') {
        await b.getByTestId('requests-row').click();
        await b.getByTestId('chat-item').filter({ hasText: 'Pinned private group' }).click();
        await b.getByRole('button', { name: 'Accept', exact: true }).click();
      } else await b.goto(a.url());
      await expect(rows(b).filter({ hasText: 'A useful group announcement' })).toBeVisible();
      await rows(a).filter({ hasText: 'A useful group announcement' }).click({ button: 'right' });
      await a.getByRole('menuitem', { name: 'Pin message', exact: true }).click();
      await expect(a.getByTestId('pinned-message')).toContainText('A useful group announcement');
      await expect(b.getByTestId('pinned-message')).toContainText('A useful group announcement');
      await expect(b.getByRole('button', { name: 'Unpin message', exact: true })).toHaveCount(0);
      await rows(b).filter({ hasText: 'A useful group announcement' }).click({ button: 'right' });
      await expect(b.getByRole('menuitem', { name: 'Pin message', exact: true })).toHaveCount(0);
      await b.keyboard.press('Escape');
      // Ordinary profile edits must preserve the pin.
      await a
        .getByRole('button', {
          name: kind === 'private' ? 'Contact profile' : 'Public group settings',
          exact: true,
        })
        .click();
      await a.getByLabel('Description', { exact: true }).fill('Updated after pinning');
      await a.getByRole('button', { name: 'Save group profile', exact: true }).click();
      if (kind === 'private') {
        await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
        await a.getByRole('button', { name: 'Close dialog', exact: true }).click();
      } else await expect(a.getByRole('dialog')).toBeHidden();
      await a.reload();
      await b.reload();
      await expect(a.getByTestId('pinned-message')).toContainText('A useful group announcement');
      await expect(b.getByTestId('pinned-message')).toContainText('A useful group announcement');
      for (const width of [1280, 390]) {
        await a.setViewportSize({ width, height: 844 });
        for (const dark of [false, true]) {
          await a.evaluate((dark) => document.body.classList.toggle('body--dark', dark), dark);
          const card = a.getByTestId('pinned-message');
          await expect(card).toBeInViewport();
          expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
      }
      await a.getByRole('button', { name: 'Go to pinned message' }).click();
      await expect(rows(a).filter({ hasText: 'A useful group announcement' })).toHaveClass(
        /highlighted/,
      );
      await a.screenshot({ path: info.outputPath(`${kind}-pin-mobile.png`) });
      // Editing and deleting the target update the card via the same message state.
      await rows(a).filter({ hasText: 'A useful group announcement' }).click({ button: 'right' });
      await a.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await send('Updated group announcement');
      await expect(a.getByTestId('pinned-message')).toContainText('Updated group announcement');
      await expect(b.getByTestId('pinned-message')).toContainText('Updated group announcement');
      await rows(a).filter({ hasText: 'Updated group announcement' }).click({ button: 'right' });
      await expect(a.getByRole('menuitem', { name: 'Unpin message', exact: true })).toBeVisible();
      await a.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      await expect(a.getByTestId('pinned-message')).toContainText('Message deleted');
      await expect(b.getByTestId('pinned-message')).toContainText('Message deleted');
      await a.getByRole('button', { name: 'Unpin message', exact: true }).click();
      await expect(a.getByTestId('pinned-message')).toHaveCount(0);
      await expect(b.getByTestId('pinned-message')).toHaveCount(0);
      await b.reload();
      await expect(b.getByTestId('pinned-message')).toHaveCount(0);
      expect(owner.browserErrors).toEqual([]);
      expect(member.browserErrors).toEqual([]);
    } finally {
      await disposeUsers(owner, member);
    }
  });
}
