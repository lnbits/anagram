// The self-service connection page and its binding to a Nostr account.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey, nip19 } from 'nostr-tools';
import { CONNECT_TEXT } from '../commands.js';
import { ConnectService } from '../connect.js';
import { PAGE, SCRIPT, STYLE } from '../connect-page.js';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { LNbitsClient } from '../lnbits.js';
import { Origins } from '../net-guard.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { keyboardFromTags } from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  mallory,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const ADMIN_KEY = 'ad000000000000000000000000000003';
const PUBLIC = 'https://connect.test';
const HOST = 'connect.test';
const A = getPublicKey(alice);
const B = getPublicKey(bob);

async function fixture(t, { options = {}, allowed } = {}) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 42_000, payments: [] },
    [ADMIN_KEY]: { name: 'spend', balance: 1, payments: [], admin: true },
  });
  defer(t, () => server.close());
  const root = tempDir(t, 'connect');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 500 });
  const origins = new Origins({
    defaultUrl: server.url,
    allowHttp: true,
    allowed,
    timeoutMs: 500,
    defaultClient: lnbits,
  });
  const registry = new Registry({
    store: db,
    keyring,
    ledger,
    clientFor: ({ origin }) => origins.client(origin),
    maxPerOwner: options.maxPerOwner ?? 5,
  });
  const logs = [];
  let bot;
  const service = new ConnectService({
    publicUrl: PUBLIC,
    port: 0,
    origins,
    registry,
    sendCode: (owner, details) => bot.sendConnectCode(owner, details),
    finished: (owner, connection) => bot.connectFinished(owner, connection),
    log: (line) => logs.push(line),
    ...options,
  });
  const ctx = setup(t, { wallets: registry, lnbits, connect: service });
  bot = ctx.bot;
  bot.flush = async () => {}; // messages stay in the outbox, where these tests read them
  const port = await service.listen();
  defer(t, () => service.close());
  defer(t, () => db.close());

  const call = (path, { method = 'POST', body = {}, cookie, csrf, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = method === 'POST' ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            host: HOST,
            ...(method === 'POST' ? { origin: PUBLIC, 'content-type': 'application/json' } : {}),
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            resolve({ status: res.statusCode, headers: res.headers, data, text });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  // A person's browser, from the link in their chat.
  const browser = async (link) => {
    const token = new URL(link).hash.slice(1);
    const opened = await call('/c/session', { body: { token } });
    if (opened.status !== 200) return { opened };
    const cookie = opened.headers['set-cookie'][0].split(';')[0];
    const send = (path, body, extra = {}) =>
      call(path, { body, cookie, csrf: opened.data.csrf, ...extra });
    return { opened, cookie, csrf: opened.data.csrf, send };
  };
  const linkFor = (owner) => service.issue(owner);
  const lastCode = (key) => {
    const text = repliesFor(bot, key)
      .filter((r) => /Your code/.test(r.content))
      .at(-1)?.content;
    return /: ([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(text ?? '')?.[1];
  };
  return {
    server,
    registry,
    service,
    bot,
    logs,
    db,
    call,
    browser,
    linkFor,
    lastCode,
    ...ctx,
    dbFile: db.file,
    root,
  };
}
const lnbitsForm = (server, invoiceKey = ALICE_KEY, label = 'Savings') => ({
  url: server.url,
  invoiceKey,
  label,
});

test('the whole flow: link, page, key, code in DM, connected, confirmed in chat', async (t) => {
  const { server, registry, browser, bot, db, lastCode, dir, logs, root } = await fixture(t);
  await sendDM(bot, alice, '/connect');
  const card = repliesFor(bot, alice).at(-1);
  assert.match(card.content, /Open this page/);
  const button = keyboardFromTags(card.tags).inline_keyboard[0][0];
  assert.equal(button.text, 'Open connection page');
  assert.match(button.url, /^https:\/\/connect\.test\/c#[\w-]{40,}$/);
  assert.equal(bot.state.outbox.length, 1, 'no copy of the link for the bot');

  const page = await browser(button.url);
  assert.equal(page.opened.status, 200);
  assert.equal(page.opened.data.account, nip19.npubEncode(A));
  assert.equal(registry.linked(A), false, 'nothing yet');

  const form = await page.send('/c/lnbits', lnbitsForm(server));
  assert.equal(form.status, 200);
  assert.equal(form.data.name, 'Savings');
  assert.equal(registry.linked(A), false, 'still nothing: the code is not confirmed');
  assert.equal(db.all().length, 0, 'nothing on disk');
  await settle(bot);
  const code = lastCode(alice);
  assert.ok(code, 'the code came by DM');
  assert.ok(!form.text.includes(code), 'never on the page itself');

  const done = await page.send('/c/code', { code });
  assert.equal(done.status, 200, done.text);
  assert.equal(registry.keyFor(A), ALICE_KEY);
  assert.equal(db.active()[0].source, 'self');
  await settle(bot);
  const confirmed = repliesFor(bot, alice).at(-1);
  assert.match(confirmed.content, /^Savings is connected \(receive only\)/);
  assert.ok(keyboardFromTags(confirmed.tags).inline_keyboard.length >= 1);

  // New link times apply, and commands now work.
  await sendDM(bot, alice, '/balance');
  assert.match(repliesFor(bot, alice).at(-1).content, /Balance \(Savings\): 2,100 sats/);

  const everything = [
    logs.join('\n'),
    readFileSync(`${dir}/state.json`, 'utf8'),
    readFileSync(join(root, DB_FILE)).toString('latin1'),
    JSON.stringify(repliesFor(bot, alice)),
    form.text,
    done.text,
  ].join('\n');
  assert.ok(!everything.includes(ALICE_KEY), 'the key is nowhere readable');
});

test('a link works once and expires', async (t) => {
  let time = Date.now();
  const { browser, linkFor } = await fixture(t, { options: { clock: () => time } });
  const link = linkFor(A);
  assert.equal((await browser(link)).opened.status, 200);
  const again = await browser(link);
  assert.equal(again.opened.status, 401);
  assert.match(again.opened.data.message, /expired or was already used/);

  const late = linkFor(A);
  time += 11 * 60000;
  assert.equal((await browser(late)).opened.status, 401);
  assert.equal((await browser('https://connect.test/c#nonsense')).opened.status, 401);
});

test('links are limited per person; only the bot can ask for one', async (t) => {
  const { service, call } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.ok(service.issue(A));
  assert.equal(service.issue(A), null);
  assert.ok(service.issue(B), 'someone else is unaffected');
  const routes = await call('/c/issue', { body: { owner: A } });
  assert.equal(routes.status, 404);
});

test('a leaked link gives no connection: the code goes to the account, not the browser', async (t) => {
  const { server, browser, linkFor, registry, bot, lastCode } = await fixture(t);
  // The thief got to Alice's link first and tries to attach their own wallet to her account.
  const thief = await browser(linkFor(A));
  const form = await thief.send('/c/lnbits', lnbitsForm(server, BOB_KEY, 'Thief'));
  assert.equal(form.status, 200);
  await settle(bot);
  assert.ok(lastCode(alice), 'Alice sees an unexpected code');
  for (const guess of ['AAAA-AAAA', '0000-0000', '', 'X'])
    assert.equal((await thief.send('/c/code', { code: guess })).status, 400);
  assert.equal(registry.linked(A), false);
  assert.equal((await thief.send('/c/code', { code: '1111-1111' })).status, 429, 'five tries');
  // The real code does not help afterwards: that session is over.
  assert.equal((await thief.send('/c/code', { code: lastCode(alice) })).status, 401);
  assert.equal(registry.linked(A), false);
});

test("someone else's link: the code goes to them, and neither side can finish alone", async (t) => {
  const { server, browser, linkFor, registry, bot, lastCode } = await fixture(t);
  // Mallory sends Alice a link for Mallory's account. The page says whose account it is.
  const page = await browser(linkFor(getPublicKey(mallory)));
  assert.equal(page.opened.data.account, nip19.npubEncode(getPublicKey(mallory)));
  assert.equal((await page.send('/c/lnbits', lnbitsForm(server))).status, 200);
  await settle(bot);
  assert.equal(lastCode(alice), undefined, 'Alice gets no code');
  assert.ok(lastCode(mallory), 'it went to the account named on the page');
  assert.equal(registry.linked(getPublicKey(mallory)), false);
  assert.match(PAGE, /Only continue if that is <strong>your own<\/strong> account/);
});

test('a code belongs to one session and cannot be used in another', async (t) => {
  const { server, browser, linkFor, registry, bot, lastCode } = await fixture(t);
  const first = await browser(linkFor(A));
  await first.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  const code = lastCode(alice);
  const second = await browser(linkFor(A));
  assert.equal((await second.send('/c/code', { code })).status, 400, 'no pending wallet here');
  await second.send('/c/lnbits', lnbitsForm(server, BOB_KEY));
  assert.equal((await second.send('/c/code', { code })).status, 400);
  assert.equal(registry.linked(A), false);
  assert.equal((await first.send('/c/code', { code })).status, 200);
  assert.equal(registry.keyFor(A), ALICE_KEY, 'the wallet of the session that got that code');
});

test('codes expire, and are forgiving only about how they are typed', async (t) => {
  let time = Date.now();
  const { server, browser, linkFor, registry, bot, lastCode } = await fixture(t, {
    options: { clock: () => time },
  });
  const late = await browser(linkFor(A));
  await late.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  time += 6 * 60000;
  const expired = await late.send('/c/code', { code: lastCode(alice) });
  assert.equal(expired.status, 400);
  assert.match(expired.data.message, /expired/);
  assert.equal(registry.linked(A), false);

  const page = await browser(linkFor(A));
  await page.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  const code = lastCode(alice);
  const typed = ` ${code.toLowerCase().replace('-', ' ')} `;
  assert.equal((await page.send('/c/code', { code: typed })).status, 200);
  assert.equal(registry.linked(A), true);
});

test('cross-site requests and other hosts are refused', async (t) => {
  const { call, browser, linkFor, server, registry } = await fixture(t);
  const page = await browser(linkFor(A));
  const form = lnbitsForm(server);
  const refused = [
    ['no CSRF token', { cookie: page.cookie }],
    ['wrong CSRF token', { cookie: page.cookie, csrf: 'x'.repeat(43) }],
    [
      'another site',
      { cookie: page.cookie, csrf: page.csrf, headers: { origin: 'https://evil.example' } },
    ],
    ['no origin', { cookie: page.cookie, csrf: page.csrf, headers: { origin: '' } }],
    [
      'form post',
      { cookie: page.cookie, csrf: page.csrf, headers: { 'content-type': 'text/plain' } },
    ],
    [
      'fetch metadata',
      { cookie: page.cookie, csrf: page.csrf, headers: { 'sec-fetch-site': 'cross-site' } },
    ],
  ];
  for (const [name, options] of refused)
    assert.equal((await call('/c/lnbits', { body: form, ...options })).status, 403, name);
  assert.equal((await call('/c/lnbits', { body: form })).status, 401, 'no session');
  // DNS rebinding: the page reached under another name.
  for (const host of ['127.0.0.1', 'evil.example', 'connect.test:8443'])
    assert.equal((await call('/c', { method: 'GET', headers: { host } })).status, 421, host);
  assert.equal(registry.linked(A), false);
});

test('the page is locked down: headers, cookie, no HTML from data, no browser storage', async (t) => {
  const { call, browser, linkFor } = await fixture(t);
  const page = await call('/c', { method: 'GET' });
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['strict-transport-security'], /max-age/);
  assert.ok(!/<script>|onclick=|style=/.test(page.text), 'no inline script or style');

  const open = await browser(linkFor(A));
  const cookie = open.opened.headers['set-cookie'][0];
  assert.match(cookie, /^__Host-alw=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
    assert.ok(cookie.includes(attribute), attribute);

  assert.match(
    STYLE,
    /#account, #account-again \{ overflow-wrap: anywhere; \}/,
    'a long npub wraps',
  );
  assert.ok(!/innerHTML|outerHTML|insertAdjacent|document\.write|eval\(/.test(SCRIPT));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(SCRIPT));
  assert.match(SCRIPT, /history\.replaceState/, 'the token leaves the address bar');
  assert.equal(
    (await call('/c/app.js', { method: 'GET' })).headers['content-type'].split(';')[0],
    'text/javascript',
  );
  assert.equal((await call('/nope', { method: 'GET' })).status, 404);
  assert.equal((await call('/c', { method: 'PUT' })).status, 405);
});

test('admin keys, bad keys and bad servers are refused and never kept', async (t) => {
  const { browser, linkFor, server, registry, bot, db, logs, lastCode } = await fixture(t);
  const page = await browser(linkFor(A));
  const admin = await page.send('/c/lnbits', lnbitsForm(server, ADMIN_KEY));
  assert.equal(admin.status, 400);
  assert.match(admin.data.message, /Admin key.*not saved/s);
  const wrong = await page.send('/c/lnbits', lnbitsForm(server, 'e'.repeat(32)));
  assert.match(wrong.data.message, /did not accept/);
  const shaped = await page.send('/c/lnbits', lnbitsForm(server, 'short'));
  assert.match(shaped.data.message, /32 letters/);
  await settle(bot);
  assert.equal(lastCode(alice), undefined, 'no code for any of these');
  assert.equal(registry.linked(A), false);
  assert.equal(db.all().length, 0);
  for (const secret of [ADMIN_KEY, 'e'.repeat(32)]) {
    assert.ok(!logs.join('\n').includes(secret));
    assert.ok(!JSON.stringify([admin.data, wrong.data]).includes(secret));
  }
});

test('addresses that could reach a private network all get the same answer', async (t) => {
  const { browser, linkFor, server } = await fixture(t, { allowed: '*' });
  const before = server.requests.length;
  const page = await browser(linkFor(A));
  const answers = new Set();
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254',
    'https://localhost',
    'https://127.0.0.1:22',
    'https://[::1]',
    'https://printer.local',
  ]) {
    const answer = await page.send('/c/lnbits', { url, invoiceKey: ALICE_KEY });
    assert.equal(answer.status, 400, url);
    answers.add(answer.data.message);
  }
  assert.equal(answers.size, 1, 'nothing to tell them apart');
  assert.equal(server.requests.length, before);
});

test('by default only the operator’s server can be used', async (t) => {
  const { browser, linkFor } = await fixture(t);
  const page = await browser(linkFor(A));
  const answer = await page.send('/c/lnbits', {
    url: 'https://other.example',
    invoiceKey: ALICE_KEY,
  });
  assert.match(answer.data.message, /does not connect to that LNbits server/);
});

test('attempts per session are limited, and oversized or malformed requests fail cleanly', async (t) => {
  const { browser, linkFor, server, call } = await fixture(t);
  const page = await browser(linkFor(A));
  for (let i = 0; i < 6; i++)
    assert.equal((await page.send('/c/lnbits', lnbitsForm(server, 'bad'))).status, 400);
  assert.equal((await page.send('/c/lnbits', lnbitsForm(server, 'bad'))).status, 429);
  assert.equal((await page.send('/c/lnbits', lnbitsForm(server))).status, 401, 'session over');

  const second = await browser(linkFor(A));
  const huge = await second
    .send('/c/lnbits', { url: 'x'.repeat(10000) })
    .catch(() => ({ status: 'closed' }));
  assert.ok([400, 'closed'].includes(huge.status));
  assert.equal((await call('/c/session', { body: [] })).status, 400);
});

test('a flood of wrong tokens cannot lock anyone out', async (t) => {
  const { call, linkFor, browser } = await fixture(t);
  for (let i = 0; i < 100; i++)
    assert.equal((await call('/c/session', { body: { token: `wrong-${i}` } })).status, 401);
  assert.equal((await browser(linkFor(A))).opened.status, 200);
});

test('strangers: limits come before any write, and they leave nothing behind', async (t) => {
  const { bot } = await fixture(t);
  let saves = 0;
  const save = bot.save.bind(bot);
  bot.save = () => {
    saves++;
    save();
  };
  for (let i = 0; i < 40; i++) await bot.directMessage(dm(mallory, '/help', bot), { tags: [] });
  await settle(bot);
  assert.equal(repliesFor(bot, mallory).length, 5, 'five answers an hour for one person');
  const seen = Object.keys(bot.state.seen).length;
  const writes = saves;
  for (let i = 0; i < 40; i++) await bot.directMessage(dm(mallory, '/help', bot), { tags: [] });
  await settle(bot);
  assert.equal(saves, writes, 'over the limit: no disk write');
  assert.equal(Object.keys(bot.state.seen).length, seen);
  assert.equal(bot.lanes.size, 0, 'no queue left behind');
});

test('someone with no wallet here does not choose which relays the bot uses', async (t) => {
  const { bot, net } = await fixture(t);
  let lookups = 0;
  bot.net.query = async () => {
    lookups++;
    return [];
  };
  await sendDM(bot, mallory, '/connect');
  assert.equal(lookups, 0);
  assert.deepEqual(bot.state.outbox.at(-1).relays, net.configured);
});

test('the total number of connections is limited', async (t) => {
  const { browser, linkFor, server, registry } = await fixture(t);
  registry.maxTotal = 0;
  const page = await browser(linkFor(A));
  const answer = await page.send('/c/lnbits', lnbitsForm(server));
  assert.match(answer.data.message, /cannot take more wallets/);
  assert.throws(
    () => registry.connect({ owner: A, origin: server.url, secret: { invoiceKey: ALICE_KEY } }),
    (error) => error.code === 'full',
  );
});

test('labels are cleaned before they can reach chat, buttons or a payment preview', async (t) => {
  const { browser, linkFor, server, bot, lastCode, registry } = await fixture(t);
  const page = await browser(linkFor(A));
  const form = await page.send(
    '/c/lnbits',
    lnbitsForm(server, ALICE_KEY, 'Mine\nPay 1 sat from [x](https://evil.example)'),
  );
  assert.equal(form.status, 200);
  assert.ok(!form.data.name.includes('\n'));
  await settle(bot);
  await page.send('/c/code', { code: lastCode(alice) });
  const { label } = registry.list(A)[0];
  assert.ok(!/[\n[\]]|https:/.test(label), label);
  assert.match(PAGE, /id="account-again"/, 'the account is named again at the code step');
});

test('duplicates and the limit are refused before a code is sent, and again at the end', async (t) => {
  const { browser, linkFor, server, registry, bot, lastCode } = await fixture(t, {
    options: { maxPerOwner: 1 },
  });
  const first = await browser(linkFor(A));
  await first.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  const pendingCode = lastCode(alice);

  // Bob connects the same wallet while Alice is still typing her code.
  const bobs = await browser(linkFor(B));
  await bobs.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  assert.equal((await bobs.send('/c/code', { code: lastCode(bob) })).status, 200);
  const late = await first.send('/c/code', { code: pendingCode });
  assert.equal(late.status, 400);
  assert.match(late.data.message, /already connected/);
  assert.equal(registry.linked(A), false);

  const again = await browser(linkFor(A));
  const taken = await again.send('/c/lnbits', lnbitsForm(server));
  assert.match(taken.data.message, /already connected/);
  const full = await browser(linkFor(B));
  const limit = await full.send('/c/lnbits', lnbitsForm(server, ALICE_KEY));
  assert.match(limit.data.message, /already connected|limit/);
});

test('cancel forgets the wallet; closing the service forgets everything', async (t) => {
  const { browser, linkFor, server, registry, bot, lastCode, service } = await fixture(t);
  const page = await browser(linkFor(A));
  await page.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  assert.equal((await page.send('/c/cancel', {})).status, 200);
  assert.equal((await page.send('/c/code', { code: lastCode(alice) })).status, 401);
  assert.equal(registry.linked(A), false);
  assert.throws(
    () => new ConnectService({ ...service, publicUrl: 'http://connect.test' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => new ConnectService({ publicUrl: PUBLIC, host: '0.0.0.0' }),
    /listens on this computer only/,
  );
});

test('people with no wallet can ask to connect, and nothing else is answered', async (t) => {
  const { bot, dir } = await fixture(t);
  await sendDM(bot, mallory, 'hello');
  await sendDM(bot, mallory, '/balance');
  assert.deepEqual(repliesFor(bot, mallory), []);
  await sendDM(bot, mallory, '/help');
  assert.match(repliesFor(bot, mallory).at(-1).content, /send \/connect/);
  await sendDM(bot, mallory, '/connect');
  assert.match(repliesFor(bot, mallory).at(-1).content, /Open this page/);
  await sendDM(bot, mallory, `my key is ${ALICE_KEY}`);
  assert.match(repliesFor(bot, mallory).at(-1).content, /looks like it contains a wallet key/);
  assert.ok(!readFileSync(`${dir}/state.json`, 'utf8').includes(ALICE_KEY));
  assert.ok(!Object.keys(bot.state.cards).length, 'no card kept for a stranger');
});

test('old messages from strangers are not answered, and the volume is bounded', async (t) => {
  const { bot } = await fixture(t);
  const old = Math.floor(Date.now() / 1000) - 600;
  await bot.directMessage(dm(mallory, '/connect', bot, [], old), { tags: [] });
  await settle(bot);
  assert.deepEqual(repliesFor(bot, mallory), []);
  bot.strangers = Array(120).fill(Math.floor(Date.now() / 1000));
  await sendDM(bot, mallory, '/connect');
  assert.deepEqual(repliesFor(bot, mallory), []);
});

test('with the service off, strangers are ignored as before and /connect says why', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, mallory, '/connect');
  assert.deepEqual(repliesFor(bot, mallory), []);
  await sendDM(bot, alice, '/connect');
  assert.match(repliesFor(bot, alice).at(-1).content, /not available/);
});

test('reconnect after disconnect through the page: old menus stay dead', async (t) => {
  const { browser, linkFor, server, registry, bot, lastCode } = await fixture(t);
  const page = await browser(linkFor(A));
  await page.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  await page.send('/c/code', { code: lastCode(alice) });
  const first = registry.lease(A);
  await sendDM(bot, alice, '/balance');
  registry.revoke(first.id, 'user');
  const again = await browser(linkFor(A));
  assert.equal((await again.send('/c/lnbits', lnbitsForm(server))).status, 200, 'allowed again');
  await settle(bot);
  await again.send('/c/code', { code: lastCode(alice) });
  assert.notEqual(registry.lease(A).ref, first.ref);
  assert.equal(registry.menuState(A, first.ref), 'stale');
});

test('the wallets card offers a new connection', async (t) => {
  const { browser, linkFor, server, bot, lastCode } = await fixture(t);
  const page = await browser(linkFor(A));
  await page.send('/c/lnbits', lnbitsForm(server));
  await settle(bot);
  await page.send('/c/code', { code: lastCode(alice) });
  await settle(bot);
  await sendDM(bot, alice, '/wallets');
  const card = repliesFor(bot, alice).at(-1);
  assert.ok(
    keyboardFromTags(card.tags)
      .inline_keyboard.flat()
      .some((b) => b.callback_data === 'w:new'),
  );
  await sendDM(bot, alice, '/help');
  assert.match(repliesFor(bot, alice).at(-1).content, /\/connect — /);
});

test('the limit on links says how long to wait, and frees a link an hour after it was issued', async (t) => {
  let time = 1_000_000_000_000;
  const service = new ConnectService({
    publicUrl: PUBLIC,
    registry: {},
    origins: {},
    clock: () => time,
    sendCode: async () => {},
    finished: () => {},
  });
  t.after(() => service.close?.());
  const owner = 'a'.repeat(64);
  assert.equal(service.linkWait(owner), undefined);
  for (let n = 0; n < 5; n++) {
    assert.ok(service.issue(owner));
    time += 60000;
  }
  assert.equal(service.issue(owner), null);
  assert.equal(service.linkWait(owner), 55);
  assert.equal(service.linkWait('b'.repeat(64)), undefined, 'another account is not affected');
  time += 55 * 60000;
  assert.ok(service.issue(owner), 'an hour after the first');
  assert.equal(service.issue(owner), null, 'and one only');
  assert.equal(
    CONNECT_TEXT.limit(1),
    'You have asked for several links recently. Please try again in about 1 minute.',
  );
  assert.match(CONNECT_TEXT.limit(undefined), /in a while\.$/);
});
