import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';

const directory = new URL('../src/locales/', import.meta.url);
const catalogs = readdirSync(directory)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({
    code: file.replace('.json', ''),
    text: JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as Record<string, string>,
  }));

for (const width of [1280, 390]) {
  test(`all languages render requests, contact search and camera errors at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
      localStorage.setItem('relays', relays);
      localStorage.setItem('nip65_relays', relays);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('Denied by test', 'NotAllowedError');
        },
      });
    });
    await page.goto('/');
    await page.getByTestId('auth-open-login-button').click();
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(generateSecretKey()));
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await page.goto('/chats/requests');
    for (const { code, text } of catalogs) {
      await page.evaluate(async (code) => {
        const { setLocale } = await import('/src/i18n.ts');
        setLocale(code);
      }, code);
      await expect(page.locator('.requests-page header p')).toHaveText(
        text['contacts.firstContactChatsStay'],
      );
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        ['ar', 'ar-EG', 'ur-PK'].includes(code) ? 'rtl' : 'ltr',
      );
    }
    await page.goto('/chats');
    await page.getByRole('button', { name: 'Chat options', exact: true }).click();
    await page.getByTestId('new-chat-button').click();
    const dialog = page.getByRole('dialog', { name: 'contact', exact: true });
    const input = dialog.getByTestId('contact-identifier-input');
    for (const { code, text } of catalogs) {
      await page.evaluate(async (code) => {
        const { setLocale } = await import('/src/i18n.ts');
        setLocale(code);
      }, code);
      await expect(dialog.locator('header').getByRole('heading')).toHaveText(
        text['contacts.newConversation'],
      );
      await expect(input).toHaveAccessibleName(text['contacts.identifierLabel']);
      await expect(
        dialog.getByRole('button', { name: text['contacts.addContactAction'], exact: true }),
      ).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', text['contacts.identifierPlaceholder']);
      await input.fill('Nobody matched');
      await expect(
        dialog.getByRole('region', { name: text['search.people'], exact: true }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: text['qr.scanNpub'], exact: true }).click();
      const scanner = dialog.getByTestId('npub-scanner');
      await expect(scanner.getByRole('alert')).toHaveText(text['qr.denied']);
      await expect(
        scanner.getByRole('button', { name: text['qr.retry'], exact: true }),
      ).toBeVisible();
      await scanner.getByRole('button', { name: text['qr.cancel'], exact: true }).click();
      await expect(scanner).toBeHidden();
      if (['ar', 'de-DE', 'ta-IN'].includes(code)) {
        await page.screenshot({ path: `test-results/localization-${code}-${width}.png` });
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  });
}
