import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  bootstrapUser,
  createGroup,
  disposeUsers,
  navigateInApp,
  navigateToChat,
  openGroupContact,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
} from './parity/helpers';

// Change the same body state as Appearance without closing the surface under test.
async function setTheme(page: Page, dark: boolean, accent = 'default') {
  await page.evaluate(
    async ({ dark, accent }) => {
      const { applyThemeAccent } = await import('/src/utils/themeAccent.ts');
      const { saveDarkModePreference } = await import('/src/utils/themeStorage.ts');
      saveDarkModePreference(dark);
      localStorage.setItem('anagram-theme', dark ? 'dark' : 'light');
      document.body.classList.toggle('body--dark', dark);
      applyThemeAccent(accent as Parameters<typeof applyThemeAccent>[0]);
    },
    { dark, accent },
  );
}

async function readableText(text: Locator, surface: Locator) {
  const color = await text.evaluate((node) => getComputedStyle(node).color);
  const background = await surface.evaluate((node) => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      const color = getComputedStyle(element).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    }
    throw new Error('No painted surface found');
  });
  const luminance = (value: string) => {
    const rgb = value
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((n) => {
        const channel = n / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(color),
    b = luminance(background);
  expect(
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    `${color} on ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

async function readableMenu(menu: Locator) {
  await expect(menu).toBeVisible();
  for (const item of await menu.getByRole('menuitem').all()) await readableText(item, menu);
}

test('selected chat and contact menus remain readable through every accent and mode change', async ({
  browser,
}, info) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.themeColors);
  const { page } = user;
  try {
    const group = await createGroup(page, {
      name: 'Theme test group',
      about: 'Theme-aware description',
    });
    await navigateToChat(page, group);
    await sendMessage(page, 'Theme-aware message');
    const selected = page.locator('.chat-row.active');
    await selected.getByRole('button', { name: 'Chat actions' }).click();
    const chatMenu = selected.getByRole('menu');
    for (const accent of [
      'default',
      'cyan',
      'green',
      'pink',
      'orange',
      'purple',
      'red',
      'slate',
      'gold',
    ]) {
      for (const dark of [false, true, false]) {
        await setTheme(page, dark, accent);
        await readableMenu(chatMenu);
        await expect(selected.locator('.chat-copy strong')).toHaveCSS(
          'color',
          'rgb(255, 255, 255)',
        );
        await readableText(
          page.getByTestId('message-composer-input'),
          page.getByTestId('message-composer-input'),
        );
        await readableText(
          threadMessage(page, 'Theme-aware message').locator('.message-text'),
          page.locator('.messages'),
        );
        if (accent === 'default')
          await page.screenshot({
            path: info.outputPath(`chat-menu-${dark ? 'dark' : 'light'}.png`),
          });
      }
    }
    await selected.getByRole('button', { name: 'Chat actions' }).click();
    await threadMessage(page, 'Theme-aware message').click({ button: 'right' });
    const messageMenu = page.getByTestId('message-context-menu');
    for (const dark of [true, false]) {
      await setTheme(page, dark);
      await readableMenu(messageMenu);
    }
    await page.keyboard.press('Escape');
    await page.getByTestId('message-composer-emoji').click();
    const emojiSearch = page.getByRole('textbox', { name: 'Search emoji' });
    const placeholders = [];
    for (const dark of [true, false]) {
      await setTheme(page, dark);
      await readableText(emojiSearch, emojiSearch);
      placeholders.push(
        await emojiSearch.evaluate((node) => getComputedStyle(node, '::placeholder').color),
      );
    }
    expect(placeholders[0]).not.toBe(placeholders[1]);
    await page.getByTestId('message-composer-emoji').click();

    await openGroupContact(page, group);
    const contact = page.locator('.contact-row.active');
    await contact.getByRole('button', { name: 'Contact actions' }).click();
    for (const dark of [true, false]) {
      await setTheme(page, dark);
      await readableMenu(contact.getByRole('menu'));
      await readableText(
        page.getByLabel('Group name', { exact: true }),
        page.getByLabel('Group name', { exact: true }),
      );
      await expect(contact.locator('.chat-copy strong')).toHaveCSS('color', 'rgb(255, 255, 255)');
    }
    await navigateInApp(page, '/settings/theme');
    const darkSwitch = page.getByRole('switch', { name: 'Dark mode', exact: true });
    const appearance = page.getByTestId('settings-theme-item');
    for (const dark of [true, false]) {
      await darkSwitch.setChecked(dark);
      await expect(page.locator('body')).toHaveClass(dark ? /body--dark/ : /^(?!.*body--dark)/);
      await appearance.hover();
      const background = await appearance.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await page.getByRole('heading', { name: 'Appearance', exact: true }).first().hover();
      await expect(appearance).toHaveCSS('background-color', background);
      await readableText(page.getByTestId('settings-logout-item'), page.locator('.sidebar'));
    }
    expect(user.browserErrors).toEqual([]);
  } finally {
    await disposeUsers(user);
  }
});
