import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateToChat,
  confirmGroupBackup,
  disposeUsers,
  logoutFromSettings,
} from './parity/helpers.ts';
// The example is the interoperability fixture: real signed events and encrypted callbacks.
import { PollBot } from '../bot-example/poll/bot.js';
import { Network, State, sign } from '../bot-example/poll/vendor/runtime.js';
import { relay } from '../bot-example/poll/test/relay.js';
import { COMMAND_TAG, keyboardTag } from '../bot-example/poll/vendor/botKeyboardProtocol.ts';
import {
  keyboardTag as sizedKeyboardTag,
  BOT_CONTROL_KIND,
  controlTag,
  parseControl,
} from '../src/stores/nostr/botKeyboardProtocol.ts';
import { rumor, wrap, unwrap } from '../bot-example/poll/vendor/runtime.js';

test('long personal replies collapse and logout clears them without database enumeration', async ({
  browser,
}) => {
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'anagram-personal-reply-'));
  const bot = new PollBot({ store: new State(dir), net: new Network([local.url]), log() {} });
  let user;
  try {
    await bot.net.publish(
      sign(bot.key, 0, [], JSON.stringify({ name: 'Private Bot', bot: true })),
      [local.url],
      bot.key,
    );
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    await openDirectChatFromIdentifier(page, nip19.npubEncode(bot.pubkey), 'Private Bot');
    await navigateToChat(page, bot.pubkey);
    const menu = rumor(
      bot.key,
      [
        ['p', user.session.publicKey],
        sizedKeyboardTag({ inline_keyboard: [[{ text: 'Details', callback_data: 'details' }]] }),
      ],
      'Get a private answer',
    );
    await bot.net.publish(wrap(menu, bot.key, user.session.publicKey), [local.url], bot.key);
    const keyboard = page.getByTestId('bot-keyboard');
    await keyboard.getByRole('button', { name: 'Details', exact: true }).click();
    const request = () =>
      [...local.events.values()]
        .map((event) => unwrap(event, bot.key)?.message)
        .filter(Boolean)
        .map((event) => parseControl(event.tags))
        .find((control) => control?.op === 'request');
    await expect.poll(request).toBeTruthy();
    const markup = {
      inline_keyboard: [
        [{ text: 'First action', copy_text: { text: 'first' } }],
        [{ text: 'Second action', copy_text: { text: 'second' } }],
      ],
      row_after: [0, 1],
    };
    const { sig: _sig, ...answer } = sign(
      bot.key,
      BOT_CONTROL_KIND,
      [
        ['p', user.session.publicKey],
        controlTag({ ...request()!, op: 'answer' }),
        sizedKeyboardTag(markup),
      ],
      'First item\n\n' + 'Private details '.repeat(400),
    );
    await bot.net.publish(wrap(answer, bot.key, user.session.publicKey), [local.url], bot.key);
    const personal = keyboard.getByTestId('bot-personal-response');
    await expect(personal.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
    await expect(personal.getByRole('button', { name: 'First action' })).toBeVisible();
    await expect(personal.getByRole('button', { name: 'Second action' })).toHaveCount(0);
    expect((await personal.locator('p').allTextContents()).join('\n\n').length).toBeLessThanOrEqual(
      4099,
    );
    await personal.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(personal.getByRole('button', { name: 'Second action' })).toBeVisible();
    // A late relay acknowledgement can refresh the same saved answer after it
    // has been expanded. Wait for that read to finish before checking the view.
    await page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const runtime = useNostrStore().botKeyboards;
      const read = runtime.read;
      try {
        await new Promise<void>((resolve, reject) => {
          runtime.read = async (...args) => {
            try {
              return await read(...args);
            } catch (error) {
              reject(error);
              throw error;
            } finally {
              resolve();
            }
          };
          runtime.changes.set({ key: null });
        });
        await new Promise(requestAnimationFrame);
      } finally {
        runtime.read = read;
      }
    });
    await expect(personal.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
    await expect(personal.getByRole('button', { name: 'Second action' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await personal.getByRole('button', { name: 'Show less', exact: true }).click();
    await expect(personal.getByRole('button', { name: 'Second action' })).toHaveCount(0);
    await page.addInitScript(() => {
      Object.assign(window, { __listDatabases: indexedDB.databases.bind(indexedDB) });
      Object.defineProperty(indexedDB, 'databases', { value: undefined, configurable: true });
    });
    await page.reload();
    await expect(personal.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
    await logoutFromSettings(page);
    const names = await page.evaluate(async () =>
      (
        await (
          window as unknown as { __listDatabases(): Promise<IDBDatabaseInfo[]> }
        ).__listDatabases()
      ).map((db) => db.name),
    );
    expect(names.some((name) => name?.startsWith('anagram-bot-interactions-'))).toBe(false);
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy buttons and three sizes work in desktop and mobile DMs without callbacks', async ({
  browser,
}) => {
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'anagram-copy-buttons-'));
  const store = new State(dir);
  const bot = new PollBot({ store, net: new Network([local.url]), log() {} });
  let user;
  try {
    await bot.net.publish(
      sign(bot.key, 0, [], JSON.stringify({ name: 'Copy Bot', bot: true })),
      [local.url],
      bot.key,
    );
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDirectChatFromIdentifier(page, nip19.npubEncode(bot.pubkey), 'Copy Bot');
    await navigateToChat(page, bot.pubkey);
    const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
    const markup = {
      inline_keyboard: [
        [
          { text: 'magnet', size: 'small' as const, copy_text: { text: magnet } },
          { text: 'open', size: 'small' as const, url: 'https://example.org/' },
        ],
        [{ text: 'Medium', size: 'medium' as const, copy_text: { text: 'medium' } }],
        [{ text: 'Large', size: 'large' as const, copy_text: { text: 'large' } }],
      ],
    };
    const recipient = user.session.publicKey;
    const card = rumor(
      bot.key,
      [['p', recipient], sizedKeyboardTag(markup)],
      '**A movie**\nSeeders: **10**',
    );
    await bot.net.publish(wrap(card, bot.key, recipient), [local.url], bot.key);
    const keyboard = page.getByTestId('bot-keyboard');
    await expect(keyboard).toBeVisible();
    const before = [...local.events.values()].filter((e) => e.kind === 1059).length;
    const copy = keyboard.getByRole('button', { name: 'magnet', exact: true });
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(magnet);
    await expect(keyboard.getByRole('status')).toHaveText('Copied magnet');
    const heights = await keyboard
      .locator('button[data-size]')
      .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height));
    expect(heights[0]).toBeLessThan(heights[2]);
    expect(heights[2]).toBeLessThan(heights[3]);
    await page.setViewportSize({ width: 390, height: 844 });
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(magnet);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await expect(copy).toBeVisible();
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(magnet);
    expect([...local.events.values()].filter((e) => e.kind === 1059).length).toBe(before);
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: () => Promise.reject(new Error('Clipboard unavailable')),
        configurable: true,
      }),
    );
    await copy.click();
    await expect(keyboard.getByRole('alert')).toHaveText('Clipboard unavailable');
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ten results keep their own copy/open buttons directly underneath in one DM', async ({
  browser,
}) => {
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'anagram-result-rows-'));
  const bot = new PollBot({ store: new State(dir), net: new Network([local.url]), log() {} });
  let user;
  try {
    await bot.net.publish(
      sign(bot.key, 0, [], JSON.stringify({ name: 'Results Bot', bot: true })),
      [local.url],
      bot.key,
    );
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDirectChatFromIdentifier(page, nip19.npubEncode(bot.pubkey), 'Results Bot');
    await navigateToChat(page, bot.pubkey);
    const magnets = Array.from({ length: 10 }, (_, i) => {
      const params = new URLSearchParams({
        dn: `Movie ${i} Español & 日本語 ${'🧲'.repeat(100)}`,
        xl: '1234567890',
      });
      for (const tracker of [
        'udp://tracker.opentrackr.org:1337/announce',
        'wss://wstracker.online',
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.btorrent.xyz',
      ])
        params.append('tr', tracker);
      return 'magnet:?xt=urn:btih:' + (i + 1).toString(16).padStart(40, '0') + '&' + params;
    });
    const markup = {
      inline_keyboard: magnets.map((magnet) => [
        { text: 'magnet', size: 'small' as const, copy_text: { text: magnet } },
        { text: 'open', size: 'small' as const, url: magnet },
        {
          text: 'open in utorrent lite',
          size: 'small' as const,
          url: `https://www.utorrent.com/lite/#/player?m=${encodeURIComponent(Buffer.from(magnet).toString('base64'))}`,
        },
      ]),
      row_after: magnets.map((_, i) => i + 2),
    };
    const text = [
      '**Movie results**',
      '*Top listings by seeders*',
      ...magnets.map(
        (_, i) =>
          `**${i + 1}. Movie edition ${i + 1}**\nSeeders: **${100 - i}**\nSubtitles: Not listed\n${'Details '.repeat(75)}`,
      ),
    ].join('\n\n');
    const card = rumor(bot.key, [['p', user.session.publicKey], sizedKeyboardTag(markup)], text);
    await bot.net.publish(wrap(card, bot.key, user.session.publicKey), [local.url], bot.key);
    const keyboard = page.getByTestId('bot-keyboard');
    const sections = keyboard.getByTestId('bot-keyboard-section');
    await expect(keyboard).toHaveCount(1);
    async function expandCard() {
      await expect(keyboard.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
      expect(
        (await sections.locator('.message-text').allTextContents()).join('\n\n').length,
      ).toBeLessThanOrEqual(4099);
      expect(await keyboard.locator('.button-row').count()).toBeLessThan(10);
      await expect(sections.last().getByRole('button')).toHaveCount(0);
      await keyboard.getByRole('button', { name: 'Show more', exact: true }).click();
    }
    await expandCard();
    await expect(sections).toHaveCount(10);
    async function verifyRows() {
      await page.evaluate(() => {
        const opened: string[] = [];
        Object.assign(window, { __openedButtonUrls: opened });
        window.open = ((url: string | URL | undefined) => {
          opened.push(String(url));
          return null;
        }) as typeof window.open;
      });
      for (let i = 0; i < 10; i++) {
        const section = sections.nth(i);
        await expect(section).toContainText(`${i + 1}. Movie edition ${i + 1}`);
        await expect(section.getByRole('button')).toHaveCount(3);
        await section.getByRole('button', { name: 'magnet', exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(magnets[i]);
        await expect(section.getByRole('button', { name: 'open ↗', exact: true })).toHaveAttribute(
          'title',
          markup.inline_keyboard[i][1].url!,
        );
        await section.getByRole('button', { name: 'open ↗', exact: true }).click();
        await section.getByRole('button', { name: 'open in utorrent lite ↗', exact: true }).click();
        expect(
          await page.evaluate(() =>
            (window as unknown as { __openedButtonUrls: string[] }).__openedButtonUrls.slice(-2),
          ),
        ).toEqual([magnets[i], markup.inline_keyboard[i][2].url]);
      }
      const positions = await sections.evaluateAll((items) =>
        items.map((item) => ({
          text: item.querySelector('.message-text')!.getBoundingClientRect().bottom,
          buttons: item.querySelector('.button-row')!.getBoundingClientRect().top,
          bottom: item.getBoundingClientRect().bottom,
          top: item.getBoundingClientRect().top,
        })),
      );
      positions.forEach((position, i) => {
        expect(position.buttons).toBeGreaterThanOrEqual(position.text);
        if (i < 9) expect(position.bottom).toBeLessThan(positions[i + 1].top);
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await verifyRows();
    await page.setViewportSize({ width: 390, height: 844 });
    await keyboard.getByRole('button', { name: 'Show less', exact: true }).click();
    await expandCard();
    await verifyRows();
    await page.reload();
    await expandCard();
    await expect(sections).toHaveCount(10);
    await verifyRows();
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('poll keyboards work privately in DMs, private groups and public groups, including reload and mobile', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-browser-'));
  const store = new State(dir);
  const bot = new PollBot({ store, net: new Network([local.url]), cooldown: 0, log() {} });
  let user;
  try {
    await bot.start();
    await bot.net.publish(
      sign(bot.key, 0, [], JSON.stringify({ name: bot.name, bot: true })),
      [local.url],
      bot.key,
    );
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    const npub = nip19.npubEncode(bot.pubkey);
    async function voteAndReload(rowId: string, question: string) {
      const rows = page.getByTestId(rowId);
      const keyboard = page.getByTestId('bot-keyboard');
      await expect(keyboard).toBeVisible();
      await expect(keyboard.getByRole('button', { name: 'Tea', exact: true })).toBeVisible();
      const command = rows.filter({ hasText: `${question}\nTea\nCoffee` });
      await expect(command).toHaveCount(0);
      const card = rows.filter({ has: keyboard });
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Show original command', exact: true }).click();
      await expect(command).toBeVisible();
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Hide original command', exact: true }).click();
      await expect(command).toHaveCount(0);
      const before = await rows.count();
      await keyboard.getByRole('button', { name: 'View results', exact: true }).click();
      await expect(keyboard.getByTestId('bot-personal-response')).toHaveText(
        `${question}\nTea: 0\nCoffee: 0\n0 vote(s)`,
      );
      await keyboard.getByRole('button', { name: 'Tea', exact: true }).click();
      const personal = keyboard.getByTestId('bot-personal-response');
      await expect(personal).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(personal.locator('strong').first()).toHaveText(question);
      await expect(personal.locator('em')).toHaveText('1 vote(s)');
      await expect(keyboard).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(keyboard.getByRole('button')).toHaveCount(0);
      await expect(rows).toHaveCount(before);
      await expect(keyboard.getByRole('status')).toBeHidden();
      await page.reload();
      await expect(keyboard).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(keyboard.getByRole('button')).toHaveCount(0);
      await expect(rows).toHaveCount(before);
      await expect(command).toHaveCount(0);
      await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
      await page.getByRole('textbox', { name: 'Search messages', exact: true }).fill('Coffee');
      await expect(command).toBeVisible();
      await expect(command).toBeInViewport();
      await page.getByRole('button', { name: 'Close search', exact: true }).click();
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Hide original command', exact: true }).click();
      await expect(command).toHaveCount(0);
    }
    await openDirectChatFromIdentifier(page, npub, bot.name);
    await navigateToChat(page, bot.pubkey);
    async function expectFormat(composerName: string) {
      await page.getByRole('textbox', { name: composerName, exact: true }).fill(`nostr:${npub}`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const help = page
        .locator('[data-testid="message-bubble"], [data-testid="public-message"]')
        .filter({ hasText: 'Bot expects format:' });
      await expect(help).toBeVisible();
      await expect(help.locator('strong')).toHaveText('Bot expects format:');
      await expect(help).toContainText(`@${bot.handle} What should we watch?`);
      await expect(help).toContainText('The Wire');
      await expect(help).toContainText('The Sopranos');
      await expect(page.getByTestId('bot-keyboard')).toHaveCount(0);
    }
    await expectFormat('Message');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Direct drinks?\nTea\nCoffee');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await voteAndReload('message-bubble', 'Direct drinks?');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New private group', exact: true }).click();
    await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Private polls');
    await page.getByLabel('Members', { exact: true }).fill(npub);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await confirmGroupBackup(page);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => Object.keys(store.data.groups).length).toBe(1);
    await expectFormat('Message');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`@${bot.handle} Private drinks?\nTea\nCoffee`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await voteAndReload('message-bubble', 'Private drinks?');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Public polls');
    await page.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page).toHaveURL(/\/public\/naddr/);
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await page.getByRole('tab', { name: 'Trusted', exact: true }).click();
    await page.getByRole('button', { name: 'Add trusted users', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trusted users' });
    await picker.getByLabel('Search people').fill(npub);
    await picker
      .locator('[data-testid="profile-search-result"], [data-testid="invite-contact-result"]')
      .click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Public group settings' })).toBeHidden();
    await expect.poll(() => Object.keys(store.data.rooms).length).toBe(1);
    await expectFormat('Public message');
    await page
      .getByRole('textbox', { name: 'Public message', exact: true })
      .fill(`@${bot.handle} Public drinks?\nTea\nCoffee`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await voteAndReload('public-message', 'Public drinks?');
    const unrelatedText = 'This ordinary conversation must stay visible.';
    await page.getByRole('textbox', { name: 'Public message', exact: true }).fill(unrelatedText);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() =>
        [...local.events.values()].some((e) => e.kind === 9 && e.content === unrelatedText),
      )
      .toBe(true);
    const unrelated = [...local.events.values()].find(
      (e) => e.kind === 9 && e.content === unrelatedText,
    )!;
    const hostile = sign(
      bot.key,
      9,
      [
        ['a', unrelated.tags.find((t) => t[0] === 'a')![1]],
        [COMMAND_TAG, '1', unrelated.id],
        keyboardTag({ inline_keyboard: [[{ text: 'Bogus button', callback_data: 'bogus' }]] }),
      ],
      'A malicious bot claims it handled this message',
    );
    await bot.net.publish(hostile, [local.url], bot.key);
    const hostileRow = page.getByTestId('public-message').filter({ hasText: hostile.content });
    await expect(hostileRow).toBeVisible();
    await expect(
      page.getByTestId('public-message').filter({ hasText: unrelatedText }),
    ).toBeVisible();
    await hostileRow.locator('.message-content').click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: 'Show original command', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a public keyboard discovers a separate bot inbox without creating a DM contact', async ({
  browser,
}) => {
  const roomRelay = await relay(),
    inboxRelay = await relay();
  const inboxNetwork = new Network([inboxRelay.url]);
  const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-routing-'));
  const bot = new PollBot({
    store: new State(dir),
    net: new Network([roomRelay.url, inboxRelay.url]),
    cooldown: 0,
    log() {},
  });
  let user;
  try {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools');
    const { acceptRoom, publicMessage } =
      await import('../bot-example/poll/vendor/public-groups.js');
    const owner = generateSecretKey(),
      address = `34550:${getPublicKey(owner)}:routing`;
    const room = sign(owner, 34550, [
      ['d', 'routing'],
      ['name', 'Routing poll'],
      ['anagram-room', '1'],
      ['relay', roomRelay.url],
      ['trusted', bot.pubkey],
    ]);
    roomRelay.emit(room);
    roomRelay.emit(sign(bot.key, 10050, [['relay', inboxRelay.url]]));
    await bot.start();
    // Only the separate inbox receives personal callback requests.
    bot.watches.get('inbox')?.();
    bot.watches.set(
      'inbox',
      inboxNetwork.watch(
        [inboxRelay.url],
        () => ({ kinds: [1059], '#p': [bot.pubkey], limit: 1000 }),
        (event) => bot.receive(event, bot.key),
        bot.key,
      ),
    );
    acceptRoom(bot, room, true);
    publicMessage(
      bot,
      sign(
        owner,
        9,
        [
          ['a', address],
          ['p', bot.pubkey],
        ],
        '/poll Route choice? | Tea | Coffee',
      ),
      address,
    );
    await bot.flush();
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botVoter, { relayUrls: [roomRelay.url] });
    const page = user.page;
    const link = nip19.naddrEncode({
      kind: 34550,
      pubkey: getPublicKey(owner),
      identifier: 'routing',
      relays: [roomRelay.url],
    });
    await page.goto(`/public/${link}`);
    const keyboard = page.getByTestId('bot-keyboard');
    await expect(keyboard).toBeVisible();
    const contactExists = () =>
      page.evaluate(async (pubkey) => {
        const { contactsService } = await import('/src/services/contactsService.ts');
        return !!(await contactsService.getContactByPublicKey(pubkey));
      }, bot.pubkey);
    expect(await contactExists()).toBe(false);
    await keyboard.getByRole('button', { name: 'Tea', exact: true }).click();
    await expect
      .poll(
        () =>
          [...inboxRelay.events.values()].filter(
            (event) =>
              event.kind === 1059 &&
              event.tags.some((tag) => tag[0] === 'p' && tag[1] === bot.pubkey),
          ).length,
        { message: 'callback reaches the advertised bot inbox' },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => Object.keys(bot.state.callbacks).length, {
        message: 'bot authenticates and processes the callback',
      })
      .toBe(1);
    await expect(keyboard.getByTestId('bot-personal-response')).toContainText('Tea: 1');
    expect(await contactExists()).toBe(false);
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    inboxNetwork.close();
    await roomRelay.close();
    await inboxRelay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
