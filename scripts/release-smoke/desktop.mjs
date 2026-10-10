// Drive the actual installed/extracted release app through Tauri's native WebDriver.
// Uses the release frontend and real signer; CSP and TLS checks stay enabled.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startRelay } from './relay.mjs';
import { probeCallMedia } from './call-media.mjs';
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
let appProcess;
const webview2 = process.env.ANAGRAM_WEBDRIVER_KIND === 'webview2';
const debugPort = Number(process.env.ANAGRAM_WEBVIEW2_DEBUG_PORT);
if (webview2 && (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535))
  throw new Error('Windows smoke tests require a dedicated WebView2 debugging port.');
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
  if (webview2) {
    appProcess = spawn(binary, [], { stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      appProcess.once('spawn', resolve);
      appProcess.once('error', reject);
    });
    await until(
      async () => {
        if (appProcess.exitCode !== null || appProcess.signalCode !== null)
          throw new Error(
            `Installed app exited before WebView2 became ready: ${appProcess.exitCode}`,
          );
        return fetch(`http://127.0.0.1:${debugPort}/json/version`, {
          signal: AbortSignal.timeout(2000),
        })
          .then(
            async (response) =>
              response.ok && Boolean((await response.json()).webSocketDebuggerUrl),
          )
          .catch(() => false);
      },
      'installed app WebView2 debugging endpoint',
      60000,
    );
  }
  const capabilities = webview2
    ? { browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${debugPort}` } }
    : { 'tauri:options': { application: binary } };
  const result = await request('/session', {
    capabilities: { alwaysMatch: capabilities },
  });
  session = result.sessionId;
  assert.ok(session, 'native WebDriver session');
  // Attached WebView2 sessions cannot resize the native host window. Use the
  // packaged app's default size there; Linux's driver owns its native window.
  if (!webview2)
    await request(`/session/${session}/window/rect`, { x: 0, y: 0, width: 1100, height: 800 });
}
async function quit() {
  try {
    if (session) await request(`/session/${session}`, undefined, 'DELETE');
  } finally {
    session = undefined;
    // Attached WebDriver sessions do not own the application process. Stop it
    // explicitly so the next open really checks a cold start and saved identity.
    const child = appProcess;
    appProcess = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once('exit', resolve));
    }
  }
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
  const launchStarted = Date.now();
  await open();
  await until(() => exists(testid('auth-open-login-button')), 'fresh release login screen');
  const loginReadyMs = Date.now() - launchStarted;
  console.log(`Packaged login ready in ${loginReadyMs}ms`);
  if (process.platform === 'linux' && loginReadyMs > 20000)
    throw new Error(`Linux packaged login took ${loginReadyMs}ms (limit 20000ms)`);
  // Configure only relay preferences before first login; all auth goes through UI/native storage.
  await execute(
    `localStorage.setItem('relays', JSON.stringify(arguments[0].map(url => ({url,read:true,write:true}))))`,
    [relay.url, 'ws://127.0.0.1:1/'],
  );
  await request(`/session/${session}/refresh`, {});
  await click(testid('auth-open-login-button'));
  await execute(`
    window.__callMediaSmoke = {result: null, video: null};
    (${probeCallMedia.toString()})(player => new Promise(resolve => {
      const rect = player.getBoundingClientRect();
      window.__callMediaSmoke.video = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        width: innerWidth, height: innerHeight};
      window.__callMediaSmoke.acceptVideo = resolve;
    })).then(result => window.__callMediaSmoke.result = result,
      error => window.__callMediaSmoke.result = {failure: String(error)});
  `);
  let media;
  let videoVerified = false;
  await until(
    async () => {
      const state = await execute(
        'return {result: window.__callMediaSmoke.result, video: window.__callMediaSmoke.video}',
      );
      if (state.video && !videoVerified && !state.result) {
        const screenshot = Buffer.from(
          await request(`/session/${session}/screenshot`, undefined, 'GET'),
          'base64',
        );
        await writeFile(`${output}/call-video.png`, screenshot);
        const png = PNG.sync.read(screenshot);
        const x = Math.floor((state.video.x * png.width) / state.video.width);
        const y = Math.floor((state.video.y * png.height) / state.video.height);
        const offset = (y * png.width + x) * 4;
        const [r, g, b, a] = png.data.subarray(offset, offset + 4);
        // Verify the actual decoded green test frame. WebKit's videoWidth and
        // frame counters can report zero even while the native sink displays it.
        if (
          a === 255 &&
          Math.abs(r - 36) < 20 &&
          Math.abs(g - 200) < 20 &&
          Math.abs(b - 106) < 20
        ) {
          videoVerified = true;
          await execute('window.__callMediaSmoke.acceptVideo()');
        }
      }
      media = state.result;
      return !!media;
    },
    'packaged call media probe',
    30000,
  );
  await writeFile(`${output}/call-media.json`, JSON.stringify(media, null, 2));
  assert.equal(media.failure, undefined, `packaged call media: ${media.failure}`);
  assert.equal(media.secure, true, 'packaged WebView must be a secure context');
  assert.equal(media.capture, true, 'packaged WebView must support microphone/camera capture');
  assert.equal(videoVerified, true, 'packaged WebView must display a decoded video frame');
  assert.deepEqual(
    media.decoded,
    ['audio/webm;codecs=opus', 'video/webm;codecs=vp8,opus'],
    `packaged WebView must record and stream call media: ${JSON.stringify(media)}`,
  );
  await execute('delete window.__callMediaSmoke');
  console.log('Passed: packaged call audio/video recording and streaming decode');
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
        loginReadyMs,
        checks: [
          'login',
          'call-audio-video-recording-and-playback',
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
  console.log(
    'Packaged release passed call media, login, relay read/write, reconnect and restart checks.',
  );
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
