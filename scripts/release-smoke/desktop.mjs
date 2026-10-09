// Drive the actual installed/extracted release app through Tauri's native WebDriver.
// Uses the release frontend and real signer; CSP and TLS checks stay enabled.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startRelay } from './relay.mjs';
import { DEFAULT_RELAYS } from '../../src/constants/relays.ts';

const binary = resolve(process.argv[2] || '');
const output = resolve(process.argv[3] || 'desktop-smoke-results');
if (!process.argv[2]) throw new Error('Pass the packaged app executable.');
if (process.env.ANAGRAM_DISPOSABLE_TEST !== '1')
  throw new Error('Use a disposable CI account or isolated user-data/keychain session.');
await mkdir(output, { recursive: true });
await rm(`${output}/result.json`, { force: true });
const relay = await startRelay();
let session;
const endpoint = process.env.TAURI_DRIVER_URL || 'http://127.0.0.1:4444';
async function request(path, data, method = 'POST') {
  // First WebView2 startup can outlast an ordinary WebDriver command. Let the
  // driver return its own startup error instead of cancelling it after 45s.
  const timeout = path === '/session' && method === 'POST' ? 180000 : 45000;
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => {
    throw new Error(`WebDriver ${method} ${path} failed (timeout ${timeout}ms): ${error.message}`, {
      cause: error,
    });
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(
      `WebDriver ${path}: ${result.value?.error || response.status}: ${result.value?.message || response.statusText}`,
    );
  return result.value;
}
const execute = (script, ...args) => request(`/session/${session}/execute/sync`, { script, args });
async function until(check, description, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      console.log(`Passed: ${description}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}
const testid = (id) => `[data-testid="${id}"]`;
const exists = (selector) => execute('return !!document.querySelector(arguments[0])', selector);
async function click(selector) {
  await until(
    () =>
      execute('const e=document.querySelector(arguments[0]); return !!e && !e.disabled', selector),
    `enabled ${selector}`,
  );
  // Native WebDriver clicks exercise the real webview event path.
  const element = await request(`/session/${session}/element`, {
    using: 'css selector',
    value: selector,
  });
  await request(`/session/${session}/element/${Object.values(element)[0]}/click`, {});
}
async function fill(selector, text) {
  await until(() => exists(selector), selector);
  const element = await request(`/session/${session}/element`, {
    using: 'css selector',
    value: selector,
  });
  const id = Object.values(element)[0];
  await request(`/session/${session}/element/${id}/value`, { text, value: [...text] });
}
const bodyIncludes = (text) =>
  execute('return document.body.innerText.includes(arguments[0])', text);
async function secureRelayRead() {
  // Exercise TLS/CSP from the packaged WebView itself. Read only: never EVENT.
  const result = await request(`/session/${session}/execute/async`, {
    args: [DEFAULT_RELAYS, relay.pubkey],
    script: `
      const [urls, pubkey, done] = arguments;
      const sockets = [], failures = [];
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const ws of sockets) { try { ws.close(); } catch {} }
        done(result);
      };
      const timer = setTimeout(() => finish({ ok: false, failures }), 20000);
      for (const url of urls) {
        try {
          const ws = new WebSocket(url);
          sockets.push(ws);
          ws.onopen = () => ws.send(JSON.stringify(['REQ', 'release-smoke', { kinds:[0], authors:[pubkey], limit:1 }]));
          ws.onmessage = event => {
            try {
              const message = JSON.parse(event.data);
              if (message[0] === 'EOSE' && message[1] === 'release-smoke') finish({ ok:true, url });
            } catch {}
          };
          ws.onerror = () => failures.push(url);
        } catch { failures.push(url); }
      }
    `,
  });
  await writeFile(`${output}/wss.json`, JSON.stringify(result, null, 2));
  assert.equal(
    result.ok,
    true,
    'at least one default WSS relay must return real EOSE in the packaged WebView',
  );
  console.log('Passed: secure WebView relay read');
}
async function open() {
  console.log('Starting packaged app WebDriver session');
  const capabilities =
    process.env.ANAGRAM_WEBDRIVER_KIND === 'webview2'
      ? { browserName: 'webview2', 'ms:edgeOptions': { binary } }
      : { 'tauri:options': { application: binary } };
  const result = await request('/session', {
    capabilities: { alwaysMatch: capabilities },
  });
  session = result.sessionId;
  assert.ok(session, 'native WebDriver session');
  await request(`/session/${session}/window/rect`, { x: 0, y: 0, width: 1100, height: 800 });
}
async function quit() {
  if (session) await request(`/session/${session}`, undefined, 'DELETE');
  session = undefined;
}
async function selfChat() {
  await click(`[data-testid="chat-item"][data-chat-public-key="${relay.pubkey}"]`);
  await until(() => exists('textarea[aria-label="Message"]'), 'self DM composer');
}
async function send(text) {
  await fill('textarea[aria-label="Message"]', text);
  await until(
    () =>
      execute(
        'return document.querySelector(arguments[0])?.value === arguments[1]',
        'textarea[aria-label="Message"]',
        text,
      ),
    'typed message',
  );
  // Enter uses the composer's normal keyboard handler in the native WebView.
  await fill('textarea[aria-label="Message"]', '\uE007');
  await until(() => bodyIncludes(text), 'optimistic message rendered');
  await until(
    () => relay.received.includes(text),
    'signed encrypted message acknowledged by relay',
  );
}
try {
  await open();
  await until(() => exists(testid('auth-open-login-button')), 'fresh release login screen');
  // Configure only relay preferences before first login; all auth goes through UI/native storage.
  await execute(
    `localStorage.setItem('relays', JSON.stringify(arguments[0].map(url => ({url,read:true,write:true}))))`,
    [relay.url, 'ws://127.0.0.1:1/'],
  );
  await request(`/session/${session}/refresh`, {});
  await click(testid('auth-open-login-button'));
  await click(testid('auth-open-key-button'));
  await fill(testid('auth-private-key-input'), relay.nsec);
  await click(testid('auth-login-button'));
  await until(
    () =>
      execute(
        'const e=[...document.querySelectorAll(".onboarding .relay")].find(e=>e.textContent.includes(arguments[0])); return !!e?.querySelector("[aria-label=Connected]")',
        relay.url,
      ),
    'first-login relay connected',
  );
  await click(testid('auth-onboarding-relays-next-button'));
  await until(() => bodyIncludes('Release smoke test'), 'profile received through relay');
  assert.ok(relay.stats.eose > 0, 'real relay EOSE received');
  await click(testid('auth-onboarding-continue-button'));
  await until(
    async () =>
      (await exists(testid('auth-notifications-skip'))) ||
      (await exists('button[aria-label="settings"]')),
    'notification choice or chats',
  );
  if (await exists(testid('auth-notifications-skip')))
    await click(testid('auth-notifications-skip'));
  await selfChat();
  await send('packaged-release-outbound');
  relay.deliver('packaged-release-inbound');
  await until(() => bodyIncludes('packaged-release-inbound'), 'incoming message rendered');
  const requests = relay.stats.requests;
  relay.disconnect();
  await until(
    () => relay.stats.requests > requests,
    'relay subscriptions restored after disconnect',
  );
  relay.deliver('packaged-release-reconnected');
  await until(
    () => bodyIncludes('packaged-release-reconnected'),
    'incoming message after reconnect',
  );
  await quit();
  await open();
  await until(
    () => exists('button[aria-label="settings"]'),
    'saved native login restored after process restart',
  );
  await selfChat();
  await until(() => bodyIncludes('packaged-release-outbound'), 'saved message after restart');
  await send('packaged-release-after-restart');
  await secureRelayRead();
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        passed: true,
        binary,
        checks: [
          'login',
          'first-relay',
          'profile-read',
          'signed-DM-publish',
          'incoming-DM',
          'reconnect',
          'cold-restart',
          'secure-relay-read',
        ],
        relay: relay.stats,
      },
      null,
      2,
    ),
  );
  console.log('Packaged release passed login, relay read/write, reconnect and restart checks.');
} finally {
  await writeFile(
    `${output}/relay.json`,
    JSON.stringify({ ...relay.stats, received: relay.received }, null, 2),
  );
  if (session) {
    await execute(
      'return {url: location.href, alerts:[...document.querySelectorAll("[role=alert]")].map(e=>e.textContent), inputs:[...document.querySelectorAll("textarea")].map(e=>({value:e.value, disabled:e.disabled}))}',
    )
      .then((data) => writeFile(`${output}/state.json`, JSON.stringify(data, null, 2)))
      .catch(() => {});
    await request(`/session/${session}/screenshot`, undefined, 'GET')
      .then((png) => writeFile(`${output}/screen.png`, Buffer.from(png, 'base64')))
      .catch(() => {});
    await execute('return document.body.innerText')
      .then((text) => writeFile(`${output}/ui.txt`, text))
      .catch(() => {});
  }
  await quit().catch(() => {});
  await relay.close();
}
