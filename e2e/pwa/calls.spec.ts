import { test, expect, firefox, type Page } from '@playwright/test';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  nip59,
  matchFilters,
} from 'nostr-tools';
import { finishOnboarding } from '../auth-helpers';

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

for (const scenario of [
  'shared relays',
  'separate inbox and outbox relays',
  'missing relay acknowledgements',
])
  test(`production direct call plays audio with ${scenario}`, async ({ browser, baseURL }) => {
    test.skip(
      process.env.ANAGRAM_LIVE_CALL_TEST !== '1',
      'Requires public Iroh relay connectivity.',
    );
    test.setTimeout(90000);
    const splitInbox = scenario === 'separate inbox and outbox relays';
    let dropAcknowledgements = false;
    let droppedAcknowledgements = 0;
    let outboxRejections = 0;
    const keys = [generateSecretKey(), generateSecretKey()];
    const pubkeys = keys.map(getPublicKey);
    const relay = 'ws://127.0.0.1:49999/';
    const outbox = 'ws://127.0.0.1:49998/';
    const events = keys.flatMap((key, i) => [
      finalizeEvent(
        {
          kind: 10050,
          tags: [['relay', relay]],
          content: '',
          created_at: Math.floor(Date.now() / 1000),
        },
        key,
      ),
      finalizeEvent(
        {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: ['Alice Calls', 'Bob Calls'][i] }),
          created_at: Math.floor(Date.now() / 1000),
        },
        key,
      ),
    ]);
    if (splitInbox)
      events.push(
        finalizeEvent(
          {
            kind: 10002,
            tags: [['r', outbox, 'write']],
            content: '',
            created_at: Math.floor(Date.now() / 1000),
          },
          keys[0],
        ),
      );
    const subscriptions = new Set<(event: (typeof events)[number]) => void>();
    const firefoxBrowser = process.env.ANAGRAM_CALL_FIREFOX_EXECUTABLE_PATH
      ? await firefox.launch({
          channel: 'moz-firefox',
          executablePath: process.env.ANAGRAM_CALL_FIREFOX_EXECUTABLE_PATH,
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
          },
        })
      : null;
    const contexts = await Promise.all(
      [browser, firefoxBrowser ?? browser].map((browser) =>
        browser.newContext({ permissions: ['microphone', 'camera'] }),
      ),
    );
    const pages: Page[] = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const page = await contexts[i].newPage();
        pages.push(page);
        await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:4999[89]\/$/, (socket) => {
          const filters = new Map<string, any[]>();
          const deliver = (event: (typeof events)[number]) => {
            for (const [id, filter] of filters)
              if (matchFilters(filter, event)) socket.send(JSON.stringify(['EVENT', id, event]));
          };
          subscriptions.add(deliver);
          socket.onClose(() => subscriptions.delete(deliver));
          socket.onMessage((raw) => {
            const [verb, id, ...rest] = JSON.parse(String(raw));
            if (verb === 'CLOSE') filters.delete(id);
            if (verb === 'EVENT') {
              if (splitInbox && socket.url() === outbox && id.kind === 1059) {
                // A sender's own DM backup may legitimately use its outbox.
                // Only a misrouted recipient call control is a regression here.
                const recipient = pubkeys.indexOf(
                  id.tags.find((tag: string[]) => tag[0] === 'p')?.[1],
                );
                if (recipient >= 0 && nip59.unwrapEvent(id, keys[recipient]).kind === 21117)
                  outboxRejections++;
                socket.send(
                  JSON.stringify([
                    'OK',
                    id.id,
                    false,
                    'blocked: outbox does not accept gift wraps',
                  ]),
                );
                return;
              }
              events.push(id);
              if (dropAcknowledgements && id.kind === 1059) droppedAcknowledgements++;
              else socket.send(JSON.stringify(['OK', id.id, true, '']));
              for (const deliver of subscriptions) deliver(id);
            }
            if (verb === 'REQ') {
              filters.set(id, rest);
              for (const event of events.filter((event) => matchFilters(rest, event)))
                socket.send(JSON.stringify(['EVENT', id, event]));
              socket.send(JSON.stringify(['EOSE', id]));
            }
          });
        });
        await page.addInitScript((relay) => {
          const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
          localStorage.setItem('relays', entries);
          localStorage.setItem('nip65_relays', entries);
        }, relay);
        await page.goto(baseURL!);
        await page.getByTestId('auth-open-login-button').click();
        await page.getByTestId('auth-open-key-button').click();
        await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(keys[i]));
        await page.getByTestId('auth-login-button').click();
        await finishOnboarding(page);
        await page.getByRole('button', { name: 'Chat options' }).click();
        await page.getByTestId('new-chat-button').click();
        await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(pubkeys[1 - i]));
        await page.getByRole('button', { name: 'Add contact', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeHidden();
      }
      const [a, b] = pages;
      await a.getByTestId('message-composer-input').fill('Production call setup');
      await a.getByTestId('message-send-button').click();
      await expect(
        b.getByTestId('message-bubble').filter({ hasText: 'Production call setup' }),
      ).toBeVisible();
      dropAcknowledgements = scenario === 'missing relay acknowledgements';
      await a.getByRole('button', { name: 'Audio call', exact: true }).click();
      await expect(b.getByTestId('call-accept')).toBeVisible({ timeout: 35000 });
      await b.getByTestId('call-accept').click();
      for (const page of pages) {
        await expect(page.getByTestId('call-status')).toHaveText(/^\d+:\d+$/, { timeout: 35000 });
        await expect
          .poll(
            () =>
              page
                .locator('audio')
                .evaluateAll((elements) =>
                  elements.some((element) => element.buffered.length > 0 && !element.error),
                ),
            { timeout: 15000 },
          )
          .toBe(true);
      }
      // Exercise several heartbeat intervals and sustained decoding, not just setup.
      for (const page of pages) {
        await expect
          .poll(
            () =>
              page
                .locator('audio')
                .evaluateAll((elements) =>
                  elements.some((element) => element.currentTime > 20 && !element.error),
                ),
            { timeout: 30000 },
          )
          .toBe(true);
        await expect(page.getByTestId('call-status')).toHaveText(/^\d+:\d+$/);
      }
      if (dropAcknowledgements) expect(droppedAcknowledgements).toBeGreaterThanOrEqual(2);
      expect(outboxRejections).toBe(0);
      await a.getByTestId('call-hangup').click();
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await firefoxBrowser?.close();
    }
  });
