import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import {
  ConfigurationError,
  Network,
  now,
  rumor,
  sign,
  single,
  State,
  unwrap,
  wrap,
} from './vendor/runtime.js';
import { BotTransport } from './vendor/bot.js';
import { readTicket } from './vendor/private-groups.js';
import { loadConfig } from './config.js';
import { loadWallets } from './wallets.js';
import { ConnectService } from './connect.js';
import { Origins } from './net-guard.js';
import { NwcClient } from './nwc.js';
import { Registry } from './registry.js';
import {
  BARE_INVOICE,
  MAX_PAYMENT_PAGES,
  PAYMENT_VIEW,
  SEND_ACTION,
  SEND_ASK,
  SEND_TEXT,
  SendFlow,
} from './send.js';
import { DB_FILE } from './store.js';
import { Queue } from './queue.js';
import { LNbitsClient, LNbitsError, MAX_HISTORY } from './lnbits.js';
import { externalId, Invoices } from './invoices.js';
import { PaymentWatcher } from './notify.js';
import {
  BOT_CONTROL_KIND,
  COMMAND_TAG,
  controlTag,
  keyboardTag,
  parseControl,
} from './vendor/botKeyboardProtocol.ts';
import {
  ACCOUNT_REF,
  Buttons,
  callbacks,
  confirmKeyboard,
  connectKeyboard,
  noticeKeyboard,
  waitingKeyboard,
  EMPTY,
  historyKeyboard,
  INVOICE_VIEW,
  invoiceDetailKeyboard,
  invoiceKeyboard,
  invoicesKeyboard,
  MAX_INVOICE_PAGES,
  MAX_PAGES,
  menuKeyboard,
  statusRef,
  WALLET_ACTION,
  walletsKeyboard,
} from './buttons.js';
import {
  balanceText,
  BUTTON_TEXT,
  CONNECT_TEXT,
  CUSTOM_TEXT,
  forWallet,
  MENU_TEXT,
  failureText,
  helpText,
  historyText,
  INVOICE_PAGE_SIZE,
  INVOICE_TEXT,
  invoiceDetailText,
  invoiceFailureText,
  invoiceListText,
  invoiceMemo,
  invoiceText,
  looksLikeSecret,
  parseCommand,
  SECRET_WARNING,
  USAGE,
  walletName,
  WALLET_TEXT,
} from './commands.js';

const HOUR = 3600;
const DAY = 86400;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LANE_LIMIT = 20; // waiting jobs per person
const STRANGERS_PER_HOUR = 120; // answers to people with no wallet here, overall
const STRANGER_PER_PERSON = 5; // and to each of them
const MAX_STRANGER_LANES = 5000;
const CUSTOM_SECONDS = 300; // how long the Custom button waits for an amount
const OUTBOX_FULL = 1000; // the transport refuses new messages at this size (vendor/bot.js)
const DISCONNECT_STEP = /^w:(?:del|delok):/;
const DISCONNECT_STEPS_PER_HOUR = 20; // these have their own limit, not the general one
// An /invoice older than this is not acted on: it may be a relay resending something the bot
// handled before an older state.json was put back, and the person has moved on either way.
const INVOICE_MAX_AGE = HOUR;
const MAX_CLAIMS = 20; // older records checked per view: each is one lookup, once

// How a message moves through the bot:
//   relay event -> receive() -> unwrap() (NIP-17: wrap, seal, rumor; the seal signature
//   authenticates the sender) -> directMessage() checks the Nostr rules -> handle() checks
//   replay, the operator's wallet links, grant time and limits, then records the message as
//   handled -> the sender's lane -> process() -> command (wallet commands call LNbits with
//   the sender's own invoice key, from wallets.json) -> say() signs the answer into the
//   durable outbox -> flush() publishes it.
// A button press takes the same path from unwrap() on, through buttonRequest() instead of
// directMessage() and handle(), to press() in the sender's lane; say() then answers it
// privately (answer()) instead of replying in the chat. See buttons.js.
//
// Relay subscriptions, the outbox and replay checks come from vendor/bot.js (the poll
// example's transport). This bot answers only direct messages: wallet data never goes to
// a group, so group invitations and public rooms are ignored.
export class WalletBot extends BotTransport {
  constructor({
    store,
    net,
    wallets,
    lnbits,
    limits = {},
    // Seconds between the checks of an invoice request whose outcome is unknown. A second
    // invoice is never created automatically.
    checkDelays = [5, 30, 120, 600],
    // Payment notification timing and limits (see notify.js DEFAULTS); tests shorten them.
    notifications = {},
    // The self-service connection page (connect.js), if the operator enabled it.
    connect,
    // Limits for the experimental /send (send.js). Absent: sending is off.
    send,
    // Seconds a preset invoice button request must still be valid for when LNbits is asked,
    // so the answer can reach the person's app before the request expires.
    buttonMargin = 30,
    name = 'LNbits Wallet',
    log = console.log,
    onFatal = (error) => {
      throw error;
    },
  }) {
    // No reply cooldown: the per-person hourly limit below applies instead.
    super({ store, net, name, log, onFatal, cooldown: 0 });
    this.wallets = wallets;
    this.lnbits = lnbits;
    this.connect = connect;
    this.strangers = [];
    this.strangerTimes = new Map();
    // People asked for an amount by the Custom button: person -> { ref, at }. In memory: a
    // restart simply forgets the question, and the next number gets the help text.
    this.awaiting = new Map();
    this.sendConfig = send;
    this.limits = {
      requestsPerHour: 60,
      historyDefault: 5,
      maxInvoiceSats: 100000,
      invoiceExpiry: 3600,
      invoicesPerHour: 10,
      presets: [1000, 5000],
      ...limits,
    };
    this.invoices = new Invoices(this.state);
    this.buttons = new Buttons(this.state);
    this.buttonMargin = buttonMargin;
    // Button requests being answered right now: a relay resending one is not run twice.
    this.answering = new Set();
    this.checkDelays = checkDelays;
    this.timers = new Set();
    this.watcher = new PaymentWatcher(this, notifications);
    this.sends = this.sendConfig ? new SendFlow(this, this.sendConfig) : undefined;
    // People whose key LNbits confirmed as a non-admin key during this run.
    this.verified = new Set();
    // Cancels LNbits requests in progress when the bot stops.
    this.abort = new AbortController();
    this.lanes = new Map();
    this.replying = new Set();
    this.requests = new Map();
    this.leaving = new Map();
    this.notices = new Map();
    this.logged = new Map();
    // Deliveries of a revoked wallet. flush() works from a snapshot, so one could otherwise go
    // out after it was removed from the outbox.
    this.withdrawn = new Set();
    const publish = net.publish.bind(net);
    net.publish = async (event, ...rest) => {
      // Suspended during a flush already under way: the item stays queued and is tried later.
      if (this.wallets.broken) throw new Error('Wallets are suspended.');
      if (!this.withdrawn.has(event?.id)) return publish(event, ...rest);
    };
    this.authorize();
    // Database mode: links change while the bot runs (registry.js).
    wallets.listener = {
      revoked: (connection) => this.connectionRevoked(connection),
      suspended: (connection) => this.connectionSuspended(connection),
      added: () => this.connectionAdded(),
      changed: () => this.authorize(),
    };
  }
  // The wallet API for a lease: one LNbits instance in wallets.json mode.
  api(lease) {
    return lease.client ?? this.lnbits;
  }
  // Cancelled when the bot stops or the connection is revoked.
  signal(lease) {
    return AbortSignal.any([this.abort.signal, lease.signal]);
  }

  // Runs in the same synchronous step as the revocation. Replies still waiting for a relay
  // are dropped: one already accepted cannot be recalled, and was valid when it was made.
  // The wallet's menus stay on record so that pressing one says it is stale; it can never
  // match again, because a reconnected wallet has a new ref.
  connectionRevoked({ id, ref, owner }) {
    for (const item of this.state.outbox)
      if (item.connection === id) this.withdrawn.add(item.event.id);
    this.state.outbox = this.state.outbox.filter((item) => item.connection !== id);
    for (const [key, entry] of Object.entries(this.state.callbacks))
      if (
        entry.ref === ref ||
        entry.delivery?.connection === id ||
        (!entry.ref && key.startsWith(`${owner}:`))
      )
        delete this.state.callbacks[key];
    delete this.state.payments[ref];
    this.sends?.connectionRevoked(id);
    this.verified.delete(id);
    this.watcher.drop(id);
    this.save();
  }
  // The revocation history cannot be read right now (registry.js). Nothing was revoked, so
  // menus, payment state and queued replies all stay: the watch stops until it can be read.
  connectionSuspended({ id }) {
    this.verified.delete(id);
    this.watcher.drop(id);
  }
  connectionAdded() {
    if (this.started && !this.stopped)
      this.checking = this.checkWallets({ pending: true }).catch(() => {});
  }

  // ---- Receiving -------------------------------------------------------------------------

  shouldReply(message) {
    return (
      typeof message.content === 'string' &&
      message.content.length <= 8000 &&
      super.shouldReply(message)
    );
  }
  receive(event, key, group) {
    if (group) return; // No group is ever joined, so this is not reached.
    this.submit(event.id, async () => {
      const opened = unwrap(event, key);
      if (opened?.message.kind === BOT_CONTROL_KIND) this.buttonRequest(opened.message);
      else if (opened) await this.directMessage(opened.message, opened.seal);
    });
  }
  async directMessage(message, seal) {
    if (message.kind === 1014) return this.privateTicket(message, seal);
    if (
      message.kind !== 14 ||
      single(message, 'p') !== this.pubkey ||
      message.tags.some((t) => ['h', 'epoch', 'member'].includes(t[0]))
    )
      return;
    await this.handle(message);
  }
  // Wallet answers stay in DMs. A valid invitation is logged and dropped, never stored.
  privateTicket(message, seal) {
    if (readTicket(message, seal, this.pubkey))
      this.note(message.pubkey, `Ignored a private group invitation: this bot only answers DMs.`);
  }
  refreshPrivate() {}
  refreshPublic() {}
  // The transport's discovery of public rooms that trust the bot is not used.
  setWatch(name, ...args) {
    if (name !== 'discovery') super.setWatch(name, ...args);
  }

  // ---- Button presses --------------------------------------------------------------------
  //
  // A press arrives as its own encrypted kind 21118 rumor, authenticated like a DM (the seal
  // signer is the sender). It is answered only when every check passes: a well-formed
  // request for this bot in its DM, not expired, from a linked person, for a card this bot
  // sent to that same person, and for a button that card (or the bot's answer on it)
  // really offers. Nothing in the request chooses a wallet: the key still comes only from
  // wallets.json. Anything else is dropped without an answer.
  buttonRequest(message) {
    const request = parseControl(message.tags);
    const time = now();
    if (
      request?.op !== 'request' ||
      message.tags.filter((t) => t[0] === 'p').length !== 1 ||
      single(message, 'p') !== this.pubkey ||
      message.pubkey === this.pubkey ||
      message.content !== '' ||
      request.target.type !== 'dm' ||
      request.target.bot !== this.pubkey ||
      // Cards are never edited, so a card's current version is the card itself.
      request.target.version !== request.target.root ||
      request.expires <= time ||
      request.expires > message.created_at + 300 ||
      message.created_at > time + 60 ||
      message.created_at < time - 300 ||
      message.created_at < this.state.startedAt ||
      this.stopped ||
      this.wallets.broken
    )
      return;
    const sender = message.pubkey;
    if (!this.wallets.linked(sender)) return this.ignoredSender(sender);
    if (!this.allowedWhenWritten(message)) return;
    const key = `${sender}:${request.id}`;
    const done = this.buttons.answered(key);
    // A retry of a request already answered gets the same answer again, nothing more. The
    // same id with different contents is someone else's guess or a broken client: dropped.
    // Nothing is resent for a wallet that was disconnected since.
    if (done) {
      if (done.ref && this.wallets.menuState(sender, done.ref) === 'stale') return;
      if (this.state.outbox.length >= OUTBOX_FULL || done.fingerprint !== message.id) return;
      // A retry costs a disk write, so it counts like any other press.
      if (this.rateLimit(sender) !== 'ok') return;
      return this.resend(done);
    }
    if (this.answering.has(key)) return;
    const card = this.buttons.card(request.target.root);
    if (!card || card.owner !== sender) return;
    if (!this.buttons.allowed(card, request.view)?.includes(request.data)) return;
    // Leaving a wallet does not wait behind a slow LNbits request, and neither the hourly limit
    // nor a busy bot can stop it. Its steps have a small limit of their own, so that they cannot
    // be used to flood the bot. A disconnect itself still happens over that limit, unanswered.
    const leaving = DISCONNECT_STEP.test(request.data);
    if (
      !leaving &&
      (this.state.outbox.length >= OUTBOX_FULL || this.lanes.get(sender)?.full || this.buttons.full)
    )
      return;
    const disconnected = this.disconnectNow(sender, request.data);
    const limit = leaving ? this.leavingLimit(sender) : this.rateLimit(sender);
    if (limit === 'silent') return;
    this.answering.add(key);
    const press = { message, sender, disconnected, button: { request, card, key } };
    const queued = this.lane(sender, async () => {
      try {
        await (limit === 'notice' ? this.say(press, BUTTON_TEXT.limit) : this.press(press));
      } finally {
        this.answering.delete(key);
      }
    });
    if (!queued) this.answering.delete(key);
  }
  resend(done) {
    if (this.state.outbox.some((item) => item.event.id === done.delivery.event.id)) return;
    this.state.outbox.push({ ...done.delivery, queuedAt: now() });
    this.save();
  }

  // Runs in the person's lane, like their commands.
  async press(press) {
    const { sender, button } = press;
    if (button.request.data.startsWith('w:')) return this.walletAction(press);
    const state = this.wallets.menuState(sender, button.card.ref);
    if (state === 'off')
      return this.say(press, BUTTON_TEXT.switchedOff, undefined, { keyboard: EMPTY });
    // The menu was made for a wallet no longer connected to this person: stale, for good.
    if (state === 'stale')
      return this.say(press, BUTTON_TEXT.relinked, undefined, { keyboard: EMPTY });
    // Everything below acts on the wallet the menu was made for, whichever is in use now.
    press.lease = this.wallets.lease(sender, button.card.ref);
    const send = SEND_ACTION.exec(button.request.data);
    if (send) return this.sends?.press(press, send[1], send[2]);
    if (button.request.data === SEND_ASK) return this.sends?.ask(press);
    const payment = PAYMENT_VIEW.exec(button.request.data);
    if (payment) {
      const page = Number(payment[1]);
      if (!this.sends || page >= MAX_PAYMENT_PAGES) return;
      return payment[2] ? this.sends.detail(press, payment[2], page) : this.sends.list(press, page);
    }
    const view = INVOICE_VIEW.exec(button.request.data);
    if (view) {
      const page = Number(view[1]);
      if (page >= MAX_INVOICE_PAGES) return;
      return view[2] ? this.invoiceDetail(press, view[2], page) : this.invoiceList(press, page);
    }
    const [action, value = '', ...rest] = button.request.data.split(':');
    const number = /^[0-9]{1,8}$/.test(value) ? Number(value) : NaN;
    if (rest.length) return;
    if (action === 'bal' && !value) return this.walletCommand(press, { name: 'balance' });
    if (action === 'hist' && number < MAX_PAGES)
      return this.walletCommand(press, { name: 'history', page: number });
    if (action === 'inv' && value === 'custom') return this.askForAmount(press);
    if (action === 'inv' && value === 'cancel') {
      return this.say(press, this.cancelAll(sender) ?? SEND_TEXT.nothing);
    }
    if (action === 'inv' && number >= 1) return this.presetInvoice(press, number);
    if (action === 'st' && /^[a-f0-9]{12}$/.test(value)) return this.invoiceDetail(press, value, 0);
  }
  get menu() {
    return menuKeyboard(
      this.limits.presets.filter((sats) => sats <= this.limits.maxInvoiceSats),
      { manageable: this.wallets.manageable, sending: Boolean(this.sends) },
    );
  }

  // ---- Wallet management -----------------------------------------------------------------
  //
  // Every action looks only in the sender's own list, so another person's wallet behaves
  // exactly like one that does not exist, whatever a request names.
  ownWallet(sender, id) {
    return this.wallets.list(sender).find((wallet) => wallet.id === id);
  }
  // Runs before the person's lane: their other work may be waiting for LNbits.
  disconnectNow(sender, data) {
    const [, action, id] = WALLET_ACTION.exec(data) ?? [];
    if (action !== 'delok' || !this.wallets.manageable) return undefined;
    const wallet = this.ownWallet(sender, id);
    if (!wallet) return undefined;
    this.wallets.revoke(id, 'user');
    this.log(`A wallet was disconnected by ${nip19.npubEncode(sender)}.`);
    return wallet;
  }
  walletsView(sender) {
    const wallets = this.wallets.list(sender);
    if (!wallets.length)
      return { text: this.connect ? WALLET_TEXT.noneConnect : WALLET_TEXT.none, keyboard: EMPTY };
    return {
      text: WALLET_TEXT.list(wallets),
      keyboard: walletsKeyboard(wallets, { connectable: Boolean(this.connect) }),
    };
  }
  // A one-time link for the authenticated sender: nothing in a message can name another
  // account. The link goes to their encrypted DM only, with no copy for the bot.
  connectLink(sender) {
    const url = this.connect?.issue(sender);
    if (!url)
      return {
        text: this.connect ? CONNECT_TEXT.limit(this.connect.linkWait(sender)) : CONNECT_TEXT.off,
        keyboard: EMPTY,
      };
    // Anagram's buttons are HTTPS only. A plain link is for a local test setup.
    if (!url.startsWith('https:')) return { text: CONNECT_TEXT.linkPlain(url), keyboard: EMPTY };
    return { text: CONNECT_TEXT.link, keyboard: connectKeyboard(url) };
  }
  connectCommand(request) {
    const { text, keyboard } = this.connectLink(request.sender);
    return this.say(request, text, undefined, { keyboard, account: true, selfCopy: false });
  }
  // A message that answers nothing in the chat, sent to one account.
  notify(owner, text, options = {}) {
    const request = {
      message: { id: randomBytes(32).toString('hex'), pubkey: owner },
      sender: owner,
      plain: true,
    };
    return this.say(request, text, undefined, { account: true, ...options }).finally(() => {
      void this.flush().catch(() => {});
    });
  }
  // The page's steps that need the person's encrypted DM.
  sendConnectCode(owner, details) {
    return this.notify(owner, CONNECT_TEXT.code(details), { selfCopy: false });
  }
  connectFinished(owner, connection) {
    const { keyboard } = this.walletsView(owner);
    const spends = this.wallets.list(owner).find((w) => w.id === connection.id)?.spends;
    const text = spends ? CONNECT_TEXT.doneSpend : CONNECT_TEXT.done;
    return this.notify(owner, text(walletName(connection)), { keyboard });
  }
  // /wallets and /disconnect: the person's wallets, as a card about the account.
  walletsCommand(request) {
    if (!this.wallets.manageable) return this.say(request, WALLET_TEXT.managed);
    const { text, keyboard } = this.walletsView(request.sender);
    return this.say(request, text, undefined, { keyboard, account: true });
  }
  async walletAction(press) {
    const { sender, button, disconnected } = press;
    const [, action, id] = WALLET_ACTION.exec(button.request.data) ?? [];
    const view = () => this.walletsView(sender);
    const show = (text, { keyboard } = view()) => this.say(press, text, undefined, { keyboard });
    if (!this.wallets.manageable)
      return this.say(press, WALLET_TEXT.managed, undefined, { keyboard: EMPTY });
    if (disconnected) {
      const rest = view();
      return show(`${WALLET_TEXT.disconnected(disconnected)}\n\n${rest.text}`, rest);
    }
    if (button.request.data === 'w:new') {
      const { text, keyboard } = this.connectLink(sender);
      return this.say(press, text, undefined, { keyboard });
    }
    if (!action) return show(view().text);
    const wallet = this.ownWallet(sender, id);
    if (!wallet) return show(`${WALLET_TEXT.gone}\n\n${view().text}`);
    if (action === 'del') {
      // About this wallet, so it goes with it, even when asked from another wallet's menu.
      press.lease = this.wallets.leaseById(id);
      return this.say(press, WALLET_TEXT.confirm(wallet), undefined, {
        keyboard: confirmKeyboard(id),
      });
    }
    if (action === 'use') {
      this.wallets.select(sender, id);
      return show(`${WALLET_TEXT.selected(wallet)}\n\n${view().text}`);
    }
    // 'delok' for a wallet that is still here: only when management is off, handled above.
  }

  // Called for every valid DM addressed to the bot.
  async handle(message) {
    // Who may do what is not known right now. Relays resend it once it is (see registry.js).
    if (this.wallets.broken || !this.shouldReply(message)) return;
    // Strangers get no answer and cannot make the bot write to disk. People whose link was
    // switched off are still answered, so they learn why their wallet commands stopped.
    if (!this.wallets.linked(message.pubkey)) return this.stranger(message);
    // Written before this person was linked: relays resend history after a restart.
    if (!this.allowedWhenWritten(message)) return;
    if (this.stopped || this.lanes.get(message.pubkey)?.full) return;
    // Over the limit and already told: nothing is written, so a flood costs no disk and leaves
    // nothing behind. Should a relay resend one after a restart, it faces the limit again.
    const limit = this.rateLimit(message.pubkey);
    if (limit === 'silent') return;
    // From here on the message is handled exactly once, even if it fails or a relay
    // resends it later. Persist that before doing anything slow.
    this.markSeen(message);
    const request = { message, sender: message.pubkey };
    if (limit === 'notice')
      return this.lane(message.pubkey, () =>
        this.say(
          request,
          'You have reached the hourly limit for this bot. Please try again later.',
        ),
      );
    this.lane(message.pubkey, () => this.process(request));
  }

  // Someone with no wallet here. Normally ignored, without a disk write. With self-service
  // connections on, a recent /connect or /help gets an answer (and a key pasted in chat gets
  // a warning), within limits per person and overall. Limits come first: over them, nothing
  // is written. Their queue goes when it is empty, so strangers leave nothing behind.
  stranger(message) {
    const { pubkey, content } = message;
    if (!this.connect) return this.ignoredSender(pubkey);
    const wanted =
      looksLikeSecret(content) || ['connect', 'help'].includes(parseCommand(content)?.name);
    if (!wanted) return this.ignoredSender(pubkey);
    const time = now();
    this.strangers = this.strangers.filter((t) => t > time - HOUR);
    if (
      message.created_at < time - 300 ||
      this.stopped ||
      this.strangers.length >= STRANGERS_PER_HOUR ||
      (!this.lanes.has(pubkey) && this.lanes.size >= MAX_STRANGER_LANES) ||
      this.lanes.get(pubkey)?.full
    )
      return;
    const recent = (this.strangerTimes.get(pubkey) ?? []).filter((t) => t > time - HOUR);
    if (recent.length >= STRANGER_PER_PERSON) return;
    recent.push(time);
    this.strangerTimes.delete(pubkey);
    this.strangerTimes.set(pubkey, recent);
    bound(this.strangerTimes);
    this.strangers.push(time);
    this.markSeen(message);
    this.lane(pubkey, async () => {
      try {
        await this.process({ message, sender: pubkey, stranger: true });
      } finally {
        if (!this.lanes.get(pubkey)?.jobs.length) this.lanes.delete(pubkey);
      }
    });
  }

  // One serial Queue per person. Everything for one person keeps its order, while a slow
  // LNbits request for one person does not hold up the others or the relay message chain.
  lane(pubkey, job) {
    if (this.stopped) return false;
    let lane = this.lanes.get(pubkey);
    if (!lane) {
      lane = new Queue(LANE_LIMIT, (error) => this.fail(error));
      this.lanes.set(pubkey, lane);
    }
    return lane.push(job);
  }
  fail(error) {
    if (this.stopped) return;
    this.stopped = true;
    this.onFatal(error);
  }

  // ---- Commands --------------------------------------------------------------------------

  async process(request) {
    const { message } = request;
    // Disconnected while this waited its turn.
    if (!request.stranger && !this.wallets.linked(request.sender)) return;
    // Checked before anything else looks at the text. The text itself is never logged.
    if (looksLikeSecret(message.content)) {
      this.log(`Refused a message from ${nip19.npubEncode(request.sender)}: it looked like a key.`);
      return this.say(request, SECRET_WARNING);
    }
    const command = parseCommand(message.content);
    // The answer to Custom, if this is one. Any command replaces the question.
    if (!request.stranger && this.awaiting.has(request.sender)) {
      if (command) {
        if (command.name !== 'cancel') this.awaiting.delete(request.sender);
      } else return this.customAmount(request);
    }
    // A pasted invoice is the same as /send: it only ever leads to a preview.
    if (!request.stranger && this.sends && !command && BARE_INVOICE.test(message.content.trim()))
      return this.sends.command(request, message.content.trim());
    if (request.stranger)
      return command?.name === 'connect'
        ? this.connectCommand(request)
        : this.say(request, CONNECT_TEXT.welcome);
    // Plain text gets help, except in replies, so two bots cannot message each other forever.
    if (!command) return isReply(message) ? undefined : this.say(request, this.help(request));
    // Help offers the menu too, but is not a command result to fold away.
    if (command.name === 'help')
      return this.say(request, this.help(request), undefined, { keyboard: this.menu });
    if (command.name === 'balance' || command.name === 'history')
      return this.walletCommand(request, command);
    if (command.name === 'wallets' || command.name === 'disconnect')
      return this.walletsCommand(request);
    if (command.name === 'connect') return this.connectCommand(request);
    if (command.name === 'send')
      return this.sends
        ? this.sends.command(request, command.invoice)
        : this.say(request, SEND_TEXT.off);
    if (command.name === 'payments')
      return this.sends ? this.sends.listCommand(request) : this.say(request, SEND_TEXT.off);
    if (command.name === 'cancel') return this.cancelCommand(request);
    if (command.name === 'menu')
      return this.say(request, MENU_TEXT(this.wallets.label(request.sender)), undefined, {
        keyboard: this.menu,
      });
    if (command.name === 'invoice') return this.invoiceCommand(request, command);
    if (command.name === 'invoices') return this.invoicesCommand(request);
    if (command.name === 'usage') return this.say(request, USAGE[command.command]);
    return this.say(request, `Unknown command.\n\n${this.help(request)}`);
  }
  // The question being cancelled, in its own words.
  cancelledText(sender) {
    return this.awaiting.get(sender)?.kind === 'send'
      ? this.sends.cancelText(sender)
      : CUSTOM_TEXT.cancelled;
  }
  // The question and any payment still waiting: "Nothing was paid" has to stay true afterwards.
  cancelAll(sender) {
    const question = this.cancelledText(sender);
    const asked = this.awaiting.delete(sender);
    if (this.sends?.cancelOpen(sender)) return this.sends.cancelText(sender);
    return asked ? question : undefined;
  }
  cancelCommand(request) {
    return this.say(request, this.cancelAll(request.sender) ?? SEND_TEXT.nothing);
  }
  // The Custom button. The amount comes as the person's next message, for the wallet this menu
  // was made for, whichever is in use by then.
  askForAmount(press) {
    const { sender, lease } = press;
    this.awaiting.delete(sender);
    this.awaiting.set(sender, { ref: lease.ref, at: now() });
    bound(this.awaiting);
    return this.say(press, CUSTOM_TEXT.ask(lease.label, this.limits.maxInvoiceSats), undefined, {
      keyboard: waitingKeyboard(),
    });
  }
  customAmount(request) {
    const { sender, message } = request;
    const { ref, at, kind } = this.awaiting.get(sender);
    if (kind === 'send') return this.pastedInvoice(request);
    // Too late, or written before the question (a relay resending something older).
    if (now() > at + CUSTOM_SECONDS || message.created_at < at - 5) {
      this.awaiting.delete(sender);
      return isReply(message) ? undefined : this.say(request, this.help(request));
    }
    const match = /^([1-9][0-9]{0,8})(?:[ \t]+([\s\S]*))?$/.exec(message.content.trim());
    if (!match) return isReply(message) ? undefined : this.say(request, CUSTOM_TEXT.again);
    // Something the person can correct keeps the question open. The time limit still runs from
    // when it was asked, so retrying does not extend it.
    const sats = Number(match[1]);
    const memo = match[2] ?? '';
    if (sats > this.limits.maxInvoiceSats)
      return this.say(
        request,
        `${INVOICE_TEXT.amount(this.limits.maxInvoiceSats)} ${CUSTOM_TEXT.retry}`,
      );
    if (invoiceMemo(memo) === undefined)
      return this.say(request, `${INVOICE_TEXT.memo} ${CUSTOM_TEXT.retry}`);
    this.awaiting.delete(sender);
    const lease = this.wallets.lease(sender, ref);
    if (!lease) return this.say(request, BUTTON_TEXT.relinked);
    request.lease = lease;
    return this.invoiceCommand(request, { sats, memo });
  }
  // The answer to the Send button: an invoice, for the wallet that menu was made for.
  pastedInvoice(request) {
    const { sender, message } = request;
    const { ref, at } = this.awaiting.get(sender);
    if (now() > at + CUSTOM_SECONDS || message.created_at < at - 5) {
      this.awaiting.delete(sender);
      return isReply(message) ? undefined : this.say(request, this.help(request));
    }
    if (!this.sends || !BARE_INVOICE.test(message.content.trim()))
      return this.say(request, SEND_TEXT.askAgain);
    this.awaiting.delete(sender);
    const lease = this.wallets.lease(sender, ref);
    if (!lease) return this.say(request, BUTTON_TEXT.relinked);
    request.lease = lease;
    return this.sends.command(request, message.content.trim());
  }
  help({ sender }) {
    return helpText(this.wallets.label(sender), {
      manageable: this.wallets.manageable,
      connectable: Boolean(this.connect),
      sending: Boolean(this.sends),
    });
  }

  // /balance and /history, and their buttons. The key comes only from wallets.json, for the
  // sender alone: nothing in the message can choose a wallet. LNbits failures become a
  // short message. page: a history page asked for with a button (0 is the newest).
  async walletCommand(request, command) {
    const { sender } = request;
    const lease = (request.lease ??= this.wallets.lease(sender));
    if (!lease)
      return this.say(
        request,
        'Your wallet link is switched off. Please ask the bot operator to check it.',
      );
    const { key, label, id } = lease;
    const client = this.api(lease);
    const signal = this.signal(lease);
    try {
      if (command.name === 'balance') {
        const { balanceMsat } = await client.wallet(key, { signal });
        this.markVerified(id);
        return this.say(request, balanceText(balanceMsat, label), undefined, {
          keyboard: this.menu,
          command: true,
        });
      }
      // The history endpoint does not show whether a key can spend, so check it first.
      if (!this.verified.has(id)) {
        await this.checkKey(client, key, signal);
        this.markVerified(id);
      }
      const count = command.count ?? this.limits.historyDefault;
      const page = command.page ?? 0;
      // One more than shown tells whether an older page exists.
      const rows = await client.payments(key, Math.min(count + 1, MAX_HISTORY), {
        signal,
        offset: page * count,
      });
      const payments = rows.slice(0, count);
      const more = rows.length > count || (count === MAX_HISTORY && rows.length === count);
      const presets = this.limits.presets.filter((sats) => sats <= this.limits.maxInvoiceSats);
      return this.say(request, historyText(payments, label, page * count), undefined, {
        keyboard: historyKeyboard(page, more, presets),
        command: true,
      });
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      // Stopping: the message was recorded as handled; the person can simply ask again.
      // Disconnected meanwhile: there is nothing left to say about that wallet.
      if (this.stopped || lease.gone()) return;
      if (error.code === 'admin_key') this.switchOff(id, sender);
      this.log(
        `LNbits ${command.name} for ${nip19.npubEncode(sender)} failed (${error.code}${error.status ? ` ${error.status}` : ''}).`,
      );
      return this.say(request, failureText(error));
    }
  }

  // Whether this key may be used. A wallet connection need not have a balance to read.
  checkKey(client, key, signal) {
    return client.verify ? client.verify(key, { signal }) : client.wallet(key, { signal });
  }

  // An admin key can spend. Stop using it for the rest of this run and tell the operator.
  switchOff(target, pubkey = target) {
    const id = this.wallets.lease(target)?.id ?? target;
    this.wallets.disable(id, 'admin key');
    this.verified.delete(id);
    this.watcher.drop(id);
    this.log(
      `Switched off the wallet link for ${nip19.npubEncode(pubkey)}: LNbits reports an admin key. Link the wallet's invoice key instead.`,
    );
  }

  // LNbits confirmed this key as a non-admin key: wallet commands and notifications may use it.
  markVerified(id) {
    this.verified.add(id);
    this.watcher.watch(id);
  }

  // Startup report: which links LNbits accepts. Never logs keys, URLs or balances. Later
  // runs (pending) only retry links not confirmed yet, quietly, e.g. after LNbits was down.
  async checkWallets({ pending = false } = {}) {
    const ids = this.wallets.ids().filter((id) => !pending || !this.verified.has(id));
    const results = await Promise.all(
      ids.map(async (id) => {
        const lease = this.wallets.leaseById(id);
        if (!lease) return 'off';
        const { owner } = lease;
        try {
          await this.checkKey(this.api(lease), lease.key, this.signal(lease));
          if (lease.valid()) this.markVerified(id);
          return 'ok';
        } catch (error) {
          if (!(error instanceof LNbitsError) || this.stopped || lease.gone()) return 'unchecked';
          if (error.code === 'admin_key') this.switchOff(id, owner);
          else
            this.note(
              `check:${id}`,
              `Wallet link for ${nip19.npubEncode(owner)} not checked: ${error.message}`,
            );
          return error.code;
        }
      }),
    );
    if (this.stopped || pending) return;
    const ok = results.filter((r) => r === 'ok').length;
    this.log(`LNbits accepted ${ok} of ${results.length} wallet link(s).`);
  }
  async start() {
    // Interrupted invoice requests are settled before any relay message is read, so a new
    // /invoice never sees a stale "queued" record.
    this.sweepRevoked();
    this.recover();
    this.sends?.recover();
    this.watcher.prune();
    this.buttons.prune();
    // Before any message can be read: the operator's revocation counts during startup too.
    this.wallets.startWatching?.((error) => this.fail(error));
    await super.start();
    // close() may have run while the outbox was flushed: start nothing more.
    if (this.stopped) return;
    this.checking = this.checkWallets().catch(() => {});
    this.recheckTimer = setInterval(() => {
      if (!this.stopped) this.checking = this.checkWallets({ pending: true }).catch(() => {});
    }, 5 * 60000);
  }

  // Revoked while this bot was not running (from the CLI, by a restore, or in a crash before
  // the cleanup was saved): the same cleanup, before anything is published.
  sweepRevoked() {
    const { outbox, callbacks } = this.state;
    this.state.outbox = outbox.filter(
      ({ connection }) =>
        !connection || this.wallets.connection?.(connection) || this.wallets.linked(connection),
    );
    let changed = this.state.outbox.length !== outbox.length;
    for (const [key, entry] of Object.entries(callbacks ?? {}))
      if (entry.ref && this.wallets.menuState(key.split(':')[0], entry.ref) === 'stale') {
        delete callbacks[key];
        changed = true;
      }
    if (changed) this.save();
  }

  // The transport drops replies relays did not accept within a day. Say so instead of
  // losing them silently (vendor/bot.js stays identical to the poll example's).
  async flush() {
    // Replies wait while the bot cannot tell which wallets were disconnected.
    if (this.wallets.broken) return;
    const stale = this.state.outbox.filter((item) => item.queuedAt < now() - DAY).length;
    if (stale && !this.flushing && !this.stopped)
      this.log(`Dropping ${stale} delivery(ies) that relays did not accept for a day.`);
    return super.flush();
  }

  // A notification that is not a reply. commit() records what it announces; it runs in the
  // same synchronous step as the outbox write, so both are saved together or not at all.
  async announce(lease, text, commit, queueFull) {
    const { owner, id: connection } = lease;
    const relays = await this.inbox(owner);
    if (lease.gone()) return; // disconnected meanwhile: nothing is sent or kept for it
    if (queueFull?.()) return; // filled up during that lookup: a later check finds this again
    commit();
    if (!lease.valid()) return this.save(); // switched off meanwhile: record only
    const keyboard = noticeKeyboard();
    const notice = rumor(this.key, [['p', owner], keyboardTag(keyboard)], text);
    this.buttons.addCard(notice.id, { owner, ref: lease.ref, keyboard });
    // No copy for the bot's key: see deliver().
    this.state.outbox.push({
      event: wrap(notice, this.key, owner),
      relays,
      queuedAt: now(),
      connection,
    });
    this.save();
  }

  // ---- Invoices --------------------------------------------------------------------------
  //
  // One /invoice message makes at most one creation request to LNbits, ever:
  //   1. checks (amount, memo, limits, no unsettled request of this person, key type);
  //   2. a record is written to state.json ("queued"), then marked "sending";
  //   3. one POST. Created: the invoice is sent in the same save that marks it "created".
  //      Certainly not created: "failed". Anything else (timeout, dropped connection,
  //      server error, an unreadable answer): "uncertain";
  //   4. an uncertain request is looked up by its external id, a few times over ten
  //      minutes. Found: "created" and the invoice is sent. Never found: "failed", since no
  //      invoice was ever shown. Anything else: "review", for the operator. It is never sent
  //      to LNbits a second time.
  // The person's lane runs all of this in order, so their requests never overlap.

  // trigger: set for a preset button (see invoices.js).
  async invoiceCommand(request, { sats, memo: written }, trigger) {
    const { sender, message } = request;
    if (this.invoices.byMessage(message.id)) return; // one request per message, ever
    if (message.created_at < now() - INVOICE_MAX_AGE) return this.say(request, INVOICE_TEXT.tooOld);
    const lease = (request.lease ??= this.wallets.lease(sender));
    if (!lease)
      return this.say(
        request,
        'Your wallet link is switched off. Please ask the bot operator to check it.',
      );
    if (sats > this.limits.maxInvoiceSats)
      return this.say(request, INVOICE_TEXT.amount(this.limits.maxInvoiceSats));
    const memo = invoiceMemo(written);
    if (memo === undefined) return this.say(request, INVOICE_TEXT.memo);
    const { key, id } = lease;
    const client = this.api(lease);
    const open = this.invoices.open(sender, id);
    if (open)
      return this.say(
        request,
        open.state === 'review' ? INVOICE_TEXT.review(open.sats) : INVOICE_TEXT.pending(open.sats),
      );
    if (this.invoices.countSince(sender, now() - HOUR) >= this.limits.invoicesPerHour)
      return this.say(request, INVOICE_TEXT.hourly(this.limits.invoicesPerHour));
    const signal = this.signal(lease);
    // Like /history: the creation endpoint does not show whether a key can spend.
    if (!this.verified.has(id)) {
      try {
        await this.checkKey(client, key, signal);
        this.markVerified(id);
      } catch (error) {
        if (!(error instanceof LNbitsError)) throw error;
        if (this.stopped || lease.gone()) return;
        if (error.code === 'admin_key') this.switchOff(id, sender);
        this.log(`LNbits invoice check for ${nip19.npubEncode(sender)} failed (${error.code}).`);
        return this.say(request, invoiceFailureText(error));
      }
    }

    // Disconnected while checking: nothing was asked of LNbits and nothing needs recording.
    if (lease.gone()) return;
    // Durable before LNbits is asked: a crash from here on is recovered from this record.
    const record = this.invoices.add({
      requester: sender,
      messageId: message.id,
      sats,
      trigger,
      connection: id,
      ref: lease.ref,
      expiresAt: now() + this.limits.invoiceExpiry,
      noMemo: !memo,
    });
    this.save();
    this.invoices.move(record, 'sending');
    this.save();
    let invoice;
    try {
      invoice = await client.createInvoice(
        key,
        { sats, memo, expiry: this.limits.invoiceExpiry, externalId: externalId(record) },
        { signal },
      );
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      return this.creationFailed(request, record, error);
    }
    this.log(`Created an invoice for ${nip19.npubEncode(sender)} (request ${short(record)}).`);
    // Disconnected during the request: the invoice exists in the person's own wallet, unseen,
    // and expires. It is not shown, and the operator can see the record.
    if (lease.gone()) return this.orphaned(record);
    // "created" is recorded in the same synchronous step that queues the reply carrying the
    // invoice (after the relay lookup), so they reach disk together. Until then the record
    // stays "sending": after a crash it is looked up and the invoice is sent then.
    const text = invoiceText({ sats, bolt11: invoice.bolt11, minutes: this.minutes, memo });
    const commit = () =>
      this.invoices.move(record, 'created', { paymentHash: invoice.paymentHash });
    const keyboard = invoiceKeyboard(invoice.bolt11, record);
    if (!request.button) return this.say(request, text, commit, { keyboard, command: true });
    // From a button: the invoice is a message of its own, to find and pay later, and the menu
    // it came from stays a menu.
    await this.say({ ...request, button: undefined, plain: true }, text, commit, { keyboard });
    return this.say(request, CUSTOM_TEXT.sent(sats));
  }

  // A preset amount button. One button on one menu gives at most one invoice at a time:
  // pressing it again, from the menu or from any answer on it (which are views of the same
  // menu), or the app retrying it as a new request, shows that invoice again while it can
  // still be paid. The usual /invoice checks and lifecycle apply.
  async presetInvoice(press, sats) {
    const { sender, button } = press;
    const { request } = button;
    const trigger = createHash('sha256')
      .update(`anagram-lnbits-wallet:${sender}:${request.target.root}:${request.data}`)
      .digest('hex')
      .slice(0, 32);
    const earlier = this.invoices.byTrigger(trigger);
    if (earlier?.state === 'created') {
      const shown = await this.showInvoice(press, earlier);
      if (shown !== 'gone') return shown;
    } else if (earlier && earlier.state !== 'failed')
      return this.say(
        press,
        earlier.state === 'review'
          ? INVOICE_TEXT.review(earlier.sats)
          : INVOICE_TEXT.pending(earlier.sats),
      );
    // Too close to the request's expiry: the answer might arrive after the app gave up.
    if (request.expires - now() < this.buttonMargin) return this.say(press, BUTTON_TEXT.late);
    return this.invoiceCommand(press, { sats, memo: '' }, trigger);
  }

  // The invoice of a created request again, if it can still be paid. 'gone': it cannot
  // (paid, expired or not found), so the caller may create a new one.
  async showInvoice(press, record) {
    const found = await this.lookup(press, record);
    if (found === undefined) return;
    if (!found || found.status !== 'pending' || this.expiresAt(record) <= now()) return 'gone';
    return this.say(
      press,
      invoiceText({
        sats: record.sats,
        bolt11: found.bolt11,
        minutes: this.minutes,
        memo: found.memo,
      }),
      undefined,
      { keyboard: invoiceKeyboard(found.bolt11, record) },
    );
  }
  expiresAt(record) {
    return record.expiresAt ?? record.createdAt + this.limits.invoiceExpiry;
  }

  // ---- /invoices -------------------------------------------------------------------------
  //
  // What was made here, in one wallet: the one in use, or the one a menu was made for, like
  // /history. Only that wallet's own key is ever used, on records that belong to it (belongsTo),
  // so a disconnected or replaced wallet shows nothing, and old menus stay dead. Memos and
  // invoices are read from the wallet each time, never kept. Nothing here creates anything.

  // What the wallet says about one record now: { status, memo?, bolt11?, lastSeen?, error? }.
  // confirm: have LNbits ask its funding source too, rather than read its own table. Expired
  // always asks: a row can stay pending after its expiry, even when the invoice was paid and
  // LNbits has not noticed. A failure to answer is Unknown, never Failed or Paid. undefined:
  // disconnected meanwhile, so nothing may be said.
  async reconcile(lease, record, { confirm = false } = {}) {
    if (record.state === 'failed') return { status: 'failed' };
    if (record.state === 'review') return { status: 'review' };
    if (record.state !== 'created') return { status: 'checking' };
    const client = this.api(lease);
    const signal = this.signal(lease);
    const lastSeen = record.payment;
    const unknown = (fields = {}) => ({ status: 'unknown', lastSeen, ...fields });
    const late = () => this.expiresAt(record) <= now();
    const shownMemo = ({ memo }) => (record.noMemo ? '' : memo);
    let invoice;
    try {
      const found = await client.findInvoices(lease.key, externalId(record), {
        signal,
        paymentHash: record.paymentHash,
      });
      if (lease.gone()) return undefined;
      if (found.length !== 1 || found[0].amountMsat !== record.sats * 1000) return unknown();
      [invoice] = found;
      if (invoice.status === 'pending' && (confirm || late()) && client.confirmInvoice) {
        const checked = await client.confirmInvoice(lease.key, invoice.paymentHash, { signal });
        if (lease.gone()) return undefined;
        if (checked.amountMsat !== record.sats * 1000) return unknown({ memo: shownMemo(invoice) });
        invoice = checked;
      }
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      if (this.stopped || lease.gone()) return undefined;
      if (error.code === 'admin_key') this.switchOff(lease.id, lease.owner);
      this.log(
        `LNbits invoice lookup for ${nip19.npubEncode(lease.owner)} failed (${error.code}).`,
      );
      return unknown({ memo: invoice && shownMemo(invoice), error });
    }
    const status =
      invoice.status === 'success'
        ? 'paid'
        : invoice.expired || (invoice.status === 'pending' && late())
          ? 'expired'
          : invoice.status === 'pending'
            ? 'pending'
            : 'failed';
    // What the wallet said goes on record, unless it contradicts what it said before.
    if (!this.invoices.canSetPayment(record, status)) return unknown({ memo: shownMemo(invoice) });
    if (this.invoices.setPayment(record, status)) this.save();
    return {
      status,
      memo: shownMemo(invoice),
      ...(status === 'pending' ? { bolt11: invoice.bolt11 } : {}),
    };
  }

  // The first page, of the wallet in use.
  invoicesCommand(request) {
    const lease = (request.lease ??= this.wallets.lease(request.sender));
    if (!lease) return this.say(request, BUTTON_TEXT.switchedOff);
    return this.invoiceList(request, 0);
  }
  // Records of an earlier release do not say which wallet they were made in. Asking the wallet
  // settles it, once for each: an external id exists only in the wallet it was made in.
  async claimOlderRecords(lease) {
    const records = this.invoices.unclaimed(lease).slice(0, MAX_CLAIMS);
    let changed = false;
    await Promise.all(
      records.map(async (record) => {
        try {
          const found = await this.api(lease).findInvoices(lease.key, externalId(record), {
            signal: this.signal(lease),
            paymentHash: record.paymentHash,
          });
          if (lease.gone()) return;
          this.invoices.settleOwner(record, found.length ? lease.ref : undefined);
          changed = true;
        } catch (error) {
          if (!(error instanceof LNbitsError)) throw error;
        }
      }),
    );
    if (changed) this.save();
  }
  async invoiceList(request, page) {
    const { lease } = request;
    await this.claimOlderRecords(lease);
    if (lease.gone()) return;
    const all = this.invoices.forWallet(lease);
    const offset = page * INVOICE_PAGE_SIZE;
    const records = all.slice(offset, offset + INVOICE_PAGE_SIZE);
    const views = await Promise.all(records.map((record) => this.reconcile(lease, record)));
    if (lease.gone() || views.includes(undefined)) return;
    const rows = records.map((record, index) => ({ record, view: views[index] }));
    return this.say(
      request,
      invoiceListText(rows, lease.label, { offset, total: all.length }),
      undefined,
      {
        keyboard: invoicesKeyboard(records, page, all.length > offset + records.length),
        command: true,
      },
    );
  }
  // One invoice, from the list or from the "Check status" button under the invoice itself.
  async invoiceDetail(press, ref, page) {
    const { lease } = press;
    await this.claimOlderRecords(lease);
    if (lease.gone()) return;
    const record = this.invoices.forWallet(lease).find((r) => statusRef(r) === ref);
    if (!record) return this.say(press, BUTTON_TEXT.unknownInvoice);
    const view = await this.reconcile(lease, record, { confirm: true });
    if (!view) return;
    return this.say(
      press,
      [
        invoiceDetailText({
          record,
          view,
          label: lease.label,
          until: this.expiresAt(record),
          bolt11: view.bolt11,
        }),
        ...(view.error ? [failureText(view.error)] : []),
      ].join('\n'),
      undefined,
      { keyboard: invoiceDetailKeyboard(record, page, view.bolt11) },
    );
  }

  // The request's invoice in LNbits (by its external id), null if there is not exactly one
  // with the requested amount, or undefined once an LNbits failure was answered.
  async lookup(press, record) {
    const { lease } = press;
    try {
      const found = await this.api(lease).findInvoices(lease.key, externalId(record), {
        signal: this.signal(lease),
        paymentHash: record.paymentHash,
      });
      return found.length === 1 && found[0].amountMsat === record.sats * 1000 ? found[0] : null;
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      if (this.stopped || lease.gone()) return undefined;
      if (error.code === 'admin_key') this.switchOff(lease.id, press.sender);
      this.log(
        `LNbits invoice lookup for ${nip19.npubEncode(press.sender)} failed (${error.code}).`,
      );
      await this.say(press, failureText(error));
      return undefined;
    }
  }
  get minutes() {
    return Math.round(this.limits.invoiceExpiry / 60);
  }

  creationFailed(request, record, error) {
    const who = nip19.npubEncode(record.requester);
    if (error.definite) {
      this.invoices.move(record, 'failed', { error: error.code });
      this.log(
        `Invoice request ${short(record)} for ${who} failed (${error.code}${error.status ? ` ${error.status}` : ''}); nothing was created.`,
      );
      if (error.code === 'admin_key')
        this.switchOff(record.connection ?? record.requester, record.requester);
      // Final and certain: saved now, whatever happens to the reply.
      this.save();
      if (this.stopped) return;
      return this.say(request, invoiceFailureText(error));
    }
    this.invoices.move(record, 'uncertain', { error: error.code });
    if (error.code === 'mismatch') {
      // An invoice exists but is not the one asked for: never shown, never replaced.
      this.invoices.move(record, 'review', { error: 'mismatch' });
      this.needsReview(record);
      this.save();
      if (this.stopped) return;
      return this.say(request, INVOICE_TEXT.toReview(record.sats));
    }
    this.log(
      `Invoice request ${short(record)} for ${who} is uncertain (${error.code}); checking LNbits by its external id.`,
    );
    this.save();
    if (this.stopped) return; // recover() continues at the next start
    this.scheduleCheck(record);
    return this.say(request, INVOICE_TEXT.uncertain(record.sats));
  }

  // failures: lookups in a row that could not reach LNbits. They do not count as checks
  // (an outage must not send a request to review); the delay doubles, up to the longest.
  scheduleCheck(record, failures = 0) {
    if (this.stopped) return;
    const delays = this.checkDelays;
    const longest = delays[delays.length - 1];
    const delay = Math.min(
      longest,
      delays[Math.min(record.checks, delays.length - 1)] * 2 ** failures,
    );
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.lane(record.requester, () => this.checkInvoice(record, failures)))
        this.scheduleCheck(record, failures);
    }, delay * 1000);
    this.timers.add(timer);
  }

  // Looks for the request's invoice by its unique external id. Never creates one.
  async checkInvoice(record, failures = 0) {
    if (this.stopped || record.state !== 'uncertain') return;
    // Only ever its own wallet. Older records name none: the person's wallet in use.
    const lease = record.connection
      ? this.wallets.leaseById(record.connection)
      : this.wallets.lease(record.requester);
    if (!lease && this.wallets.broken) return this.scheduleCheck(record, failures + 1);
    if (!lease) {
      // Link removed or switched off: nobody can look it up any more. The operator decides.
      this.invoices.move(record, 'review', { error: 'no_key' });
      this.save();
      return this.needsReview(record);
    }
    let found;
    try {
      found = await this.api(lease).findInvoices(lease.key, externalId(record), {
        signal: this.signal(lease),
      });
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      if (this.stopped) return;
      // Disconnected during the lookup: handled like any other wallet that is gone.
      if (lease.gone()) return this.scheduleCheck(record, failures);
      this.note(
        `lookup:${record.op}`,
        `Check of invoice request ${short(record)} could not reach LNbits (${error.code}); retrying.`,
      );
      return this.scheduleCheck(record, failures + 1);
    }
    if (this.stopped) return;
    record.checks += 1;
    record.updatedAt = now();
    const request = { ...this.recordRequest(record), lease };
    // This wallet cannot find an invoice whose answer was lost (NWC). It was never shown, so
    // it can never be paid: nothing is at stake, and the person can simply ask again.
    if (!found.length && this.api(lease).findsLost === false) {
      this.invoices.move(record, 'failed', { error: 'not_found' });
      this.save();
      return this.say(request, INVOICE_TEXT.lost(record.sats));
    }
    if (found.length === 1 && found[0].amountMsat === record.sats * 1000) {
      // Confirmed only after it stopped being payable, for example after a long outage.
      if (found[0].status !== 'pending' || this.expiresAt(record) <= now()) {
        this.log(`Invoice request ${short(record)} was created but can no longer be paid.`);
        return this.say(request, INVOICE_TEXT.lateExpired(record.sats), () =>
          this.invoices.move(record, 'created', { paymentHash: found[0].paymentHash }),
        );
      }
      this.log(`Invoice request ${short(record)} was created after all; sending it.`);
      // As at creation: recorded together with the reply that carries the invoice.
      return this.say(
        request,
        invoiceText({
          sats: record.sats,
          bolt11: found[0].bolt11,
          minutes: this.minutes,
          memo: found[0].memo,
          late: true,
        }),
        () => this.invoices.move(record, 'created', { paymentHash: found[0].paymentHash }),
        { keyboard: invoiceKeyboard(found[0].bolt11, record) },
      );
    }
    if (found.length > 0) {
      this.invoices.move(record, 'review', { error: 'ambiguous' });
      this.needsReview(record);
      this.save();
      return this.say(request, INVOICE_TEXT.toReview(record.sats));
    }
    if (record.checks >= this.checkDelays.length) {
      this.invoices.move(record, 'failed', { error: 'not_found' });
      this.log(`Invoice request ${short(record)} was never found in LNbits; marked as failed.`);
      this.save();
      return this.say(request, INVOICE_TEXT.notCreated(record.sats));
    }
    this.save();
    this.scheduleCheck(record);
  }

  // Who a later message about a request goes to. A button request is not a message in the
  // chat, so those messages are sent on their own instead of as replies.
  recordRequest(record) {
    return {
      message: { id: record.messageId, pubkey: record.requester },
      sender: record.requester,
      plain: Boolean(record.trigger),
    };
  }

  // An invoice was created for a wallet disconnected meanwhile.
  orphaned(record) {
    this.invoices.move(record, 'uncertain', { error: 'revoked' });
    // Not disconnected: wallets are suspended for now, and it can be looked up afterwards.
    if (this.wallets.broken) {
      this.save();
      return this.scheduleCheck(record);
    }
    this.invoices.move(record, 'review', { error: 'no_key' });
    this.needsReview(record);
    this.save();
  }
  needsReview(record) {
    this.log(
      `Invoice request ${short(record)} needs operator review: search the wallet's payments in LNbits for external id ${externalId(record)}, then run "npm run review".`,
    );
  }

  // On startup: finish what a crash or shutdown interrupted.
  recover() {
    for (const record of this.invoices.all) {
      const request = this.recordRequest(record);
      // Disconnected meanwhile: the record is still settled, but nothing more is said about it.
      const tell = (text) => {
        if (record.connection ? this.wallets.leaseById(record.connection) : true)
          if (this.wallets.linked(record.requester))
            this.lane(record.requester, () => this.say(request, text));
      };
      if (record.state === 'queued') {
        // Written, but "sending" never was: the request did not leave the bot.
        this.invoices.move(record, 'failed', { error: 'restart' });
        this.save();
        tell(INVOICE_TEXT.restarted(record.sats));
      } else if (record.state === 'sending') {
        // It may have reached LNbits: never resend, look it up.
        this.invoices.move(record, 'uncertain', { error: 'restart' });
        this.save();
        this.log(`Invoice request ${short(record)} was interrupted by a restart; checking LNbits.`);
        tell(INVOICE_TEXT.uncertain(record.sats));
        this.scheduleCheck(record);
      } else if (record.state === 'uncertain') {
        this.scheduleCheck(record);
      } else if (record.state === 'review' && record.error === 'not_found') {
        // An earlier release held these for the operator. Every lookup found nothing, so the
        // invoice was never shown and the person need not stay locked out.
        this.invoices.move(record, 'failed');
        this.save();
        this.log(`Invoice request ${short(record)} was never found in LNbits; marked as failed.`);
        tell(INVOICE_TEXT.notCreated(record.sats));
      } else if (record.state === 'review') {
        this.needsReview(record);
      }
    }
  }

  // ---- Replies ---------------------------------------------------------------------------

  // Some callers do not await it, so it never rejects: a storage error goes to onFatal, and
  // close() waits for replies still in flight before releasing the data directory.
  // commit (optional) runs after the relay lookup, in the same synchronous step as the
  // outbox write, so a state change and the reply announcing it are saved together.
  // options.keyboard: buttons for the message (a card); options.command: the reply answers
  // a command successfully, so Anagram may fold the command away under it.
  // A button press (request.button) is answered privately instead; see answer().
  say(request, rawText, commit, options = {}) {
    const text = forWallet(rawText, request.lease);
    const promise = (
      request.button
        ? this.answer(request, text, commit, options)
        : this.deliver(request, text, commit, options)
    ).catch((error) => this.fail(error));
    this.replying.add(promise);
    promise.finally(() => this.replying.delete(promise));
    return promise;
  }
  // NIP-17 reply: a kind:14 rumor with an `e` reply tag, wrapped for the person. No copy for the
  // bot unless asked for: these are balances and payments, and a later leak of its key must not
  // show them. A plain request (about a button press, which is not a chat message) gets no reply
  // tag.
  async deliver(
    request,
    text,
    commit,
    { keyboard, command = false, account = false, selfCopy = false, hadWallet = false } = {},
  ) {
    const { message } = request;
    // Someone with no wallet here does not get to choose which relays the bot connects to.
    // hadWallet: the outcome of their payment, after that wallet is gone. They must hear it.
    const relays =
      this.wallets.linked(message.pubkey) || hadWallet
        ? await this.inbox(message.pubkey)
        : this.relays;
    // Checked in the same synchronous step as the outbox write: a wallet disconnected before
    // this point gets nothing, and anything queued earlier is removed by the revocation.
    if (request.lease?.gone()) return;
    commit?.();
    // Buttons only for a wallet that is linked now: they are tied to it (see buttons.js).
    const lease = request.lease ?? this.wallets.lease(message.pubkey);
    const card =
      keyboard?.inline_keyboard.length && (account || lease?.valid()) ? keyboard : undefined;
    // A card about the account is not tied to a wallet, and survives any disconnect.
    const connection = lease && !account ? { connection: lease.id } : {};
    const reply = rumor(
      this.key,
      [
        ['p', message.pubkey],
        ...(request.plain ? [] : [['e', message.id, '', 'reply']]),
        ...(card ? [keyboardTag(card)] : []),
        ...(card && command && !request.plain ? [[COMMAND_TAG, '1', message.id]] : []),
      ],
      text,
    );
    // A card with only link buttons is never pressed here: nothing to keep.
    if (card && callbacks(card).length)
      this.buttons.addCard(reply.id, {
        owner: message.pubkey,
        ref: account ? ACCOUNT_REF : lease.ref,
        keyboard: card,
      });
    this.queue(message, [
      { event: wrap(reply, this.key, message.pubkey), relays, ...connection },
      ...(selfCopy
        ? [{ event: wrap(reply, this.key, this.pubkey), relays: this.relays, ...connection }]
        : []),
    ]);
    return reply.id;
  }

  // The private answer to a button press: a kind 21118 rumor for the person only, shown in
  // place of the card's text. It always carries a keyboard (by default the menu), which
  // becomes a valid view of the card. The answer, the exact encrypted delivery kept for
  // retries, the card's new view and any commit are saved in one step.
  // An answer created after the request expired would be ignored by the app. If it records
  // something (a new invoice), it is sent as an ordinary message instead; otherwise the
  // person simply presses again.
  async answer(press, text, commit, { keyboard = this.menu } = {}) {
    const { message, sender, button } = press;
    const { request, card, key } = button;
    const relays = await this.inbox(sender);
    if (press.lease?.gone()) return;
    if (now() > request.expires) {
      if (!commit) return;
      this.log(
        `A button answer for ${nip19.npubEncode(sender)} was late; sending it as a message.`,
      );
      return this.deliver({ ...press, plain: true }, text, commit, { keyboard });
    }
    commit?.();
    const control = {
      op: 'answer',
      id: request.id,
      target: request.target,
      expires: request.expires,
    };
    const response = {
      ...rumor(this.key, [['p', sender], controlTag(control), keyboardTag(keyboard)], text),
      kind: BOT_CONTROL_KIND,
    };
    response.id = getEventHash(response);
    const delivery = {
      event: wrap(response, this.key, sender),
      relays,
      ...(press.lease ? { connection: press.lease.id } : {}),
    };
    this.buttons.addView(card, response.id, keyboard);
    this.buttons.remember(key, {
      fingerprint: message.id,
      expires: request.expires,
      delivery,
      ...(card.ref === ACCOUNT_REF ? {} : { ref: card.ref }),
    });
    this.queue(message, [delivery]);
    return response.id;
  }

  // ---- Bookkeeping -----------------------------------------------------------------------

  // Sliding one-hour window per person. Over the limit: one notice per window, then silence.
  rateLimit(pubkey) {
    const recent = (this.requests.get(pubkey) ?? []).filter((t) => t > now() - HOUR);
    this.requests.delete(pubkey);
    this.requests.set(pubkey, recent);
    if (recent.length >= this.limits.requestsPerHour) {
      if ((this.notices.get(pubkey) ?? 0) > now() - HOUR) return 'silent';
      this.notices.set(pubkey, now());
      return 'notice';
    }
    recent.push(now());
    bound(this.requests);
    bound(this.notices);
    return 'ok';
  }

  leavingLimit(pubkey) {
    const recent = (this.leaving.get(pubkey) ?? []).filter((t) => t > now() - HOUR);
    this.leaving.delete(pubkey);
    this.leaving.set(pubkey, recent);
    bound(this.leaving);
    if (recent.length >= DISCONNECT_STEPS_PER_HOUR) return 'silent';
    recent.push(now());
    return 'ok';
  }

  // Persists when each linked person was first linked. Times survive restarts; a person
  // missing from the wallet file at startup loses their time, so linking them again later
  // starts from that later startup and old messages stay unanswered.
  authorize() {
    const saved = this.state.authorized?.users ?? {};
    const users = {};
    for (const id of this.wallets.owners()) {
      const time = this.wallets.linkedSince?.(id) ?? (Object.hasOwn(saved, id) ? saved[id] : now());
      if (!Number.isSafeInteger(time) || time < 0)
        throw new Error('Invalid saved authorization time. Restore state.json from backup.');
      users[id] = time;
    }
    const next = { users };
    if (JSON.stringify(next) === JSON.stringify(this.state.authorized)) return;
    this.state.authorized = next;
    this.save();
  }
  allowedWhenWritten(message) {
    const since = this.state.authorized.users[message.pubkey];
    return Number.isSafeInteger(since) && message.created_at >= since;
  }
  markSeen(message) {
    this.state.seen[message.id] = now();
    this.save();
  }

  // Logs show who to link, never what they wrote. One line per key per hour.
  note(key, line) {
    if ((this.logged.get(key) ?? 0) > now() - HOUR) return;
    this.logged.delete(key);
    this.logged.set(key, now());
    bound(this.logged);
    this.log(line);
  }
  ignoredSender(pubkey) {
    this.note(pubkey, `Ignored a message from ${nip19.npubEncode(pubkey)}: no linked wallet.`);
  }

  async close() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearInterval(this.recheckTimer);
    this.wallets.stopWatching?.();
    // LNbits requests in progress end now instead of after their timeout. An invoice
    // request cut off this way is "uncertain" and is looked up at the next start.
    this.abort.abort();
    await this.watcher.stop();
    await Promise.all([...this.lanes.values()].map((lane) => lane.stop()));
    await this.checking;
    await this.work;
    await Promise.all(this.replying);
    await super.close();
  }
}

// Which connections this configuration does not allow. They are switched off, not deleted: NWC
// ones with NWC off, and ones that can spend with sending off. The registry applies this each time
// it loads one, so nothing brings one back while the bot runs.
export const disallowedBy =
  ({ nwc, send }) =>
  ({ kind }, secret) =>
    (kind === 'nwc' && !nwc) || (secret?.scope === 'spend' && !send) ? 'configuration' : undefined;

// A short, non-secret label for an invoice request in logs.
const short = (record) => record.op.slice(0, 8);

// Replies carry an `e` reply tag. Other bots, including this one, always reply that way.
const isReply = (message) => message.tags.some((t) => t[0] === 'e' && t[3] === 'reply');

// Backups in which an earlier release's migrate kept wallets.json, keys and all.
export function plaintextCopies(dataDir) {
  const backups = join(dataDir, 'backups');
  try {
    return readdirSync(backups).filter((name) => existsSync(join(backups, name, 'wallets.json')))
      .length;
  } catch {
    return 0; // No backups folder, or one that cannot be read: only a reminder is lost.
  }
}

// Keeps an insertion-ordered Map bounded by dropping its oldest entries.
function bound(map, max = 1000) {
  while (map.size > max) map.delete(map.keys().next().value);
}

export async function publishProfile(bot, { pictureURL = '', nip05 = '' } = {}) {
  const about = bot.connect
    ? 'A Lightning wallet bot. Send /connect to link your own wallet on a secure page. Never send wallet keys in chat.'
    : 'A read-only LNbits wallet bot. It answers only people its operator has linked to a wallet. Never send wallet keys in chat.';
  await bot.net.publish(
    sign(
      bot.key,
      10050,
      bot.relays.map((r) => ['relay', r]),
    ),
    bot.relays,
    bot.key,
  );
  const picture = pictureURL.trim();
  if (picture && new URL(picture).protocol !== 'https:')
    throw new Error('PICTURE_URL must use HTTPS.');
  await bot.net.publish(
    sign(
      bot.key,
      0,
      [],
      JSON.stringify({
        name: bot.name,
        display_name: bot.name,
        bot: true,
        ...(nip05.trim() ? { nip05: nip05.trim() } : {}),
        about,
        ...(picture ? { picture } : {}),
      }),
    ),
    bot.relays,
    bot.key,
  );
}

export const nwcClientFor = (config) =>
  new NwcClient({
    timeoutMs: config.lnbits.timeoutMs + 5000,
    trustedRelays: config.connect.nwcTestRelays,
  });

export async function main() {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const dataDir = config.dataDir || resolve(HERE, 'data');
  const database = join(dataDir, DB_FILE);
  if (existsSync(`${database}.tmp`))
    throw new ConfigurationError(
      'A migration or restore was interrupted: run the same command again.',
    );
  // wallets.json mode until the operator migrates; then only the database counts.
  const migrated = existsSync(database);
  const copies = plaintextCopies(dataDir);
  if (copies)
    console.log(
      `DATA_DIR/backups holds ${copies} copy(ies) of wallets.json in the clear, from an earlier migration: delete them (see the README, "Moving to database mode and back").`,
    );
  if (migrated && config.walletsFile)
    throw new ConfigurationError(
      'wallets.json was migrated to connections.db: unset WALLETS_FILE, or run "npm run rollback".',
    );
  if (config.send && !(migrated && config.connect.nwc))
    throw new ConfigurationError(
      'SEND_ENABLED needs database mode and NWC_ENABLED (see the README).',
    );
  if (migrated && !config.secretsDir)
    throw new ConfigurationError('Database mode needs SECRETS_DIR (see the README).');
  if (config.connect.publicUrl && !migrated)
    throw new ConfigurationError(
      'CONNECT_PUBLIC_URL needs database mode: run "npm run connections -- init" or "npm run migrate".',
    );
  let wallets = migrated
    ? undefined
    : loadWallets(config.walletsFile || resolve(HERE, 'wallets.json'));
  const lnbits = new LNbitsClient(config.lnbits);
  const nwc = nwcClientFor(config);
  if (config.connect.nwcTestRelays.length)
    console.log(
      `TEST ONLY: NWC may use ${config.connect.nwcTestRelays.length} relay(s) on this computer (NWC_LOCAL_TEST_RELAYS). Remove it from any real deployment.`,
    );
  const origins = new Origins({
    defaultUrl: config.lnbits.url,
    allowHttp: config.lnbits.allowHttp,
    allowed: config.connect.allowedOrigins,
    timeoutMs: config.lnbits.timeoutMs,
    defaultClient: lnbits,
  });
  const store = new State(dataDir, { nsec: config.nsec });
  let bot;
  try {
    // Opened only once the data folder is locked: migration tools hold the same lock.
    if (migrated) {
      wallets = Registry.open({
        dataDir,
        secretsDir: config.secretsDir,
        maxPerOwner: config.maxConnections,
        maxTotal: config.maxConnectionsTotal,
        log: console.log,
        disallowed: disallowedBy({ nwc: config.connect.nwc, send: Boolean(config.send) }),
        clientFor: ({ kind, origin }) => (kind === 'nwc' ? nwc : origins.client(origin)),
      });
      const off = wallets.ids().filter((id) => wallets.connection(id).disabled).length;
      if (off)
        console.log(
          `Switched off ${off} wallet connection(s) that this configuration does not allow. Nothing was deleted.`,
        );
      const age = (Date.now() / 1000 - wallets.keyring.currentCreated) / 86400;
      if (age > config.keyRotationDays)
        console.log(
          `The credential key is ${Math.floor(age)} days old: rotate it (see the README).`,
        );
    }
    const net = new Network(config.relays);
    const fatal = () => {
      console.error(
        'Bot stopped after an internal/storage error. Check disk space and data permissions.',
      );
      process.exitCode = 1;
      void shutdown();
    };
    bot = new WalletBot({
      store,
      net,
      wallets,
      lnbits,
      limits: config.limits,
      send: config.send,
      name: config.name,
      onFatal: fatal,
    });
    const service =
      config.connect.publicUrl &&
      new ConnectService({
        publicUrl: config.connect.publicUrl,
        port: config.connect.port,
        allowHttpLocal: config.connect.allowHttpLocal,
        origins,
        nwc: config.connect.nwc ? nwc : undefined,
        registry: wallets,
        sending: Boolean(config.send),
        sendCode: (owner, details) => bot.sendConnectCode(owner, details),
        finished: (owner, connection) => bot.connectFinished(owner, connection),
        log: console.log,
      });
    bot.connect = service || undefined;
    let profileTimer,
      publishing = false,
      closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      bot.stopped = true;
      clearInterval(profileTimer);
      while (publishing) await new Promise((r) => setTimeout(r, 50));
      if (service) await service.close();
      await bot.close();
      wallets.close?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (!wallets.size && !service)
      console.log(
        `Warning: ${migrated ? 'the database' : 'WALLETS_FILE'} links no wallets, so the bot will not answer anyone.`,
      );
    await bot.start();
    // A SIGTERM during startup: shutdown() is already running; start nothing more.
    if (closing) return;
    console.log(`${wallets.size} linked wallet(s).`);
    if (service) {
      const port = await service.listen();
      console.log(`Connection page listening on 127.0.0.1:${port}, for ${service.url.origin}.`);
    }
    const profile = async () => {
      if (publishing || closing) return;
      publishing = true;
      try {
        await publishProfile(bot, { pictureURL: config.pictureURL, nip05: config.nip05 });
        console.log('Profile and DM inbox published.');
        clearInterval(profileTimer);
      } catch {
        console.error(
          'Profile/inbox publication pending. Check relays and PICTURE_URL; retrying in 60s.',
        );
      } finally {
        publishing = false;
      }
    };
    profileTimer = setInterval(profile, 60000);
    void profile();
  } catch (error) {
    if (bot) await bot.close();
    else store.close();
    wallets?.close?.();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : 'Cannot start LNbits Wallet. Check configuration and state.json; existing keys are never replaced.',
    );
    process.exitCode = 1;
  });
}
