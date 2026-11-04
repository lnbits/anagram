# GitHub Issue Agent bot

A standalone bot using Node 24 or later that turns Anagram chat requests into GitHub issues. A model running on **your own computer** ([Ollama](https://ollama.com)) writes the draft. **Nothing is published until the person who asked sends `/confirm` with the draft's code.** Copy this whole folder anywhere; no Anagram installation is needed.

```text
You:  create an issue in lnbits/anagram about the mobile login bug
Bot:  Draft AG-7K92 for lnbits/anagram — code K3P9QX
      Title: Mobile login fails
      ...
      /confirm K3P9QX — publish this issue to lnbits/anagram
You:  /confirm K3P9QX
Bot:  Published AG-7K92 as lnbits/anagram#412: https://github.com/lnbits/anagram/issues/412
```

It works in direct messages, private groups and public groups, only for people, groups and repositories you allow.

## Setup

1. **Ollama.** Install it from [ollama.com/download](https://ollama.com/download) (0.5 or later, for structured output), then `ollama pull llama3.2`. Larger models (for example `qwen3:8b`) write better drafts.
2. **GitHub token.** Create a **fine-grained personal access token** (classic `ghp_` tokens are refused): _Only select repositories_ = exactly the repositories in `ALLOWED_REPOS`, **Repository permissions → Issues: Read and write**, nothing else, 90 days or less. Issues are created as the token's account; a dedicated GitHub account keeps that separate from yours.
3. **Configure and start:**

   ```sh
   npm ci
   cp .env.example .env
   chmod 600 .env   # then edit .env
   npm start
   ```

   ```dotenv
   GITHUB_TOKEN=github_pat_...
   ALLOWED_REPOS=lnbits/anagram,lnbits/lnbits
   # Each person gets their own repositories; "*" means all of ALLOWED_REPOS.
   ALLOWED_USERS="npub1alice...=lnbits/anagram; npub1bob...=*"
   ```

**Nobody is allowed by default**, including you. On first start the bot creates a Nostr identity, prints its npub, publishes its profile and DM inbox, and checks its services:

```text
GitHub Issue Agent (Example Anagram Bot): npub1...
lnbits/anagram: ok
lnbits/lnbits: ok (not public: handled only in DMs)
Ollama is reachable; model llama3.2 is installed.
GitHub token accepted (account my-issue-bot).
Profile and DM inbox published.
```

All settings, with defaults and limits, are documented in `.env.example`. Restart to apply changes.

## Talking to it

- **DM:** add the printed npub as a contact and write to it.
- **Private group:** invite the bot. It logs `Ignored a private group invitation from npub1...`; add that npub to `ALLOWED_PRIVATE_GROUPS` and restart.
- **Public group:** put the group's `naddr1...` or share link in `ALLOWED_PUBLIC_GROUPS` and restart. The bot only joins groups listed there.

The person writing must always be in `ALLOWED_USERS`; group membership never gives access. In groups the bot reacts only to messages that mention it, reply to one of its messages, or are `/confirm`, `/edit`, `/cancel` or `/who` with a code or reference of this bot in this group. Other group messages are ignored without being stored or logged.

| Command                         | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `/new owner/repo <description>` | Draft a new issue.                                          |
| `/drafts`                       | Your drafts in this conversation.                           |
| `/edit CODE <instructions>`     | Change a draft (or reply to the draft). You get a new code. |
| `/confirm CODE`                 | Publish the draft. The only way to publish.                 |
| `/cancel CODE`                  | Delete a draft.                                             |
| `/issues`                       | The 10 most recent issues created in this conversation.     |
| `/who AG-XXXX`                  | Who requested an issue in this conversation, and where.     |
| `/help`                         | The commands and, in a DM, your repositories.               |

Plain messages work too: "create an issue in lnbits/anagram about the login bug" drafts an issue when it names exactly one of your repositories (as `owner/repo` or a `github.com` link). Fixed rules decide what a message means; the model is never asked. Approval in words ("yes", "looks good") never publishes: the bot answers with the exact `/confirm CODE`.

### Buttons

In Anagram, every draft message carries three [inline buttons](../../docs/bot-keyboards.md): **Preview** (the issue exactly as `/confirm` would publish it, with the current code), **Refresh status** (draft waiting, being edited or published; or the published issue, its failure, or that it is waiting for the operator) and **Cancel draft** (the same as `/cancel CODE`). There is deliberately **no Publish button**: `/confirm CODE`, typed by the requester, stays the only way to publish, and a button press can never create an issue.

A press is answered **privately**: the answer replaces the draft message's text for that person, in that chat, without a new message or notification, and keeps the buttons (Cancel removes them for that person). So in a group, members can read a preview or the status without adding messages, and a cancellation is seen only by the requester. A press gets no answer unless all of this holds:

- The request is a valid, unexpired Anagram button request (encrypted `kind:21118`) for a draft message this bot sent, with the button really on that message or on the bot's own answer to that person there. The button's data is one of three fixed names; it cannot carry a code, a repository or anything else.
- The same access rules as for a message: the person is in `ALLOWED_USERS`, the chat is allowed, and the press was made after access was granted. In a DM, the person pressing is the one the draft was sent to. In a private group, the request carries a valid invitation proof for the group's current epoch (and the answer carries the bot's). In a public group, the bot must still be trusted and neither party blocked. Presses count against the hourly message limit.
- In groups, the repository must still be public on GitHub (asked again right before answering, like `/drafts`); otherwise the answer only says the repository is not shown here.
- Cancel works for the requester only, and not while the draft is being published. After a restart, or once a draft has expired, Preview and Cancel say the draft is no longer available; Refresh status still reports a published, failed or uncertain issue from the saved records.

**Idempotent.** The exact encrypted answer to each request is kept (five minutes past its expiry), so when Anagram retries a request the same answer is sent again and nothing is cancelled twice; a reused request id with other contents is refused. Presses are handled in the conversation's lane, in order with `/confirm` and `/cancel`. `state.json` keeps, per draft message, the chat it was sent to, its AG reference and the ids of the answers each person received, for 7 days (at most 1,000 messages, 1,000 people per message); it never keeps draft text. Answers are encrypted to the person, and Anagram stores them on that device only.

## Drafts, codes and references

- A **code** (`K3P9QX`) belongs to one version of one draft. Every edit gives a new code and the old one stops working, so you can only confirm the text you last saw.
- An **AG reference** (`AG-7K92`) stays the same across edits and appears in the GitHub issue instead of your npub. It is a label, not a password.
- Drafts belong to the person who asked, in the conversation where they asked. A code from another conversation is treated as unknown.
- Drafts live **in memory only**, for 24 hours (up to 10 per person). Restarting the bot deletes them.
- An edit sends the model only the current draft and your instructions. The repository never changes.
- Each draft lists existing issues with similar titles. This is only a warning.

## Groups and private repositories

Group members are not necessarily allowed users, and anyone can read a public group. In private and public groups the bot drafts, lists and links only repositories that are **public** on GitHub; your repository list and refused repository names appear only in your DM. It checks visibility at startup and every ten minutes, and **asks GitHub again right before** sending a draft, `/drafts`, `/issues`, `/who` or a publication result to a group. Any error counts as private. Requests for repositories already known to be private are refused without asking GitHub. If a repository is not public when a publication result is sent, the group is told only that the requester was informed, and the result goes to the requester's DM. Similar-issue warnings in groups show numbers and links, not titles.

`/issues` and `/who` only show issues created in the current conversation. In a group, everyone who can read the group sees drafts, results and, through `/who`, the requester's npub.

## Publication safety

One `/confirm` creates at most one issue, even across crashes:

1. Before contacting GitHub the bot saves a "publishing" record in `state.json`.
2. It sends one request and **never retries it automatically**. The issue body carries a hidden marker (`<!-- anagram-issue-agent:<random id> -->`) unique to this attempt.
3. If GitHub clearly refused, the draft stays available and you may confirm it again.
4. If the answer is unclear (timeout, server error, connection lost after sending), the bot looks for the marker among its recent issues after 5 seconds, 1 minute and 5 minutes.
5. If it still cannot tell, it asks you **not** to confirm again and waits for the operator.
6. After a restart, records that were never sent are marked failed and records that may have been sent are checked the same way. Results that could not be delivered are sent again.

### Operator review

When the log says `AG-XXXX needs operator review`, stop the bot, search the repository for the marker, and record the result:

```sh
npm run review                                          # list records to decide
npm run review -- published AG-7K92 https://github.com/lnbits/anagram/issues/412
npm run review -- failed AG-7K92                        # no issue exists
```

The requester is told when the bot starts again.

## Security

- **Access.** Every sender must be listed with their own repositories, and groups must be listed too. Messages are authenticated by Nostr signatures and NIP-171 invitation proofs. Permissions are checked again at `/confirm`.
- **Old messages.** Relays resend recent history at every start. The bot saves when each user and group was first allowed and ignores messages written before then; messages from allowed people sent while it was offline (up to 24 hours) are still answered.
- **The model only writes text.** It gets the request, or the current draft and edit instructions, and returns a title, a description and missing details as JSON. No tools, token, files or other conversations. It cannot choose the repository or publish. Its text is shown to the requester before publishing.
- **Sanitizing.** HTML comments and control characters are removed, `@user` and `@org/team` are wrapped in backticks so GitHub sends no notifications, and Nostr mentions are shortened. Over-long text is shortened **with a visible warning**.
- **GitHub client.** One HTTPS host, five fixed endpoints, repository paths only from your configuration, no redirects, 20-second timeout, 1 MiB responses, public addresses only. The token is sent only in the `Authorization` header. `GITHUB_API_URL` and `GITHUB_ALLOW_LOCAL` exist for test servers.
- **Ollama.** Loopback only unless `OLLAMA_ALLOW_REMOTE=true`.
- **Limits.** Per person: 60 messages and 20 model calls per hour, 10 published issues per 24 hours (from saved records, so restarts do not reset it), 10 drafts.
- **Data.** `data/state.json` holds the bot's secret key, group keys and issue records (who requested what, where). Keep it private and backed up; logs contain no message text and no token.

## Running on a server

```sh
sudo cp -r github-issue-agent /opt/github-issue-agent
cd /opt/github-issue-agent
sudo npm ci --omit=dev
sudo cp .env.example .env && sudo chmod 600 .env   # then edit .env
sudo cp github-issue-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-issue-agent
```

The service runs as an unprivileged dynamic user with state in `/var/lib/anagram-github-issue-agent`. For `npm run review`, stop the service and run it as root with `DATA_DIR=/var/lib/anagram-github-issue-agent`.

## Code and checks

`bot.js` holds the chat logic (`handle()`, `command()`, `natural()`, `confirm()`, `publish()`, `reconcile()`, `recover()`), the button presses (`callback()`, `press()`) and this bot's access-gated Nostr receive and send paths. `drafting.js` has the prompts and output sanitizing, `intent.js` the fixed parsing rules, `github.js` and `ollama.js` the HTTP clients, `drafts.js` and `issues.js` the drafts and saved records, `messages.js` the user-facing text and the button keyboard. The transport and the inline keyboard validator in `vendor/` are the poll example's, unchanged; see `LICENSE`.

Run `npm run check` and `npm test`. Tests use a mock Ollama, a mock GitHub API and local WebSocket relays; they need no Ollama install, tokens or internet. CI also runs them from a copy of this folder outside the repository.

## Limitations

- Drafts are lost on restart, and replies to bot messages sent before a restart are no longer recognized; use the commands.
- After startup, groups are served once the first repository check answers. A repository made public again is served in groups after the next ten-minute check.
- A repository made private between the check and the moment relays deliver the message can still leak that one message. In groups, each message with repository details waits for one GitHub request (at most 20 seconds); later messages in that conversation wait behind it, other conversations do not.
- An allowed public group that cannot be found at startup is not retried; restart the bot.
- The model may write something inaccurate. The requester reviews the draft before confirming.
- Similar-issue search uses GitHub search, which can lag and has its own rate limit.
- Labels, assignees, editing published issues and GitHub App authentication are not supported.
