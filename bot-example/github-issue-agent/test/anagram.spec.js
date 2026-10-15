// Optional interoperability check with the real Anagram client (mock Ollama and GitHub).
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
import { IssueAgent, publishProfile } from '../bot.js';
import { Access } from '../access.js';
import { Drafts } from '../drafts.js';
import { GitHubClient } from '../github.js';
import { OllamaClient } from '../ollama.js';
import { Network, State } from '../runtime.js';
import { relay } from './relay.js';
import { chat, ollamaServer } from './ollama-server.js';
import { githubServer } from './github-server.js';

const REPO = 'lnbits/anagram';

// The groups are created in the browser, so their ids are unknown in advance: allow every
// group here. The user allowlist still only contains the test user. allowJoined() then
// gives each joined group an authorization time, as configured groups get at startup.
class TestAccess extends Access {
  privateGroup() {
    return true;
  }
  publicGroup() {
    return true;
  }
}

test('Anagram UI can draft and confirm issues by DM and in private and public groups', async ({
  browser,
}) => {
  const local = await relay();
  const ollama = await ollamaServer((request, res) =>
    chat(
      res,
      JSON.stringify({
        title: 'Login button does nothing',
        body: 'Tapping login has no effect.',
        missing: [],
      }),
    ),
  );
  const github = await githubServer();
  const parent = fileURLToPath(new URL('../data/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(`${parent}browser-`);
  const store = new State(dir);
  const account = TEST_ACCOUNTS.botOwner;
  const bot = new IssueAgent({
    store,
    net: new Network([local.url]),
    ollama: new OllamaClient({ url: ollama.url, model: 'test-model' }),
    github: new GitHubClient({ token: github.token, url: github.url, allowLocal: true }),
    access: new TestAccess({
      users: [[getPublicKey(Buffer.from(account.privateKey, 'hex')), [REPO]]],
    }),
    drafts: new Drafts(),
    log() {},
  });
  let user;
  try {
    await bot.start();
    await publishProfile(bot);
    user = await bootstrapUser(browser, account, { relayUrls: [local.url] });
    const page = user.page;
    const npub = nip19.npubEncode(bot.pubkey);
    const latestCode = () => bot.drafts.all().at(-1)?.code;
    const allowJoined = () => {
      for (const group of Object.keys(store.data.groups)) bot.access.privateGroups.add(group);
      for (const room of Object.keys(store.data.rooms)) bot.access.publicGroups.add(room);
      bot.authorize();
    };

    await openDirectChatFromIdentifier(page, npub, 'GitHub Issue Agent');
    await navigateToChat(page, bot.pubkey);
    const send = async (box, text) => {
      await page.getByRole('textbox', { name: box, exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    };
    await send('Message', `create an issue in ${REPO} about the login button`);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Title: Login button does nothing' }),
    ).toBeVisible();
    await expect.poll(latestCode).toBeTruthy();
    await send('Message', 'yes');
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'never publish' }),
    ).toBeVisible();
    await send('Message', `/confirm ${latestCode()}`);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: `as ${REPO}#1` }),
    ).toBeVisible();
    expect(github.issues).toHaveLength(1);

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New private group', exact: true }).click();
    await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Private issues');
    await page.getByLabel('Members', { exact: true }).fill(npub);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await confirmGroupBackup(page);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => Object.keys(store.data.groups).length).toBe(1);
    allowJoined();
    await send('Message', `issue in ${REPO}: login broken nostr:${npub}`);
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Title: Login button does nothing' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Public issues');
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
    allowJoined();
    await send('Public message', `issue in ${REPO}: login broken nostr:${npub}`);
    await expect(
      page.getByTestId('public-message').filter({ hasText: 'Title: Login button does nothing' }),
    ).toBeVisible();
    await send('Public message', `/confirm ${latestCode()}`);
    await expect(
      page.getByTestId('public-message').filter({ hasText: `as ${REPO}#2` }),
    ).toBeVisible();
    expect(github.issues).toHaveLength(2);
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    await ollama.close();
    await github.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
