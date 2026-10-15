// Pending drafts, in memory only. Unconfirmed draft text never reaches disk, and a restart
// forgets every draft. Each draft belongs to one requester in one conversation.
//
// draft = { ref, code, revision, requester, conversation, repo, title, body, missing,
//           warnings, similar, createdAt, expiresAt, editing, publishing }
export class Drafts {
  constructor({
    ttlSeconds = 86400,
    maxPerUser = 10,
    maxTotal = 1000,
    clock = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxPerUser = maxPerUser;
    this.maxTotal = maxTotal;
    this.clock = clock;
    this.items = new Map(); // code → draft
    // Codes replaced by an edit: old code → { ref, conversation, requester }. Lets the bot
    // explain that a code is outdated instead of "unknown". Bounded.
    this.retired = new Map();
  }
  purge() {
    const time = this.clock();
    for (const [code, draft] of this.items)
      if (draft.expiresAt <= time && !draft.publishing) this.items.delete(code);
  }
  get(code) {
    this.purge();
    return this.items.get(code);
  }
  has(code) {
    return this.items.has(code) || this.retired.has(code);
  }
  all() {
    this.purge();
    return [...this.items.values()];
  }
  // Drafts that count against the per-user limit (publishing ones included).
  count(requester) {
    return this.all().filter((d) => d.requester === requester).length;
  }
  list(conversation, requester) {
    return this.all()
      .filter((d) => d.conversation === conversation && d.requester === requester)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  // Whether one more draft fits for this requester.
  room(requester) {
    return this.count(requester) < this.maxPerUser && this.items.size < this.maxTotal;
  }
  findByRef(ref) {
    return this.all().find((d) => d.ref === ref);
  }
  create({ ref, code, requester, conversation, repo, content }) {
    const createdAt = this.clock();
    const draft = {
      ref,
      code,
      revision: 1,
      requester,
      conversation,
      repo,
      ...content,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      editing: false,
      publishing: false,
    };
    this.items.set(code, draft);
    return draft;
  }
  // Applies an edit under a new code. The old code is retired and can never confirm.
  revise(draft, code, content) {
    this.items.delete(draft.code);
    this.retire(draft);
    Object.assign(draft, content, { code, revision: draft.revision + 1 });
    this.items.set(code, draft);
    return draft;
  }
  retire(draft) {
    this.retired.set(draft.code, {
      ref: draft.ref,
      conversation: draft.conversation,
      requester: draft.requester,
    });
    while (this.retired.size > 5000) this.retired.delete(this.retired.keys().next().value);
  }
  remove(draft) {
    if (this.items.get(draft.code) === draft) this.items.delete(draft.code);
  }
}
