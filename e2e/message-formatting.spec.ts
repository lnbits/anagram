import { test, expect } from '@playwright/test';

test('paging cached group history preserves formatting in unchanged messages', async ({
  browser,
}) => {
  const { bootstrapUser, disposeUsers, TEST_ACCOUNTS, createGroup, navigateInApp } =
    await import('./parity/helpers');
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.formattingAlice);
  try {
    const group = await createGroup(user.page, { name: 'Formatting while paging', about: '' });
    await navigateInApp(user.page, '/settings/profile');
    await user.page.evaluate(
      async ({ group, author }) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        const start = Date.now() - 300000;
        for (let index = 0; index < 160; index++)
          await chatDataService.createMessage({
            chat_public_key: group,
            author_public_key: author,
            message: index === 159 ? 'Keep this ||revealed text|| visible' : `Cached row ${index}`,
            created_at: new Date(start + index * 1000).toISOString(),
            meta: {},
          });
      },
      { group, author: user.session.publicKey },
    );
    await navigateInApp(user.page, `/chats/${group}`);
    const thread = user.page.getByTestId('chat-thread');
    const message = thread.locator('.message-row').filter({ hasText: 'Keep this' });
    await message.getByRole('button', { name: 'Reveal spoiler' }).click();
    await expect(message).toContainText('revealed text');
    const before = await thread.locator('.message-row').count();
    await user.page.evaluate(async (group) => {
      const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
      await useMessageStore().loadOlderMessages(group);
    }, group);
    await expect.poll(() => thread.locator('.message-row').count()).toBeGreaterThan(before);
    await expect(message).toContainText('revealed text');
    await expect(message.getByRole('button', { name: 'Reveal spoiler' })).toHaveCount(0);
  } finally {
    await disposeUsers(user);
  }
});

test('formatting component renders text safely and reveals spoilers by keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/src/lib/dev/mountFixture.ts');
    const { default: FormattedMessage } =
      await import('/src/lib/components/FormattedMessage.svelte');
    const { formatMessage } = await import('/src/utils/messageFormatting.ts');
    const target = document.createElement('div');
    target.id = 'formatting-fixture';
    document.body.replaceChildren(target);
    mount(FormattedMessage, {
      target,
      props: {
        parts: formatMessage(
          '**Bold *nested italic*** _Italic_ __Underline__ ~Strike~ `**literal** <script>`\n```js\n  const value = "<img>";\n```\n||Hidden text|| [Docs](https://example.org/docs) [Unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>',
        ),
        onopen: (href: string) => {
          target.dataset.opened = href;
        },
        oncontact: () => {},
        onlinkmenu: (event: MouseEvent, href: string) => {
          event.preventDefault();
          target.dataset.menu = href;
        },
      },
    });
  });
  const fixture = page.locator('#formatting-fixture');
  await expect(fixture.locator('strong')).toHaveText('Bold nested italic');
  await expect(fixture.locator('strong em')).toHaveText('nested italic');
  await expect(fixture.locator('u')).toHaveText('Underline');
  await expect(fixture.locator('s')).toHaveText('Strike');
  await expect(fixture.locator('code').first()).toHaveText('**literal** <script>');
  await expect(fixture.locator('code.block')).toHaveText('  const value = "<img>";');
  await expect(fixture.locator('script, img, iframe')).toHaveCount(0);
  await expect(fixture.locator('a')).toHaveCount(1);
  const link = fixture.getByRole('link', { name: 'Docs' });
  await expect(link).toHaveAttribute('title', 'https://example.org/docs');
  await link.click();
  await expect(fixture).toHaveAttribute('data-opened', 'https://example.org/docs');
  await link.click({ button: 'right' });
  await expect(fixture).toHaveAttribute('data-menu', 'https://example.org/docs');
  await expect(fixture).not.toContainText('Hidden text');
  const spoiler = fixture.getByRole('button', { name: 'Reveal spoiler' });
  await spoiler.focus();
  await page.keyboard.press('Enter');
  await expect(fixture).toContainText('Hidden text');
  await expect(spoiler).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fixture.locator('code.block')).toBeVisible();
  expect(
    await fixture.evaluate((node) => node.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
});

test('call invitations stay compact after expiry and cannot open expired calls', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/src/lib/dev/mountFixture.ts');
    const { default: FormattedMessage } = await import('/src/lib/components/FormattedMessage.svelte');
    const { formatMessage } = await import('/src/utils/messageFormatting.ts');
    const { roomLinkToken } = await import('/src/utils/callRoom.ts');
    const call = {
      id: '12345678-1234-4123-8123-123456789abc', host: 'a'.repeat(64),
      secret: 'b'.repeat(64), relays: ['wss://relay.example.org/'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const expired = roomLinkToken({ ...call, expiresAt: new Date(Date.now() - 60000).toISOString() });
    const target = document.createElement('div');
    target.id = 'call-link-fixture';
    document.body.replaceChildren(target);
    mount(FormattedMessage, { target, props: {
      parts: formatMessage([
        `https://anagram.chat/join/call.html#/call/${roomLinkToken(call)}`,
        `https://anagram.chat/join/call.html#/call/${expired}`,
        `anagram://room/call/${expired}`,
      ].join('\n')),
      onopen: () => { target.dataset.opened = 'true'; },
    } });
  });
  const fixture = page.locator('#call-link-fixture');
  await expect(fixture.locator('.expired')).toHaveText(['Call expired', 'Call expired']);
  await expect(fixture.locator('a')).toHaveCount(1);
  const active = fixture.getByRole('link', { name: 'Join group call' });
  await active.click();
  await expect(fixture).toHaveAttribute('data-opened', 'true');
  await page.evaluate(() => {
    delete document.querySelector<HTMLElement>('#call-link-fixture')!.dataset.opened;
    const later = Date.now() + 120000;
    Date.now = () => later;
  });
  await active.click();
  await expect(fixture).not.toHaveAttribute('data-opened');
});

test('actual chat messages format after sending, editing and reloading in both layouts', async ({
  browser,
}, info) => {
  const { bootstrapUser, disposeUsers, TEST_ACCOUNTS, establishAcceptedDirectChat, threadMessage } =
    await import('./parity/helpers');
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.formattingAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.formattingBob);
  const text = [
    'Styling tests',
    '**bold**',
    '*italic*',
    '`code`',
    '```',
    'code',
    '```',
    '_text_',
    '__underline__',
    '~strike~',
    '* bullet',
    '||spoiler||',
    '[Docs](https://format.example.test/docs)',
    '<img src=x onerror=alert(1)>',
  ].join('\n');
  try {
    await alice.page.route('https://format.example.test/docs', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>Formatting documentation</title>',
      }),
    );
    await establishAcceptedDirectChat(alice, bob);
    await alice.page.getByTestId('message-composer-input').fill(text);
    await alice.page.getByTestId('message-send-button').click();
    for (const user of [alice, bob]) {
      const message = threadMessage(user.page, 'Styling tests').locator('.message-text');
      await expect(message.locator('strong')).toHaveText('bold');
      await expect(message.locator('strong')).toHaveCSS('font-weight', '700');
      await expect(message.locator('em')).toHaveText(['italic', 'text']);
      await expect(message.locator('em').first()).toHaveCSS('font-style', 'italic');
      await expect(message.locator('u')).toHaveText('underline');
      await expect(message.locator('s')).toHaveText('strike');
      await expect(message.locator('code')).toHaveText(['code', 'code']);
      await expect(message.locator('code.block')).toBeVisible();
      await expect(message).toContainText('• bullet');
      await expect(message.locator('img, script')).toHaveCount(0);
      await expect(message).not.toContainText('spoiler');
      await expect(message.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute(
        'href',
        'https://format.example.test/docs',
      );
    }
    const sent = threadMessage(alice.page, 'Styling tests');
    await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await sent.getByRole('link', { name: 'Docs', exact: true }).click({ button: 'right' });
    await alice.page.getByTestId('message-link-copy').click();
    expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://format.example.test/docs',
    );
    await sent.locator('.message-text').click({ button: 'right' });
    await alice.page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(alice.page.getByTestId('message-composer-input')).toHaveValue(text);
    await alice.page
      .getByTestId('message-composer-input')
      .fill(text.replace('**bold**', '**edited bold**'));
    await alice.page.getByTestId('message-send-button').click();
    await expect(
      threadMessage(bob.page, 'Styling tests').locator('.message-text strong'),
    ).toHaveText('edited bold');
    await alice.page.reload();
    await expect(sent.locator('.message-text strong')).toHaveText('edited bold');
    for (const layout of ['bubbles', 'text']) {
      await alice.page.evaluate((layout) => {
        localStorage.setItem('ui-desktop-message-layout', layout);
        window.dispatchEvent(
          new CustomEvent('anagram:desktop-message-layout-changed', { detail: { layout } }),
        );
      }, layout);
      for (const width of [1280, 390]) {
        await alice.page.setViewportSize({ width, height: 844 });
        await expect(sent.locator('.message-text strong')).toHaveText('edited bold');
        await expect(sent.locator('code.block')).toBeVisible();
        const bounds = await sent.locator('.message-content').boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await alice.page.screenshot({ path: info.outputPath(`formatting-${layout}-${width}.png`) });
      }
    }
    await sent.getByRole('button', { name: 'Reveal spoiler' }).click();
    await expect(sent.locator('.message-text')).toContainText('spoiler');
    expect([...alice.browserErrors, ...bob.browserErrors]).toEqual([]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('chat spoilers and code do not leak through media attachments or collapsed text', async ({
  browser,
}) => {
  const { bootstrapUser, disposeUsers, TEST_ACCOUNTS, establishAcceptedDirectChat, threadMessage } =
    await import('./parity/helpers');
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.hiddenFormattingAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.hiddenFormattingBob);
  const image = 'https://format.example.test/hidden.png';
  const code = 'https://format.example.test/code.png';
  const text = `Hidden media fixture\n||${image}||\n\`${code}\`\n||${'secret '.repeat(800)}||`;
  const requests: string[] = [];
  try {
    await alice.page.route('https://format.example.test/**', (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await establishAcceptedDirectChat(alice, bob);
    await alice.page.getByTestId('message-composer-input').fill(text);
    await alice.page.getByTestId('message-send-button').click();
    const message = threadMessage(alice.page, 'Hidden media fixture');
    await expect(message.getByRole('button', { name: 'Reveal spoiler' })).toHaveCount(2);
    await alice.page.evaluate(
      async ({ chatId, text, urls }) => {
        await window.__appE2E__!.setStoredMessageAttachments({
          chatId,
          messageText: text,
          attachments: urls.map((url) => ({
            type: 'media' as const,
            url,
            mimeType: 'image/png',
            size: 128,
          })),
        });
      },
      { chatId: bob.session.publicKey, text, urls: [image, code] },
    );
    await expect(message.locator('.media-attachment, .preview-container')).toHaveCount(0);
    await expect(message.locator('.message-text')).not.toContainText('secret');
    await expect(message.locator('code')).toHaveText(code);
    await message.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(message.getByRole('button', { name: 'Reveal spoiler' })).toHaveCount(2);
    await expect(message.locator('.message-text')).not.toContainText('secret');
    expect(requests).toEqual([]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

test('editing a DM preserves other messages sent by the same author in the same second', async ({
  browser,
}) => {
  const {
    bootstrapUser,
    disposeUsers,
    editMessage,
    establishAcceptedDirectChat,
    expectNoUnexpectedBrowserErrors,
    navigateToChat,
    reloadAndWaitForApp,
    sendMessage,
    TEST_ACCOUNTS,
    threadMessage,
    waitForThreadMessage,
  } = await import('./parity/helpers');
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.sameSecondEditAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.sameSecondEditBob);

  try {
    await establishAcceptedDirectChat(alice, bob);
    const now = new Date();
    await alice.page.clock.setFixedTime(now);
    await bob.page.clock.setFixedTime(now);
    await sendMessage(alice.page, 'Same-second neighbour', { chatId: bob.session.publicKey });
    await waitForThreadMessage(bob.page, 'Same-second neighbour', {
      chatId: alice.session.publicKey,
    });
    await sendMessage(alice.page, 'Same-second original', { chatId: bob.session.publicKey });
    await waitForThreadMessage(bob.page, 'Same-second original', {
      chatId: alice.session.publicKey,
    });
    await editMessage(alice.page, 'Same-second original', 'Same-second edited', {
      chatId: bob.session.publicKey,
    });

    for (const user of [alice, bob]) {
      await expect(threadMessage(user.page, 'Same-second edited')).toHaveCount(1);
      await expect(threadMessage(user.page, 'Same-second neighbour')).toHaveCount(1);
      await expect(threadMessage(user.page, 'Accepted conversation')).toHaveCount(1);
    }
    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(threadMessage(bob.page, 'Same-second edited')).toHaveCount(1);
    await expect(threadMessage(bob.page, 'Same-second neighbour')).toHaveCount(1);
    await expect(threadMessage(bob.page, 'Same-second original')).toHaveCount(0);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
