# GitHub Issue Agent — design

Status: approved product decisions, implemented in this folder.
Branch `feat/github-issue-agent`, worktree `../anagram-github-agent`.

A standalone Node daemon in the style of `bot-example/dad-jokes` and the Ollama Bridge.
An allowed person asks for an issue in Anagram. A local Ollama model drafts a title and
description. The bot shows the draft, and publishes it to GitHub only when the same person
sends `/confirm <code>` in the same conversation.

```text
Anagram ──(DM / private group / public group)──▶ relay ──▶ bot
bot: verify Nostr rules, check addressing, sender, group, rate limits
bot: commands are parsed deterministically; plain text is classified by fixed rules
bot ──(POST /api/chat, loopback)──▶ Ollama ──(JSON: title, body, missing)──▶ bot
bot: validate, bound, sanitize; search GitHub for similar issues; show draft + code
user ──(/confirm CODE)──▶ bot: persist "publishing" record ──▶ POST /repos/o/r/issues
bot ──(issue link + AG reference)──▶ conversation
```

## 1. Modules

| File                                                          | Role                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.js`                                                  | copied unchanged: identity, state file, NIP-44/59, relay pool                                                                                 |
| `direct-messages.js`, `private-groups.js`, `public-groups.js` | copied protocol handlers; changed to pass a `mentioned` flag instead of requiring a mention, and to return the id of each reply the bot sends |
| `ollama.js`                                                   | copied loopback-only Ollama client; adds an optional `format` (JSON schema) option                                                            |
| `config.js`                                                   | environment validation, fails closed                                                                                                          |
| `access.js`                                                   | per-user repository permissions and group allowlists                                                                                          |
| `github.js`                                                   | minimal GitHub REST client: fixed host, fixed paths, token in a private field                                                                 |
| `ids.js`                                                      | random AG references and confirmation codes                                                                                                   |
| `intent.js`                                                   | command parsing, repository references, confirmation-phrase and intent rules                                                                  |
| `drafting.js`                                                 | prompts, model-output parsing, bounds, sanitizing, issue footer and marker                                                                    |
| `drafts.js`                                                   | in-memory drafts, revisions, retired codes, expiry                                                                                            |
| `issues.js`                                                   | persisted issue records (the protected mapping)                                                                                               |
| `messages.js`                                                 | user-facing text                                                                                                                              |
| `queue.js`                                                    | small serial job queue (one for the model, one for GitHub)                                                                                    |
| `bot.js`                                                      | orchestration: addressing, authorization, commands, jobs, publish, reconcile                                                                  |
| `review.js`                                                   | operator CLI for records whose outcome is uncertain                                                                                           |

## 2. Chat contexts and addressing

DMs, private groups (NIP-171) and public groups (NIP-72/NIP-C7) are supported.

- Every sender must be listed in `ALLOWED_USERS`, in every context.
- Groups must also be listed (`ALLOWED_PRIVATE_GROUPS`, `ALLOWED_PUBLIC_GROUPS`).
  Group membership never grants access.
- In a DM every message is addressed to the bot.
- In a group a message is addressed to the bot when it:
  1. mentions the bot (npub/nprofile in the text, or a `p` tag in public groups), or
  2. replies to a message the bot sent in that same group (`e` tag marked `reply` in
     private groups, `q` tag in public groups), or
  3. is a draft/issue command whose ID belongs to this bot in this group, for example a
     bare `/confirm K3P9QX`. Bare `/help`, `/new`, `/drafts`, `/issues` need a mention or
     a reply, so the bot does not answer commands meant for other bots.
- Unaddressed group messages are dropped before any marking, logging or rate counting.
- Old messages: relays resend recent history (up to 24 hours) after every start. The bot
  saves in `state.json` (`authorized`) when each user and group was first allowed, and
  drops any message written before its author, or its group, was allowed. Times survive
  restarts, so messages sent while the bot was offline are still answered. An identity
  missing from the configuration at a start loses its time; adding it back starts a new
  one. Dropped messages, like those from senders who are not allowed, are not recorded
  as handled.
- Conversation keys isolate everything: `dm:<sender>`, `private:<group>`,
  `public:<group address>`.

## 3. Identifiers

- **AG reference** (`AG-7K92`): assigned when the draft is created, stable across edits,
  shown in the GitHub issue footer instead of the requester's npub, and persisted with the
  issue record. It is a label, never a credential.
- **Confirmation code** (`K3P9QX`, 6 Crockford base-32 characters): identifies one draft
  _revision_. Every successful edit issues a new code and retires the old one. `/edit`,
  `/confirm` and `/cancel` accept only the current code.
- **Idempotency marker**: a random UUID per publication attempt, embedded in the issue
  body as `<!-- anagram-issue-agent:<uuid> -->`. It is generated at `/confirm`, after the
  model has finished, so the model cannot know or forge it.

## 4. Repository selection and authorization

- `ALLOWED_REPOS` lists every repository the bot may touch (the token should be scoped to
  exactly these).
- `ALLOWED_USERS` maps each npub to a subset of them, or `*` for all of them:
  `ALLOWED_USERS="npub1aaa=lnbits/anagram,lnbits/lnbits; npub1bbb=*"`.
- Repositories are only ever taken from the user's own text (`owner/repo` or a
  `github.com/owner/repo` link), never from model output, and are matched against the
  sender's permissions.
- No repository, or several: the bot asks which one and remembers the request (in
  memory, one per requester per conversation, 1 hour). The requester answers with the
  repository name, either as a reply to the question or as a short message.
- An explicitly named repository the sender may not use is refused by name.
- Permissions are re-checked at `/confirm`.
- Public groups never list a user's repositories (everyone can read the group).

## 5. Natural language

Fixed rules, not the model, decide what a plain message means. The model only writes text.

1. A reply to one of the bot's draft messages, from that draft's requester, edits that
   draft revision. A reply to an older revision is refused with the current code.
2. A message that names exactly one current code of the requester's drafts in this
   conversation edits that draft. Several codes → the bot asks for one.
3. A confirmation phrase ("yes", "confirm", "publish it", "looks good", …) never
   publishes. The bot answers with the exact `/confirm CODE` to send.
4. An answer to the repository question completes the waiting request.
5. Otherwise a message that looks like an issue request (keywords such as issue, bug,
   crash, feature, or a repository reference) starts a new draft. Anything else gets a
   short hint.

## 6. Drafts

- Created immediately from the available information; the model also lists up to five
  useful missing details, shown after the draft.
- In memory only. Lost on restart. Expire 24 hours after creation (`DRAFT_TTL_HOURS`).
- Several drafts per user, at most `MAX_DRAFTS_PER_USER` (default 10) across all
  conversations, at most 1,000 in total.
- Bound to `(conversation, requester)`. Lookups from another conversation behave exactly
  like an unknown code, so codes cannot be probed across conversations.
- `/drafts` lists the requester's drafts in the current conversation.
- An edit sends the model only the current title, body, repository name and the edit
  instructions. No chat history and no other drafts.
- While an edit is running the draft cannot be confirmed; a cancelled or published draft
  discards the edit result.

## 7. Confirmation and publication

`/confirm CODE` is the only way to publish. It must come from the requester, in the
draft's conversation, with the current code. It publishes immediately.

1. Checks: current code, requester, conversation, no edit running, repository still
   permitted, under `MAX_ISSUES_PER_DAY` (rolling 24 hours, counted from persisted
   records so a restart does not reset it).
2. A record `{ref, code, attempt, requester, conversation, repo, title, state:
'publishing', sending: false}` is written to `state.json` (fsync) before anything else.
3. The GitHub job sets `sending: true`, saves, then sends one `POST`. It is never retried
   automatically.
4. Outcome:
   - **created** → `published`, with number and URL.
   - **definitely not created** (request never fully sent, 3xx, 4xx) → `failed`; the
     draft returns to pending and the requester may `/confirm` again.
   - **uncertain** (timeout or connection loss after sending, 5xx, unreadable 2xx) →
     reconcile.
5. Reconciliation lists the repository's issues created by the token's user since the
   attempt and looks for the marker. Found → `published`. Not found after the last check
   (5 s, 1 min, 5 min) → `review`: the requester is told not to confirm again and the
   operator resolves it with `npm run review`. The bot never concludes on its own that
   an uncertain request failed.
6. On startup, `publishing` records with `sending: false` become `failed` (nothing was
   sent); with `sending: true` they are reconciled.
7. Outcome notices are persisted (`notified`) and resent after a restart if they were
   lost during shutdown.

Repeated `/confirm` of the same code: while publishing → "already being published"; after
success → "already published as AG-… #N"; in review → "being checked by the operator".
This is distinct from duplicate _content_ (below), which is only a warning.

## 8. Duplicate detection

After each draft or edit the bot searches the repository's issues by title keywords
(GitHub search, top results that share keywords) and lists them with links and state.
It also warns when the requester already published an issue with the same title in the
same repository through this bot, in the same conversation. In groups only issue numbers
and links are listed, not titles, because the repository may be private. Nothing is blocked; the requester may edit or confirm
unchanged.

## 9. Issue records, `/who`, `/issues`

`state.json` keeps one record per publication attempt: reference, requester npub,
originating conversation, repository, title, issue number and URL, state, times. No
draft bodies are stored. The file is mode 0600 in a 0700 directory.

- `/issues`: the 10 most recent records of the current conversation.
- `/who AG-XXXX`: the record's details, only inside the originating conversation. In a DM
  that means only the requester. In a group any authorized sender of that group.
- Public-group answers are public: anyone reading the group sees the requester's npub and
  the issue link.

## 10. Model boundary

- One model, set by the operator. No user command changes it.
- Requests contain only `model`, `messages`, `stream:false`, `options.num_predict` and a
  JSON schema in `format`. No `tools`. No GitHub token, no keys, no file contents.
- The bot never imports `child_process`, never evaluates output, never fetches URLs from
  chat or model output.
- Output is parsed as JSON; only `title`, `body`, `missing` are read and type-checked.
- Title ≤ 256 characters (GitHub's limit); body ≤ `MAX_BODY_CHARS` (default 6000).
  Longer text is shortened **with a visible warning in the draft**, so the requester can
  see and fix it before confirming. Over-long input is refused with the limit, never
  silently cut.
- Sanitizing: control characters and HTML comments removed; `@user` and `@org/team`
  wrapped in backticks so GitHub sends no notifications; Nostr mentions shortened so the
  bot never pings group members. The draft shown is exactly what is published, plus a
  visible footer and the hidden marker.
- System prompt: use only facts from the request, never invent versions, steps, logs or
  causes; put unknowns in `missing`. This is guidance, not a security boundary: the
  security boundary is that output is only text that the requester reviews.

## 11. GitHub token and client

- Fine-grained personal access token, only the allowed repositories, **Issues: read and
  write** (Metadata read is implied). Classic `ghp_` tokens are refused at startup.
- Base URL `https://api.github.com`. `GITHUB_API_URL` may point at GitHub Enterprise
  (HTTPS, public address, no credentials/query). `GITHUB_ALLOW_LOCAL=true` is for local
  mock servers only.
- Endpoints: `GET /user`, `GET /repos/{o}/{r}`, `GET /search/issues`,
  `GET /repos/{o}/{r}/issues`, `POST /repos/{o}/{r}/issues`. Path segments come only from
  validated configured repository names.
- Token only in the `Authorization` header, stored in a private class field. Never in
  URLs, logs, errors, model prompts or chat replies.
- Redirects refused, 20 s timeout, 1 MiB response limit, DNS re-checked per connection.

## 12. Limits

| Limit                                        | Default | Setting                    |
| -------------------------------------------- | ------- | -------------------------- |
| Messages per user per hour (all commands)    | 60      | `MAX_REQUESTS_PER_HOUR`    |
| Model calls per user per hour                | 20      | `MAX_MODEL_CALLS_PER_HOUR` |
| Published issues per user, rolling 24 h      | 10      | `MAX_ISSUES_PER_DAY`       |
| Pending drafts per user                      | 10      | `MAX_DRAFTS_PER_USER`      |
| Waiting model jobs                           | 10      | `MAX_QUEUE`                |
| Input characters                             | 4000    | `MAX_INPUT_CHARS`          |
| Body characters                              | 6000    | `MAX_BODY_CHARS`           |
| One model job per requester per conversation | fixed   |                            |

## 13. Security review

An independent pass found no high-severity issues. Fixed, with tests in
`test/security.test.js`: `@` mentions after punctuation or as HTML entities; private issue
titles in group duplicate warnings; cross-conversation "already published" hints; a
dropped edit result leaving a draft locked; unawaited replies escaping `onFatal` and
shutdown. Accepted as residual: the PID-file lock race and outbox back-pressure inherited
from `runtime.js`, and the theoretical gap between the kernel accepting a request and
Node's `finish` event in `definitelyNotCreated`.

Found in manual testing: after an operator allowed a new user and restarted the bot,
it answered that user's messages from before they were allowed, because relays resend
them and denied messages are deliberately not recorded. It could not publish anything:
drafts and codes do not survive a restart. Fixed with saved authorization times (section
2), tested in `test/authorization.test.js`.

## 14. Deviations from the first proposal

- Groups are supported (approved), with reply-based addressing.
- Several drafts per user, 24 h expiry, no identical-title block (approved).
- Per-user repository permissions replace the global list plus optional narrowing.
- AG references replace requester attribution.
- Uncertain publications go to operator review rather than "failed".
- `ollama.js` gains a `format` option; the Ollama Bridge itself is not modified.
