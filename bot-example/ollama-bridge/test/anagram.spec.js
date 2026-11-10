import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateToChat,
  confirmGroupBackup,
  disposeUsers,
} from '../../../e2e/parity/helpers.ts';
import { OllamaBridge, publishProfile } from '../bot.js';
import { Access } from '../access.js';
import { OllamaClient } from '../ollama.js';
import { Network, State } from '../runtime.js';
import { relay } from './relay.js';
import { chat, ollamaServer } from './ollama-server.js';

// The groups are created in the browser, so their ids are unknown in advance: allow every
// group here. The sender allowlist still only contains the test user.
class TestAccess extends Access {
  privateGroup() {
    return true;
  }
  publicGroup() {
    return true;
  }
}

test('Anagram UI can DM the bot and use it in private and public groups', async ({ browser }) => {
  const local = await relay();
  const answer = 'Mining adds blocks by finding a valid proof of work.';
  const ollama = await ollamaServer((request, res) => chat(res, answer));
  const parent = fileURLToPath(new URL('../data/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(`${parent}browser-`);
  const store = new State(dir);
  const account = TEST_ACCOUNTS.botOwner;
  const bot = new OllamaBridge({
    store,
    net: new Network([local.url]),
    ollama: new OllamaClient({ url: ollama.url, model: 'test-model' }),
    access: new TestAccess({
      senders: [getPublicKey(Buffer.from(account.privateKey, 'hex'))],
    }),
    log() {},
  });
  let user;
  try {
    await bot.start();
    await publishProfile(bot);
    user = await bootstrapUser(browser, account, { relayUrls: [local.url] });
    const page = user.page;
    const npub = nip19.npubEncode(bot.pubkey);
    async function expectPromptBeforeReply(testId, prompt) {
      const rows = page.getByTestId(testId);
      await expect(rows.filter({ hasText: answer })).toBeVisible();
      await expect
        .poll(async () => {
          const texts = await rows.locator('.message-text').allTextContents();
          const promptIndex = texts.findIndex((text) => text.includes(prompt));
          return promptIndex >= 0 && promptIndex < texts.findIndex((text) => text.includes(answer));
        })
        .toBe(true);
    }

    await openDirectChatFromIdentifier(page, npub, 'Ollama Bridge');
    await navigateToChat(page, bot.pubkey);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Explain mining');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('message-bubble', 'Explain mining');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New private group', exact: true }).click();
    await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Private AI');
    await page.getByLabel('Members', { exact: true }).fill(npub);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await confirmGroupBackup(page);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => Object.keys(store.data.groups).length).toBe(1);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`Private question nostr:${npub}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('message-bubble', 'Private question');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Public AI');
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
    await page
      .getByRole('textbox', { name: 'Public message', exact: true })
      .fill(`Public question nostr:${npub}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expectPromptBeforeReply('public-message', 'Public question');
    expect(ollama.requests.filter((r) => r.url === '/api/chat')).toHaveLength(3);
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    await ollama.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
