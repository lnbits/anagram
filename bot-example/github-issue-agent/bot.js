import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  ConfigurationError,
  mentions,
  Network,
  now,
  rumor,
  sign,
  single,
  State,
  unwrap,
  valid,
  wrap,
} from './vendor/runtime.js';
import { BotTransport } from './vendor/bot.js';
import { acceptTicket, authorized, readTicket } from './vendor/private-groups.js';
import { acceptRoom, joinPublic, parseRoom } from './vendor/public-groups.js';
import { Access } from './access.js';
import { loadConfig } from './config.js';
import { Drafts } from './drafts.js';
import { Issues } from './issues.js';
import { Queue } from './queue.js';
import { newCode, newRef, normalizeCode, normalizeRef } from './ids.js';
import {
  confirmationPhrase,
  parseCommand,
  repoRefs,
  replyTarget,
  splitId,
  stripMention,
  validRepo,
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

const DAY = 86400;
const HOUR = 3600;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LANE_LIMIT = 100; // waiting jobs per conversation
const NOT_SHOWN =
  'That repository is not public, so I handle it only in a direct message. Nothing about it is shown here.';

// How a message moves through the bot:
//   relay event -> receive() -> directMessage()/privateMessage()/publicMessage() check the
//   Nostr rules and the allowed groups -> handle() checks addressing, sender, limits ->
//   the conversation's lane -> process() -> command() or natural() -> model jobs
//   (draftJob/editJob) or the publication job (publish) -> reply() signs the answer into
//   the durable outbox -> flush() publishes it.
//
// Relay subscriptions, the outbox and group tickets come from vendor/bot.js (the poll
// example's transport), whose message chain only receives, verifies and authorizes.
// Serial queues keep slow work off it: `models` (Ollama), `publisher` (GitHub issue
// creation and reconciliation) and one lane per conversation (see lane()).
export class IssueAgent extends BotTransport {
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
    // No reply cooldown: the per-user hourly limits below apply instead.
    super({ store, net, name, log, onFatal, cooldown: 0 });
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
    const jobError = () => this.log('Internal error in a background job.');
    this.models = new Queue(this.limits.maxQueue, jobError);
    this.publisher = new Queue(1000, jobError);
    this.lanes = new Map();
    this.abort = new AbortController();
    this.timers = new Set();
    this.replying = new Set();
    // In memory, bounded: ids of messages the bot sent → what they showed, so replies to
    // draft messages can be recognized as edits.
    this.sent = new Map();
    // Repositories GitHub reports as public (checkRepos). See shown().
    this.publicRepos = new Set();
    this.busy = new Set();
    this.requests = new Map();
    this.modelCalls = new Map();
    this.notices = new Map();
    this.logged = new Map();
    this.authorize();
  }

  // ---- Receiving -------------------------------------------------------------------------

  // The transport's replay, age, edit and epoch-author checks, for text messages only.
  shouldReply(message) {
    return typeof message.content === 'string' && super.shouldReply(message);
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
    // A full lane is left unrecorded too, so the message is not lost silently.
    if (this.stopped || this.lanes.get(context.conversation)?.full) return;
    // From here on the message is handled exactly once, even if it fails or a relay
    // resends it later. Persist that before doing anything slow.
    this.markSeen(message);
    const request = {
      message,
      context,
      sender: message.pubkey,
      text,
      command,
      target,
      key: `${context.conversation}\n${message.pubkey}`,
    };
    this.lane(context.conversation, () => this.process(request));
  }

  // One serial Queue per conversation. Everything for one conversation (its requests, model
  // results and publication notices) keeps its order, while a slow GitHub or relay request
  // in one conversation no longer holds up the others. Lanes exist only for allowed users
  // and groups, so their number, and the requests in flight, are bounded by the
  // configuration. Shared state is checked and changed without an await in between.
  lane(conversation, job) {
    if (this.stopped) return false;
    let lane = this.lanes.get(conversation);
    if (!lane) {
      lane = new Queue(LANE_LIMIT, (error) => this.fail(error));
      this.lanes.set(conversation, lane);
    }
    return lane.push(job);
  }
  fail(error) {
    if (this.stopped) return;
    this.stopped = true;
    this.onFatal(error);
  }

  async process(request) {
    const { text, command } = request;
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
      case 'drafts': {
        const drafts = this.drafts.list(conversation, sender);
        const visible = await this.visibleNow(
          drafts.map((d) => d.repo),
          request,
        );
        return this.say(request, draftList(drafts.filter((d) => visible.has(d.repo))));
      }
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
        return this.say(request, `Cancelled draft ${draft.ref} (code ${draft.code}).`);
      }
      case 'issues': {
        const records = this.issues.recent(conversation);
        const visible = await this.visibleNow(
          records.map((r) => r.repo),
          request,
        );
        return this.say(request, issueList(records.filter((r) => visible.has(r.repo))));
      }
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
      showRepos: context.type === 'dm',
      group: context.type !== 'dm',
    });
  }

  // Group members are not necessarily allowed users, and public groups are readable by
  // anyone. In groups the bot names, drafts and links only repositories GitHub reports as
  // public; everything about other repositories stays in direct messages.
  // shown(): the cached answer, for refusing early (a cached "private" only withholds).
  shown(repo, { context }) {
    return context.type === 'dm' || this.publicRepos.has(repo);
  }
  // visibleNow(): the repositories whose details may be sent here right now. In groups a
  // cached "public" may be stale, so GitHub is asked again just before sending; a cached
  // "private" is trusted without a request. Errors count as private and update the cache.
  // Callers send immediately afterwards, on the message chain, with no await in between.
  async visibleNow(repos, request) {
    const visible = new Set();
    for (const repo of new Set(repos)) {
      if (request.context.type === 'dm') {
        visible.add(repo);
        continue;
      }
      if (!this.publicRepos.has(repo)) continue;
      let info;
      try {
        info = await this.github.repository(repo);
      } catch {
        /* Unknown counts as private. */
      }
      if (info?.public === true) visible.add(repo);
      else this.publicRepos.delete(repo);
    }
    return visible;
  }

  // /new owner/repo <description>. Without a repository, behaves like a plain request.
  async newCommand(args, request) {
    if (!args) return this.say(request, 'Usage: /new owner/repo <description of the issue>');
    const { id, rest } = splitId(args);
    if (validRepo(id)) {
      const repo = this.access.repo(request.sender, id);
      if (!repo) return this.say(request, this.deniedText([id], request));
      if (!rest) return this.say(request, 'Describe the issue too: /new owner/repo <description>');
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
      if (!this.shown(draft.repo, request)) return void this.say(request, NOT_SHOWN);
      if (draft.requester === sender) return draft;
      this.say(request, `Only the person who requested draft ${code} can ${action} it.`);
      return undefined;
    }
    const record = this.issues.byCode(code);
    if (record && record.conversation === conversation) {
      if (!this.shown(record.repo, request)) this.say(request, NOT_SHOWN);
      else if (record.requester !== sender)
        this.say(request, `Only the person who requested draft ${code} can ${action} it.`);
      else if (record.state === 'published')
        this.say(
          request,
          `Draft ${code} was already published as ${record.ref}${request.context.type === 'dm' ? `: ${record.url}` : ''}. Nothing was changed.`,
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
    this.say(
      request,
      `No draft with code ${code} in this conversation. Codes change with every edit, drafts expire ${Math.round(this.drafts.ttlMs / 3600000)} hours after creation and are forgotten when the bot restarts. Send /drafts to list yours.`,
    );
    return undefined;
  }

  async who(rawId, request) {
    const ref = normalizeRef(rawId);
    if (!ref) return this.say(request, 'Usage: /who AG-XXXX');
    const conversation = request.context.conversation;
    // Only records created in this conversation. In a DM that means only the requester's.
    const record = this.issues.inConversation(ref, conversation);
    const draft = !record && this.drafts.findByRef(ref);
    const repo = record?.repo ?? (draft?.conversation === conversation && draft.repo);
    if (repo && !(await this.visibleNow([repo], request)).has(repo))
      return this.say(request, NOT_SHOWN);
    if (record) return this.say(request, whoText(record));
    if (repo)
      return this.say(
        request,
        `${ref} is an unpublished draft for ${draft.repo}, requested by ${nip19.npubEncode(draft.requester)} in this conversation.`,
      );
    return this.say(request, `No issue ${ref} was created in this conversation.`);
  }

  // ---- Plain text ------------------------------------------------------------------------
  // Fixed rules decide what plain text means. The model is never asked what to do.

  async natural(request) {
    const { text, sender, target, context } = request;
    // A reply to one of the bot's draft messages edits exactly that draft revision.
    if (target?.kind === 'draft') {
      const draft = this.ownDraft(target.code, request, 'edit');
      if (!draft) return;
      if (confirmationPhrase(text)) return this.say(request, confirmHint([draft], request));
      return this.startEdit(draft, text, request);
    }
    // Approval in plain words never publishes.
    if (confirmationPhrase(text)) {
      const drafts = this.drafts
        .list(context.conversation, sender)
        .filter((d) => !d.publishing && this.shown(d.repo, request));
      return this.say(
        request,
        drafts.length
          ? confirmHint(drafts, request)
          : 'There is no draft of yours to confirm in this conversation.',
      );
    }
    return this.newRequest(text, request);
  }

  // Picks the repository from the requester's own words. The model never chooses it.
  async newRequest(text, request) {
    const refs = repoRefs(text);
    const permitted = [
      ...new Set(refs.flatMap(({ repo }) => this.access.repo(request.sender, repo) ?? [])),
    ];
    if (permitted.length === 1) return this.startDraft(permitted[0], text, request);
    const denied = refs
      .filter((r) => r.explicit && !this.access.repo(request.sender, r.repo))
      .map((r) => r.repo);
    if (!permitted.length && denied.length)
      return this.say(request, this.deniedText(denied, request));
    const ask = permitted.length
      ? 'Your message names several repositories. Pick one'
      : 'Which repository is this for? Name it as owner/repo';
    return this.say(
      request,
      `${ask}, for example: /new owner/repo <description of the issue>${this.yourRepos(request)}`,
    );
  }

  deniedText(repos, request) {
    const names = request.context.type === 'dm' ? repos.join(', ') : 'that repository';
    return `You are not allowed to create issues in ${names}.${this.yourRepos(request)}`;
  }
  // A user's repositories are listed only in their DM (see shown()).
  yourRepos({ sender, context }) {
    if (context.type !== 'dm') return '';
    return ` Your repositories: ${this.access.repos(sender).join(', ')}.`;
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
    if (!this.shown(repo, request)) return this.say(request, NOT_SHOWN);
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
    this.lane(request.context.conversation, async () => {
      if (failure) return this.reply(request, modelFailureText(failure, this.ollama.model));
      // The repository may have stopped being public while the model was working.
      if (!(await this.visibleNow([repo], request)).has(repo))
        return this.reply(request, NOT_SHOWN);
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
    // Applied in the draft's conversation lane, where /confirm runs too, and checked after
    // the last await, so no /confirm can slip between the check and the change.
    const queued = this.lane(request.context.conversation, async () => {
      const visible = !failure && (await this.visibleNow([draft.repo], request)).has(draft.repo);
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
      if (!visible) return this.reply(request, NOT_SHOWN);
      this.drafts.revise(draft, this.freshCode(), content);
      this.log(`Draft revised (${request.context.type}, ${draft.repo}).`);
      await this.reply(
        request,
        `${formatDraft(draft, { revised: true })}\nThe previous code ${code} is no longer valid.`,
        { kind: 'draft', code: draft.code },
      );
    });
    // lane() drops work while stopping or overloaded; never leave the draft locked.
    if (!queued) draft.editing = false;
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

  // Replies to the /confirm message in its conversation, possibly after a restart. If the
  // repository is not (or no longer) public, a group only learns that the requester was
  // told, and the details go to the requester's DM.
  send(record, text, done = () => {}) {
    // Dropped notices keep notified === false and are sent again at the next start.
    this.lane(record.conversation, async () => {
      const message = { id: record.messageId, pubkey: record.requester };
      const context = { type: record.conversation.split(':')[0] };
      if (!(await this.visibleNow([record.repo], { context })).has(record.repo)) {
        await this.deliverTo(`dm:${record.requester}`, message, text);
        text = `${record.ref}: I sent the result to the requester by direct message.`;
      }
      await this.deliverTo(record.conversation, message, text);
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

  // Replies right away; only for code already running in the conversation's lane. Some
  // callers do not await it, so it never rejects: a storage error goes to onFatal, and
  // close() waits for replies still in flight before releasing the data directory.
  say(request, text, meta) {
    const promise = this.reply(request, text, meta).catch((error) => this.fail(error));
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

  // Signs the reply into the outbox for one conversation. Returns the reply's id, which the
  // person's client references when replying to it.
  async deliverTo(conversation, message, text) {
    const split = conversation.indexOf(':');
    const type = conversation.slice(0, split);
    const target = conversation.slice(split + 1);
    if (type === 'dm') {
      // NIP-17, wrapped for the person and for the bot itself (its other clients).
      const relays = await this.inbox(target);
      const reply = rumor(
        this.key,
        [
          ['p', target],
          ['e', message.id, '', 'reply'],
        ],
        text,
      );
      this.queue(message, [
        { event: wrap(reply, this.key, target), relays },
        { event: wrap(reply, this.key, this.pubkey), relays: this.relays },
      ]);
      return reply.id;
    }
    if (type === 'private' && this.access.privateGroup(target)) {
      // The group's epoch at sending time: answers may take a while. Epoch keys never
      // author messages; the bot signs the seal with its own identity.
      const epoch = this.state.groups[target];
      if (!epoch || epoch.conflict) return undefined;
      const reply = rumor(
        this.key,
        [
          ['p', epoch.pubkey],
          ['h', target],
          ['epoch', String(epoch.epoch)],
          ['invited_at', String(epoch.ticket.created_at)],
          ['invitation_proof', epoch.ticket.sig],
          ['e', message.id, '', 'reply'],
        ],
        text,
      );
      this.queue(message, [
        {
          event: wrap(reply, this.key, epoch.pubkey),
          relays: this.groupRelays.get(target) ?? this.relays,
          group: target,
          epoch: epoch.epoch,
        },
      ]);
      return reply.id;
    }
    if (type === 'public' && this.access.publicGroup(target)) {
      // NIP-C7: kind:9 in the room (`a`) quoting the request (`q`). Public for everyone.
      const saved = this.state.rooms[target];
      const room = saved && parseRoom(saved.event);
      if (!room) return undefined;
      const reply = sign(
        this.key,
        9,
        [
          ['a', target],
          ['q', message.id, '', message.pubkey],
        ],
        text,
      );
      this.queue(message, [{ event: reply, relays: room.relays, room: target }]);
      return reply.id;
    }
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

  // ---- Nostr -----------------------------------------------------------------------------
  // vendor/bot.js answers synchronously from its own handlers. This bot answers later (after
  // the model or GitHub) and only in allowed groups, so it receives chat messages itself.

  receive(event, key, group) {
    this.submit(event.id, async () => {
      const opened = unwrap(event, key);
      if (!opened) return;
      if (group) await this.privateMessage(opened.message, group, getPublicKey(key));
      else await this.directMessage(opened.message, opened.seal);
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
    // One conversation per sender: nobody else's drafts or issues are ever visible here.
    await this.handle(message, {
      type: 'dm',
      conversation: `dm:${message.pubkey}`,
      mentioned: true,
    });
  }
  // Invitations from groups the operator has not allowed are ignored, not stored: the bot
  // does not subscribe to or decrypt their traffic. The ticket stays in the relay inbox,
  // so after allowing the group and restarting, the invitation is read again.
  privateTicket(message, seal) {
    if (!readTicket(message, seal, this.pubkey)) return;
    if (!this.access.privateGroup(message.pubkey)) return this.ignoredPrivateGroup(message.pubkey);
    acceptTicket(this, message, seal);
  }
  async privateMessage(message, group, receivingEpoch) {
    const epoch = this.state.groups[group];
    if (
      !epoch ||
      epoch.conflict ||
      epoch.pubkey !== receivingEpoch ||
      !this.access.privateGroup(group) ||
      !authorized(message, group, epoch) ||
      typeof message.content !== 'string' ||
      message.content.length > 8000
    )
      return;
    await this.handle(message, {
      type: 'private',
      conversation: `private:${group}`,
      mentioned: mentions(message.content, this.pubkey),
    });
  }
  async publicMessage(event, address) {
    const saved = this.state.rooms[address];
    const room = saved && parseRoom(saved.event);
    if (
      !room ||
      !this.access.publicGroup(address) ||
      room.blocked.includes(this.pubkey) ||
      room.blocked.includes(event.pubkey) ||
      (!saved.explicit && !room.trusted.includes(this.pubkey)) ||
      event.kind !== 9 ||
      !valid(event) ||
      single(event, 'a') !== address ||
      typeof event.content !== 'string' ||
      !event.content ||
      event.content.length > 8000
    )
      return;
    await this.handle(event, {
      type: 'public',
      conversation: `public:${address}`,
      mentioned:
        mentions(event.content, this.pubkey) ||
        event.tags.some((t) => t[0] === 'p' && t[1] === this.pubkey),
    });
  }
  // Groups removed from the configuration keep their saved ticket but are not followed.
  refreshPrivate(group) {
    if (this.access.privateGroup(group)) return super.refreshPrivate(group);
    this.watches.get(`private:${group}`)?.();
  }
  // As in vendor/bot.js, for allowed rooms only and with this bot's message handler.
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
      (event) => this.submit(event.id, () => this.publicMessage(event, address)),
    );
  }
  // Rooms come only from ALLOWED_PUBLIC_GROUPS, looked up at startup (main), so the
  // transport's discovery of every room that trusts the bot is not used.
  setWatch(name, ...args) {
    if (name !== 'discovery') super.setWatch(name, ...args);
  }
  async start() {
    await super.start();
    this.recover();
    // Until the first check answers, every repository counts as private.
    void this.checkRepos(this.log);
    this.repoTimer = setInterval(() => void this.checkRepos(), 10 * 60000);
  }
  // Records which allowed repositories are public, so a repository made private stops being
  // shown in groups within ten minutes. Errors count as private. log: the startup report.
  async checkRepos(log = () => {}) {
    for (const repo of new Set([...this.access.users.values()].flat())) {
      let info;
      try {
        info = await this.github.repository(repo);
        log(
          `${repo}: ${info.archived ? 'archived, issues cannot be created' : info.hasIssues ? 'ok' : 'issues are disabled'}${info.public ? '' : ' (not public: handled only in DMs)'}`,
        );
      } catch (error) {
        log(
          `${repo}: not accessible (${error?.code ?? 'error'}). Check the token's repository access.`,
        );
      }
      if (info?.public) this.publicRepos.add(repo);
      else this.publicRepos.delete(repo);
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.repoTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Cancel the model request in progress and forget waiting jobs (drafts are in memory
    // anyway). A GitHub request in progress is NOT cancelled: its outcome is recorded first.
    this.abort.abort();
    await this.models.stop();
    await this.publisher.stop();
    await Promise.all([...this.lanes.values()].map((lane) => lane.stop()));
    await this.work;
    await Promise.all(this.replying);
    await super.close();
  }
}

// Keeps an insertion-ordered Map bounded by dropping its oldest entries.
function bound(map, max = 1000) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// Repositories and titles only in DMs: this hint is not re-checked against GitHub.
function confirmHint(drafts, { context }) {
  return [
    'Plain-text replies never publish anything. To publish, send the command with the code:',
    ...drafts.map(
      (d) =>
        `/confirm ${d.code} — ${d.ref}${context.type === 'dm' ? ` ${d.repo}: ${d.title}` : ''}`,
    ),
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
export async function checkServices(bot, log) {
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
    void checkServices(bot, console.log);
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
