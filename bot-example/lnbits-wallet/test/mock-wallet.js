// A pretend NIP-47 wallet for trying the bot by hand on one computer. No money exists here: it never
// touches LNbits or Lightning, and its balance is a number in a file. It answers only through a
// relay on this computer, and refuses any other. Tests and manual testing only.
//
//   node test/mock-wallet.js serve   --dir DIR --relay ws://127.0.0.1:7791 [--kind spend]
//                                    [--balance SATS] [--budget SATS] [--fee SATS]
//   node test/mock-wallet.js invoice --dir DIR --sats N [--memo TEXT] [--expiry SECONDS]
//   node test/mock-wallet.js mode    --dir DIR [--pay MODE] [--lookup MODE]
//   node test/mock-wallet.js settle  --dir DIR --hash HEX [--state settled|failed]
//   node test/mock-wallet.js receive --dir DIR --sats N
//   node test/mock-wallet.js status  --dir DIR
//
// The connection string goes to DIR/connection.txt, readable by this user only, never to the
// terminal. Copy it with: pbcopy < DIR/connection.txt
//
// --kind:   spend, receive, no-limit (no get_budget), extra-power (also pay_keysend)
// --pay:    ok, payment-failed (says PAYMENT_FAILED, pays nothing), lost-paid (pays, the answer
//           is lost), lost-unpaid (pays nothing, no answer), bad-proof (pays, wrong preimage)
// --lookup: ok, silent (lookups go unanswered)
//
// `status` counts pay_invoice requests per payment hash, also those sent while it was stopped: more
// than one is a duplicate, and the mock refuses it. Only the invoices it made itself can be paid.
import './no-network.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeInvoice } from '../bolt11.js';
import { localTestRelays } from '../config.js';
import { nwcService } from './nwc-server.js';
import { encode } from './send-helpers.js';

const READING = ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'list_transactions'];
const KINDS = {
  spend: [...READING, 'pay_invoice', 'get_budget'],
  receive: READING,
  'no-limit': [...READING, 'pay_invoice'],
  'extra-power': [...READING, 'pay_invoice', 'get_budget', 'pay_keysend'],
};
const PAY_MODES = ['ok', 'payment-failed', 'lost-paid', 'lost-unpaid', 'bad-proof'];
const LOOKUP_MODES = ['ok', 'silent'];
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);
const controlFile = (dir) => join(dir, 'control.json');
const sats = (value, what) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${what} must be whole sats.`);
  return number;
};

// Commands reach the running wallet on this computer, with a token only this user can read.
function ask(dir, request) {
  return new Promise((done, fail) => {
    const notRunning = () => fail(new Error('No mock wallet is running with that --dir.'));
    let control;
    try {
      control = JSON.parse(readFileSync(controlFile(dir), 'utf8'));
    } catch {
      return notRunning();
    }
    const socket = net.connect(control.port, '127.0.0.1');
    let text = '';
    socket.on('error', notRunning);
    socket.on('data', (data) => (text += data));
    socket.on('end', () => {
      try {
        const answer = JSON.parse(text);
        if (answer.error) fail(new Error(answer.error));
        else done(answer.result);
      } catch {
        notRunning();
      }
    });
    socket.end(JSON.stringify({ ...request, token: control.token }));
  });
}

// Runs one wallet until closed. A restart with the same folder is the same wallet.
export async function startMockWallet({ dir, relay, kind, balance, budget, fee }) {
  const [relayUrl] = localTestRelays(relay);
  if (!relayUrl || relay.includes(','))
    throw new Error('--relay must name one relay on this computer.');
  const file = join(dir, 'wallet.json');
  const known = existsSync(file);
  if (known && [kind, balance, budget, fee].some((value) => value !== undefined))
    throw new Error('That --dir already holds a wallet: start it without choosing its settings.');
  if (!known && existsSync(dir) && readdirSync(dir).length)
    throw new Error('--dir must be a new or empty folder.');
  if (!Object.hasOwn(KINDS, kind ?? 'spend'))
    throw new Error(`--kind must be one of ${Object.keys(KINDS)}.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (
    await ask(dir, { command: 'status' }).then(
      () => true,
      () => false,
    )
  )
    throw new Error('A mock wallet is already running with that --dir.');
  const state = known
    ? JSON.parse(readFileSync(file, 'utf8'))
    : {
        walletKey: hex(randomBytes(32)),
        clientKey: hex(randomBytes(32)),
        kind: kind ?? 'spend',
        balance: sats(balance ?? 100000, '--balance') * 1000,
        budget: sats(budget ?? 20000, '--budget') * 1000,
        used: 0,
        fee: sats(fee ?? 1, '--fee') * 1000,
        transactions: [],
        preimages: {},
        attempts: {},
        missed: {}, // hash -> pay_invoice requests sent while it was stopped: not acted on
        seen: [], // pay_invoice events handled, so a relay's replay is not one more
        lost: {}, // hash -> invoice: asked for, not paid, may be settled later
        mode: { pay: 'ok', lookup: 'ok' },
      };
  const startedAt = nowSeconds();
  let wallet;
  const save = () => {
    state.transactions = wallet.transactions;
    state.balance = wallet.balance;
    writeFileSync(`${file}.new`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${file}.new`, file);
  };
  const applyMode = () => {
    wallet.silent = state.mode.lookup === 'silent' ? ['lookup_invoice'] : [];
  };
  const row = (hash, invoice, msat, status, fees, preimage) => ({
    type: 'outgoing',
    state: status,
    invoice,
    description: '',
    payment_hash: hash,
    amount: msat,
    fees_paid: fees,
    created_at: nowSeconds(),
    ...(status === 'settled' ? { settled_at: nowSeconds(), preimage } : {}),
  });
  const debit = (hash, invoice, msat) => {
    wallet.balance -= msat + state.fee;
    state.used += msat + state.fee;
    wallet.transactions.unshift(
      row(hash, invoice, msat, 'settled', state.fee, state.preimages[hash]),
    );
  };
  const pay = ({ invoice }) => {
    let decoded;
    try {
      decoded = decodeInvoice(invoice);
    } catch {
      return { error: 'OTHER' };
    }
    const hash = decoded.paymentHash;
    const msat = decoded.amountMsat;
    state.attempts[hash] = (state.attempts[hash] ?? 0) + 1;
    try {
      if (state.attempts[hash] > 1) return { error: 'PAYMENT_FAILED' }; // never pays one hash twice
      if (!state.preimages[hash]) return { error: 'OTHER' }; // not its own: it can pay nothing else
      if (state.mode.pay === 'payment-failed') return { error: 'PAYMENT_FAILED' };
      if (state.mode.pay === 'lost-unpaid') {
        state.lost[hash] = invoice;
        return wallet.NO_ANSWER;
      }
      if (wallet.balance < msat + state.fee) return { error: 'INSUFFICIENT_BALANCE' };
      if (state.used + msat + state.fee > state.budget) return { error: 'QUOTA_EXCEEDED' };
      debit(hash, invoice, msat);
      if (state.mode.pay === 'lost-paid') return wallet.NO_ANSWER;
      return {
        preimage: state.mode.pay === 'bad-proof' ? hex(randomBytes(32)) : state.preimages[hash],
        fees_paid: state.fee,
      };
    } finally {
      save();
    }
  };
  // What the relay kept from before this start was not asked of this run, and a real wallet offline
  // at the time would not act on it either. A payment request among it is still counted.
  const accept = (request, method, params) => {
    if (method === 'pay_invoice') {
      if (state.seen.includes(request.id)) return false;
      state.seen.push(request.id);
    }
    if (request.created_at >= startedAt) return true;
    if (method === 'pay_invoice') {
      try {
        const hash = decodeInvoice(params.invoice).paymentHash;
        state.missed[hash] = (state.missed[hash] ?? 0) + 1;
        save();
      } catch {
        // Not an invoice: nothing to count against.
      }
    }
    return false;
  };
  await nwcService(relayUrl, {
    walletKey: Buffer.from(state.walletKey, 'hex'),
    clientKey: Buffer.from(state.clientKey, 'hex'),
    onlyOwnClient: true,
    info: false,
    accept,
    prepare: (made) => {
      wallet = made;
      wallet.methods = KINDS[state.kind];
      wallet.transactions = state.transactions;
      wallet.balance = state.balance;
      wallet.pay = pay;
      applyMode();
      Object.defineProperty(wallet, 'budget', {
        get: () => ({ total_budget: state.budget, used_budget: state.used }),
      });
    },
  });
  const commands = {
    invoice({ sats: amount, memo, expiry }) {
      const preimage = randomBytes(32);
      const hash = createHash('sha256').update(preimage).digest();
      const invoice = encode({
        sats: sats(amount, '--sats'),
        memo: memo ?? 'Mock wallet test',
        hash,
        expiry: expiry === undefined ? 600 : sats(expiry, '--expiry'),
      });
      state.preimages[hash.toString('hex')] = hex(preimage);
      return { invoice, paymentHash: hash.toString('hex') };
    },
    mode({ pay, lookup }) {
      if (pay !== undefined && !PAY_MODES.includes(pay)) throw new Error(`--pay: ${PAY_MODES}`);
      if (lookup !== undefined && !LOOKUP_MODES.includes(lookup))
        throw new Error(`--lookup: ${LOOKUP_MODES}`);
      Object.assign(state.mode, pay && { pay }, lookup && { lookup });
      applyMode();
      return state.mode;
    },
    // What a lost payment turned out to be, for a later lookup to find.
    settle({ hash, state: status = 'settled' }) {
      const invoice = Object.hasOwn(state.lost, hash) ? state.lost[hash] : undefined;
      if (!invoice || !state.preimages[hash]) throw new Error('No lost payment with that hash.');
      if (!['settled', 'failed'].includes(status)) throw new Error('--state: settled or failed.');
      const msat = decodeInvoice(invoice).amountMsat;
      if (status === 'settled') debit(hash, invoice, msat);
      else wallet.transactions.unshift(row(hash, invoice, msat, 'failed', 0));
      delete state.lost[hash];
      return { hash, state: status };
    },
    receive({ sats: amount }) {
      const { payment_hash: paymentHash } = wallet.settle(
        sats(amount, '--sats'),
        'Mock wallet test',
      );
      return { paymentHash };
    },
    status() {
      const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
      const requests = { ...state.attempts };
      for (const [hash, n] of Object.entries(state.missed))
        requests[hash] = (requests[hash] ?? 0) + n;
      return {
        kind: state.kind,
        balanceSats: wallet.balance / 1000,
        limitSats: state.budget / 1000,
        usedSats: state.used / 1000,
        mode: state.mode,
        payRequests: total(state.attempts),
        missedWhileStopped: total(state.missed),
        hashes: Object.keys(requests).length,
        duplicates: Object.entries(requests)
          .filter(([, n]) => n > 1)
          .map(([hash, n]) => ({ hash, requests: n })),
      };
    },
  };
  const token = hex(randomBytes(32));
  const control = net.createServer((socket) => {
    let text = '';
    socket.on('error', () => {});
    socket.on('data', (data) => {
      text += data;
      if (text.length > 64 * 1024) socket.destroy();
    });
    socket.on('end', () => {
      let answer;
      try {
        const { command, token: given, ...options } = JSON.parse(text);
        if (given !== token) throw new Error('Wrong token.');
        if (!Object.hasOwn(commands, command)) throw new Error('Unknown command.');
        answer = { result: commands[command](options) };
        save();
      } catch (error) {
        answer = { error: error.message };
      }
      socket.end(JSON.stringify(answer));
    });
  });
  await new Promise((done, fail) => control.once('error', fail).listen(0, '127.0.0.1', done));
  writeFileSync(controlFile(dir), JSON.stringify({ port: control.address().port, token }), {
    mode: 0o600,
  });
  chmodSync(controlFile(dir), 0o600);
  save();
  const connection = join(dir, 'connection.txt');
  writeFileSync(connection, `${wallet.uri}\n`, { mode: 0o600 });
  chmodSync(connection, 0o600);
  wallet.publishInfo();
  return {
    uri: wallet.uri,
    kind: state.kind,
    secret: wallet.secret,
    requests: wallet.requests,
    socket: wallet.socket,
    run: (command, options = {}) => {
      const result = commands[command](options);
      save();
      return result;
    },
    close: () =>
      new Promise((done) => {
        wallet.close();
        control.close(() => done());
      }),
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(
      [
        'dir',
        'relay',
        'kind',
        'balance',
        'budget',
        'fee',
        'sats',
        'memo',
        'expiry',
        'pay',
        'lookup',
        'hash',
        'state',
      ].map((name) => [name, { type: 'string' }]),
    ),
  });
  const { dir, ...options } = values;
  if (!dir) throw new Error('--dir is required. See the top of this file.');
  if (command !== 'serve') {
    console.log(JSON.stringify(await ask(dir, { command, ...options }), null, 2));
    return;
  }
  const wallet = await startMockWallet({ dir, ...options });
  console.log(
    `Mock wallet ready (${wallet.kind}). Connection string: ${join(dir, 'connection.txt')}`,
  );
  wallet.socket.once('close', () => {
    console.log('The relay went away. Start this mock wallet again once it is back.');
    wallet.close().then(() => process.exit(1));
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => wallet.close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
