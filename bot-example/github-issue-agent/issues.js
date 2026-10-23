// Persisted issue records: the protected mapping between an AG reference, the requester,
// the originating conversation, the repository and the GitHub issue. Stored in state.json
// (mode 0600). Contains titles of confirmed issues, never unconfirmed draft text.
//
// record = { ref, code, attempt, requester, conversation, repo, title, messageId,
//            state, sending, number, url, createdAt, updatedAt, notified, checks }
// state:  publishing → published | failed | review
//   publishing: written before the GitHub request. `sending` becomes true just before it.
//   review:     the outcome could not be determined; the operator must check GitHub.
import { HEX } from './vendor/runtime.js';
import { CODE, REF } from './ids.js';
import { validRepo } from './intent.js';

export const STATES = ['publishing', 'published', 'failed', 'review'];
const MAX_RECORDS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONVERSATION =
  /^(dm:[a-f0-9]{64}|private:[a-f0-9]{64}|public:34550:[a-f0-9]{64}:[a-zA-Z0-9_-]{1,128})$/;

export function validRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    REF.test(r.ref) &&
    CODE.test(r.code) &&
    UUID.test(r.attempt) &&
    HEX.test(r.requester) &&
    CONVERSATION.test(r.conversation) &&
    validRepo(r.repo) &&
    typeof r.title === 'string' &&
    HEX.test(r.messageId) &&
    STATES.includes(r.state) &&
    typeof r.sending === 'boolean' &&
    Number.isSafeInteger(r.createdAt) &&
    (r.state !== 'published' || (Number.isSafeInteger(r.number) && typeof r.url === 'string'))
  );
}

export class Issues {
  // state: the bot's persisted state object; records live in state.issues.
  constructor(state) {
    state.issues ??= [];
    if (!Array.isArray(state.issues) || !state.issues.every(validRecord))
      throw new Error('Invalid issue records in state.json. Restore it from backup.');
    this.state = state;
  }
  get all() {
    return this.state.issues;
  }
  add(record) {
    this.all.push(record);
    // Keep the newest records. Records still waiting for an outcome are never dropped.
    while (this.all.length > MAX_RECORDS) {
      const index = this.all.findIndex((r) => ['published', 'failed'].includes(r.state));
      if (index < 0) break;
      this.all.splice(index, 1);
    }
  }
  byRef(ref) {
    return this.all.findLast((r) => r.ref === ref);
  }
  byCode(code) {
    return this.all.findLast((r) => r.code === code);
  }
  // Records that consume the daily allowance: everything except definite failures.
  countSince(requester, since) {
    return this.all.filter(
      (r) => r.requester === requester && r.createdAt >= since && r.state !== 'failed',
    ).length;
  }
  // Most recent issues of one conversation, newest first. Failed attempts are omitted.
  recent(conversation, limit = 10) {
    return this.all
      .filter((r) => r.conversation === conversation && r.state !== 'failed')
      .slice(-limit)
      .reverse();
  }
  // Records of this ref in this conversation (one ref can have a failed attempt and a retry).
  inConversation(ref, conversation) {
    return (
      this.all.findLast(
        (r) => r.ref === ref && r.conversation === conversation && r.state !== 'failed',
      ) ?? this.all.findLast((r) => r.ref === ref && r.conversation === conversation)
    );
  }
}
