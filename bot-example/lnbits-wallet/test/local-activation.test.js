// The real bot process, as the manual tests will run it: a listed local relay, the mock wallet, the
// connection page, a payment and what happens once the relay is no longer listed. Everything is
// throwaway and synthetic: no LNbits, no Lightning.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { BOT_CONTROL_KIND, keyboardFromTags } from '../vendor/botKeyboardProtocol.ts';
import { now } from '../vendor/runtime.js';
import { defer, tempDir } from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';
import { startMockWallet } from './mock-wallet.js';
import { relay, until } from './relay.js';

const BOT = fileURLToPath(new URL('../bot.js', import.meta.url));
const ADMIN = fileURLToPath(new URL('../admin.js', import.meta.url));
const GUARD = fileURLToPath(new URL('./no-network.js', import.meta.url));
const person = generateSecretKey();

function start(t, dir, env) {
  let output = '';
  const child = spawn(process.execPath, ['--import', GUARD, BOT], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return {
    output: () => output,
    exited,
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
    },
  };
}
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
function post(port, path, body, { cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test(
  'a listed local relay, the mock wallet and a real bot, and nothing once it is unlisted',
  { timeout: 90000 },
  async (t) => {
    const dir = tempDir(t, 'activation');
    const chat = await relay();
    defer(t, () => chat.close());
    const walletRelay = await relay();
    defer(t, () => walletRelay.close());
    const lnbits = await lnbitsServer({});
    defer(t, () => lnbits.close());
    const wallet = await startMockWallet({ dir: `${dir}/mock`, relay: walletRelay.url });
    defer(t, () => wallet.close());
    const port = await freePort();
    const common = {
      DATA_DIR: `${dir}/data`,
      LNBITS_URL: lnbits.url,
      LNBITS_ALLOW_HTTP: 'true',
      RELAYS: chat.url,
      SECRETS_DIR: `${dir}/secrets`,
      CONNECT_PUBLIC_URL: `http://127.0.0.1:${port}`,
      CONNECT_PORT: String(port),
      CONNECT_ALLOW_HTTP_LOCAL: 'true',
      NWC_ENABLED: 'true',
      SEND_ENABLED: 'true',
    };
    for (const args of [
      ['keyring', 'init'],
      ['connections', 'init'],
    ]) {
      const made = spawnSync(process.execPath, [ADMIN, ...args], {
        env: { PATH: process.env.PATH, ...common },
        encoding: 'utf8',
      });
      assert.equal(made.status, 0, made.stderr);
    }
    const boot = async (env) => {
      const bot = start(t, dir, env);
      await until(() => /Connection page listening/.test(bot.output()), 'page', 15000);
      return bot;
    };
    let bot = await boot({ ...common, NWC_LOCAL_TEST_RELAYS: walletRelay.url });
    assert.match(bot.output(), /TEST ONLY: NWC may use 1 relay/);
    const botKey = nip19.decode(/: (npub1[a-z0-9]+)/.exec(bot.output())[1]).data;

    const replies = () =>
      [...chat.events.values()]
        .filter((e) => e.kind === 1059)
        .flatMap((event) => {
          try {
            return [unwrapEvent(event, person)];
          } catch {
            return [];
          }
        })
        .filter((m) => m.pubkey === botKey)
        .sort((a, b) => a.created_at - b.created_at);
    const say = (content) =>
      chat.emit(
        wrapEvent({ kind: 14, tags: [['p', botKey]], content, created_at: now() }, person, botKey),
      );
    const pressing = (card, data) =>
      chat.emit(
        wrapEvent(
          {
            kind: BOT_CONTROL_KIND,
            created_at: now(),
            tags: [
              ['p', botKey],
              [
                'anagram-bot',
                '1',
                JSON.stringify({
                  op: 'request',
                  id: randomBytes(16).toString('hex'),
                  target: {
                    type: 'dm',
                    chat: botKey,
                    root: card.id,
                    version: card.id,
                    bot: botKey,
                  },
                  data,
                  expires: now() + 300,
                }),
              ],
            ],
            content: '',
          },
          person,
          botKey,
        ),
      );
    const newReply = async (test, what) => {
      await until(() => replies().some(test), what, 15000);
      return replies().filter(test).at(-1);
    };

    // Connecting: the page refuses a relay that is not on the list, however local.
    say('/connect');
    // Anagram's buttons are HTTPS only, so a local page's link comes as text.
    const linkCard = await newReply((m) => /http:\/\/127\.0\.0\.1\S+#/.test(m.content), 'link');
    const link = /http:\/\/127\.0\.0\.1\S+#\S+/.exec(linkCard.content)[0];
    const opened = await post(port, '/c/session', { token: new URL(link).hash.slice(1) });
    assert.equal(opened.status, 200);
    const browser = {
      cookie: opened.headers['set-cookie'][0].split(';')[0],
      csrf: opened.data.csrf,
    };
    const unlisted = wallet.uri.replace(
      encodeURIComponent(walletRelay.url),
      encodeURIComponent(chat.url),
    );
    assert.equal(
      (
        await post(
          port,
          '/c/nwc',
          { connection: unlisted, spend: true, acknowledged: true },
          browser,
        )
      ).status,
      400,
    );
    const form = await post(
      port,
      '/c/nwc',
      { connection: wallet.uri, spend: true, acknowledged: true },
      browser,
    );
    assert.equal(form.status, 200, JSON.stringify(form.data));
    assert.match(form.data.limit, /20,000 sats/);
    const codeCard = await newReply((m) => /Your code/.test(m.content), 'code');
    const code = /: ([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(codeCard.content)[1];
    assert.equal((await post(port, '/c/code', { code }, browser)).status, 200);
    await newReply(
      (m) => /[Cc]onnected/.test(m.content) && !/Your code/.test(m.content),
      'connected',
    );

    // Paying: preview, press, proof, once.
    const made = wallet.run('invoice', { sats: 1000 });
    say(`/send ${made.invoice}`);
    const preview = await newReply((m) => /^Pay /.test(m.content), 'preview');
    assert.equal(wallet.run('status').payRequests, 0, 'a preview pays nothing');
    const pay = keyboardFromTags(preview.tags).inline_keyboard[0][0].callback_data;
    pressing(preview, pay);
    pressing(preview, pay);
    await until(() => wallet.run('status').payRequests >= 1, 'the payment', 15000);
    await newReply((m) => /^Paid /.test(m.content), 'confirmation');
    const paid = wallet.run('status');
    assert.equal(paid.payRequests, 1);
    assert.deepEqual(paid.duplicates, []);
    assert.equal(paid.usedSats, 1001);
    say('/payments');
    await newReply((m) => /Confirmed/.test(m.content), 'history');
    await bot.stop();

    // Unlisted: the stored connection stays stored, the relay is out of reach, and nothing pays.
    const seen = walletRelay.connections.length;
    bot = await boot(common);
    assert.doesNotMatch(bot.output(), /TEST ONLY/);
    const later = wallet.run('invoice', { sats: 1000 });
    say(`/send ${later.invoice}`);
    const another = await newReply(
      (m) => /^Pay /.test(m.content) && m.id !== preview.id,
      'second preview',
    );
    pressing(another, keyboardFromTags(another.tags).inline_keyboard[0][0].callback_data);
    await newReply((m) => /Nothing was paid/.test(m.content), 'refusal');
    assert.equal(wallet.run('status').payRequests, 1);
    assert.equal(walletRelay.connections.length, seen, 'not even connected to');
    await bot.stop();

    // No secret in anything the bot printed.
    const connection = readFileSync(`${dir}/mock/connection.txt`, 'utf8');
    const secret = new URL(connection.trim()).searchParams.get('secret');
    assert.ok(!bot.output().includes(secret));
  },
);
