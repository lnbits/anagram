import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  bytes,
  ConfigurationError,
  Network,
  newer,
  now,
  sign,
  State,
  unwrap,
  valid,
  single,
} from './runtime.js';
import { Access } from './access.js';
import { loadConfig } from './config.js';
import { Drafts } from './drafts.js';
import { Issues } from './issues.js';
import { Queue } from './queue.js';
import { newCode, newRef, normalizeCode, normalizeRef } from './ids.js';
import {
  codeCandidates,
  confirmationPhrase,
  issueIntent,
  parseCommand,
  removeToken,
  repoRefs,
  replyTarget,
  splitId,
  stripMention,
  validRepo,
  withoutRepos,
} from './intent.js';
import {
  DRAFT_SCHEMA,
  draftMessages,
  editMessages,
  issueBody,
  markerText,
  normalizeTitle,
  parseDraft,
  sanitizeText,
} from './drafting.js';
import {
  draftList,
  formatDraft,
  githubFailureText,
  helpText,
  issueList,
  modelFailureText,
  publishedText,
  reviewText,
  uncertainText,
  whoText,
} from './messages.js';
import { definitelyNotCreated, GitHubClient, keywords } from './github.js';
import { OllamaClient } from './ollama.js';
import { directMessage, sendDirect } from './direct-messages.js';
import { acceptTicket, privateMessage, readTicket, sendPrivate } from './private-groups.js';
import { acceptRoom, joinPublic, parseRoom, publicMessage, sendPublic } from './public-groups.js';

const DAY = 86400;
const HOUR = 3600;
const QUESTION_SECONDS = HOUR;
const HERE = fileURLToPath(new URL('.', import.meta.url));

// How a message moves through the bot:
//   relay event -> receive()/submit() -> protocol handler (direct-messages.js,
//   private-groups.js, public-groups.js) checks the Nostr rules -> handle() checks
//   addressing, sender, limits -> command() or natural() -> model jobs (draftJob/editJob)
//   or the publication job (publish) -> reply() signs the answer into the durable outbox
//   -> flush() publishes it to relays.
//
// Two serial queues keep slow work off the message chain: `models` (Ollama) and
// `publisher` (GitHub issue creation and reconciliation).
export class IssueAgent {
  constructor({
    store,
    net,
    ollama,
    github,
    access = new Access(),
    drafts = new Drafts(),
    limits = {},
    reconcileDelays = [5, 60, 300],
    name = 'GitHub Issue Agent (Example Anagram Bot)',
    log = console.log,
    onFatal = (error) => {
      throw error;
    },
  }) {
    this.name = name;
    this.store = store;
    this.state = store.data;
    this.key = store.key;
    this.pubkey = getPublicKey(this.key);
    this.net = net;
    this.relays = net.configured;
    this.ollama = ollama;
    this.github = github;
    this.access = access;
    this.drafts = drafts;
    this.issues = new Issues(this.state);
    this.limits = {
      maxInputChars: 4000,
      maxBodyChars: 6000,
      requestsPerHour: 60,
      modelCallsPerHour: 20,
      issuesPerDay: 10,
      maxQueue: 10,
      ...limits,
    };
    this.reconcileDelays = reconcileDelays;
    this.log = log;
    this.onFatal = onFatal;
    this.groupRelays = new Map();
    this.inboxes = new Map();
    this.watches = new Map();
    this.pending = new Set();
    this.work = Promise.resolve();
    this.stopped = false;
    this.started = false;
    const jobError = () => this.log('Internal error in a background job.');
    this.models = new Queue(this.limits.maxQueue, jobError);
    this.publisher = new Queue(1000, jobError);
    this.abort = new AbortController();
    this.timers = new Set();
    this.replying = new Set();
    // In memory, bounded. sent: ids of messages the bot sent → what they showed, so replies
    // to them can be recognized. questions: requests waiting for a repository name.
    this.sent = new Map();
    this.questions = new Map();
    this.busy = new Set();
    this.requests = new Map();
    this.modelCalls = new Map();
    this.notices = new Map();
    this.logged = new Map();
    // Corrupt persisted protocol state must not silently grant access or rotate identity.
    for (const [group, epoch] of Object.entries(this.state.groups)) {
      const { sig, ...message } = epoch.ticket ?? {};
      const parsed = readTicket(message, { tags: [['invitation_proof', sig]] }, this.pubkey);
      if (
        !parsed ||
        message.pubkey !== group ||
        parsed.pubkey !== epoch.pubkey ||
        parsed.epoch !== epoch.epoch
      )
        throw new Error('Invalid saved private group ticket. Restore state.json from backup.');
    }
    for (const [address, room] of Object.entries(this.state.rooms)) {
      if (parseRoom(room.event)?.address !== address)
        throw new Error('Invalid saved public group profile.');
    }
    this.authorize();
  }
  save() {
    this.store.save();
  }

  // ---- Receiving -------------------------------------------------------------------------

  // Protocol-level filter shared by every chat type: replay, age, edits, own/epoch authors.
  shouldReply(message) {
    if (
      message.pubkey === this.pubkey ||
      ![9, 14].includes(message.kind) ||
      typeof message.content !== 'string' ||
      message.created_at < Math.max(this.state.startedAt, now() - DAY) ||
      message.created_at > now() + 60 ||
      this.state.seen[message.id] ||
      this.state.outbox.length >= 1000 ||
      message.tags.some((t) => t[0] === 'e' && t[3] === 'edit')
    )
      return false;
    // Never answer with an epoch key as an author, even in another conversation.
    if (Object.values(this.state.groups).some((g) => g.pubkey === message.pubkey)) return false;
    return true;
  }

  // Called by the protocol handlers for every valid chat message.
  // context: { type: 'dm' | 'private' | 'public', conversation, mentioned }
  async handle(message, context) {
    if (!this.shouldReply(message)) return;
    const text = stripMention(message.content, this.pubkey);
    const command = parseCommand(text);
    const sent = this.sent.get(replyTarget(message));
    const target = sent?.conversation === context.conversation ? sent : undefined;
    // In groups, only messages addressed to the bot are processed (see README).
    if (
      context.type !== 'dm' &&
      !context.mentioned &&
      !target &&
      !this.ownsCommandId(command, context.conversation)
    )
      return;
    if (!this.access.sender(message.pubkey)) return this.ignoredSender(message.pubkey);
    // Written before its author or group was allowed: relays resend history after every
    // restart, so these are dropped without being recorded (see README, "Old messages").
    if (!this.allowedWhenWritten(message, context)) return;
    // From here on the message is handled exactly once, even if it fails or a relay
    // resends it later. Persist that before doing anything slow.
    this.markSeen(message);
    const request = {
      message,
      context,
      sender: message.pubkey,
      text,
      target,
      key: `${context.conversation}\n${message.pubkey}`,
    };
    if (!this.allow(this.requests, request.sender, this.limits.requestsPerHour)) {
      if ((this.notices.get(request.sender) ?? 0) > now() - HOUR) return;
      this.notices.set(request.sender, now());
      bound(this.notices);
      return this.say(
        request,
        'You have reached the hourly message limit for this bot. Please try again later.',
      );
    }
    if ([...text].length > this.limits.maxInputChars)
      return this.say(
        request,
        `Your message is too long (${[...text].length} characters). Please keep it under ${this.limits.maxInputChars} characters; nothing was drafted.`,
      );
    if (command) return this.command(command, request);
    if (!text) return this.say(request, this.helpFor(request));
    return this.natural(request);
  }

  // A bare group command is addressed to this bot only if its ID belongs to this bot in
  // this conversation (so "/confirm X" meant for another bot is ignored).
  ownsCommandId(command, conversation) {
    if (!command) return false;
    const { id } = splitId(command.args);
    if (['confirm', 'edit', 'cancel'].includes(command.name)) {
      const code = normalizeCode(id);
      if (!code) return false;
      return (
        this.drafts.get(code)?.conversation === conversation ||
        this.drafts.retired.get(code)?.conversation === conversation ||
        this.issues.byCode(code)?.conversation === conversation
      );
    }
    if (command.name === 'who') {
      const ref = normalizeRef(id);
      return Boolean(
        ref &&
        (this.issues.inConversation(ref, conversation) ||
          this.drafts.findByRef(ref)?.conversation === conversation),
      );
    }
    return false;
  }

  // ---- Commands --------------------------------------------------------------------------

  async command({ name, args }, request) {
    const { sender, context } = request;
    const conversation = context.conversation;
    switch (name) {
      case 'new':
        return this.newCommand(args, request);
      case 'drafts':
        return this.say(request, draftList(this.drafts.list(conversation, sender)));
      case 'edit': {
        const { id, rest } = splitId(args);
        const draft = this.ownDraft(id, request, 'edit');
        if (!draft) return;
        if (!rest)
          return this.say(request, `Tell me what to change: /edit ${draft.code} <instructions>`);
        return this.startEdit(draft, rest, request);
      }
      case 'confirm':
        return this.confirm(splitId(args).id, request);
      case 'cancel': {
        const draft = this.ownDraft(splitId(args).id, request, 'cancel');
        if (!draft) return;
        if (draft.publishing) return this.say(request, `${draft.ref} is already being published.`);
        this.drafts.remove(draft);
        this.drafts.retire(draft);
        return this.say(request, `Cancelled draft ${draft.ref} (code ${draft.code}).`);
      }
      case 'issues':
        return this.say(request, issueList(this.issues.recent(conversation)));
      case 'who':
        return this.who(splitId(args).id, request);
      default:
        return this.say(
          request,
          name === 'unknown'
            ? `Unknown command.\n\n${this.helpFor(request)}`
            : this.helpFor(request),
        );
    }
  }

  helpFor({ sender, context }) {
    return helpText({
      repos: this.access.repos(sender),
      // Public groups are readable by anyone: never list a user's repositories there.
      showRepos: context.type !== 'public',
      group: context.type !== 'dm',
    });
  }

  // /new owner/repo <description>. Without a repository, behaves like a plain request.
  async newCommand(args, request) {
    if (!args) return this.say(request, 'Usage: /new owner/repo <description of the issue>');
    const { id, rest } = splitId(args);
    if (validRepo(id)) {
      const repo = this.access.repo(request.sender, id);
      if (!repo) return this.say(request, this.deniedText([id], request));
      if (!rest) return this.say(request, `Describe the issue too: /new ${repo} <description>`);
      return this.startDraft(repo, rest, request);
    }
    return this.newRequest(args, request);
  }

  // Finds a draft by its current code for /edit, /confirm and /cancel. Every check runs on
  // every call: same conversation, same requester, current revision. Otherwise it explains
  // the problem and returns undefined. Codes from other conversations look unknown.
  ownDraft(rawId, request, action) {
    const { sender, context } = request;
    const conversation = context.conversation;
    const code = normalizeCode(rawId);
    if (!code) {
      const ref = normalizeRef(rawId);
      const byRef = ref && this.drafts.findByRef(ref);
      if (byRef && byRef.conversation === conversation && byRef.requester === sender)
        this.say(request, `Use the draft's current code: /${action} ${byRef.code}`);
      else this.say(request, `Usage: /${action} CODE${action === 'edit' ? ' <instructions>' : ''}`);
      return undefined;
    }
    const draft = this.drafts.get(code);
    if (draft && draft.conversation === conversation) {
      if (draft.requester === sender) return draft;
      this.say(request, `Only the person who requested draft ${code} can ${action} it.`);
      return undefined;
    }
    const record = this.issues.byCode(code);
    if (record && record.conversation === conversation) {
      if (record.requester !== sender)
        this.say(request, `Only the person who requested draft ${code} can ${action} it.`);
      else if (record.state === 'published')
        this.say(
          request,
          `Draft ${code} was already published as ${record.ref}: ${record.url}. Nothing was changed.`,
        );
      else if (record.state === 'publishing')
        this.say(request, `${record.ref} is already being published. Please wait for the result.`);
      else if (record.state === 'review') this.say(request, reviewText(record));
      else
        this.say(
          request,
          `Draft ${code} could not be published and is no longer available. Please create it again.`,
        );
      return undefined;
    }
    const retired = this.drafts.retired.get(code);
    if (retired && retired.conversation === conversation && retired.requester === sender) {
      const current = this.drafts.findByRef(retired.ref);
      this.say(
        request,
        current
          ? `Code ${code} belongs to an older version of draft ${retired.ref}. The current code is ${current.code}; review the latest version before you ${action} it.`
          : `Code ${code} is no longer valid.`,
      );
      return undefined;
    }
    this.say(
      request,
      `No draft with code ${code} in this conversation. Drafts expire ${Math.round(this.drafts.ttlMs / 3600000)} hours after creation and are forgotten when the bot restarts. Send /drafts to list yours.`,
    );
    return undefined;
  }

  async who(rawId, request) {
    const ref = normalizeRef(rawId);
    if (!ref) return this.say(request, 'Usage: /who AG-XXXX');
    const conversation = request.context.conversation;
    // Only records created in this conversation. In a DM that means only the requester's.
    const record = this.issues.inConversation(ref, conversation);
    if (record) return this.say(request, whoText(record));
    const draft = this.drafts.findByRef(ref);
    if (draft?.conversation === conversation)
      return this.say(
        request,
        `${ref} is an unpublished draft for ${draft.repo}, requested by ${nip19.npubEncode(draft.requester)} in this conversation.`,
      );
    return this.say(request, `No issue ${ref} was created in this conversation.`);
  }

  // ---- Natural language ------------------------------------------------------------------
  // Fixed rules decide what plain text means. The model is never asked what to do.

  async natural(request) {
    const { text, sender, target, context } = request;
    const conversation = context.conversation;

    // 1. A reply to one of the bot's draft messages edits exactly that draft revision.
    if (target?.kind === 'draft') {
      const draft = this.drafts.get(target.code);
      if (!draft || draft.conversation !== conversation)
        return this.ownDraft(target.code, request, 'edit');
      if (draft.requester !== sender)
        return this.say(
          request,
          `Only the person who requested draft ${draft.code} can change it.`,
        );
      if (confirmationPhrase(text)) return this.say(request, confirmHint([draft]));
      return this.startEdit(draft, text, request);
    }

    // 2. A message naming one of the requester's current codes edits that draft.
    const candidates = codeCandidates(text);
    const named = candidates
      .map((code) => this.drafts.get(code))
      .filter((d) => d && d.conversation === conversation && d.requester === sender);
    if (named.length > 1)
      return this.say(
        request,
        `Your message names several drafts (${named.map((d) => d.code).join(', ')}). Please change one at a time with /edit CODE <instructions>.`,
      );
    if (named.length === 1) {
      const rest = removeToken(text, named[0].code);
      if (!rest || confirmationPhrase(rest)) return this.say(request, confirmHint(named));
      return this.startEdit(named[0], rest, request);
    }
    const stale = candidates.find((code) => {
      const retired = this.drafts.retired.get(code);
      return retired?.conversation === conversation && retired.requester === sender;
    });
    if (stale) return this.ownDraft(stale, request, 'edit');

    // 3. Approval in plain words never publishes.
    if (confirmationPhrase(text)) {
      const drafts = this.drafts.list(conversation, sender).filter((d) => !d.publishing);
      return this.say(
        request,
        drafts.length
          ? confirmHint(drafts)
          : 'There is no draft of yours to confirm in this conversation.',
      );
    }

    // 4. An answer to "which repository?".
    const question = this.question(request.key);
    if (question) {
      const permitted = this.permittedRepos(text, sender);
      const rest = withoutRepos(text);
      const words = rest.split(/\s+/).filter(Boolean).length;
      if (permitted.length && (target?.kind === 'question' || words <= 3)) {
        if (permitted.length > 1) return this.askRepo(question.text, request, []);
        this.questions.delete(request.key);
        const extra = target?.kind === 'question' && words > 3 ? `\n${rest}` : '';
        return this.startDraft(permitted[0], `${question.text}${extra}`, request);
      }
      if (target?.kind === 'question') return this.askRepo(question.text, request, []);
    }

    // 5. A new request.
    if (!issueIntent(text) && !this.permittedRepos(text, sender).length)
      return this.say(
        request,
        'I create GitHub issue drafts. For example: "create an issue in owner/repo about the login bug", or send /help.',
      );
    return this.newRequest(text, request);
  }

  permittedRepos(text, sender) {
    return [...new Set(repoRefs(text).flatMap(({ repo }) => this.access.repo(sender, repo) ?? []))];
  }

  // Picks the repository from the requester's own words. The model never chooses it.
  async newRequest(text, request) {
    const permitted = this.permittedRepos(text, request.sender);
    if (permitted.length === 1) return this.startDraft(permitted[0], text, request);
    const denied = repoRefs(text)
      .filter((r) => r.explicit && !this.access.repo(request.sender, r.repo))
      .map((r) => r.repo);
    return this.askRepo(text, request, permitted.length ? [] : denied);
  }

  async askRepo(text, request, denied) {
    this.questions.delete(request.key);
    this.questions.set(request.key, { text, at: now() });
    bound(this.questions);
    const lines = [];
    if (denied.length) lines.push(this.deniedText(denied, request));
    lines.push(
      request.context.type === 'public'
        ? 'Which repository should this issue go to? Reply with its name (owner/repo).'
        : `Which repository should this issue go to? Reply with one of: ${this.access.repos(request.sender).join(', ')}`,
    );
    return this.say(request, lines.join('\n'), { kind: 'question', requester: request.sender });
  }

  deniedText(repos, request) {
    const yours =
      request.context.type === 'public'
        ? ''
        : ` Your repositories: ${this.access.repos(request.sender).join(', ')}.`;
    return `You are not allowed to create issues in ${repos.join(', ')}.${yours}`;
  }

  question(key) {
    const question = this.questions.get(key);
    if (question && question.at <= now() - QUESTION_SECONDS) {
      this.questions.delete(key);
      return undefined;
    }
    return question;
  }

  // ---- Model jobs ------------------------------------------------------------------------

  // Common checks before any model call. Returns false after explaining the refusal.
  reserveModel(request) {
    if (this.busy.has(request.key)) {
      this.say(
        request,
        'I am still working on your previous request in this conversation. Please wait for it.',
      );
      return false;
    }
    if (this.models.full) {
      this.say(request, 'The bot is busy right now. Please try again in a minute.');
      return false;
    }
    if (!this.allow(this.modelCalls, request.sender, this.limits.modelCallsPerHour)) {
      this.say(
        request,
        `You have reached the limit of ${this.limits.modelCallsPerHour} drafts and edits per hour. Please try again later.`,
      );
      return false;
    }
    this.busy.add(request.key);
    return true;
  }

  startDraft(repo, text, request) {
    if (!this.drafts.room(request.sender))
      return this.say(
        request,
        `You already have ${this.drafts.maxPerUser} pending drafts. Confirm or cancel one first (/drafts lists those in this conversation).`,
      );
    if (!this.reserveModel(request)) return;
    this.models.push(() => this.draftJob(request, repo, text));
  }

  startEdit(draft, instructions, request) {
    if (draft.publishing) return this.say(request, `${draft.ref} is already being published.`);
    if (draft.editing)
      return this.say(request, `Draft ${draft.code} is already being edited. Please wait.`);
    if (!this.reserveModel(request)) return;
    draft.editing = true;
    this.models.push(() => this.editJob(request, draft, instructions));
  }

  async draftJob(request, repo, text) {
    let content, failure;
    try {
      content = await this.generate(draftMessages({ repo, request: text }), repo, request);
    } catch (error) {
      failure = error;
    } finally {
      this.busy.delete(request.key);
    }
    if (this.stopped) return;
    this.submit(`draft:${request.message.id}`, async () => {
      if (failure) return this.reply(request, modelFailureText(failure, this.ollama.model));
      if (!this.drafts.room(request.sender))
        return this.reply(request, `You already have ${this.drafts.maxPerUser} pending drafts.`);
      const draft = this.drafts.create({
        ref: newRef((ref) => this.drafts.findByRef(ref) || this.issues.byRef(ref)),
        code: this.freshCode(),
        requester: request.sender,
        conversation: request.context.conversation,
        repo,
        content,
      });
      this.log(`Draft created (${request.context.type}, ${repo}).`);
      await this.reply(request, formatDraft(draft), { kind: 'draft', code: draft.code });
    });
  }

  async editJob(request, draft, instructions) {
    const { code, revision } = draft;
    let content, failure;
    try {
      content = await this.generate(
        editMessages({ repo: draft.repo, draft, instructions }),
        draft.repo,
        request,
      );
    } catch (error) {
      failure = error;
    } finally {
      this.busy.delete(request.key);
    }
    if (this.stopped) return;
    // Applied on the message chain, so no /confirm can slip between the check and the change.
    const queued = this.submit(`edit:${request.message.id}`, async () => {
      draft.editing = false;
      if (failure)
        return this.reply(
          request,
          `${modelFailureText(failure, this.ollama.model)} Draft ${code} is unchanged.`,
        );
      if (this.drafts.get(code) !== draft || draft.revision !== revision || draft.publishing)
        return this.reply(
          request,
          `Draft ${draft.ref} was cancelled, published or expired before the edit finished. The edit was discarded.`,
        );
      this.drafts.revise(draft, this.freshCode(), content);
      this.log(`Draft revised (${request.context.type}, ${draft.repo}).`);
      await this.reply(
        request,
        `${formatDraft(draft, { revised: true })}\nThe previous code ${code} is no longer valid.`,
        { kind: 'draft', code: draft.code },
      );
    });
    if (!queued) draft.editing = false; // Never leave a draft locked if the result is dropped.
  }

  freshCode() {
    return newCode((c) => this.drafts.has(c) || Boolean(this.issues.byCode(c)));
  }

  // One model call plus the duplicate search. Throws model/draft errors.
  async generate(messages, repo, request) {
    const started = Date.now();
    let result;
    try {
      result = await this.ollama.chat(messages, {
        signal: this.abort.signal,
        format: DRAFT_SCHEMA,
      });
    } catch (error) {
      if (!this.stopped) this.log(`Ollama request failed (${error?.code ?? 'internal error'}).`);
      throw error;
    }
    const content = parseDraft(result.text, {
      maxBody: this.limits.maxBodyChars,
      truncated: result.truncated,
    });
    this.log(`Model answered in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    const { similar, warnings } = await this.similar(repo, content.title, request);
    return { ...content, similar, warnings: [...content.warnings, ...warnings] };
  }

  // Possible duplicates. Only a warning: the requester may still confirm unchanged.
  // Only this conversation's own records are mentioned, so a group never learns about issues
  // someone published elsewhere. In groups, existing issue titles are not quoted (they may
  // come from a private repository and not every reader is an allowed user): only links.
  async similar(repo, title, { sender: requester, context }) {
    const similar = [];
    const warnings = [];
    const normalized = normalizeTitle(title);
    for (const r of this.issues.all) {
      if (
        r.requester === requester &&
        r.conversation === context.conversation &&
        r.repo === repo &&
        r.state === 'published' &&
        r.createdAt > now() - 30 * DAY &&
        normalizeTitle(r.title) === normalized
      )
        similar.push(`You already published ${r.ref} with the same title: ${r.url}`);
    }
    try {
      const words = keywords(title);
      for (const item of await this.github.searchIssues(repo, title)) {
        const same = normalizeTitle(item.title) === normalized;
        const shared = keywords(item.title).filter((w) => words.includes(w)).length;
        if (!same && shared < Math.min(2, words.length)) continue;
        if (similar.some((line) => line.includes(item.url))) continue;
        const state = item.state === 'closed' ? 'closed' : 'open';
        const label = context.type === 'dm' ? ` ${sanitizeText(item.title).slice(0, 200)}` : '';
        similar.push(
          `${same ? 'Same title: ' : ''}#${item.number} (${state})${label} — ${item.url}`,
        );
      }
    } catch (error) {
      this.log(`Similar-issue search failed (${error?.code ?? 'internal error'}).`);
      warnings.push('I could not search GitHub for similar issues right now.');
    }
    return { similar: similar.slice(0, 5), warnings };
  }

  // ---- Confirmation and publication --------------------------------------------------------

  // /confirm CODE: the only path that creates an issue.
  async confirm(rawId, request) {
    const draft = this.ownDraft(rawId, request, 'confirm');
    if (!draft) return;
    if (draft.publishing)
      return this.say(
        request,
        `${draft.ref} is already being published. Please wait for the result.`,
      );
    if (draft.editing)
      return this.say(
        request,
        `Draft ${draft.code} is being edited. Wait for the new version, then confirm its new code.`,
      );
    const repo = this.access.repo(request.sender, draft.repo);
    if (!repo) return this.say(request, this.deniedText([draft.repo], request));
    if (this.issues.countSince(request.sender, now() - DAY) >= this.limits.issuesPerDay)
      return this.say(
        request,
        `You have reached the limit of ${this.limits.issuesPerDay} published issues per 24 hours. Your draft is kept until it expires; try again later.`,
      );
    if (this.publisher.full)
      return this.say(request, 'The bot is busy right now. Please try again in a minute.');
    // The record is on disk before GitHub is contacted. See README, "Publication safety".
    const record = {
      ref: draft.ref,
      code: draft.code,
      attempt: randomUUID(),
      requester: request.sender,
      conversation: request.context.conversation,
      repo,
      title: draft.title,
      messageId: request.message.id,
      state: 'publishing',
      sending: false,
      createdAt: now(),
      updatedAt: now(),
      notified: true,
      checks: 0,
    };
    this.issues.add(record);
    draft.publishing = true;
    this.save();
    const body = issueBody(draft, draft.ref, record.attempt);
    this.publisher.push(() => this.publish(record, body));
  }

  // Sends the one and only creation request for this attempt. Never retried automatically.
  async publish(record, body) {
    if (this.stopped || record.state !== 'publishing' || record.sending) return;
    record.sending = true;
    record.updatedAt = now();
    this.save();
    try {
      const issue = await this.github.createIssue(record.repo, { title: record.title, body });
      this.finish(record, 'published', issue);
    } catch (error) {
      if (definitelyNotCreated(error)) return this.finish(record, 'failed', undefined, error);
      this.log(
        `Publication of ${record.ref} is uncertain (${error?.code ?? 'error'}); checking GitHub.`,
      );
      this.send(record, uncertainText(record));
      this.scheduleReconcile(record);
    }
  }

  // Looks for the attempt's marker among the bot account's recent issues. Found means
  // published. Never concludes "not created": after the last check it asks the operator.
  async reconcile(record) {
    if (this.stopped || record.state !== 'publishing') return;
    let found;
    try {
      this.login ??= (await this.github.user()).login;
      const { issues } = await this.github.recentIssues(record.repo, {
        creator: this.login,
        since: record.createdAt - 300,
      });
      found = issues.find((issue) => issue.body.includes(markerText(record.attempt)));
    } catch (error) {
      this.log(
        `Reconciliation of ${record.ref} could not reach GitHub (${error?.code ?? 'error'}).`,
      );
    }
    if (this.stopped) return;
    record.checks = (record.checks ?? 0) + 1;
    record.updatedAt = now();
    this.save();
    if (found) return this.finish(record, 'published', found);
    if (record.checks >= this.reconcileDelays.length) return this.finish(record, 'review');
    this.scheduleReconcile(record);
  }

  scheduleReconcile(record) {
    if (this.stopped) return;
    const delays = this.reconcileDelays;
    const delay = delays[Math.min(record.checks ?? 0, delays.length - 1)];
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.publisher.push(() => this.reconcile(record))) this.scheduleReconcile(record);
    }, delay * 1000);
    this.timers.add(timer);
  }

  // Records the outcome on disk first, then tells the requester.
  finish(record, state, issue, error) {
    record.state = state;
    record.updatedAt = now();
    if (issue) {
      record.number = issue.number;
      record.url = issue.url;
    }
    if (error) record.error = error.code ?? 'error';
    record.notified = false;
    const draft = this.drafts.findByRef(record.ref);
    if (draft?.code === record.code) {
      if (state === 'failed') draft.publishing = false;
      else this.drafts.remove(draft);
    }
    this.save();
    if (state === 'published')
      this.log(`Published ${record.ref} as ${record.repo}#${record.number}.`);
    else if (state === 'review')
      this.log(
        `${record.ref} needs operator review: the outcome is uncertain. Run "npm run review".`,
      );
    else this.log(`Publication of ${record.ref} failed (${record.error}).`);
    this.sendOutcome(record);
  }

  sendOutcome(record) {
    const draftKept = this.drafts.findByRef(record.ref)?.code === record.code;
    let text;
    if (record.state === 'published') text = publishedText(record);
    else if (record.state === 'review') text = reviewText(record);
    else if (!draftKept)
      text = `${record.ref} was not published, and the unconfirmed draft was not kept because the bot restarted. Please request it again.`;
    else text = githubFailureText({ code: record.error }, record);
    this.send(record, text, () => {
      record.notified = true;
      this.save();
    });
  }

  // Replies to the /confirm message in its conversation, possibly after a restart.
  send(record, text, done = () => {}) {
    this.submit(`notice:${record.attempt}:${record.state}:${record.checks ?? 0}`, async () => {
      await this.deliverTo(
        record.conversation,
        { id: record.messageId, pubkey: record.requester },
        text,
      );
      done();
    });
  }

  // On startup: finish what a crash or shutdown interrupted.
  recover() {
    for (const record of this.issues.all) {
      if (record.state === 'publishing' && !record.sending) {
        // The record was written, but the request never started: nothing was created.
        this.finish(record, 'failed', undefined, { code: 'restart' });
      } else if (record.state === 'publishing') {
        this.log(`Checking whether ${record.ref} was created before the restart.`);
        this.scheduleReconcile(record);
      } else {
        if (record.state === 'review')
          this.log(`${record.ref} still needs operator review. Run "npm run review".`);
        if (record.notified === false) this.sendOutcome(record);
      }
    }
  }

  // ---- Replies ---------------------------------------------------------------------------

  // Replies right away; only for code already running on the message chain. Some callers do
  // not await it, so it never rejects: a storage error goes to onFatal, and close() waits
  // for replies still in flight before releasing the data directory.
  say(request, text, meta) {
    const promise = this.reply(request, text, meta).catch((error) => {
      if (this.stopped) return;
      this.stopped = true;
      this.onFatal(error);
    });
    this.replying.add(promise);
    promise.finally(() => this.replying.delete(promise));
    return promise;
  }

  async reply(request, text, meta = { kind: 'other' }) {
    const id = await this.deliverTo(request.context.conversation, request.message, text);
    if (id) {
      this.sent.set(id, { ...meta, conversation: request.context.conversation });
      bound(this.sent, 5000);
    }
    return id;
  }

  // Signs the reply into the outbox for one conversation. Returns the reply's id.
  async deliverTo(conversation, message, text) {
    const split = conversation.indexOf(':');
    const type = conversation.slice(0, split);
    const target = conversation.slice(split + 1);
    if (type === 'dm') return sendDirect(this, { ...message, pubkey: target }, text);
    if (type === 'private' && this.access.privateGroup(target))
      return sendPrivate(this, message, target, text);
    if (type === 'public' && this.access.publicGroup(target))
      return sendPublic(this, message, target, text);
    return undefined;
  }

  // ---- Bookkeeping -----------------------------------------------------------------------

  // Sliding one-hour window per sender.
  allow(map, pubkey, max) {
    const recent = (map.get(pubkey) ?? []).filter((t) => t > now() - HOUR);
    map.delete(pubkey);
    if (recent.length >= max) {
      map.set(pubkey, recent);
      return false;
    }
    recent.push(now());
    map.set(pubkey, recent);
    bound(map);
    return true;
  }

  // Persists when each allowed user and group was first allowed. Times survive restarts;
  // an identity missing from the configuration at startup loses its time, so adding it
  // back later starts again from that later startup.
  authorize() {
    const current = {
      users: [...this.access.users.keys()],
      privateGroups: [...this.access.privateGroups],
      publicGroups: [...this.access.publicGroups],
    };
    const saved = this.state.authorized ?? {};
    const next = {};
    for (const [list, ids] of Object.entries(current)) {
      const times = saved[list] ?? {};
      next[list] = {};
      for (const id of ids) {
        const time = Object.hasOwn(times, id) ? times[id] : now();
        if (!Number.isSafeInteger(time) || time < 0)
          throw new Error('Invalid saved authorization time. Restore state.json from backup.');
        next[list][id] = time;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(saved)) return;
    this.state.authorized = next;
    this.save();
  }
  allowedWhenWritten(message, context) {
    const { users, privateGroups, publicGroups } = this.state.authorized;
    const group = context.conversation.slice(context.type.length + 1);
    const since = [users[message.pubkey]];
    if (context.type === 'private') since.push(privateGroups[group]);
    if (context.type === 'public') since.push(publicGroups[group]);
    return since.every((time) => Number.isSafeInteger(time) && message.created_at >= time);
  }
  markSeen(message) {
    this.state.seen[message.id] = now();
    this.save();
  }
  queue(message, deliveries) {
    // Persist the exact signed reply before publishing. A crash/retry republishes
    // identical event IDs instead of asking the model a second time.
    this.state.seen[message.id] = now();
    this.state.outbox.push(...deliveries.map((delivery) => ({ ...delivery, queuedAt: now() })));
    this.save();
  }

  // Logs show who to allow, never what they wrote. One line per key per hour.
  note(key, line) {
    if ((this.logged.get(key) ?? 0) > now() - HOUR) return;
    this.logged.delete(key);
    this.logged.set(key, now());
    bound(this.logged);
    this.log(line);
  }
  ignoredSender(pubkey) {
    this.note(pubkey, `Ignored a message from ${nip19.npubEncode(pubkey)}: not in ALLOWED_USERS.`);
  }
  ignoredPrivateGroup(group) {
    this.note(
      group,
      `Ignored a private group invitation from ${nip19.npubEncode(group)}: not in ALLOWED_PRIVATE_GROUPS.`,
    );
  }
  ignoredPublicGroup(room) {
    const naddr = nip19.naddrEncode({
      kind: 34550,
      pubkey: room.event.pubkey,
      identifier: single(room.event, 'd'),
      relays: room.relays.slice(0, 3),
    });
    this.note(room.address, `Ignored public group ${naddr}: not in ALLOWED_PUBLIC_GROUPS.`);
  }

  // ---- Nostr plumbing (same as the Ollama Bridge) ------------------------------------------

  // Returns false if the action was not queued.
  submit(id, action) {
    if (this.stopped || this.pending.has(id) || this.pending.size >= 2000) return false;
    this.pending.add(id);
    this.work = this.work
      .then(async () => {
        if (!this.stopped) await action();
      })
      .catch((error) => {
        this.stopped = true;
        this.onFatal(error);
      })
      .finally(() => this.pending.delete(id));
    return true;
  }
  receive(event, key, group) {
    this.submit(event.id, async () => {
      const opened = unwrap(event, key);
      if (!opened) return;
      if (group) await privateMessage(this, opened.message, group, getPublicKey(key));
      else await directMessage(this, opened.message, opened.seal);
    });
  }
  privateTicket(message, seal) {
    acceptTicket(this, message, seal);
  }
  async inbox(pubkey) {
    const cached = this.inboxes.get(pubkey);
    if (cached && cached.at > now() - 300) return cached.relays;
    let latest;
    try {
      for (const event of await this.net.query(this.relays, {
        kinds: [10050],
        authors: [pubkey],
        limit: 10,
      })) {
        if (event.kind === 10050 && event.pubkey === pubkey && valid(event) && newer(event, latest))
          latest = event;
      }
    } catch {
      /* Configured relays remain usable when discovery fails. */
    }
    const hints = latest?.tags.filter((t) => t[0] === 'relay').map((t) => t[1]) ?? [];
    const relays = this.net.routes(hints);
    if (this.inboxes.size >= 1000) this.inboxes.delete(this.inboxes.keys().next().value);
    this.inboxes.set(pubkey, { at: now(), relays });
    return relays;
  }
  setWatch(name, relays, filter, handler, key = this.key) {
    if (!this.started || this.stopped) return;
    this.watches.get(name)?.();
    this.watches.set(name, this.net.watch(relays, filter, handler, key));
  }
  refreshPrivate(group) {
    this.watches.get(`private:${group}`)?.();
    const epoch = this.state.groups[group];
    if (!epoch || epoch.conflict || !this.access.privateGroup(group)) return;
    if (!this.started || this.stopped) return;
    const key = bytes(epoch.ticket.content);
    const watch = (relays) =>
      this.setWatch(
        `private:${group}`,
        relays,
        () => ({
          kinds: [1059],
          '#p': [epoch.pubkey],
          since: Math.max(this.state.startedAt, now() - DAY) - 2 * DAY - 60,
          limit: 1000,
        }),
        (event) => this.receive(event, key, group),
        key,
      );
    watch(this.groupRelays.get(group) ?? this.relays);
    void this.inbox(group)
      .then((relays) => {
        if (this.stopped || this.state.groups[group] !== epoch) return;
        this.groupRelays.set(group, relays);
        watch(relays);
      })
      .catch(() => this.log('Group relay discovery failed; using configured relays.'));
  }
  refreshPublic(address) {
    const room = parseRoom(this.state.rooms[address].event);
    if (!room || !this.access.publicGroup(address)) return;
    const owner = room.event.pubkey;
    const slug = single(room.event, 'd');
    this.setWatch(
      `profile:${address}`,
      room.relays,
      () => ({ kinds: [34550], authors: [owner], '#d': [slug], limit: 10 }),
      (event) => this.submit(event.id, () => acceptRoom(this, event)),
    );
    this.setWatch(
      `public:${address}`,
      room.relays,
      () => ({
        kinds: [9],
        '#a': [address],
        since: Math.max(this.state.startedAt, now() - DAY),
        limit: 1000,
      }),
      (event) => this.submit(event.id, () => publicMessage(this, event, address)),
    );
  }
  async start() {
    this.started = true;
    this.log(`${this.name}: ${nip19.npubEncode(this.pubkey)}`);
    this.setWatch(
      'inbox',
      this.relays,
      () => ({ kinds: [1059], '#p': [this.pubkey], limit: 1000 }),
      (event) => this.receive(event, this.key),
    );
    // Rooms where an owner marked the bot Trusted. acceptRoom() still requires the room
    // to be in ALLOWED_PUBLIC_GROUPS; this only notices rooms outside the startup lookup.
    this.setWatch(
      'discovery',
      this.relays,
      () => ({ kinds: [34550], limit: 500 }),
      (event) => this.submit(event.id, () => acceptRoom(this, event)),
    );
    for (const group of Object.keys(this.state.groups)) this.refreshPrivate(group);
    for (const room of Object.keys(this.state.rooms)) this.refreshPublic(room);
    this.timer = setInterval(() => {
      void this.flush().catch(this.onFatal);
    }, 2000);
    this.discoveryTimer = setInterval(() => {
      for (const group of Object.keys(this.state.groups)) this.refreshPrivate(group);
    }, 5 * 60000);
    this.recover();
    await this.flush();
  }
  async flush() {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      for (const item of this.state.outbox
        .filter((item) => !item.retryAt || item.retryAt <= now())
        .slice(0, 20)) {
        if (this.stopped) break;
        const epoch = item.group && this.state.groups[item.group];
        const room = item.room && this.state.rooms[item.room];
        const policy = room && parseRoom(room.event);
        const obsolete =
          item.queuedAt < now() - DAY ||
          (item.group && (!epoch || epoch.conflict || epoch.epoch !== item.epoch)) ||
          (item.room &&
            (!policy ||
              policy.blocked.includes(this.pubkey) ||
              (!room.explicit && !policy.trusted.includes(this.pubkey))));
        if (!obsolete) {
          try {
            await this.net.publish(
              item.event,
              policy?.relays ?? (item.group && this.groupRelays.get(item.group)) ?? item.relays,
              epoch ? bytes(epoch.ticket.content) : this.key,
            );
          } catch {
            item.attempts = (item.attempts ?? 0) + 1;
            item.retryAt = now() + Math.min(300, 2 ** Math.min(item.attempts, 9));
            this.save();
            continue;
          } // One ACK is enough. With zero ACKs the durable outbox retries.
        }
        this.state.outbox = this.state.outbox.filter((pending) => pending !== item);
        this.save();
      }
      // Incoming age checks use a 24h window; keep dedupe IDs longer than that window.
      let changed = false;
      for (const [id, time] of Object.entries(this.state.seen)) {
        if (time < now() - 2 * DAY) {
          delete this.state.seen[id];
          changed = true;
        }
      }
      if (changed) this.save();
      const queued = this.state.outbox.length;
      if (queued && now() - (this.lastWarning ?? 0) > 60) {
        this.log(`${queued} deliveries pending; relays will be retried.`);
        this.lastWarning = now();
      }
    } finally {
      this.flushing = false;
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.discoveryTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Cancel the model request in progress and forget waiting jobs (drafts are in memory
    // anyway). A GitHub request in progress is NOT cancelled: its outcome is recorded first.
    this.abort.abort();
    await this.models.stop();
    await this.publisher.stop();
    this.net.close();
    await this.work;
    await Promise.all(this.replying);
    // A publish finishing during shutdown still writes its result before releasing the lock.
    while (this.flushing) await new Promise((r) => setTimeout(r, 10));
    this.store.close();
  }
}

// Keeps an insertion-ordered Map bounded by dropping its oldest entries.
function bound(map, max = 1000) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function confirmHint(drafts) {
  return [
    'Plain-text replies never publish anything. To publish, send the command with the code:',
    ...drafts.map((d) => `/confirm ${d.code} — ${d.ref} ${d.repo}: ${d.title}`),
  ].join('\n');
}

export async function publishProfile(bot, { pictureURL = '', nip05 = '' } = {}) {
  await bot.net.publish(
    sign(
      bot.key,
      10050,
      bot.relays.map((r) => ['relay', r]),
    ),
    bot.relays,
    bot.key,
  );
  if (pictureURL && new URL(pictureURL).protocol !== 'https:')
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
        ...(nip05 ? { nip05 } : {}),
        about:
          'Drafts GitHub issues from chat requests with a local AI model. Publishes only after /confirm from people its operator has allowed.',
        ...(pictureURL ? { picture: pictureURL } : {}),
      }),
    ),
    bot.relays,
    bot.key,
  );
}

// Startup checks so the operator sees problems early. Never fatal: services may start later.
export async function checkServices(bot, repos, log) {
  try {
    if (await bot.ollama.hasModel())
      log(`Ollama is reachable; model ${bot.ollama.model} is installed.`);
    else
      log(
        `Ollama is reachable, but model ${bot.ollama.model} is missing. Run: ollama pull ${bot.ollama.model}`,
      );
  } catch {
    log('Ollama is not reachable yet. Start it with "ollama serve"; the bot keeps running.');
  }
  try {
    bot.login = (await bot.github.user()).login;
    log(`GitHub token accepted (account ${bot.login}).`);
  } catch (error) {
    log(`GitHub token check failed (${error?.code ?? 'error'}). Check GITHUB_TOKEN.`);
  }
  for (const repo of repos) {
    try {
      const info = await bot.github.repository(repo);
      log(
        `${repo}: ${info.archived ? 'archived, issues cannot be created' : info.hasIssues ? 'ok' : 'issues are disabled'}`,
      );
    } catch (error) {
      log(
        `${repo}: not accessible (${error?.code ?? 'error'}). Check the token's repository access.`,
      );
    }
  }
}

export async function main() {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const store = new State(config.dataDir || resolve(HERE, 'data'), { nsec: config.nsec });
  let bot;
  try {
    const net = new Network(config.relays);
    const access = new Access({
      users: config.access.users,
      privateGroups: config.access.privateGroups,
      publicGroups: config.access.publicGroups.map((g) => g.address),
    });
    const fatal = () => {
      console.error(
        'Bot stopped after an internal/storage error. Check disk space and data permissions.',
      );
      process.exitCode = 1;
      void shutdown();
    };
    bot = new IssueAgent({
      store,
      net,
      ollama: new OllamaClient(config.ollama),
      github: new GitHubClient(config.github),
      access,
      drafts: new Drafts(config.drafts),
      limits: config.limits,
      name: config.name,
      onFatal: fatal,
    });
    let profileTimer,
      publishing = false,
      closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      bot.stopped = true;
      clearInterval(profileTimer);
      while (publishing) await new Promise((r) => setTimeout(r, 50));
      await bot.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (!bot.ollama.local)
      console.log('Warning: OLLAMA_URL is not on this computer. Use HTTPS or a private network.');
    if (!config.access.users.size)
      console.log('Warning: ALLOWED_USERS is empty, so the bot will not answer anyone.');
    await bot.start();
    void checkServices(bot, config.repos, console.log);
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
    for (const { link } of config.access.publicGroups) {
      bot.submit(`join:${link}`, async () => {
        try {
          if (!(await joinPublic(bot, link)))
            console.error('Allowed public group not found; check the link and relays.');
        } catch {
          console.error('Allowed public group lookup failed.');
        }
      });
    }
  } catch (error) {
    if (bot) await bot.close();
    else store.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : 'Cannot start GitHub Issue Agent. Check configuration and state.json; existing keys are never replaced.',
    );
    process.exitCode = 1;
  });
}
