// /send: paying a BOLT11 invoice through an NWC connection the person created to spend, and
// /payments: what was sent. Off by default (SEND_ENABLED). The bot holds no other way to spend.
//
// A payment takes the authenticated person's /send or pasted invoice, a preview, a separate press
// on that card, and limits, the wallet's limit and a look at the wallet's records all passing
// right then. The wallet's own limit is the one that binds if this bot or its host is ever
// compromised, so it is always required. The bot's limits come on top.
//
//   prepared   previewed, waiting for the person's press           -> sending | cancelled
//   sending    the one payment request is about to go              -> paid | failed | uncertain
//   uncertain  the wallet may or may not have paid: looked up by
//              payment hash, NEVER sent again                       -> paid | failed | unknown
//   unknown    checks ran out: Refresh can still settle it, also by
//              looking only. It counts as spent, and its invoice
//              stays refused                                        -> paid | failed
//   paid       the wallet produced the preimage of the invoice's hash (final)
//   failed     the wallet certainly did not pay (final), or a lookup reported a failure, which
//              a later proof of payment can still correct       -> paid
//   cancelled  never sent (final)
//
// NIP-47 has no idempotency, so nothing here promises exactly once. What is promised: at most one
// request from this bot for a payment, and never another while one may have succeeded.
//
// state.sends = [{ id, requester, connection, ref, paymentHash, msat, state, createdAt, updatedAt,
//                  checks, previewExpires, invoiceExpires, feesMsat?, error? }]
// No invoice, description or preimage is ever stored: the invoice waits in memory, so a restart
// cancels what was waiting, and nothing after the request needs it.
import { createHash, randomBytes } from 'node:crypto';
import { nip19 } from 'nostr-tools';
import { decodeInvoice, InvoiceError } from './bolt11.js';
import { formatMsat, sanitizeMemo } from './commands.js';
import { LNbitsError } from './lnbits.js';

const HOUR = 3600;
const DAY = 86400;
const KEEP = 90 * DAY;
const MAX_RECORDS = 5000;
const MAX_PER_PERSON = 200;
// Older records that still block their payment hash: another invoice could carry it.
const MAX_BLOCKING_PER_PERSON = 1000;
// Records that keep a promise (see #mustKeep). Nothing evicts them, so new payments stop instead.
const MAX_HELD_PER_PERSON = 300;
// With the bot full, someone can still pay up to this many held records: many accounts filling it
// must not stop everybody else. It is also what nobody else's records can push out.
const FAIR_SHARE = 20;
const STATES = ['prepared', 'sending', 'uncertain', 'unknown', 'paid', 'failed', 'cancelled'];
const OPEN = ['prepared', 'sending', 'uncertain'];
// One at a time: a new payment waits until the last one is settled or has run out of checks.
const IN_FLIGHT = ['sending', 'uncertain'];
// States that may have spent, or might still: they count against the limits, and their invoice
// is refused.
const COUNTED = ['sending', 'uncertain', 'unknown', 'paid'];
const NEXT = {
  prepared: ['sending', 'cancelled'],
  sending: ['paid', 'failed', 'uncertain'],
  uncertain: ['paid', 'failed', 'unknown'],
  unknown: ['paid', 'failed'],
  // Only a failure that a lookup reported, and only with the preimage: see #move.
  failed: ['paid'],
};
// Wallet answers that mean it certainly did not pay. Not PAYMENT_FAILED: NIP-47 says that may
// be a timeout, and a payment that timed out can still be in flight.
const CERTAIN = new Set([
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXCEEDED',
  'RESTRICTED',
  'UNAUTHORIZED',
  'NOT_IMPLEMENTED',
  'RATE_LIMITED',
  'UNSUPPORTED_ENCRYPTION',
]);
const REF = /^[a-f0-9]{12}$/;
const PREVIEWS_PER_HOUR = 30;
// An invoice this close to expiring may run out on its way.
const EXPIRY_MARGIN = 30;
// A failed row is believed only once the invoice cannot be paid at all, and this long after.
const FAILED_MARGIN = 60;
// A record outlives its invoice, so an invoice cannot be allowed to last for ever.
const MAX_INVOICE_LIFE = 90 * DAY;
const PAGE_SIZE = 5;
export const MAX_PAYMENT_PAGES = 40;
const now = () => Math.floor(Date.now() / 1000);
const HEX64 = /^[a-f0-9]{64}$/;

export const SEND_ACTION = /^s:(ok|no):([a-f0-9]{12})$/;
export const SEND_ASK = 's:ask';
export const PAYMENT_VIEW = /^pm:([0-9]{1,2})(?::([a-f0-9]{12}))?$/;
// A whole message that is just an invoice.
export const BARE_INVOICE = /^(?:lightning:)?ln(?:bc|tb|tbs|bcrt)[0-9a-z]{20,}$/i;
const sats = (msat) => formatMsat(msat);
const date = (time) => {
  const iso = new Date(time * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

export const SEND_TEXT = {
  off: 'Sending is not available on this bot.',
  usage:
    'Usage: /send <lightning invoice>, or just paste the invoice. You will see the details and confirm before anything is paid.',
  ask: (label) =>
    `Paste the Lightning invoice to pay${label ? ` from ${label}` : ''}. You will see the details and confirm before anything is paid. /cancel stops this.`,
  askAgain: 'That is not a Lightning invoice. Paste one, or send /cancel to stop.',
  noSpend:
    'The wallet in use cannot send: it is connected for receiving only. To send, connect a wallet that can spend (/connect), and choose it in /wallets.',
  invalid: 'That is not a valid Lightning invoice. Nothing was paid.',
  signature: 'That invoice’s signature does not match who it says it pays. Nothing was paid.',
  network: 'That invoice is for another network. Nothing was paid.',
  noAmount:
    'That invoice has no amount. Only invoices with an amount can be paid here. Nothing was paid.',
  expired: 'That invoice has expired. Nothing was paid.',
  farExpiry: 'That invoice lasts unusually long, so I will not pay it from here. Nothing was paid.',
  tooMany:
    'I cannot take more payments for you right now. Please try again later. Nothing was paid.',
  tooOld: 'That request is over an hour old, so I did not act on it. Nothing was paid.',
  perPayment: (max) =>
    `That is above this bot's limit of ${sats(max * 1000)} per payment. Nothing was paid.`,
  daily: (max) =>
    `That would go over this bot's limit of ${sats(max * 1000)} in 24 hours. Nothing was paid.`,
  hourly: 'You have reached the limit of payments per hour. Please try again later.',
  open: 'You already have a payment waiting. Confirm or cancel it first (/cancel).',
  busy: 'Your last payment is still being checked. Please wait for the result. Nothing new was sent.',
  duplicate:
    'That invoice was already paid or attempted from here, and may have gone through. It will not be paid again from here. See /payments.',
  budget:
    'I could not confirm a spending limit set in your wallet, so I will not pay from this connection. Nothing was paid.',
  overBudget:
    'That is more than is left of the spending limit set in your wallet. Nothing was paid.',
  alreadyInWallet:
    'Your wallet already knows this invoice: as paid, in progress, tried before, or as its own. I sent nothing just now. Check your wallet’s history before paying this in any other way: it may already be paid.',
  switchedOff: 'This wallet connection is switched off on this bot. Nothing was paid.',
  reportedFailed: (msat) =>
    `Your wallet reports that the payment of ${sats(msat)} failed. It will not be sent again from here. Check your wallet’s history if in doubt.`,
  cannotCheck: 'I could not check with your wallet just now. Nothing was paid. Please try again.',
  preview: ({ msat, memo, destination, expires, minutes, label }) =>
    [
      `Pay ${sats(msat)} from ${label}?`,
      ...(memo ? [`The invoice says: ${memo}`] : []),
      destination
        ? `Pays node: ${destination}`
        : 'Pays node: not stated in the invoice. Your wallet checks it when it pays.',
      `Invoice expires: ${date(expires)}`,
      'Plus a routing fee, decided by your wallet and known only afterwards.',
      `This request lasts ${minutes} minutes. Nothing is paid until you confirm.`,
    ].join('\n'),
  seeBelow: 'The result is in the message below.',
  cancelled: 'Cancelled. Nothing was paid.',
  cancelledEarlier:
    'Cancelled. Nothing new was sent. An earlier payment may still have gone through: see /payments, or that wallet’s own history.',
  nothing: 'There is nothing to cancel.',
  stalePreview:
    'This payment request has expired. Nothing was paid. Send /send again if you still want to pay.',
  gone: 'This request is no longer waiting. Nothing more will happen with it.',
  paid: ({ msat, fees }) =>
    `Paid ${sats(msat)}.${fees === undefined ? '' : ` Routing fee: ${sats(fees)}.`}`,
  failed: (msat, why) => `The payment of ${sats(msat)} failed: ${why} Nothing was paid.`,
  uncertain: (msat) =>
    `I do not know yet whether the payment of ${sats(msat)} went through. It will not be sent again. I am checking with your wallet and will tell you.`,
  unknown: (msat) =>
    `I could not confirm whether the payment of ${sats(msat)} went through. It will not be sent again. Check your wallet’s history, or press Refresh under /payments.`,
  unknownOff: (msat) =>
    `I could not confirm whether the payment of ${sats(msat)} went through, and that wallet is switched off here, so I cannot check. It will not be sent again. Check that wallet’s own history.`,
  unknownGone: (msat) =>
    `I could not confirm whether the payment of ${sats(msat)} went through, and that wallet is no longer connected. It will not be sent again. Check that wallet’s own history.`,
  reportedFailedAlready:
    'Your wallet reports that this payment failed. It will not be sent again. Check its history if in doubt.',
  already: {
    paid: 'This was already paid.',
    failed: 'This payment already failed. Nothing was paid.',
    cancelled: 'This was already cancelled. Nothing was paid.',
    sending: 'This payment is already on its way.',
    uncertain: 'I am still checking this payment. It will not be sent again.',
    unknown:
      'I could not confirm this payment. It will not be sent again. Please check your wallet.',
  },
};
const WHY = {
  INSUFFICIENT_BALANCE: 'the wallet does not have enough funds.',
  QUOTA_EXCEEDED: 'it is over the spending limit set in your wallet.',
  RESTRICTED: 'your wallet does not allow this connection to pay.',
  UNAUTHORIZED: 'your wallet refused this connection.',
  RATE_LIMITED: 'your wallet asked to slow down. Try again in a moment.',
  NOT_IMPLEMENTED: 'your wallet does not offer payments on this connection.',
};
const SHOWN = {
  sending: 'Pending',
  uncertain: 'Pending',
  unknown: 'Unknown',
  paid: 'Confirmed',
  failed: 'Failed',
};
const SAID = {
  sending: 'it is on its way.',
  uncertain: 'I am still checking whether it went through. It will not be sent again.',
  unknown:
    'I could not confirm whether it went through. It will not be sent again. Check your wallet’s history.',
  paid: 'it went through.',
  failed: 'it was not paid.',
};

// When it counts from: when it was sent, for a record of a payment sent.
const countedFrom = (r) => r.sentAt ?? r.createdAt;
const alreadyText = (record) =>
  record.state === 'failed' && record.error === 'lookup'
    ? SEND_TEXT.reportedFailedAlready
    : (SEND_TEXT.already[record.state] ?? SEND_TEXT.gone);

function validRecord(r) {
  return (
    r !== null &&
    typeof r === 'object' &&
    /^[a-f0-9]{32}$/.test(r.id) &&
    HEX64.test(r.requester) &&
    HEX64.test(r.paymentHash) &&
    Number.isSafeInteger(r.msat) &&
    r.msat > 0 &&
    STATES.includes(r.state) &&
    Number.isSafeInteger(r.createdAt) &&
    Number.isSafeInteger(r.updatedAt) &&
    (r.sentAt === undefined || Number.isSafeInteger(r.sentAt)) &&
    (r.ref === undefined || /^[a-f0-9]{32}$/.test(r.ref)) &&
    (r.feesMsat === undefined || (Number.isSafeInteger(r.feesMsat) && r.feesMsat >= 0))
  );
}
const shortId = (record) => record.id.slice(0, 12);
const rows = (...list) => ({ inline_keyboard: list.filter((row) => row.length) });

// Whether this is the preimage of that hash: the wallet's proof of having paid.
const proves = (preimage, hash) =>
  typeof preimage === 'string' &&
  HEX64.test(preimage) &&
  createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === hash;

export class SendFlow {
  // Invoices waiting for a press, by record id. Never on disk.
  #waiting = new Map();
  constructor(
    bot,
    {
      maxSats = 10000,
      dailySats = 50000,
      perHour = 5,
      previewSeconds = 300,
      networks = ['bc'],
      checkDelays = [5, 30, 120, 600],
    } = {},
  ) {
    this.bot = bot;
    this.limits = { maxSats, dailySats, perHour, previewSeconds };
    this.networks = networks;
    this.checkDelays = checkDelays;
    bot.state.sends ??= [];
    if (!Array.isArray(bot.state.sends) || !bot.state.sends.every(validRecord))
      throw new Error('Invalid payment records in state.json. Restore it from backup.');
    // Earlier experimental releases kept these.
    for (const record of bot.state.sends) {
      delete record.invoice;
      delete record.memo;
    }
  }
  get all() {
    return this.bot.state.sends;
  }
  #move(record, state, fields = {}) {
    if (
      !NEXT[record.state]?.includes(state) ||
      (record.state === 'failed' && record.error !== 'lookup')
    )
      throw new Error(`A payment cannot go from ${record.state} to ${state}.`);
    Object.assign(record, fields, { state, updatedAt: now() });
    if (state !== 'prepared') this.#waiting.delete(record.id);
  }
  // These keep a promise, so no limit on records may ever remove them: something in progress,
  // whatever counts against the 24-hour limit, and whatever blocks an invoice that can still be
  // paid. There are few by construction, and over MAX_HELD_PER_PERSON new payments stop instead.
  #mustKeep(r) {
    if (OPEN.includes(r.state)) return true;
    if (!this.#blocksHash(r)) return false;
    return countedFrom(r) >= now() - DAY || (r.invoiceExpires ?? 0) + FAILED_MARGIN > now();
  }
  // Records are kept 90 days, 200 per person besides those. Cancelled ones go first, and a day
  // later: they only hold the cap on previews.
  #prune() {
    const cutoff = now() - KEEP;
    const idle = now() - DAY;
    const bucket = (r) => `${r.requester}:${this.#blocksHash(r)}`;
    const counts = new Map();
    for (const r of this.all)
      if (!this.#mustKeep(r)) counts.set(bucket(r), (counts.get(bucket(r)) ?? 0) + 1);
    this.bot.state.sends = this.all.filter((r) => {
      if (this.#mustKeep(r)) return true;
      const count = counts.get(bucket(r));
      const keep =
        (r.state === 'cancelled' ? r.updatedAt >= idle : r.updatedAt >= cutoff) &&
        count <= (this.#blocksHash(r) ? MAX_BLOCKING_PER_PERSON : MAX_PER_PERSON);
      if (!keep) counts.set(bucket(r), count - 1);
      return keep;
    });
    // What only served a cap goes first, then failures.
    for (const removable of [
      (r) => r.state === 'cancelled',
      (r) => !this.#mustKeep(r) && !this.#blocksHash(r),
    ])
      // Below the cap, not at it: a bot at the cap refuses new payments.
      while (this.all.length >= MAX_RECORDS) {
        const index = this.all.findIndex(removable);
        if (index < 0) break;
        this.all.splice(index, 1);
      }
    while (this.all.length >= MAX_RECORDS) {
      const index = this.#heaviestOldest();
      if (index < 0) break;
      this.all.splice(index, 1);
    }
  }
  // Old records that block a hash go last, and from whoever holds the most, so someone filling the
  // bot loses theirs first. Nobody loses their most recent FAIR_SHARE this way.
  #heaviestOldest() {
    const holding = new Map();
    for (const r of this.all) holding.set(r.requester, (holding.get(r.requester) ?? 0) + 1);
    let most = FAIR_SHARE;
    let found = -1;
    this.all.forEach((r, index) => {
      if (holding.get(r.requester) > most && !this.#mustKeep(r)) {
        most = holding.get(r.requester);
        found = index;
      }
    });
    return found;
  }
  #spent(requester) {
    return (
      this.all
        .filter(
          (r) => r.requester === requester && countedFrom(r) >= now() - DAY && this.#blocksHash(r),
        )
        // A fee counts as reported. At worst a false one stops that person until the window ends.
        .reduce(
          (total, r) => total + r.msat + Math.min(r.feesMsat ?? 0, this.limits.dailySats * 1000),
          0,
        )
    );
  }
  // A failure only the wallet's later lookup reported may still hide a payment in flight, and
  // another invoice with the same hash could pay it again.
  #blocksHash(r) {
    return COUNTED.includes(r.state) || (r.state === 'failed' && r.error === 'lookup');
  }
  #mayHavePaid(requester, hash) {
    return this.all.some(
      (r) => r.paymentHash === hash && r.requester === requester && this.#blocksHash(r),
    );
  }

  // ---- /send <invoice> -------------------------------------------------------------------

  async command(request, text) {
    const { bot } = this;
    const { sender, message } = request;
    if (!text) return bot.say(request, SEND_TEXT.usage);
    if (message.created_at < now() - HOUR) return bot.say(request, SEND_TEXT.tooOld);
    const lease = (request.lease ??= bot.wallets.lease(sender));
    if (!lease || !lease.spends || !bot.api(lease).pay) return bot.say(request, SEND_TEXT.noSpend);
    let decoded;
    try {
      decoded = decodeInvoice(text, { networks: this.networks });
    } catch (error) {
      if (!(error instanceof InvoiceError)) throw error;
      if (error.code === 'network') return bot.say(request, SEND_TEXT.network);
      if (error.code === 'no_amount') return bot.say(request, SEND_TEXT.noAmount);
      if (error.code === 'signature') return bot.say(request, SEND_TEXT.signature);
      return bot.say(request, SEND_TEXT.invalid);
    }
    if (lease.key.network && lease.key.network !== decoded.network)
      return bot.say(request, SEND_TEXT.network);
    // Before anything is pruned: that may only ever follow this check.
    if (this.#mayHavePaid(sender, decoded.paymentHash))
      return bot.say(request, SEND_TEXT.duplicate);
    this.expireOld();
    // The cap below counts what must be kept, not what is merely still around.
    this.#prune();
    const refusal = this.#refusal(sender, decoded);
    if (refusal) return bot.say(request, refusal);
    if (this.all.some((r) => r.requester === sender && r.state === 'prepared'))
      return bot.say(request, SEND_TEXT.open);
    const time = now();
    const record = {
      id: randomBytes(16).toString('hex'),
      requester: sender,
      connection: lease.id,
      ref: lease.ref,
      paymentHash: decoded.paymentHash,
      msat: decoded.amountMsat,
      state: 'prepared',
      createdAt: time,
      updatedAt: time,
      checks: 0,
      previewExpires: Math.min(
        time + this.limits.previewSeconds,
        decoded.expiresAt - EXPIRY_MARGIN,
      ),
      invoiceExpires: decoded.expiresAt,
    };
    return bot.say(
      request,
      SEND_TEXT.preview({
        msat: record.msat,
        memo: sanitizeMemo(decoded.description),
        destination: decoded.destination,
        expires: decoded.expiresAt,
        minutes: Math.max(1, Math.round((record.previewExpires - time) / 60)),
        label: lease.label || 'your wallet',
      }),
      () => {
        this.all.push(record);
        this.#waiting.set(record.id, decoded.invoice);
        this.#prune();
      },
      { keyboard: this.keyboard(record), selfCopy: false },
    );
  }
  keyboard(record) {
    return {
      inline_keyboard: [
        [{ text: `Pay ${sats(record.msat)}`, callback_data: `s:ok:${shortId(record)}` }],
        [{ text: 'Cancel', callback_data: `s:no:${shortId(record)}` }],
      ],
    };
  }
  // pressed: the record being paid, which is not one more on top of itself.
  #refusal(sender, { expiresAt, amountMsat }, pressed) {
    if (expiresAt - EXPIRY_MARGIN <= now()) return SEND_TEXT.expired;
    if (expiresAt > now() + MAX_INVOICE_LIFE) return SEND_TEXT.farExpiry;
    const held = this.all.filter(
      (r) => r.requester === sender && r !== pressed && this.#mustKeep(r),
    ).length;
    if (held >= MAX_HELD_PER_PERSON) return SEND_TEXT.tooMany;
    if (this.all.length >= MAX_RECORDS && held >= FAIR_SHARE) return SEND_TEXT.tooMany;
    if (amountMsat > this.limits.maxSats * 1000) return SEND_TEXT.perPayment(this.limits.maxSats);
    if (this.all.some((r) => r.requester === sender && IN_FLIGHT.includes(r.state)))
      return SEND_TEXT.busy;
    if (this.#spent(sender) + amountMsat > this.limits.dailySats * 1000)
      return SEND_TEXT.daily(this.limits.dailySats);
    const recent = this.all.filter(
      (r) =>
        r.requester === sender &&
        (r.sentAt ?? r.updatedAt) >= now() - HOUR &&
        COUNTED.includes(r.state),
    ).length;
    if (recent >= this.limits.perHour) return SEND_TEXT.hourly;
    const asked = this.all.filter(
      (r) => r.requester === sender && r !== pressed && r.createdAt >= now() - HOUR,
    ).length;
    if (asked >= PREVIEWS_PER_HOUR) return SEND_TEXT.hourly;
    return undefined;
  }
  // Waiting too long is the same as being cancelled.
  expireOld() {
    let changed = false;
    for (const record of this.all)
      if (record.state === 'prepared' && record.previewExpires <= now()) {
        this.#move(record, 'cancelled', { error: 'expired' });
        changed = true;
      }
    if (changed) this.bot.save();
  }

  // ---- The buttons, and /cancel ----------------------------------------------------------

  // Runs in the person's lane, with press.lease the wallet the preview was made for.
  async press(press, action, ref) {
    const { bot } = this;
    const { sender, lease } = press;
    const record = this.all.find(
      (r) =>
        r.requester === sender && REF.test(ref) && shortId(r) === ref && r.connection === lease.id,
    );
    const done = (text) => bot.say(press, text, undefined, { keyboard: { inline_keyboard: [] } });
    if (!record) return done(SEND_TEXT.gone);
    if (record.state !== 'prepared') return done(alreadyText(record));
    const stop = (error, text) => {
      this.#move(record, 'cancelled', { error });
      bot.save();
      return done(text);
    };
    if (action === 'no') return stop(undefined, this.cancelText(sender));
    const invoice = this.#waiting.get(record.id);
    if (!invoice || record.previewExpires <= now()) return stop('expired', SEND_TEXT.stalePreview);
    if (!lease.spends) return stop('scope', SEND_TEXT.noSpend);
    // Everything is checked again: time passed since the preview.
    const decoded = { expiresAt: record.invoiceExpires, amountMsat: record.msat };
    const refusal = this.#refusal(sender, decoded, record);
    if (refusal) return stop('limit', refusal);
    if (this.#mayHavePaid(sender, record.paymentHash))
      return stop('duplicate', SEND_TEXT.duplicate);
    const blocked = await this.#walletAllows(lease, record);
    // Waited for the wallet: disconnected meanwhile, or the like.
    if (record.state !== 'prepared') return done(alreadyText(record));
    if (blocked) return stop('wallet', blocked);
    // The operator's revocation counts from when it finished, not from the next regular look.
    bot.wallets.check?.();
    if (record.state !== 'prepared') return done(alreadyText(record));
    // The database was too busy to apply what the ledger may already say: it is not known yet.
    if (bot.wallets.unfinished) return stop('off', SEND_TEXT.cannotCheck);
    if (!lease.valid()) return stop('off', SEND_TEXT.switchedOff);
    // What was shown, or the press itself, may have run out while this waited.
    const pressLate = press.button.request.expires <= now();
    if (
      record.previewExpires <= now() ||
      record.invoiceExpires - EXPIRY_MARGIN <= now() ||
      pressLate
    ) {
      // Settled before anything is awaited: the record may not stay as it is during a wait.
      const answered = stop('expired', SEND_TEXT.stalePreview);
      // Too late to answer the press itself: Anagram would ignore it.
      if (pressLate) await this.#notify(record, SEND_TEXT.stalePreview);
      return answered;
    }
    return this.#pay(press, record, lease, invoice);
  }
  // "Nothing was paid" is only true of what was cancelled, not of what went before.
  cancelText(sender) {
    return this.all.some(
      (r) => r.requester === sender && [...IN_FLIGHT, 'unknown'].includes(r.state),
    )
      ? SEND_TEXT.cancelledEarlier
      : SEND_TEXT.cancelled;
  }
  // What the wallet itself says right before paying. Returns why not, or undefined. It fails
  // closed: nothing has been spent, and the person can simply try again.
  async #walletAllows(lease, record) {
    const client = this.bot.api(lease);
    const signal = this.bot.signal(lease);
    return this.#urgent(client, () => this.#askWallet(client, signal, lease, record));
  }
  #urgent(client, action) {
    return client.urgent ? client.urgent(action) : action();
  }
  async #askWallet(client, signal, lease, record) {
    try {
      // Asked anew for every payment: a connection that gained more power is switched off.
      await client.verify(lease.key, { signal, fresh: true });
      const { totalMsat, usedMsat } = await client.budget(lease.key, { signal });
      if (!(totalMsat > 0)) return SEND_TEXT.budget;
      if (record.msat > totalMsat - usedMsat) return SEND_TEXT.overBudget;
      // Anything under this hash stops it. Even a failed row: NIP-47 lets a wallet call a timeout
      // a failure, and the payment may still be in flight.
      const known = await client.lookupPayment(lease.key, record.paymentHash, { signal });
      return known ? SEND_TEXT.alreadyInWallet : undefined;
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      if (error.code === 'admin_key') {
        this.bot.switchOff(lease.id, lease.owner);
        return SEND_TEXT.switchedOff;
      }
      return SEND_TEXT.cannotCheck;
    }
  }
  // Durable before the wallet is asked. One request, ever: an unknown outcome is looked up.
  async #pay(press, record, lease, invoice) {
    const { bot } = this;
    const who = nip19.npubEncode(record.requester);
    this.#move(record, 'sending', { sentAt: now() });
    bot.save();
    let result;
    try {
      const client = bot.api(lease);
      result = await this.#urgent(client, () =>
        client.pay(lease.key, invoice, { signal: bot.signal(lease) }),
      );
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      const certain = CERTAIN.has(error.walletCode) || (error.definite && !error.walletCode);
      if (certain) {
        this.#move(record, 'failed', { error: error.walletCode ?? error.code });
        bot.save();
        bot.log(`A payment for ${who} failed (${error.walletCode ?? error.code}).`);
        return this.#tell(
          press,
          record,
          SEND_TEXT.failed(
            record.msat,
            WHY[error.walletCode] ?? 'your wallet could not be reached.',
          ),
        );
      }
      return this.#uncertain(press, record, error.walletCode ?? error.code);
    }
    // A wallet proves a payment with the preimage of the invoice's payment hash.
    if (!proves(result?.preimage, record.paymentHash))
      return this.#uncertain(press, record, 'bad_proof');
    const fees =
      Number.isSafeInteger(result.fees_paid) && result.fees_paid >= 0
        ? result.fees_paid
        : undefined;
    this.#move(record, 'paid', { feesMsat: fees });
    bot.save();
    bot.log(`A payment for ${who} went through.`);
    return this.#tell(press, record, SEND_TEXT.paid({ msat: record.msat, fees }));
  }
  // The outcome always arrives as a message: that cannot be lost to a press that has gone
  // stale or a wallet disconnected meanwhile. The card only points to it, so nobody reads the
  // same result twice and takes it for a second payment.
  async #tell(press, record, text) {
    const { bot } = this;
    await this.#notify(record, text);
    if (press?.button && !press.lease?.gone())
      return bot.say(press, SEND_TEXT.seeBelow, undefined, { keyboard: { inline_keyboard: [] } });
  }
  // About the account, so it is not withdrawn with the wallet: the person must hear it. No copy for
  // the bot's own key: a later leak of that key should not show what was spent.
  #notify(record, text) {
    return this.bot.notify(record.requester, text, { selfCopy: false, hadWallet: true });
  }
  #uncertain(press, record, why) {
    const { bot } = this;
    this.#move(record, 'uncertain', { error: String(why).slice(0, 40) });
    bot.save();
    bot.log(
      `A payment for ${nip19.npubEncode(record.requester)} is uncertain (${why}); it will not be sent again.`,
    );
    this.#schedule(record);
    return this.#tell(press, record, SEND_TEXT.uncertain(record.msat));
  }
  #schedule(record) {
    const { bot } = this;
    if (bot.stopped) return;
    const delays = this.checkDelays;
    const timer = setTimeout(
      () => {
        bot.timers.delete(timer);
        if (!bot.lane(record.requester, () => this.#check(record))) this.#schedule(record);
      },
      delays[Math.min(record.checks, delays.length - 1)] * 1000,
    );
    bot.timers.add(timer);
  }
  // Asks the wallet what happened, and records it if that settles it. Only ever looks: this path
  // has no way to pay. Returns the new state if it changed.
  async #reconcile(lease, record) {
    const known = await this.bot
      .api(lease)
      .lookupPayment(lease.key, record.paymentHash, { signal: this.bot.signal(lease) });
    if (this.bot.stopped || lease.gone() || !NEXT[record.state]) return undefined;
    if (!known || known.outgoing === false) return undefined;
    if (
      known.state === 'settled' &&
      known.amountMsat === record.msat &&
      proves(known.preimage, record.paymentHash)
    ) {
      this.#move(record, 'paid', { feesMsat: known.feesMsat, error: undefined });
      this.bot.save();
      return 'paid';
    }
    // Failed is believed only for an invoice that can no longer be paid at all.
    if (
      known.state === 'failed' &&
      record.state !== 'failed' &&
      record.invoiceExpires + FAILED_MARGIN <= now()
    ) {
      this.#move(record, 'failed', { error: 'lookup' });
      this.bot.save();
      return 'failed';
    }
    return undefined;
  }
  async #check(record) {
    const { bot } = this;
    if (bot.stopped || record.state !== 'uncertain') return;
    const lease = bot.wallets.leaseById(record.connection);
    // Suspended for now, not disconnected: this says nothing about the payment.
    if (!lease && bot.wallets.broken) return this.#schedule(record);
    const finish = () => {
      this.#move(record, 'unknown');
      bot.save();
      const off = bot.wallets.connection?.(record.connection)?.disabled;
      const text = lease ? SEND_TEXT.unknown : off ? SEND_TEXT.unknownOff : SEND_TEXT.unknownGone;
      return this.#notify(record, text(record.msat));
    };
    if (!lease) return finish();
    let settled;
    try {
      // Urgent as the payment was. A Refresh is not: anyone could press that as often as allowed.
      settled = await this.#urgent(bot.api(lease), () => this.#reconcile(lease, record));
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
    }
    if (bot.stopped || record.state !== 'uncertain') {
      if (settled === 'paid')
        return this.#notify(record, SEND_TEXT.paid({ msat: record.msat, fees: record.feesMsat }));
      if (settled === 'failed') return this.#notify(record, SEND_TEXT.reportedFailed(record.msat));
      return undefined;
    }
    record.checks += 1;
    record.updatedAt = now();
    if (record.checks >= this.checkDelays.length) return finish();
    bot.save();
    this.#schedule(record);
  }
  // /cancel: a payment still waiting for its confirmation.
  cancelOpen(sender) {
    const record = this.all.find((r) => r.requester === sender && r.state === 'prepared');
    if (!record) return false;
    this.#move(record, 'cancelled');
    this.bot.save();
    return true;
  }
  // A disconnected wallet's waiting payments go with it.
  connectionRevoked(id) {
    for (const record of this.all)
      if (record.connection === id && record.state === 'prepared')
        this.#move(record, 'cancelled', { error: 'disconnected' });
  }
  // After a restart: what was waiting is cancelled, because its invoice was only in memory. A
  // payment that was on its way may have gone out. Never sent again.
  recover() {
    for (const record of this.all) {
      if (record.state === 'prepared') {
        this.#move(record, 'cancelled', { error: 'restart' });
        this.bot.save();
      } else if (record.state === 'sending') {
        this.#move(record, 'uncertain', { error: 'restart' });
        this.bot.save();
        this.bot.log(
          `A payment was interrupted by a restart; checking, and it will not be sent again.`,
        );
        void this.#notify(record, SEND_TEXT.uncertain(record.msat));
      }
      if (record.state === 'uncertain') this.#schedule(record);
    }
  }

  // ---- The Send button -------------------------------------------------------------------

  ask(press) {
    const { bot } = this;
    const { sender, lease } = press;
    if (!lease.spends) return bot.say(press, SEND_TEXT.noSpend);
    bot.awaiting.delete(sender);
    bot.awaiting.set(sender, { ref: lease.ref, at: now(), kind: 'send' });
    return bot.say(press, SEND_TEXT.ask(lease.label), undefined, {
      keyboard: rows([{ text: 'Cancel', callback_data: 'inv:cancel' }]),
    });
  }

  // ---- /payments -------------------------------------------------------------------------
  //
  // What was sent from one wallet, like /invoices: the one in use, or the one a menu was made for.
  // Only that exact link shows them. Refresh only ever looks. A lookup that fails changes nothing.

  #forWallet(lease) {
    return this.all
      .filter(
        (r) =>
          r.requester === lease.owner &&
          r.ref === lease.ref &&
          !['prepared', 'cancelled'].includes(r.state),
      )
      .reverse();
  }
  // Settles what can be settled. A failed lookup is not an answer: returns whether one failed.
  async #refresh(lease, record) {
    if (!['uncertain', 'unknown'].includes(record.state) && record.error !== 'lookup') return false;
    try {
      await this.#reconcile(lease, record);
      return false;
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      return true;
    }
  }
  listCommand(request) {
    const { bot } = this;
    const lease = (request.lease ??= bot.wallets.lease(request.sender));
    if (!lease) return bot.say(request, SEND_TEXT.noSpend);
    return this.list(request, 0);
  }
  async list(request, page) {
    const { bot } = this;
    const { lease } = request;
    const all = this.#forWallet(lease);
    const offset = page * PAGE_SIZE;
    const records = all.slice(offset, offset + PAGE_SIZE);
    // One at a time: a wallet takes only a few requests at once. A wallet not answering is asked
    // no further.
    let failed = false;
    for (const record of records) failed ||= await this.#refresh(lease, record);
    if (lease.gone()) return undefined;
    const wallet = sanitizeMemo(lease.label);
    const lines = records.map((record, index) => {
      const fee = record.state === 'paid' && record.feesMsat !== undefined;
      return `${index + 1}. ${sats(record.msat)} · ${SHOWN[record.state]} · ${date(record.createdAt)}${fee ? ` · fee ${sats(record.feesMsat)}` : ''}`;
    });
    const text = records.length
      ? [
          `Payments sent${wallet ? ` (${wallet})` : ''} ${offset + 1}–${offset + records.length} of ${all.length}, newest first:`,
          ...lines,
          ...(failed ? ['I could not check some of these with the wallet just now.'] : []),
          'Press a number for details. Invoices you received are under /invoices.',
        ].join('\n')
      : offset
        ? `No older payments${wallet ? ` from ${wallet}` : ''}.`
        : `No payments sent from here yet${wallet ? ` from ${wallet}` : ''}. Paste an invoice to pay one.`;
    const more = all.length > offset + records.length;
    return bot.say(request, text, undefined, {
      keyboard: rows(
        records.slice(0, 4).map((record, index) => this.#numberButton(record, page, index)),
        records.slice(4).map((record, index) => this.#numberButton(record, page, index + 4)),
        [
          ...(more && page + 1 < MAX_PAYMENT_PAGES
            ? [{ text: 'Older', callback_data: `pm:${page + 1}` }]
            : []),
          ...(page > 0 ? [{ text: 'Newer', callback_data: `pm:${page - 1}` }] : []),
        ],
        [{ text: 'Refresh', callback_data: `pm:${page}` }],
        [
          { text: 'Invoices', callback_data: 'iv:0' },
          { text: 'History', callback_data: 'hist:0' },
        ],
      ),
      command: true,
      selfCopy: false,
    });
  }
  #numberButton(record, page, index) {
    return { text: String(index + 1), callback_data: `pm:${page}:${shortId(record)}` };
  }
  async detail(press, ref, page) {
    const { bot } = this;
    const { lease } = press;
    const record = this.#forWallet(lease).find((r) => shortId(r) === ref);
    if (!record) return bot.say(press, SEND_TEXT.gone, undefined, { keyboard: bot.menu });
    const failed = await this.#refresh(lease, record);
    if (lease.gone()) return undefined;
    const wallet = sanitizeMemo(lease.label);
    return bot.say(
      press,
      [
        `Payment of ${sats(record.msat)}: ${
          record.error === 'lookup' && record.state === 'failed'
            ? 'your wallet reports it failed. Check its history if in doubt.'
            : SAID[record.state]
        }`,
        `Status: ${SHOWN[record.state]}`,
        ...(wallet ? [`Wallet: ${wallet}`] : []),
        `Created: ${date(record.createdAt)}`,
        ...(record.state === 'paid' && record.feesMsat !== undefined
          ? [`Routing fee: ${sats(record.feesMsat)}`]
          : []),
        `Payment hash: ${record.paymentHash}`,
        ...(failed ? ['I could not check it with the wallet just now. Nothing has changed.'] : []),
      ].join('\n'),
      undefined,
      {
        keyboard: rows(
          [{ text: 'Refresh', callback_data: `pm:${page}:${shortId(record)}` }],
          [{ text: 'All payments', callback_data: `pm:${page}` }],
        ),
      },
    );
  }
}
