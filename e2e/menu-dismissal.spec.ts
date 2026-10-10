import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  navigateToChat,
  openGroupContact,
  TEST_ACCOUNTS,
} from './parity/helpers';

test.use({ hasTouch: true });

test('menus dismiss outside without swallowing clicks, toggles or menu actions', async ({
  browser,
}) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.menuDismissal);
  const { page } = user;
  try {
    const first = await createGroup(page, {
      name: 'First menu group',
      about: 'Menu dismissal test',
    });
    await navigateToChat(page, first);
    const second = await createGroup(page, {
      name: 'Second menu group',
      about: 'Menu dismissal test',
    });
    await navigateToChat(page, second);
    const firstRow = page
      .locator('.chat-row')
      .filter({ has: page.locator(`[data-chat-public-key="${first}"]`) });
    const secondRow = page
      .locator('.chat-row')
      .filter({ has: page.locator(`[data-chat-public-key="${second}"]`) });
    const firstTrigger = firstRow.getByRole('button', { name: 'Chat actions' });
    const secondTrigger = secondRow.getByRole('button', { name: 'Chat actions' });
    const composer = page.getByTestId('message-composer-input');

    await firstTrigger.click();
    await expect(firstRow.getByRole('menu')).toBeVisible();
    await composer.click();
    await expect(firstRow.getByRole('menu')).toBeHidden();
    await expect(composer).toBeFocused();
    await firstTrigger.click();
    await firstTrigger.click();
    await expect(firstRow.getByRole('menu')).toBeHidden();
    await firstTrigger.click();
    await secondTrigger.click();
    await expect(firstRow.getByRole('menu')).toBeHidden();
    await expect(secondRow.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(secondRow.getByRole('menu')).toBeHidden();
    await expect(secondTrigger).toBeFocused();
    await firstTrigger.click();
    await firstRow.getByRole('menuitem', { name: 'Mark as Read' }).click();
    await expect(firstRow.getByRole('menu')).toBeHidden();

    // Real touch clicks use the same dismissal path, without leaving an invisible overlay.
    await firstTrigger.tap();
    await composer.tap();
    await expect(firstRow.getByRole('menu')).toBeHidden();
    await expect(composer).toBeFocused();

    const emoji = page.getByTestId('message-composer-emoji');
    const attachments = page.getByTestId('message-composer-menu');
    const searchEmoji = page.getByRole('textbox', { name: 'Search emoji' });
    await emoji.click();
    await searchEmoji.fill('smile');
    await expect(searchEmoji).toBeVisible();
    await emoji.click();
    await expect(searchEmoji).toBeHidden();
    await emoji.click();
    await attachments.click();
    await expect(searchEmoji).toBeHidden();
    await expect(page.locator('.attachment-menu')).toBeVisible();
    await composer.click();
    await expect(page.locator('.attachment-menu')).toBeHidden();

    await openGroupContact(page, first);
    const firstContact = page
      .locator('.contact-row')
      .filter({ has: page.locator(`[data-public-key="${first}"]`) });
    const secondContact = page
      .locator('.contact-row')
      .filter({ has: page.locator(`[data-public-key="${second}"]`) });
    const contactTrigger = firstContact.getByRole('button', { name: 'Contact actions' });
    await contactTrigger.click();
    await page.getByLabel('Group name', { exact: true }).click();
    await expect(firstContact.getByRole('menu')).toBeHidden();
    await contactTrigger.click();
    await contactTrigger.click();
    await expect(firstContact.getByRole('menu')).toBeHidden();
    // Open the lower row first so its popup does not cover the next trigger.
    await secondContact.getByRole('button', { name: 'Contact actions' }).click();
    await contactTrigger.click();
    await expect(secondContact.getByRole('menu')).toBeHidden();
    await expect(firstContact.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(firstContact.getByRole('menu')).toBeHidden();
    await contactTrigger.click();
    await firstContact.getByRole('menuitem', { name: 'Chat', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/chats/${first}$`));
    expect(user.browserErrors).toEqual([]);
  } finally {
    await disposeUsers(user);
  }
});
