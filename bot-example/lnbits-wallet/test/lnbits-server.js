// Local LNbits stand-in on 127.0.0.1, shaped like LNbits v1.6.2 (recorded in the M0 spike
// and the M3 investigation). wallets: { [invoiceKey]: { name, balance (msat), payments,
// admin?: true } }. Per-request behaviour: server.next = (record, req, res) => 'handled'.
// Invoice creation behaviour: server.create = one of
//   'ok'            store the invoice and answer 201 (default)
//   'hang'          never answer and store nothing
//   'store-hang'    store the invoice, then never answer (accepted, outcome unknown)
//   'store-drop'    store the invoice, then drop the connection
//   'store-later'   never answer; store the invoice after server.storeDelayMs
//   'wrong-amount'  store and return an invoice for a different amount
//   'slow'          store the invoice, answer 201 after server.storeDelayMs
//   520 | 400 | 500 an error status; 520 and 400 store nothing, 500 stores nothing either
// server.ignoreFilters = true imitates LNbits ignoring an unknown filter: every payment.
// Payment events: /api/v1/ws/{channel}, like LNbits. server.settle()
// and server.pay() change a wallet and push frames; server.push() sends anything;
// server.wsRefuse refuses new sockets; server.dropSockets() cuts the open ones.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
export const fakeBolt11 = (sats) =>
  `lnbc${sats}0n1${Array.from(randomBytes(220), (b) => BECH32[b % 32]).join('')}`;

export const payment = ({
  amount,
  memo = '',
  time = '2026-10-31T18:04:43.215755+00:00',
  fee = 0,
  status = 'success',
  hash = 'f5'.repeat(32),
  bolt11 = 'lnbc1...',
  external_id = null,
  updated = time,
}) => ({
  checking_id: hash,
  payment_hash: hash,
  wallet_id: 'w'.repeat(32),
  amount,
  fee,
  bolt11,
  payment_request: bolt11,
  fiat_provider: null,
  status,
  memo,
  expiry: time,
  webhook: null,
  webhook_status: null,
  preimage: '0'.repeat(64),
  tag: null,
  extension: null,
  time,
  created_at: time,
  updated_at: updated,
  labels: [],
  extra: {},
  external_id,
});

export async function lnbitsServer(wallets = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => handle(req, res, raw));
  });
  const json = (res, status, body) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  function store(wallet, body, sats = body.amount) {
    const invoice = payment({
      amount: sats * 1000,
      memo: body.memo || 'LNbits',
      status: 'pending',
      hash: randomBytes(32).toString('hex'),
      bolt11: fakeBolt11(sats),
      external_id: body.external_id ?? null,
      time: new Date().toISOString(),
    });
    invoice.expiry = new Date(Date.now() + (body.expiry ?? 3600) * 1000).toISOString();
    wallet.payments.push(invoice);
    fixture.created.push(invoice);
    return invoice;
  }
  // GET /api/v1/payments/{hash}, as in LNbits v1.6.2, with "details" only for the wallet that owns
  // the payment. Asking settles what the funding source knows
  // (fixture.funding) and marks an expired incoming invoice failed, labelled "expired".
  function confirm(res, key, hash) {
    const owner = Object.entries(wallets).find(([, w]) =>
      w.payments.some((p) => p.payment_hash === hash),
    );
    if (!owner) return json(res, 404, { detail: 'Payment does not exist.' });
    const row = owner[1].payments.find((p) => p.payment_hash === hash);
    if (row.status === 'pending') {
      if (Date.parse(row.expiry) < Date.now()) {
        row.status = 'failed';
        row.labels = [...row.labels, 'expired'];
      } else {
        const told = fixture.funding?.(row);
        if (told) row.status = told;
      }
    }
    return json(res, 200, {
      paid: row.status === 'success',
      status: row.status,
      ...(owner[0] === key ? { details: row } : {}),
    });
  }
  function handle(req, res, raw) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = req.headers['x-api-key'];
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      key,
      body,
    };
    requests.push(record);
    if (fixture.next?.(record, req, res) === 'handled') return;
    const single = /^\/api\/v1\/payments\/([a-f0-9]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && single) return confirm(res, key, single[1]);
    if (!key) return json(res, 401, { detail: 'No Api Key provided.' });
    const wallet = wallets[key];
    if (!wallet) return json(res, 404, { detail: 'Wallet not found.' });
    if (req.method === 'GET' && url.pathname === '/api/v1/wallet')
      return json(res, 200, {
        name: wallet.name,
        balance: wallet.balance,
        ...(wallet.admin ? { id: 'w'.repeat(32) } : {}),
      });
    if (req.method === 'GET' && url.pathname === '/api/v1/payments') {
      let list = wallet.payments.filter((p) => p.status !== 'failed');
      if (url.searchParams.get('status'))
        list = list.filter((p) => p.status === url.searchParams.get('status'));
      list = [...list].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(
        res,
        200,
        list.slice(offset, offset + Number(url.searchParams.get('limit') ?? 20)),
      );
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/payments/paginated') {
      const q = url.searchParams;
      let list = [...wallet.payments];
      if (!fixture.ignoreFilters) {
        if (q.has('external_id')) list = list.filter((p) => p.external_id === q.get('external_id'));
        if (q.has('status')) list = list.filter((p) => p.status === q.get('status'));
        if (q.has('amount[gt]')) list = list.filter((p) => p.amount > Number(q.get('amount[gt]')));
      }
      if (q.get('sortby') === 'updated_at')
        list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 10);
      return json(res, 200, { data: list.slice(offset, offset + limit), total: list.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/payments') {
      if (body?.out !== false)
        return json(res, 403, { detail: 'Invoice (or Admin) key required.' });
      const mode = fixture.create;
      if (mode === 520)
        return json(res, 520, { detail: 'Invoice amount too high.', status: 'failed' });
      if (mode === '520-proxy') {
        // A proxy's 520 after LNbits stored the invoice: not LNbits' own InvoiceError body.
        store(wallet, body);
        res.writeHead(520, { 'content-type': 'text/html' });
        return res.end('<html>520: Web server is returning an unknown error</html>');
      }
      if (mode === 400) return json(res, 400, { detail: 'invalid' });
      if (mode === 500) return json(res, 500, { detail: 'Internal Server Error' });
      if (mode === 'hang') return;
      if (mode === 'store-hang') return void store(wallet, body);
      if (mode === 'store-drop') {
        store(wallet, body);
        return req.socket.destroy();
      }
      if (mode === 'store-later') {
        setTimeout(() => store(wallet, body), fixture.storeDelayMs);
        return;
      }
      if (mode === 'wrong-amount') return json(res, 201, store(wallet, body, body.amount + 1));
      if (mode === 'slow') {
        const invoice = store(wallet, body);
        setTimeout(() => json(res, 201, invoice), fixture.storeDelayMs);
        return;
      }
      return json(res, 201, store(wallet, body));
    }
    return json(res, 404, { detail: 'Not Found' });
  }
  const wss = new WebSocketServer({ noServer: true });
  const channels = new Map();
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/api\/v1\/ws\/([^/]+)$/.exec(new URL(req.url, 'http://127.0.0.1').pathname);
    fixture.upgrades++;
    if (!match || fixture.wsRefuse) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (fixture.wsCloseOnOpen) return ws.close();
      const id = decodeURIComponent(match[1]);
      if (!channels.has(id)) channels.set(id, new Set());
      channels.get(id).add(ws);
      ws.on('close', () => channels.get(id)?.delete(ws));
      ws.on('error', () => {});
    });
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixture = {
    url: `http://127.0.0.1:${server.address().port}/`,
    wallets,
    requests,
    created: [],
    next: undefined,
    create: 'ok',
    storeDelayMs: 300,
    ignoreFilters: false,
    get posts() {
      return requests.filter((r) => r.method === 'POST');
    },
    upgrades: 0,
    wsRefuse: false,
    wsCloseOnOpen: false,
    open: (channel) => channels.get(channel)?.size ?? 0,
    push(channel, text, times = 1) {
      for (let i = 0; i < times; i++) for (const ws of channels.get(channel) ?? []) ws.send(text);
    },
    dropSockets() {
      for (const set of channels.values()) for (const ws of set) ws.terminate();
    },
    // An incoming payment settles now, like an internal LNbits payment: two identical frames.
    settle(key, { sats, memo = '', frames = 2, createdAt = new Date().toISOString() }) {
      const wallet = wallets[key];
      const now = new Date().toISOString();
      const settled = payment({
        amount: sats * 1000,
        memo,
        status: 'success',
        hash: randomBytes(32).toString('hex'),
        time: createdAt,
        updated: now,
      });
      wallet.payments.push(settled);
      wallet.balance += sats * 1000;
      const frame = JSON.stringify({ wallet_balance: wallet.balance / 1000, payment: settled });
      fixture.push(key, frame, frames);
      return settled;
    },
    // An existing pending invoice becomes settled.
    settlePending(key, invoice, frames = 2) {
      invoice.status = 'success';
      invoice.updated_at = new Date().toISOString();
      wallets[key].balance += invoice.amount;
      fixture.push(key, JSON.stringify({ wallet_balance: 0, payment: invoice }), frames);
      return invoice;
    },
    // An outgoing payment from this wallet: one frame with a negative amount.
    pay(key, sats) {
      const sent = payment({
        amount: -sats * 1000,
        status: 'success',
        hash: randomBytes(32).toString('hex'),
        time: new Date().toISOString(),
      });
      wallets[key].payments.push(sent);
      fixture.push(key, JSON.stringify({ wallet_balance: 0, payment: sent }));
      return sent;
    },
    close: () =>
      new Promise((resolve) => {
        fixture.dropSockets();
        for (const socket of sockets) socket.destroy();
        wss.close();
        server.close(resolve);
      }),
  };
  return fixture;
}

// A port on this computer with nothing listening: connection refused.
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/`;
}
