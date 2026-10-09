import { confirmGroupBackup } from './parity/helpers';
import { finishOnboarding } from './auth-helpers';
import WebSocket from 'ws';
import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19, nip59, nip44, finalizeEvent } from 'nostr-tools';
const relay = 'ws://127.0.0.1:7777/';
async function login(page: Page, key = generateSecretKey()) {
  await page.addInitScript((relay) => {
    if (!localStorage.getItem('relays')) {
      const entries = JSON.stringify([{ url: relay, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }
  }, relay);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  return { key, pubkey: getPublicKey(key) };
}
async function contact(page: Page, pubkey: string, name: string) {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByTestId('new-chat-button').click();
  await page.getByTestId('contact-identifier-input').fill(nip19.npubEncode(pubkey));
  await page.getByLabel('Name (optional)').fill(name);
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('message-composer-input')).toBeVisible();
}
async function groupTicketState(page: Page, clearProof = false) {
  return page.evaluate(
    (clearProof) =>
      new Promise<{ proof: string; epoch: string }>((resolve, reject) => {
        const request = indexedDB.open('chat-data-indexeddb-v2');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('chats', clearProof ? 'readwrite' : 'readonly');
          let result: { proof: string; epoch: string } | undefined;
          transaction.oncomplete = () => {
            db.close();
            result ? resolve(result) : reject(new Error('Group fixture not found'));
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          const cursor = transaction.objectStore('chats').openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            const chat = entry.value;
            if (chat.type !== 'group') {
              entry.continue();
              return;
            }
            const epoch = chat.meta.group_epoch_keys.find(
              (key: { epoch_public_key: string }) =>
                key.epoch_public_key === chat.meta.current_epoch_public_key,
            );
            if (clearProof) {
              delete epoch.invitation_proof;
              delete epoch.invitation_event_id;
              delete chat.meta.group_member_ticket_deliveries;
              entry.update(chat);
            }
            result = { proof: epoch.invitation_proof ?? '', epoch: epoch.epoch_public_key };
          };
        };
      }),
    clearProof,
  );
}
test('invalid key remains on login', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill('invalid');
  await page.getByTestId('auth-login-button').click();
  await expect(page.getByRole('alert')).toContainText('valid');
});
test('encrypted DM, reaction, edit, reload and private group', async ({ browser }) => {
  const one = await browser.newContext(),
    two = await browser.newContext();
  const a = await one.newPage(),
    b = await two.newPage();
  const errors: string[] = [];
  a.on('pageerror', (e) => errors.push(e.message));
  b.on('pageerror', (e) => errors.push(e.message));
  const alice = await login(a),
    bob = await login(b);
  await contact(a, bob.pubkey, 'Bob');
  await contact(b, alice.pubkey, 'Alice');
  a.on('dialog', (d) => d.accept());
  b.on('dialog', (d) => d.accept());
  await a.getByTestId('message-composer-input').fill('A real encrypted message');
  await a.getByTestId('message-send-button').click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'A real encrypted message' }),
  ).toBeVisible();
  await b
    .getByTestId('message-bubble')
    .filter({ hasText: 'A real encrypted message' })
    .click({ button: 'right' });
  await b.getByRole('button', { name: 'React', exact: true }).click();
  await expect(a.locator('.reactions')).toContainText('👍');
  await a.bringToFront();
  await expect
    .poll(() =>
      a.evaluate(async () => {
        const path = '/src/stores/messageStore.ts';
        const url = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => new URL(url).pathname === path);
        const { useMessageStore } = await import(url ?? path);
        const chatId = location.pathname.split('/')[2];
        return Boolean(
          useMessageStore()
            .getMessages(chatId)
            .some((message) =>
              message.meta.reactions?.some(
                (reaction) => reaction.emoji === '👍' && reaction.viewedByAuthorAt,
              ),
            ),
        );
      }),
    )
    .toBe(true);

  await a.getByTestId('message-bubble').first().click({ button: 'right' });
  await a.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await a.getByTestId('message-composer-input').fill('Edited encrypted message');
  await a.getByTestId('message-send-button').click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Edited encrypted message' }),
  ).toBeVisible();
  await b.reload();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Edited encrypted message' }),
  ).toBeVisible();
  await a.getByRole('button', { name: 'Chat options' }).click();
  await a.getByRole('button', { name: 'New private group' }).click();
  await a.getByRole('button', { name: 'Generate new group', exact: true }).click();
  await a.getByLabel('Group name').fill('Private test group');
  await a.getByLabel('Members', { exact: true }).fill(nip19.npubEncode(bob.pubkey));
  await a.getByRole('button', { name: 'Continue', exact: true }).click();
  await confirmGroupBackup(a);
  await a.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(a.getByRole('dialog')).toBeHidden();
  await a.getByTestId('message-composer-input').fill('Hello encrypted group');
  await a.getByTestId('message-send-button').click();
  await b.getByRole('button', { name: 'Chat options' }).click();
  await b.getByRole('button', { name: /Message requests/ }).click();
  await expect(b.getByTestId('chat-item').filter({ hasText: 'Private test group' })).toBeVisible();
  await b.getByTestId('chat-item').filter({ hasText: 'Private test group' }).click();
  await b.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Hello encrypted group' }),
  ).toBeVisible();
  // A missing personal ticket must not lock out an owner who is already a member.
  const ownerEpoch = (await groupTicketState(a, true)).epoch;
  await a.getByTestId('message-composer-input').fill('Owner issued personal ticket');
  await a.getByTestId('message-send-button').click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Owner issued personal ticket' }),
  ).toBeVisible();
  const issued = await groupTicketState(a);
  expect(issued.proof).toMatch(/^[0-9a-f]{128}$/);
  expect(issued.epoch).toBe(ownerEpoch);
  await a.reload();
  await expect(a.getByTestId('message-composer-input')).toBeVisible();
  expect(await groupTicketState(a)).toEqual(issued);

  // An ordinary member can receive a replacement without a rotation or rejoining.
  expect((await groupTicketState(b, true)).proof).toBe('');
  await a.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await a.getByRole('tab', { name: 'Members', exact: true }).click();
  await a
    .locator(`.member[data-public-key="${bob.pubkey}"]`)
    .getByRole('button', { name: 'Resend invitation', exact: true })
    .click();
  await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await a.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect.poll(async () => (await groupTicketState(b)).proof).toMatch(/^[0-9a-f]{128}$/);
  const resent = await groupTicketState(b);
  expect(resent.epoch).toBe(ownerEpoch);
  await b.reload();
  await expect(b.getByTestId('message-composer-input')).toBeVisible();
  expect(await groupTicketState(b)).toEqual(resent);
  // Members can reply but must not see owner-only group controls.
  await b.getByTestId('message-composer-input').fill('Reply from group member');
  await b.getByTestId('message-send-button').click();
  await expect(
    a.getByTestId('message-bubble').filter({ hasText: 'Reply from group member' }),
  ).toBeVisible();
  // Encrypting to the public epoch address must not grant posting rights.
  const epochPubkey = await a.evaluate(async () => {
    const path = '/src/services/chatDataService.ts';
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => new URL(url).pathname === path);
    const { chatDataService } = await import(url ?? path);
    const chats = await chatDataService.listChats();
    return chats.find((chat: { type: string }) => chat.type === 'group').meta
      .current_epoch_public_key as string;
  });
  const outsider = generateSecretKey();
  const forged = nip59.createRumor(
    {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      content: 'Uninvited group injection',
      tags: [['p', epochPubkey]],
    },
    outsider,
  );
  await publishFixture(relay, [
    nip59.createWrap(nip59.createSeal(forged, outsider, epochPubkey), epochPubkey),
  ]);
  await b
    .getByTestId('message-bubble')
    .filter({ hasText: 'Hello encrypted group' })
    .click({ button: 'right' });
  await b.getByRole('button', { name: 'React', exact: true }).click();
  await expect(
    a
      .getByTestId('message-bubble')
      .filter({ hasText: 'Hello encrypted group' })
      .locator('.reactions'),
  ).toContainText('👍');
  await a
    .getByTestId('message-bubble')
    .filter({ hasText: 'Hello encrypted group' })
    .click({ button: 'right' });
  await a.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await a.getByTestId('message-composer-input').fill('Edited encrypted group message');
  await a.getByTestId('message-send-button').click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Edited encrypted group message' }),
  ).toBeVisible();
  await expect(a.getByText('Uninvited group injection', { exact: true })).toHaveCount(0);
  await expect(b.getByText('Uninvited group injection', { exact: true })).toHaveCount(0);
  await b.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await b.getByRole('tab', { name: 'Members', exact: true }).click();
  await expect(b.getByRole('button', { name: 'Invite members', exact: true })).toHaveCount(0);
  await b.getByRole('tab', { name: 'Relays', exact: true }).click();
  await expect(b.getByRole('button', { name: 'Save group relays' })).toHaveCount(0);
  await b.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await a.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await a.getByLabel('Description', { exact: true }).fill('A private group with rotating keys');
  await a.getByRole('button', { name: 'Save group profile', exact: true }).click();
  await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await a.getByRole('tab', { name: 'Relays', exact: true }).click();
  await expect(a.getByTestId('group-details')).toContainText(relay);
  await a.getByRole('button', { name: 'Save group relays', exact: true }).click();
  await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await a.getByRole('tab', { name: 'Members', exact: true }).click();
  await a.getByRole('button', { name: 'Rotate group keys', exact: true }).click();
  await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await a.getByRole('tab', { name: 'Epochs', exact: true }).click();
  await expect(a.getByTestId('group-details').locator('.epoch')).toHaveCount(2);
  await a.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await a.getByTestId('message-composer-input').fill('After group rotation');
  await a.getByTestId('message-send-button').click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'After group rotation' }),
  ).toBeVisible();

  // A fresh account session must recover invitations and messages in both epochs.
  const fresh = await browser.newContext();
  const restored = await fresh.newPage();
  restored.on('pageerror', (e) => errors.push(e.message));
  await login(restored, bob.key);
  await restored.getByTestId('chat-item').filter({ hasText: 'Private test group' }).click();
  await expect(
    restored.getByTestId('message-bubble').filter({ hasText: 'Edited encrypted group message' }),
  ).toBeVisible();
  await expect(
    restored.getByTestId('message-bubble').filter({ hasText: 'Reply from group member' }),
  ).toBeVisible();
  await expect(
    restored.getByTestId('message-bubble').filter({ hasText: 'After group rotation' }),
  ).toBeVisible();
  await restored.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await expect(restored.getByTestId('group-details')).toContainText(
    'A private group with rotating keys',
  );
  await fresh.close();

  // Removing a member must rotate automatically and exclude them from the new epoch.
  await a.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await a.getByRole('tab', { name: 'Members', exact: true }).click();
  await expect(a.getByLabel('Member public keys', { exact: true })).toHaveCount(0);
  await a
    .locator(`.member[data-public-key="${bob.pubkey}"]`)
    .getByRole('button', { name: 'Remove member', exact: true })
    .click();
  await expect(a.getByTestId('group-details').getByRole('status')).toHaveText('Saved');
  await a.getByRole('tab', { name: 'Epochs', exact: true }).click();
  await expect(a.getByTestId('group-details').locator('.epoch')).toHaveCount(3);
  const currentEpoch = await a.getByLabel('Epoch public key', { exact: true }).first().inputValue();
  await b.getByRole('button', { name: 'Contact profile', exact: true }).click();
  await b.getByRole('tab', { name: 'Epochs', exact: true }).click();
  await expect(b.getByTestId('group-details').locator('.epoch')).toHaveCount(2);
  expect(await b.getByLabel('Epoch public key', { exact: true }).first().inputValue()).not.toEqual(
    currentEpoch,
  );
  await b.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await a.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await a.getByTestId('message-composer-input').fill('Only remaining members');
  await a.getByTestId('message-send-button').click();
  await expect(
    a.getByTestId('message-bubble').filter({ hasText: 'Only remaining members' }),
  ).toBeVisible();
  // A later direct message is a relay/ingestion barrier, not an arbitrary sleep.
  await a.locator(`[data-testid="chat-item"][data-chat-public-key="${bob.pubkey}"]`).click();
  await expect(a.getByTestId('chat-thread')).toHaveAttribute('data-chat-public-key', bob.pubkey);
  await a.getByTestId('message-composer-input').fill('Removal check complete');
  await a.getByTestId('message-send-button').click();
  await b.locator(`[data-testid="chat-item"][data-chat-public-key="${alice.pubkey}"]`).click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Removal check complete' }),
  ).toBeVisible();
  await b.getByTestId('chat-item').filter({ hasText: 'Private test group' }).click();
  await expect(
    b.getByTestId('message-bubble').filter({ hasText: 'Only remaining members' }),
  ).toHaveCount(0);
  const ownerRestore = await browser.newContext();
  const ownerPage = await ownerRestore.newPage();
  await login(ownerPage, alice.key);
  await ownerPage.getByTestId('chat-item').filter({ hasText: 'Private test group' }).click();
  await expect(
    ownerPage.getByTestId('message-bubble').filter({ hasText: 'Reply from group member' }),
  ).toBeVisible();
  await expect(
    ownerPage.getByTestId('message-bubble').filter({ hasText: 'Only remaining members' }),
  ).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Contact profile', exact: true }).click();
  try {
    await expect(
      ownerPage.getByRole('button', { name: 'Save group profile', exact: true }),
    ).toBeVisible();
  } catch (error) {
    await test.info().attach('restored-owner-state', {
      contentType: 'application/json',
      body: JSON.stringify(
        await ownerPage.evaluate(async () => {
          const { contactsService } = await import('/src/services/contactsService.ts');
          const { useNostrStore } = await import('/src/stores/nostrStore.ts');
          const group = location.pathname.split('/')[2];
          const contact = await contactsService.getContactByPublicKey(group);
          return {
            hasContact: Boolean(contact),
            isOwner: contact?.meta.owner_public_key === useNostrStore().getLoggedInPublicKeyHex(),
            hasEncryptedMaster: Boolean(contact?.meta.group_private_key_encrypted),
            memberCount: contact?.meta.group_members?.length,
          };
        }),
      ),
    });
    throw error;
  }
  await ownerPage.getByRole('tab', { name: 'Epochs', exact: true }).click();
  await expect(ownerPage.getByTestId('group-details').locator('.epoch')).toHaveCount(3);
  await ownerRestore.close();
  expect(errors).toEqual([]);
  await one.close();
  await two.close();
});
test('mobile navigation and cached large inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-theme-item').click();
  await expect(page.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible();
  await page.getByRole('switch', { name: 'Dark mode', exact: true }).uncheck();
  await expect(page.locator('body')).not.toHaveClass(/body--dark/);
});
test('a 20,000-message account opens a bounded cached window', async ({ page }) => {
  const account = await login(page);
  const peer = getPublicKey(generateSecretKey());
  await page.evaluate(
    async ({ peer, own }) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      await chatDataService.createChat({
        public_key: peer,
        name: 'Large history',
        meta: { inbox_state: 'accepted', last_seen_received_activity_at: new Date().toISOString() },
        last_message: 'Cached message 19999',
        last_message_at: new Date().toISOString(),
      });
      const db = await chatDataService.getDatabase();
      for (let batch = 0; batch < 20; batch++)
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('messages', 'readwrite');
          const store = tx.objectStore('messages');
          for (let n = batch * 1000; n < (batch + 1) * 1000; n++)
            store.add({
              chat_public_key: peer,
              author_public_key: own,
              message: `Cached message ${n}`,
              created_at: new Date(Date.now() - 20000000 + n * 1000).toISOString(),
              meta: {},
            });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
    },
    { peer, own: account.pubkey },
  );
  await page.addInitScript(() => {
    // Model a busy/backgrounded tab: reactive notifications may arrive well
    // after a handful of animation frames. Paging must wait for the actual DOM.
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler, delay, ...args) =>
      schedule(
        handler,
        (window as any).__delayHistoryUi && delay === 16 ? 250 : delay,
        ...args,
      )) as typeof window.setTimeout;
    const original = IDBObjectStore.prototype.getAll;
    (window as any).__fullHistoryReads = 0;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'messages') (window as any).__fullHistoryReads++;
      return original.apply(this, args);
    };
  });
  const started = Date.now();
  await page.goto(`/chats/${peer}`);
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Cached message 19999' }),
  ).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(100);
  const thread = page.getByTestId('chat-thread');
  for (const fraction of [0.2, 0.8, 0.35, 1]) {
    const visible = await thread.evaluate(async (node, fraction) => {
      node.scrollTop = fraction * (node.scrollHeight - node.clientHeight);
      await new Promise(requestAnimationFrame);
      const viewport = node.getBoundingClientRect();
      return [...node.querySelectorAll<HTMLElement>('.message-row')]
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.bottom > viewport.top + 40 && box.top < viewport.bottom;
        })
        .map((row) => ({
          painted: row.checkVisibility({ contentVisibilityAuto: true }),
          text: row.querySelector('.message-content')?.textContent?.trim(),
        }));
    }, fraction);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((row) => row.painted && row.text?.includes('Cached message'))).toBe(true);
  }
  const more = page.getByTestId('thread-load-older');
  await expect(more).toHaveText('More');
  async function loadKeepingAnchor(action: () => Promise<unknown>) {
    await thread.evaluate((node) => {
      node.scrollTop = 0;
    });
    const anchor = page.getByTestId('message-bubble').first();
    const id = await anchor.getAttribute('id');
    const before = (await anchor.boundingBox())!.y;
    await action();
    await expect(page.getByTestId('message-bubble').first()).not.toHaveAttribute('id', id!);
    await expect(more).toBeEnabled();
    await expect
      .poll(async () => Math.abs((await page.locator(`#${id}`).boundingBox())!.y - before))
      .toBeLessThan(3);
  }
  await page.evaluate(() => {
    (window as any).__delayHistoryUi = true;
  });
  for (let n = 0; n < 6; n++) await loadKeepingAnchor(() => more.click());
  await page.evaluate(() => {
    (window as any).__delayHistoryUi = false;
  });

  // Scrolling to the top is not a pull: wheel momentum must not load a page.
  const beforeMomentum = await page.getByTestId('message-bubble').first().getAttribute('id');
  await thread.evaluate((node) => {
    node.scrollTop = 100;
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true }));
    node.scrollTop = 0;
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  await expect(page.getByTestId('message-bubble').first()).toHaveAttribute('id', beforeMomentum!);
  await loadKeepingAnchor(() => thread.dispatchEvent('wheel', { deltaY: -40 }));
  await page.setViewportSize({ width: 390, height: 844 });
  await loadKeepingAnchor(() =>
    thread.evaluate((node) => {
      const point = (y: number) =>
        new Touch({ identifier: 1, target: node, clientX: 100, clientY: y });
      node.dispatchEvent(new TouchEvent('touchstart', { touches: [point(100)], bubbles: true }));
      node.dispatchEvent(
        new TouchEvent('touchmove', { touches: [point(160)], bubbles: true, cancelable: true }),
      );
      node.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(300);
  await page.getByRole('button', { name: 'Search conversation' }).click();
  await page.getByLabel('Search messages', { exact: true }).fill('Cached message 10000');
  await page.getByRole('button', { name: 'Cached message 10000', exact: true }).click();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Cached message 10000' }),
  ).toBeVisible();
  expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(101);
  expect(await page.evaluate(() => (window as any).__fullHistoryReads)).toBe(0);
  await page.getByTestId('message-composer-input').fill('UI remains responsive');
  await expect(page.getByTestId('message-composer-input')).toHaveValue('UI remains responsive');
});

test('language changes persist and call assets load on nested routes', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-language-item').click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('de-DE');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  const response = await page.request.get('/iroh/anagram_iroh_calls.js');
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain('CallEndpoint');
});

async function publishFixture(url: string, events: ReturnType<typeof finalizeEvent>[]) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    for (const event of events)
      await new Promise<void>((resolve, reject) => {
        const handler = (data: WebSocket.RawData) => {
          const result = JSON.parse(String(data));
          if (result[0] !== 'OK' || result[1] !== event.id) return;
          socket.off('message', handler);
          result[2] ? resolve() : reject(new Error('Fixture rejected'));
        };
        socket.on('message', handler);
        socket.send(JSON.stringify(['EVENT', event]));
      });
  } finally {
    socket.close();
  }
}

test('fresh login restores historical DMs from the advertised inbox relay without exposing keys', async ({
  page,
}) => {
  const key = generateSecretKey(),
    peer = generateSecretKey();
  const own = getPublicKey(key),
    sender = getPublicKey(peer);
  const dmRelay = 'ws://127.0.0.1:7778/';
  const now = Math.floor(Date.now() / 1000);
  await publishFixture(relay, [
    finalizeEvent({ kind: 10050, created_at: now, tags: [['relay', dmRelay]], content: '' }, key),
  ]);
  const rumor = nip59.createRumor(
    {
      kind: 14,
      created_at: now - 7 * 86400,
      tags: [['p', own]],
      content: 'Restored from a dedicated DM relay',
    },
    peer,
  );
  const seal = nip59.createSeal(rumor, peer, own);
  const ephemeral = generateSecretKey();
  const wrapped = finalizeEvent(
    {
      kind: 1059,
      created_at: now - 7 * 86400,
      tags: [['p', own]],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(ephemeral, own),
      ),
    },
    ephemeral,
  );
  await publishFixture(dmRelay, [wrapped]);
  const consoleOutput: string[] = [],
    wire: string[] = [];
  page.on('console', (message) => consoleOutput.push(message.text()));
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => wire.push(String(payload))),
  );
  await login(page, key);
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: /Message requests/ }).click();
  await expect(page.getByTestId('chat-item')).toHaveCount(2, { timeout: 60000 });
  await page.goto(`/chats/${sender}`);
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Restored from a dedicated DM relay' }),
  ).toBeVisible();
  for (const secret of [nip19.nsecEncode(key), Buffer.from(key).toString('hex')]) {
    // Compare booleans so failed assertions cannot print the key itself.
    expect(consoleOutput.some((value) => value.includes(secret))).toBe(false);
    expect(wire.some((value) => value.includes(secret))).toBe(false);
  }
  expect(consoleOutput.some((value) => value.includes('Restored from a dedicated DM relay'))).toBe(
    false,
  );

  // Import the same module instance as the running app, including Vite's HMR
  // timestamp when this test reuses an already-running development server.
  await page.evaluate(async () => {
    const serviceUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/services\/chatDataService\.ts(?:\?|$)/.test(url));
    if (!serviceUrl) throw new Error('Live message service module was not loaded');
    const { chatDataService } = await import(serviceUrl);
    const original = chatDataService.createMessage.bind(chatDataService);
    const barrier = new Promise<void>((resolve) => {
      (window as any).__releaseMessageWrite = resolve;
    });
    chatDataService.createMessage = async (...args) => {
      (window as any).__messageWriteStarted = true;
      await barrier;
      return original(...args);
    };
  });
  await publishFixture(dmRelay, [
    nip59.wrapEvent(
      { kind: 14, tags: [['p', own]], content: 'Visible before the database commit' },
      peer,
      own,
    ),
  ]);
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Visible before the database commit' }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__messageWriteStarted)).toBe(true);
  await publishFixture(dmRelay, [
    nip59.wrapEvent(
      {
        kind: 14,
        created_at: now + 1,
        tags: [['p', own]],
        content: 'Another DM while the first write waits',
      },
      peer,
      own,
    ),
  ]);
  await expect(
    page
      .getByTestId('message-bubble')
      .filter({ hasText: 'Another DM while the first write waits' }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).__releaseMessageWrite());
  await expect
    .poll(() =>
      page.evaluate(
        async ({ sender }) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          return (await chatDataService.listLatestMessages(sender, 10)).rows.filter(
            (message) => message.message === 'Visible before the database commit',
          ).length;
        },
        { sender },
      ),
    )
    .toBe(1);
  await page.reload();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Visible before the database commit' }),
  ).toHaveCount(1);
  // A failed message write must leave ciphertext available for a later retry.
  await page.evaluate(async () => {
    const serviceUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/src\/services\/chatDataService\.ts(?:\?|$)/.test(url));
    const { chatDataService } = await import(serviceUrl!);
    const original = chatDataService.createMessage.bind(chatDataService);
    chatDataService.createMessage = async (...args) => {
      chatDataService.createMessage = original;
      (window as any).__failedMessageWrite = true;
      throw new Error('Simulated database interruption');
    };
  });
  await publishFixture(dmRelay, [
    nip59.wrapEvent(
      {
        kind: 14,
        created_at: now + 2,
        tags: [['p', own]],
        content: 'Retried after a failed write',
      },
      peer,
      own,
    ),
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).__failedMessageWrite)).toBe(true);
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Retried after a failed write' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async (sender) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        return (await chatDataService.listLatestMessages(sender, 10)).rows.filter(
          (message) => message.message === 'Retried after a failed write',
        ).length;
      }, sender),
    )
    .toBe(1);
  await page.reload();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Retried after a failed write' }),
  ).toHaveCount(1);
});

test('chat controls retain desktop and mobile interactions', async ({ page }, testInfo) => {
  await login(page);
  page.on('dialog', (dialog) => dialog.accept());
  await contact(page, getPublicKey(generateSecretKey()), 'Parity fixture');
  const composer = page.getByTestId('message-composer-input');
  await composer.fill(':thumb');
  await expect(page.getByRole('listbox', { name: 'Emoji suggestions' })).toBeVisible();
  await composer.press('ArrowDown');
  await composer.press('Enter');
  await expect(composer).not.toHaveValue(':thumb');
  await expect(page.getByTestId('message-bubble')).toHaveCount(0);
  await composer.fill('Find this parity message');
  await page.getByTestId('message-send-button').click();
  const message = page
    .getByTestId('message-bubble')
    .filter({ hasText: 'Find this parity message' });
  await expect(message).toBeVisible();
  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search messages', exact: true }).fill('parity');
  await expect(page.getByTestId('thread-search-status')).toHaveText('1 / 1');
  await page.getByRole('button', { name: 'Next search result' }).click();
  await expect(message).toHaveClass(/highlighted/);
  await page.getByRole('button', { name: 'Close search' }).click();
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Nostr info', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Event ID');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.keyboard.press('Escape');
  const sidebar = page.locator('aside.sidebar');
  const before = await sidebar.boundingBox();
  await page.getByRole('separator', { name: 'Resize left panel' }).press('ArrowRight');
  expect((await sidebar.boundingBox())!.width).toBe(before!.width + 16);
  await testInfo.attach('desktop-chat.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.composer-context')).toContainText('Find this parity message');
  await testInfo.attach('mobile-chat.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await expect(page.getByTestId('chat-item').filter({ hasText: 'Parity fixture' })).toBeVisible();
  await expect(composer).toBeHidden();
});

test('hydrates successive time windows through sparse years-old DM history', async ({ page }) => {
  const key = generateSecretKey(),
    peer = generateSecretKey();
  const own = getPublicKey(key),
    sender = getPublicKey(peer);
  const now = Math.floor(Date.now() / 1000);
  const days = [3, 16, 150, 1100];
  const events = days.map((age) => {
    const created_at = now - age * 86400;
    const rumor = nip59.createRumor(
      { kind: 14, created_at, tags: [['p', own]], content: `Hydrated history at ${age} days` },
      peer,
    );
    const seal = nip59.createSeal(rumor, peer, own);
    const ephemeral = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        created_at,
        tags: [['p', own]],
        content: nip44.v2.encrypt(
          JSON.stringify(seal),
          nip44.v2.utils.getConversationKey(ephemeral, own),
        ),
      },
      ephemeral,
    );
  });
  await publishFixture(relay, events);
  const historyRequests: Array<{ since: number; until: number; limit: number }> = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame[0] !== 'REQ') return;
      for (const filter of frame.slice(2))
        if (filter.kinds?.includes(1059) && filter.limit && filter.until !== undefined)
          historyRequests.push(filter);
    }),
  );
  await login(page, key);
  await expect
    .poll(() => historyRequests.some((filter) => filter.until < now - 1000 * 86400), {
      timeout: 60000,
    })
    .toBe(true);
  // Opening the thread starts a foreground recheck with a week plus two days
  // of NIP-59 timestamp skew on either side. Keep the background-window
  // assertion separate so priority fetching does not invalidate it.
  const backgroundRequests = [...historyRequests];
  await page.goto(`/chats/${sender}`);
  for (const age of days)
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: `Hydrated history at ${age} days` }),
    ).toBeVisible();
  expect(historyRequests.some((filter) => filter.limit === 1 && filter.since === 0)).toBe(true);
  expect(
    backgroundRequests.every(
      (filter) =>
        filter.limit <= 128 && (filter.limit === 1 || filter.until - filter.since < 7 * 86400),
    ),
  ).toBe(true);
  expect(
    historyRequests.every(
      (filter) =>
        filter.limit <= 128 && (filter.limit === 1 || filter.until - filter.since <= 11 * 86400),
    ),
  ).toBe(true);
});

test('all 1,200 DM and group threads remain available after reload', async ({ page }) => {
  await login(page);
  await page.evaluate(async () => {
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    const db = await chatDataService.getDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chats', 'readwrite');
      const store = tx.objectStore('chats');
      for (let index = 0; index < 1200; index++) {
        store.put({
          public_key: (index + 1).toString(16).padStart(64, '0'),
          type: index % 2 ? 'group' : 'user',
          name: `${index % 2 ? 'Group' : 'DM'} ${index.toString().padStart(4, '0')}`,
          last_message: 'Cached conversation',
          last_message_at: new Date(1700000000000 + index * 1000).toISOString(),
          unread_count: 0,
          meta: { inbox_state: 'accepted' },
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
  await page.reload();
  await expect(page.getByTestId('chat-item')).toHaveCount(1201);
  await page.getByTestId('chat-item').filter({ hasText: 'DM 0000' }).click();
  await expect(page.getByTestId('message-composer-input')).toBeVisible();
  await page.getByTestId('chat-item').filter({ hasText: 'Group 0001' }).click();
  await expect(page.getByRole('button', { name: 'Contact profile', exact: true })).toBeVisible();
  await page.getByPlaceholder('Search', { exact: true }).fill('Group 1199');
  await expect(page.getByTestId('chat-item')).toHaveCount(1);
  await page.getByTestId('chat-item').click();
  await page.getByPlaceholder('Search', { exact: true }).fill('');
  await expect(page.getByTestId('chat-item')).toHaveCount(1201);
});

test('concurrent DM hydration stays in the authenticated sender thread while switching chats', async ({
  page,
}) => {
  const account = await login(page);
  const barry = generateSecretKey(),
    monika = generateSecretKey();
  const peers = [getPublicKey(barry), getPublicKey(monika)];
  await publishFixture(relay, [
    finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({ name: 'Barry fixture' }),
      },
      barry,
    ),
    finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({ name: 'Monika fixture' }),
      },
      monika,
    ),
  ]);
  await contact(page, peers[0], 'Barry fixture');
  await contact(page, peers[1], 'Monika fixture');
  await page.evaluate(async () => {
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    const original = chatDataService.createMessage.bind(chatDataService);
    chatDataService.createMessage = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return original(input);
    };
  });
  const now = Math.floor(Date.now() / 1000);
  const fixtures = [];
  for (let index = 0; index < 24; index++) {
    for (const [number, key] of [barry, monika].entries()) {
      for (const incoming of [false, true]) {
        const rumor = nip59.createRumor(
          {
            kind: 14,
            created_at: now - 1000 + index,
            tags: [['p', incoming ? account.pubkey : peers[number]]],
            content: `${number === 0 ? 'BARRY' : 'MONIKA'} ${incoming ? 'incoming' : 'outgoing'} ${index}`,
          },
          incoming ? key : account.key,
        );
        const seal = nip59.createSeal(rumor, incoming ? key : account.key, account.pubkey);
        fixtures.push(nip59.createWrap(seal, account.pubkey));
      }
    }
  }
  await publishFixture(relay, fixtures);
  for (let index = 0; index < 12; index++) {
    const number = index % 2;
    await page
      .locator(`[data-testid="chat-item"][data-chat-public-key="${peers[number]}"]`)
      .click();
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: number === 0 ? 'MONIKA' : 'BARRY' }),
    ).toHaveCount(0);
  }
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        const db = await chatDataService.getDatabase();
        return new Promise<number>((resolve) => {
          const request = db.transaction('messages').objectStore('messages').count();
          request.onsuccess = () => resolve(request.result);
        });
      }),
    )
    .toBe(96);
  const storedThreads = await page.evaluate(async (peers) => {
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    return Promise.all(
      peers.map(async (peer) => (await chatDataService.listLatestMessages(peer, 100)).rows),
    );
  }, peers);
  for (const [number, rows] of storedThreads.entries()) {
    expect(rows).toHaveLength(48);
    for (const row of rows) {
      expect(row.chat_public_key).toBe(peers[number]);
      expect(row.message).toContain(number === 0 ? 'BARRY' : 'MONIKA');
      expect(row.author_public_key).toBe(
        row.message.includes('incoming') ? peers[number] : account.pubkey,
      );
    }
  }
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    for (const [number, pubkey] of peers.entries()) {
      await page.locator(`[data-testid="chat-item"][data-chat-public-key="${pubkey}"]`).click();
      await expect(page.getByTestId('message-bubble')).toHaveCount(48);
      await expect(page.getByTestId('chat-thread')).toHaveAttribute('data-chat-public-key', pubkey);
      // A chat switch can replace the previous 48 rows after the count check.
      // Wait for the expected thread's complete render, not a transient snapshot.
      await expect
        .poll(() =>
          page
            .getByTestId('message-bubble')
            .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-chat-public-key'))),
        )
        .toEqual(Array(48).fill(pubkey));
      // Bubble layout shows a name once per consecutive author group. Events
      // sharing a timestamp can sort into different groups on each run.
      await expect
        .poll(async () => [
          ...new Set(
            await page
              .getByTestId('message-bubble')
              .filter({ hasText: 'incoming' })
              .getByTestId('thread-author-name-link')
              .allTextContents(),
          ),
        ])
        .toEqual([number === 0 ? 'Barry fixture' : 'Monika fixture']);
      await expect(
        page.getByTestId('message-bubble').filter({ hasText: number === 0 ? 'MONIKA' : 'BARRY' }),
      ).toHaveCount(0);
      await expect(page.getByTestId('message-bubble').filter({ hasText: 'incoming' })).toHaveCount(
        24,
      );
    }
  }
});

test('incoming DM committed during a cached load remains visible', async ({ page }) => {
  const account = await login(page);
  const peer = generateSecretKey(),
    pubkey = getPublicKey(peer);
  await contact(page, pubkey, 'Concurrent reply');
  await page.getByTestId('message-composer-input').fill('Existing outgoing message');
  await page.getByTestId('message-send-button').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(1);
  await page.evaluate(async () => {
    const { nostrEventDataService } = await import('/src/services/nostrEventDataService.ts');
    const { useMessageStore } = await import('/src/stores/messageStore.ts');
    const { useChatStore } = await import('/src/stores/chatStore.ts');
    const original = nostrEventDataService.getEventsByIds.bind(nostrEventDataService);
    let release: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadStarted = new Promise<void>((resolve) => {
      nostrEventDataService.getEventsByIds = async (ids) => {
        nostrEventDataService.getEventsByIds = original;
        const result = await original(ids);
        resolve();
        await barrier;
        return result;
      };
    });
    (window as any).__releaseMessageSnapshot = () => release();
    (window as any).__messageSnapshotLoad = useMessageStore().loadMessages(
      useChatStore().selectedChatId!,
      true,
    );
    await loadStarted;
  });
  const rumor = nip59.createRumor(
    {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', account.pubkey]],
      content: 'Incoming during cached snapshot',
    },
    peer,
  );
  await publishFixture(relay, [
    nip59.createWrap(nip59.createSeal(rumor, peer, account.pubkey), account.pubkey),
  ]);
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        return Boolean(await chatDataService.getMessageByEventId(id));
      }, rumor.id),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const { useMessageStore } = await import('/src/stores/messageStore.ts');
        const { useChatStore } = await import('/src/stores/chatStore.ts');
        return useMessageStore()
          .getMessages(useChatStore().selectedChatId)
          .some((message) => message.eventId === id && /^\d+$/.test(message.id));
      }, rumor.id),
    )
    .toBe(true);
  const afterSnapshot = await page.evaluate(async () => {
    const { useMessageStore } = await import('/src/stores/messageStore.ts');
    const { useChatStore } = await import('/src/stores/chatStore.ts');
    (window as any).__releaseMessageSnapshot();
    await (window as any).__messageSnapshotLoad;
    return useMessageStore()
      .getMessages(useChatStore().selectedChatId)
      .map((message) => message.text);
  });
  expect(afterSnapshot).toContain('Incoming during cached snapshot');
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'Incoming during cached snapshot' }),
  ).toBeVisible();
});

test('message actions open at the pointer, stay within the viewport, and support mobile long press', async ({
  page,
}, testInfo) => {
  await login(page);
  await contact(page, getPublicKey(generateSecretKey()), 'Menu placement fixture');
  const composer = page.getByTestId('message-composer-input');
  await composer.fill('Pointer anchor fixture');
  await page.getByTestId('message-send-button').click();
  const message = page.getByTestId('message-bubble').filter({ hasText: 'Pointer anchor fixture' });
  await expect(message).toBeVisible();
  const menu = page.getByTestId('message-context-menu');
  await message.hover();
  await expect(menu).toHaveCount(0);
  const content = message.locator('.message-content');
  const box = (await content.boundingBox())!;
  await page.mouse.click(box.x + 16, box.y + 8, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((node) => node.closest('.message-row') === null)).toBe(true);
  const bounds = (await menu.boundingBox())!;
  expect(Math.abs(bounds.x - box.x - 16)).toBeLessThan(3);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 7);
  const reply = menu.getByRole('menuitem', { name: 'Reply', exact: true });
  const forward = menu.getByRole('menuitem', { name: 'Forward', exact: true });
  expect((await forward.boundingBox())!.y).toBeGreaterThan((await reply.boundingBox())!.y);
  await testInfo.attach('message-context-desktop.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await reply.click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.composer-context')).toContainText('Pointer anchor fixture');
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Cancel reply or edit' }).click();
  await message.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await expect(reply).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Copy message' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(message.getByRole('button', { name: 'Message actions' })).toBeFocused();
  await page.evaluate(async () => {
    const { saveDesktopMessageLayoutPreference } = await import('/src/utils/themeStorage.ts');
    saveDesktopMessageLayoutPreference('bubbles');
  });
  await message.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Choose reaction' }).click();
  await expect(menu.locator('input')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = (await content.boundingBox())!;
  const position = {
    clientX: mobileBox.x + 14,
    clientY: mobileBox.y + 10,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
  };
  await content.dispatchEvent('pointerdown', position);
  await expect(menu).toBeVisible();
  await content.dispatchEvent('pointerup', position);
  await content.dispatchEvent('click', { clientX: position.clientX, clientY: position.clientY });
  await expect(menu).toBeVisible();
  const mobileBounds = (await menu.boundingBox())!;
  expect(mobileBounds.x).toBeGreaterThanOrEqual(8);
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(383);
  expect(mobileBounds.y + mobileBounds.height).toBeLessThanOrEqual(837);
  await testInfo.attach('message-context-mobile.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByTestId('chat-thread').dispatchEvent('scroll');
  await expect(menu).toHaveCount(0);
});
