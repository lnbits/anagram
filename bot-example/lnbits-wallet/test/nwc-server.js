// A local NIP-47 wallet service for tests, reached through the local relay fixture like a real
// one. It keeps a balance and transactions, signs its answers and can be told to misbehave.
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { WebSocket } from 'ws';
import { fakeBolt11 } from './lnbits-server.js';

const hex = (key) => Buffer.from(key).toString('hex');
const NO_ANSWER = Symbol('no answer');

export async function nwcService(relayUrl, options = {}) {
  const walletKey = options.walletKey ?? generateSecretKey();
  const clientKey = options.clientKey ?? generateSecretKey();
  const walletPubkey = getPublicKey(walletKey);
  const clientSecret = hex(clientKey);
  const conversation = nip44.v2.utils.getConversationKey(walletKey, getPublicKey(clientKey));
  const socket = new WebSocket(relayUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  const publish = (kind, tags, content) => {
    const event = finalizeEvent(
      { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
      walletKey,
    );
    socket.send(JSON.stringify(['EVENT', event]));
    return event;
  };
  const fixture = {
    walletPubkey,
    clientSecret,
    relayUrl,
    uri: `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(relayUrl)}&secret=${clientSecret}`,
    secret: { walletPubkey, clientSecret, relays: [relayUrl] },
    methods: ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'list_transactions'],
    alias: 'Test wallet',
    balance: 5_000_000,
    transactions: [],
    requests: [],
    mode: 'ok', // 'silent' never answers; 'late' answers after delayMs; 'wrong-amount'
    delayMs: 200,
    forge: null, // called with (request, answer) to send something else first
    errors: {}, // method -> error code
    answer(request, body, { key = conversation, signer = publish, type } = {}) {
      return signer(
        23195,
        [
          ['p', request.pubkey],
          ['e', request.id],
        ],
        nip44.v2.encrypt(JSON.stringify({ result_type: type ?? body.result_type, ...body }), key),
      );
    },
    pay: null, // pay_invoice behaviour, for the /send tests
    NO_ANSWER, // what pay returns for a wallet that acts but whose answer gets lost
    socket,
    settle(sats, memo = '') {
      const now = Math.floor(Date.now() / 1000);
      const row = {
        type: 'incoming',
        state: 'settled',
        invoice: fakeBolt11(sats),
        description: memo,
        payment_hash: randomBytes(32).toString('hex'),
        amount: sats * 1000,
        fees_paid: 0,
        created_at: now,
        settled_at: now,
      };
      fixture.transactions.unshift(row);
      fixture.balance += sats * 1000;
      return row;
    },
    publishInfo(encryption = 'nip44_v2') {
      publish(13194, encryption ? [['encryption', encryption]] : [], fixture.methods.join(' '));
    },
    close() {
      socket.terminate();
    },
  };
  const run = (method, params) => {
    if (method === 'get_info')
      return { alias: fixture.alias, methods: fixture.methods, network: 'mainnet' };
    if (method === 'get_balance') return { balance: fixture.balance };
    if (method === 'make_invoice') {
      const sats = params.amount / 1000;
      const row = {
        type: 'incoming',
        state: 'pending',
        invoice: fakeBolt11(sats),
        description: params.description ?? '',
        payment_hash: randomBytes(32).toString('hex'),
        amount: fixture.mode === 'wrong-amount' ? params.amount + 1000 : params.amount,
        fees_paid: 0,
        created_at: Math.floor(Date.now() / 1000),
      };
      fixture.transactions.unshift(row);
      return row;
    }
    if (method === 'lookup_invoice') {
      const row = fixture.transactions.find((t) => t.payment_hash === params.payment_hash);
      return row ?? { error: 'NOT_FOUND' };
    }
    if (method === 'list_transactions') {
      let rows = fixture.transactions;
      if (params.type) rows = rows.filter((t) => t.type === params.type);
      if (!params.unpaid) rows = rows.filter((t) => t.state === 'settled');
      const offset = params.offset ?? 0;
      return { transactions: rows.slice(offset, offset + (params.limit ?? 10)) };
    }
    if (method === 'get_budget') return fixture.budget ?? { error: 'NOT_IMPLEMENTED' };
    if (method === 'pay_invoice' && fixture.pay) return fixture.pay(params);
    return { error: 'NOT_IMPLEMENTED' };
  };
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw);
    if (frame[0] !== 'EVENT' || frame[2].kind !== 23194) return;
    const request = frame[2];
    if (options.onlyOwnClient && request.pubkey !== getPublicKey(clientKey)) return;
    const { method, params } = JSON.parse(nip44.v2.decrypt(request.content, conversation));
    if (options.accept && !options.accept(request, method, params)) return;
    fixture.requests.push({ method, params, tags: request.tags });
    if (fixture.mode === 'silent' || fixture.silent?.includes(method)) return;
    const respond = () => {
      fixture.forge?.(request, method);
      const result = fixture.errors[method]
        ? { error: fixture.errors[method] }
        : run(method, params ?? {});
      if (result === NO_ANSWER) return;
      if (result?.error)
        return fixture.answer(request, {
          result_type: method,
          result: null,
          error: { code: result.error, message: 'test' },
        });
      fixture.answer(request, { result_type: method, result, error: null });
    };
    if (fixture.mode === 'late') setTimeout(respond, fixture.delayMs);
    else respond();
  });
  // Ready before the first request can arrive.
  options.prepare?.(fixture);
  socket.send(JSON.stringify(['REQ', 'w', { kinds: [23194], '#p': [walletPubkey] }]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (options.info !== false) fixture.publishInfo(options.encryption);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return fixture;
}
