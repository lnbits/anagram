// A real bot process with everything around it on this computer: a chat relay, a wallet relay, an
// LNbits stand-in, mock wallets and people talking to it the way Anagram does. Nothing is reused
// between tests, and nothing real is involved.
import './no-network.js';
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
export const LONG = { timeout: 240000 };
export { until };
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Every button of a card, as { text, data }.
export const buttons = (card) =>
  (keyboardFromTags(card.tags)?.inline_keyboard ?? [])
    .flat()
    .map((b) => ({ text: b.text, data: b.callback_data }));
export const button = (card, text) => {
  const found = buttons(card).find((b) => text.test(b.text));
  assert.ok(found, `no button ${text} on the card`);
  return found.data;
};

export async function world(t, { env = {}, lnbitsWallets = {} } = {}) {
  const dir = tempDir(t, 'live');
  const chat = await relay();
  defer(t, () => chat.close());
  const walletRelay = await relay();
  defer(t, () => walletRelay.close());
  const lnbits = await lnbitsServer(lnbitsWallets);
  defer(t, () => lnbits.close());
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
    NWC_LOCAL_TEST_RELAYS: walletRelay.url,
    ...env,
  };
  const admin = (...args) =>
    spawnSync(process.execPath, ['--import', GUARD, ADMIN, ...args], {
      env: { PATH: process.env.PATH, ...common },
      encoding: 'utf8',
    });
  for (const args of [
    ['keyring', 'init'],
    ['connections', 'init'],
  ])
    assert.equal(admin(...args).status, 0);

  let child;
  let exited;
  let output = '';
  // When each part of the output arrived, printed only if the test fails, so that a slow step can
  // be found afterwards. The bot logs no keys or secrets (see the tests that check its output).
  const bootedAt = Date.now();
  const timeline = [];
  const collect = (data) => {
    output += data;
    timeline.push(`+${((Date.now() - bootedAt) / 1000).toFixed(1)}s ${String(data).trimEnd()}`);
  };
  t.after(() => {
    if (!t.passed) console.log(`Bot output of the failed test, by time:\n${timeline.join('\n')}`);
  });
  let botKey;
  const boot = async () => {
    const started = output.length;
    child = spawn(process.execPath, ['--import', GUARD, BOT], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, ...common },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running = child;
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    exited = new Promise((resolve) => running.once('exit', resolve));
    await until(
      () => /Profile and DM inbox published/.test(output.slice(started)),
      `the bot to start: ${output.slice(started, started + 300)}`,
      20000,
    );
    botKey = nip19.decode(/: (npub1[a-z0-9]+)/.exec(output)[1]).data;
  };
  defer(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await boot();

  const person = () => {
    const key = generateSecretKey();
    const seen = new Set();
    const self = {
      key,
      replies: () =>
        [...chat.events.values()]
          .filter((e) => e.kind === 1059)
          .flatMap((event) => {
            try {
              return [unwrapEvent(event, key)];
            } catch {
              return [];
            }
          })
          .filter((m) => m.pubkey === botKey)
          .sort((a, b) => a.created_at - b.created_at),
      // Chat messages only, without answers to button presses.
      messages: (text) => self.replies().filter((m) => m.kind === 14 && text.test(m.content)),
      // Answers to button presses only.
      answers: (text) =>
        self.replies().filter((m) => m.kind === BOT_CONTROL_KIND && text.test(m.content)),
      say: (content) =>
        chat.emit(
          wrapEvent({ kind: 14, tags: [['p', botKey]], content, created_at: now() }, key, botKey),
        ),
      // Returns the event, for replaying it the way a relay could.
      // view: the answer on that card the button came from, if it was not the card itself.
      press: (card, data, view = card) => {
        const event = wrapEvent(
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
                  ...(view === card ? {} : { view: view.id }),
                  data,
                  expires: now() + 300,
                }),
              ],
            ],
            content: '',
          },
          key,
          botKey,
        );
        chat.emit(event);
        return event;
      },
      // The first reply matching that this person has not been given yet.
      next: async (text, what = String(text), timeout = 20000) => {
        const fresh = () => self.replies().find((m) => !seen.has(m.id) && text.test(m.content));
        await until(() => fresh(), what, timeout);
        const found = fresh();
        seen.add(found.id);
        return found;
      },
    };
    return self;
  };

  const page = async (who) => {
    who.say('/connect');
    const card = await who.next(/http:\/\/127\.0\.0\.1\S+#/, 'a link');
    const link = /http:\/\/127\.0\.0\.1\S+#\S+/.exec(card.content)[0];
    const opened = await post(port, '/c/session', { token: new URL(link).hash.slice(1) });
    assert.equal(opened.status, 200);
    return {
      cookie: opened.headers['set-cookie'][0].split(';')[0],
      csrf: opened.data.csrf,
      kinds: opened.data.kinds,
    };
  };
  const finish = async (who, browser, form) => {
    assert.equal(form.status, 200, JSON.stringify(form.data));
    const card = await who.next(/Your code/, 'a code');
    const code = /: ([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(card.content)[1];
    assert.equal((await post(port, '/c/code', { code }, browser)).status, 200);
    return who.next(/is connected/, 'connected');
  };
  let wallets = 0;
  return {
    dir,
    chat,
    walletRelay,
    lnbits,
    admin,
    person,
    page,
    output: () => output,
    state: () => JSON.parse(readFileSync(`${dir}/data/state.json`, 'utf8')),
    submit: (browser, body) => post(port, '/c/nwc', body, browser),
    connectLnbits: async (who, invoiceKey, label) => {
      const browser = await page(who);
      const form = await post(port, '/c/lnbits', { url: lnbits.url, invoiceKey, label }, browser);
      return finish(who, browser, form);
    },
    connectNwc: async (who, wallet, { spend = true, label } = {}) => {
      const browser = await page(who);
      const form = await post(
        port,
        '/c/nwc',
        { connection: wallet.uri, spend, acknowledged: spend, label },
        browser,
      );
      return finish(who, browser, form);
    },
    wallet: async (options = {}) => {
      const folder = options.dir ?? `${dir}/mock-${++wallets}`;
      const running = await startMockWallet({ dir: folder, relay: walletRelay.url, ...options });
      defer(t, () => running.close());
      return running;
    },
    boot,
    // Nothing is saved or said on the way out: as a power cut would leave it.
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
    },
  };
}
