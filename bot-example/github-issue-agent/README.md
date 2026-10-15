# GitHub Issue Agent bot

A standalone Node daemon that turns chat requests in Anagram into GitHub issues. A model running on **your own computer** ([Ollama](https://ollama.com)) writes the draft. **Nothing is published until the person who asked sends `/confirm` with the draft's code.**

```text
You:  create an issue in lnbits/anagram about the mobile login bug
Bot:  Draft AG-7K92 for lnbits/anagram — code K3P9QX
      Title: Mobile login fails
      ...
      /confirm K3P9QX — publish this issue to lnbits/anagram
You:  /confirm K3P9QX
Bot:  Published AG-7K92 as lnbits/anagram#412: https://github.com/lnbits/anagram/issues/412
```

It works in direct messages, private groups and public groups, only for people and repositories you allow. See [DESIGN.md](DESIGN.md) for the full design.

## How a request flows

```text
Anagram ──(encrypted DM / group message)──▶ Nostr relay ──▶ GitHub Issue Agent
Agent: verify, check sender, group, repository and limits; parse commands with fixed rules
Agent ──(HTTP on 127.0.0.1)──▶ Ollama: "write a title and description for this request"
Agent: validate and bound the draft, search GitHub for similar issues, show draft + code
Requester ──(/confirm CODE)──▶ Agent: save a "publishing" record, then one POST to GitHub
Agent ──(issue link)──▶ the same conversation
```

## 1. Install Ollama and a model

Install Ollama from [ollama.com/download](https://ollama.com/download), then:

```sh
ollama pull llama3.2
ollama run llama3.2 "Say hi"   # Ctrl+D to exit
```

The bot asks the model for structured JSON output, which needs a recent Ollama (0.5 or later). Larger models (for example `qwen3:8b`) write better drafts.

## 2. Create a GitHub token

Use a **fine-grained personal access token**. Classic `ghp_` tokens are refused.

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
2. **Resource owner:** the account or organization that owns the repositories.
3. **Expiration:** 90 days or less. Put a reminder in your calendar to rotate it.
4. **Repository access:** _Only select repositories_, and pick exactly the repositories you will list in `ALLOWED_REPOS`.
5. **Repository permissions:** **Issues: Read and write.** Metadata becomes read-only automatically. Leave everything else at _No access_.

Issues are created as the token's account. A dedicated GitHub account for the bot keeps that separate from your own.

## 3. Configure the bot

Use **Node 24 or later**:

```sh
cd bot-example/github-issue-agent
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
GITHUB_TOKEN=github_pat_...
ALLOWED_REPOS=lnbits/anagram,lnbits/lnbits
# Each person gets their own repositories; "*" means all of ALLOWED_REPOS.
ALLOWED_USERS="npub1alice...=lnbits/anagram; npub1bob...=*"
OLLAMA_MODEL=llama3.2
```

**Nobody is allowed by default**, including you. Find your npub in Anagram (your profile).

## 4. Start it

```sh
npm start
```

On first start it creates a Nostr identity, prints its **npub**, publishes a **GitHub Issue Agent (Example Anagram Bot)** profile marked as a bot, and checks its services:

```text
GitHub Issue Agent (Example Anagram Bot): npub1...
Ollama is reachable; model llama3.2 is installed.
GitHub token accepted (account my-issue-bot).
lnbits/anagram: ok
Profile and DM inbox published.
```

Stop it with Ctrl+C. Later starts reuse the same identity.

## 5. Talk to it from Anagram

- **DM:** add the printed npub as a contact and write to it.
- **Private group:** invite the bot's npub. The bot logs `Ignored a private group invitation from npub1...`. Add that npub to `ALLOWED_PRIVATE_GROUPS` and restart.
- **Public group:** put the group's `naddr1...` or share link in `ALLOWED_PUBLIC_GROUPS` and restart.

In groups **the group must be allowed and the person writing must be in `ALLOWED_USERS`**. Group membership never gives access. The bot reacts in a group only when a message:

- mentions the bot (Anagram's mention picker, or its npub), or
- replies to one of the bot's messages in that group, or
- is `/confirm`, `/edit`, `/cancel` or `/who` with a code or reference that belongs to this bot in this group.

Other group messages are ignored without being stored or logged. A bare `/help` or `/issues` needs a mention, so the bot does not answer commands meant for other bots.

## Commands

| Command                         | What it does                                                      |
| ------------------------------- | ----------------------------------------------------------------- |
| `/new owner/repo <description>` | Draft a new issue.                                                |
| `/drafts`                       | Your drafts in this conversation.                                 |
| `/edit CODE <instructions>`     | Change a draft. You get a new code.                               |
| `/confirm CODE`                 | Publish the draft. The only way to publish.                       |
| `/cancel CODE`                  | Delete a draft.                                                   |
| `/issues`                       | The 10 most recent issues created in this conversation.           |
| `/who AG-XXXX`                  | Who requested an issue, and where it is.                          |
| `/help`                         | Lists the commands and, outside public groups, your repositories. |

In groups, mention the bot before a command: `nostr:npub1... /issues`.

### Plain language

Fixed rules decide what a plain message means. The model is never asked what to do.

- **New request.** "create an issue in lnbits/anagram about the mobile login bug". The repository must be written by you, as `owner/repo` or a `github.com` link. If it is missing, the bot asks which one, and you answer with just the name.
- **Edit.** Reply to a draft message with what to change, or name its code: "K3P9QX: mention it happens on Android 15".
- **Approval never publishes.** "yes", "confirm", "looks good" get an answer with the exact `/confirm CODE` to send.

## Drafts and codes

- A draft is created right away from what you wrote. Details the model thinks are missing are listed after the draft; add them with an edit if you know them.
- **Codes belong to one version of a draft.** Every edit gives a new code, and the old one stops working. You can only confirm the text you last saw.
- **AG references** (`AG-7K92`) stay the same across edits. They appear in the GitHub issue instead of your npub. A reference is a label, not a password.
- Drafts belong to the person who asked, in the conversation where they asked. Nobody else can edit, confirm or cancel them. A code from another conversation is treated as unknown.
- Drafts are kept **in memory only**, for 24 hours. **Restarting the bot deletes all drafts.** You can have up to 10 at once.
- An edit sends the model only the current draft and your instructions, not the chat history.

## Publication safety

The bot is built so that one `/confirm` creates at most one issue, even across crashes:

1. Before contacting GitHub it writes a "publishing" record to `state.json`.
2. It sends one request and **never retries it automatically**. The issue body carries a hidden marker (`<!-- anagram-issue-agent:<random id> -->`) that is unique to this attempt.
3. If GitHub clearly refused (for example a permission error), the draft stays available and you may `/confirm` it again.
4. If the answer is unclear (timeout, server error, connection lost after sending), the bot looks for the marker among its recent issues after 5 seconds, 1 minute and 5 minutes. If it finds the issue it reports the link.
5. If it still cannot tell, it says so and asks you **not** to confirm again. The operator decides (see "Operator review").
6. After a crash, records that were never sent are marked failed; records that may have been sent are checked the same way.

Repeating `/confirm` for the same code never creates a second issue. The bot answers "already being published" or "already published as AG-… #N".

### Possible duplicates

Each draft lists existing issues with similar titles, and any issue you already published with the same title through the bot in the same conversation. In groups only issue numbers and links are shown, not titles, because the repository may be private and not every reader is an allowed user. This is only a warning. You can edit the draft or confirm it unchanged.

## Privacy

- `/who AG-XXXX` and `/issues` only show issues created in the current conversation. In a DM that means only your own. In a group any allowed member of that group can see them.
- **Public groups are public.** Drafts, `/who` answers (with the requester's npub) and issue links posted there can be read by anyone who can read the group.
- GitHub issues show the AG reference, never the requester's npub. The mapping is in `state.json`, which is private to the bot's operator.
- Logs contain no message text, no draft text and no token.

## Security

- **Access.** Every sender must be listed, with their own repositories. Groups must be listed too. Messages are authenticated by Nostr signatures and NIP-171 invitation proofs.
- **Old messages.** Relays resend recent messages whenever the bot starts. The bot remembers in `state.json` when each user and group was first allowed and ignores messages written before then, so adding someone to `ALLOWED_USERS` does not make the bot answer what they sent earlier. Messages sent by allowed people while the bot was offline (up to 24 hours) are still answered. If you remove a user or group and start the bot, adding them back later counts as a new authorization.
- **The model only writes text.** It receives the request (or the current draft and the edit instructions) and returns a title, a description and a list of missing details as JSON. It gets no tools, no token, no files, no other conversations. It cannot choose the repository, publish, or run anything. Its text is shown to the requester before anything is published.
- **Sanitizing.** HTML comments and control characters are removed, `@user` and `@org/team` are wrapped in backticks so GitHub sends no notifications, and Nostr mentions are shortened so the bot never pings group members. Over-long titles or descriptions are shortened **with a visible warning** in the draft.
- **GitHub client.** One configured host (`https://api.github.com` by default), five fixed endpoints, repository paths only from your configuration, no redirects, 20-second timeout, 1 MiB response limit, DNS checked on every connection. The token is sent only in the `Authorization` header and kept in a private field.
- **Ollama.** Loopback only unless `OLLAMA_ALLOW_REMOTE=true`, same client as the Ollama Bridge example.
- **Limits.** Per person: 60 messages per hour, 20 model calls per hour, 10 published issues per 24 hours (counted from saved records, so restarts do not reset it), 10 drafts. One model job per person per conversation, 10 waiting jobs in total.
- **Operations.** `state.json` (bot nsec, group keys, issue records) is mode `0600` in a `0700` directory and excluded from Git. One process per data directory.

## Operator review

When the bot cannot tell whether an issue was created, the log says `AG-XXXX needs operator review`. Stop the bot, then:

```sh
npm run review                                          # list records to decide
npm run review -- published AG-7K92 https://github.com/lnbits/anagram/issues/412
npm run review -- failed AG-7K92                        # no issue exists
```

Search the repository for the marker printed by `npm run review` to decide. The requester is told the result when the bot starts again.

## Configuration reference

All settings are in `.env.example` with comments.

| Variable                   | Default                  | Meaning                                                     |
| -------------------------- | ------------------------ | ----------------------------------------------------------- |
| `ALLOWED_REPOS`            | _(empty)_                | Repositories the bot may use                                |
| `ALLOWED_USERS`            | _(empty: nobody)_        | `npub=owner/repo,...` entries separated by `;`, `*` for all |
| `ALLOWED_PRIVATE_GROUPS`   | _(empty)_                | Private groups (group npubs)                                |
| `ALLOWED_PUBLIC_GROUPS`    | _(empty)_                | Public groups (naddr or link)                               |
| `GITHUB_TOKEN`             | _(required)_             | Fine-grained token, Issues read and write                   |
| `GITHUB_API_URL`           | `https://api.github.com` | GitHub Enterprise Server API (HTTPS)                        |
| `OLLAMA_MODEL`             | `llama3.2`               | Model name as shown by `ollama list`                        |
| `OLLAMA_URL`               | `http://127.0.0.1:11434` | Ollama server                                               |
| `OLLAMA_TIMEOUT_SECONDS`   | `180`                    | Maximum time for one draft                                  |
| `MAX_ISSUES_PER_DAY`       | `10`                     | Published issues per person, rolling 24 hours               |
| `MAX_DRAFTS_PER_USER`      | `10`                     | Pending drafts per person                                   |
| `DRAFT_TTL_HOURS`          | `24`                     | Draft lifetime                                              |
| `MAX_REQUESTS_PER_HOUR`    | `60`                     | Messages per person, commands included                      |
| `MAX_MODEL_CALLS_PER_HOUR` | `20`                     | Drafts and edits per person                                 |
| `MAX_QUEUE`                | `10`                     | Requests waiting for the model                              |
| `MAX_INPUT_CHARS`          | `4000`                   | Longer messages are refused                                 |
| `MAX_BODY_CHARS`           | `6000`                   | Longer descriptions are shortened with a warning            |

Identity and relay settings (`NSEC`, `NAME`, `RELAYS`, `DATA_DIR`, `PICTURE_URL`, `NIP05`) work as in the dad-jokes example.

## Running on a server

Install Ollama and pull your model, then:

```sh
sudo cp -r bot-example/github-issue-agent /opt/github-issue-agent
cd /opt/github-issue-agent
sudo npm ci --omit=dev
sudo cp .env.example .env && sudo chmod 600 .env   # then edit .env
sudo cp github-issue-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-issue-agent
sudo journalctl -u github-issue-agent -f
```

The service runs as an unprivileged dynamic user with state in `/var/lib/anagram-github-issue-agent`. For `npm run review` on a server, stop the service and run it with `DATA_DIR=/var/lib/anagram-github-issue-agent` as root.

## Make it your own

- **bot.js** — `handle()` (addressing and access), `command()`, `natural()` (plain-language rules), `confirm()`, `publish()`, `reconcile()`, `recover()`.
- **drafting.js** — prompts, output parsing, limits, sanitizing, the issue footer.
- **intent.js** — command parsing, repository references, confirmation phrases.
- **github.js** — the GitHub client and `definitelyNotCreated()`.
- **drafts.js / issues.js** — in-memory drafts and persisted issue records.
- **direct-messages.js / private-groups.js / public-groups.js / runtime.js** — Nostr protocol handling, shared with the other examples.

## Checks

```sh
npm run check
npm test
```

Tests use a mock Ollama, a mock GitHub API and local WebSocket relays. They need no Ollama install, real tokens, real keys or internet.

When this folder is inside the Anagram repository, an optional browser test drives the real client through a DM and both group flows. From the repository root, with dependencies and Chromium installed:

```sh
npm run test:e2e:local -- --config bot-example/github-issue-agent/playwright.config.js
```

## Limitations

- Drafts and waiting questions are lost on restart. Replies to bot messages sent before a restart are no longer recognized in groups; mention the bot instead.
- Plain-language understanding is keyword based. When in doubt, use the commands.
- The model may still write something inaccurate. The requester is responsible for reviewing the draft before confirming.
- Similar-issue search uses GitHub search, which can lag a few minutes behind new issues and has its own rate limit.
- Labels, assignees, editing published issues and GitHub App authentication are not supported.
- Authorization times come from the bot's clock, message times from the sender's. A sender can date a message at most 60 seconds ahead, so a message written less than a minute before that sender was allowed may still be answered. Removing and re-adding someone without starting the bot in between keeps their original time.
- Like the other examples, the bot stops reading new messages while 1,000 replies are waiting for relays, and the data-directory lock is a simple PID file.
