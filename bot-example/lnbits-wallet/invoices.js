// Durable invoice requests, in state.json (mode 0600). One record per /invoice message,
// written BEFORE LNbits is asked, so a restart can always tell what happened.
//
// record = { op, requester, messageId, sats, state, createdAt, updatedAt, checks,
//            paymentHash?, error?, trigger?, connection?, ref?, expiresAt?, payment?, noMemo? }
//
// noMemo: the person wrote none, so whatever LNbits fills in (its name) is not shown as theirs.
//
// connection: the wallet it was made in. A request whose wallet was disconnected cannot hold
// up the person's other wallets, and is only ever looked up in its own wallet.
//
// ref: the same wallet as menus know it. Only that exact link shows the record (belongsTo): a
// reconnected wallet has a new ref, so history ends with a disconnect, like old menus do.
// Records of an earlier release have none until the wallet confirms it holds them (unclaimed);
// noWallet: it did not, so they are never shown.
//
// trigger: set for an invoice asked for with a preset button (messageId is then the
// button request's id). A digest of person, card and button: one button on one menu gives at
// most one invoice at a time, whichever answer on that menu it was pressed from, and even when
// the person's app retries it as a new request after it expired. Later messages about it are
// not replies to anything.
//
// Neither the memo nor the invoice text is stored: the invoice reaches the person only
// inside the encrypted reply, and recovery reads it from LNbits again.
//
//   queued     written; LNbits not asked yet                  -> sending | failed
//   sending    the one creation request is about to be sent   -> created | failed | uncertain
//   created    LNbits confirmed the invoice (final)
//   failed     LNbits certainly created nothing (final)
//   uncertain  the request may or may not have created one: checked by external id
//              (never by asking again)                          -> created | failed | review
//              Every lookup answered and none found it: failed. If LNbits stored it even later,
//              nobody ever saw that invoice, so nobody can pay it.
//   review     cannot be settled automatically (an invoice that does not match, more than one,
//              or no key to look with): the operator decides (npm run review)
//                                                               -> created | failed
//
// A created invoice also has a payment, the last answer read from its wallet. Nothing else sets
// it: not a socket frame, and nothing in a Nostr message. It is shown only as what was last
// seen, and never replaces asking the wallet (see reconcile() in bot.js).
//
//   (none)   -> pending | paid | expired | failed
//   pending  -> paid | expired | failed
//   expired  -> paid         a wallet that noticed a settlement late is believed
//   failed   -> paid         the same
//   paid     final
//
// The status a person sees comes from both, plus the answer of the moment:
//   Pending, Paid, Expired, Failed   what the wallet says now
//   Unknown                          no answer, or one that cannot be trusted. Never a guess
//   Needs review                     state "review": the operator decides
import { randomUUID } from 'node:crypto';
import { HEX } from './vendor/runtime.js';
import { walletRef } from './wallets.js';

export const STATES = ['queued', 'sending', 'created', 'failed', 'uncertain', 'review'];
const NEXT = {
  queued: ['sending', 'failed'],
  sending: ['created', 'failed', 'uncertain'],
  uncertain: ['created', 'failed', 'review'],
  review: ['created', 'failed'],
  created: [],
  failed: [],
};
// Requests that block a new /invoice from the same person until they are settled.
export const OPEN = ['queued', 'sending', 'uncertain', 'review'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PAYMENTS = ['pending', 'paid', 'expired', 'failed'];
const PAYMENT_NEXT = {
  pending: ['paid', 'expired', 'failed'],
  expired: ['paid'],
  failed: ['paid'],
  paid: [],
};
const KEEP_FINISHED = 90 * 86400;
const MAX_RECORDS = 5000;
const MAX_PER_PERSON = 200;

export const externalId = (record) => `alw-${record.op}`;

export function validRecord(r) {
  return (
    r !== null &&
    typeof r === 'object' &&
    UUID.test(r.op) &&
    HEX.test(r.requester) &&
    HEX.test(r.messageId) &&
    Number.isSafeInteger(r.sats) &&
    r.sats > 0 &&
    STATES.includes(r.state) &&
    Number.isSafeInteger(r.createdAt) &&
    Number.isSafeInteger(r.updatedAt) &&
    Number.isSafeInteger(r.checks) &&
    r.checks >= 0 &&
    (r.paymentHash === undefined || /^[a-f0-9]{64}$/.test(r.paymentHash)) &&
    (r.error === undefined || /^[a-z_0-9 ]{1,40}$/.test(r.error)) &&
    (r.trigger === undefined || /^[a-f0-9]{32}$/.test(r.trigger)) &&
    (r.ref === undefined || /^[a-f0-9]{32}$/.test(r.ref)) &&
    (r.expiresAt === undefined || Number.isSafeInteger(r.expiresAt)) &&
    (r.payment === undefined || PAYMENTS.includes(r.payment))
  );
}

// Whether a record was made in the wallet of this lease.
export const belongsTo = (record, lease) =>
  record.requester === lease.owner && record.ref === lease.ref;

// Whether an older record, naming no ref, may have been made in this wallet: the wallet is then
// asked. The test only limits who is asked: being in this wallet is what proves it.
export function mayBelongTo(record, lease) {
  if (record.requester !== lease.owner || record.ref || record.noWallet) return false;
  if (record.connection) return record.connection === lease.id;
  // A link carried over from wallets.json, so with the ref it had there.
  return typeof lease.key === 'string' && lease.ref === walletRef(lease.owner, lease.key);
}

export class Invoices {
  // state: the bot's persisted state object; records live in state.invoices.
  constructor(state, clock = () => Math.floor(Date.now() / 1000)) {
    state.invoices ??= [];
    if (!Array.isArray(state.invoices) || !state.invoices.every(validRecord))
      throw new Error('Invalid invoice records in state.json. Restore it from backup.');
    this.state = state;
    this.clock = clock;
  }
  get all() {
    return this.state.invoices;
  }
  byMessage(messageId) {
    return this.all.find((r) => r.messageId === messageId);
  }
  byOp(op) {
    return this.all.find((r) => r.op === op);
  }
  // The person's request in this wallet that is not settled yet, if any (at most one at a
  // time). Older records name no wallet and hold up all of them.
  open(requester, connection) {
    return this.all.find(
      (r) =>
        r.requester === requester &&
        OPEN.includes(r.state) &&
        (!connection || !r.connection || r.connection === connection),
    );
  }
  // Requests in the last hour that may have produced an invoice.
  countSince(requester, since) {
    return this.all.filter(
      (r) => r.requester === requester && r.createdAt >= since && r.state !== 'failed',
    ).length;
  }
  // The latest request made by one press of one preset button (see trigger above).
  byTrigger(trigger) {
    return this.all.findLast((r) => r.trigger === trigger);
  }
  // The requests made in this wallet, newest first. Its status button finds one by its ref.
  forWallet(lease) {
    return this.all.filter((record) => belongsTo(record, lease)).reverse();
  }
  // Older records this wallet has yet to be asked about, newest first.
  unclaimed(lease) {
    return this.all
      .filter((record) => mayBelongTo(record, lease) && record.state === 'created')
      .reverse();
  }
  // What the wallet said: it holds this record (its ref), or it does not.
  settleOwner(record, ref) {
    if (ref) record.ref = ref;
    else record.noWallet = true;
  }
  add({ requester, messageId, sats, trigger, connection, ref, expiresAt, noMemo }) {
    const time = this.clock();
    const record = {
      op: randomUUID(),
      requester,
      messageId,
      sats,
      state: 'queued',
      createdAt: time,
      updatedAt: time,
      checks: 0,
      ...(trigger ? { trigger } : {}),
      ...(connection ? { connection } : {}),
      ...(ref ? { ref } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(noMemo ? { noMemo } : {}),
    };
    this.all.push(record);
    this.prune();
    return record;
  }
  // The only way a state changes. A wrong transition is a bug: it throws.
  move(record, state, fields = {}) {
    if (!NEXT[record.state].includes(state))
      throw new Error(`Invoice request cannot go from ${record.state} to ${state}.`);
    Object.assign(record, fields, { state, updatedAt: this.clock() });
    return record;
  }
  // What the wallet just said about a created invoice. Returns whether anything changed. An
  // answer that would undo a final one is not recorded, and the caller shows it as unknown.
  canSetPayment(record, payment) {
    return (
      !record.payment ||
      record.payment === payment ||
      PAYMENT_NEXT[record.payment].includes(payment)
    );
  }
  setPayment(record, payment) {
    if (record.payment === payment || !this.canSetPayment(record, payment)) return false;
    record.payment = payment;
    record.updatedAt = this.clock();
    return true;
  }
  // Settled records are kept 90 days for /invoices (at most 200 per person), and always long
  // enough for the hourly limit and duplicate messages; open ones always.
  prune() {
    const cutoff = this.clock() - KEEP_FINISHED;
    const finished = new Map();
    for (const r of this.all)
      if (!OPEN.includes(r.state)) finished.set(r.requester, (finished.get(r.requester) ?? 0) + 1);
    this.state.invoices = this.all.filter((r) => {
      if (OPEN.includes(r.state)) return true;
      const count = finished.get(r.requester);
      if (r.updatedAt >= cutoff && count <= MAX_PER_PERSON) return true;
      finished.set(r.requester, count - 1);
      return false;
    });
    while (this.all.length > MAX_RECORDS) {
      const index = this.all.findIndex((r) => !OPEN.includes(r.state));
      if (index < 0) break;
      this.all.splice(index, 1);
    }
  }
}
