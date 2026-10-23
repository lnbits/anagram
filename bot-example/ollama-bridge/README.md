# Ollama Bridge bot

A standalone Node daemon that lets you chat with an AI model running on **your own computer** through Anagram. Messages travel over Nostr relays; answers come from [Ollama](https://ollama.com). No cloud AI service, API key, browser or database is needed.

```text
You:  Explain Bitcoin mining in simple terms.
Bot:  Bitcoin mining is the process of...
```

It works in direct messages, private groups and public groups. It only answers people you allow, and in groups only when mentioned.

## How a message flows

```text
Anagram ──(encrypted DM / group message)──▶ Nostr relay
Nostr relay ──(WebSocket subscription)──▶ Ollama Bridge
Ollama Bridge: decrypt, verify, check allowlists, commands and limits
Ollama Bridge ──(HTTP POST /api/chat on 127.0.0.1)──▶ Ollama
Ollama ──(answer text)──▶ Ollama Bridge
Ollama Bridge: shorten, sign (and encrypt), save to outbox
Ollama Bridge ──(publish)──▶ Nostr relay ──▶ Anagram
```

## 1. Install Ollama and a model

Install Ollama from [ollama.com/download](https://ollama.com/download) (macOS, Windows, Linux). On Linux:

```sh
curl -fsSL https://ollama.com/install.sh | sh
```

Download a model and check it works:

```sh
ollama pull llama3.2          # about 2 GB; fine on most laptops
ollama run llama3.2 "Say hi"  # Ctrl+D to exit
```

Larger models (for example `qwen3:8b`, `llama3.1:8b`) answer better but need more memory and are slower. Ollama listens on `http://127.0.0.1:11434` by default, which is what the bot uses.

## 2. Configure the bot

Use **Node 24 or later**:

```sh
cd bot-example/ollama-bridge
npm ci
cp .env.example .env
chmod 600 .env
```

Find your own npub in Anagram (your profile) and allow yourself in `.env`:

```dotenv
ALLOWED_NPUBS=npub1yourkey...
OLLAMA_MODEL=llama3.2
```

Separate several people with commas. **Nobody is allowed by default**, including you.

## 3. Start it

```sh
npm start
```

On first start it creates a Nostr identity, prints its **npub**, and publishes an **Ollama Bridge (Example Anagram Bot)** profile marked as a bot. It also checks that Ollama is reachable and the model is installed:

```text
Ollama Bridge (Example Anagram Bot): npub1...
Ollama is reachable; model llama3.2 is installed.
Profile and DM inbox published.
```

Stop it with Ctrl+C. Later starts reuse the same identity.

## 4. Talk to it from Anagram

- **DM:** add the printed npub as a contact and send a message. Each person has their own private conversation with the bot.
- **Private group:** invite the bot's npub through Anagram's member picker. The bot logs `Ignored a private group invitation from npub1...` until you allow that group (see below). Then mention the bot in the group.
- **Public group:** allow the group (see below) and restart. If the owner also adds the bot under **Public group settings → Trusted**, the bot sees that too. Mention the bot to ask a question.

Mention the bot with Anagram's mention picker, or paste its `npub` (with or without `nostr:`). Plain text like `@Ollama Bridge` is not a mention.

### Allowing groups

Two checks apply in groups: **the group must be allowed, and the person writing must be in `ALLOWED_NPUBS`.** Being a member of an allowed group does not give anyone access; other members' mentions are ignored.

```dotenv
# Private groups: the group's npub, copied from the bot's log after you invite it.
ALLOWED_PRIVATE_GROUPS=npub1group...

# Public groups: the naddr1... from the group's share link (quote full links).
ALLOWED_PUBLIC_GROUPS="naddr1..."
```

Restart after editing `.env`. An ignored private-group invitation stays on the relays, so the bot accepts it after the restart without a new invitation. Removing a group from the list stops the bot from reading or answering it. Access is never retroactive: messages written before a person or group was allowed are not answered (see [Restarts and delivery](#restarts-and-delivery)).

## Commands

| Command  | What it does                                                     |
| -------- | ---------------------------------------------------------------- |
| `/help`  | Lists the commands.                                              |
| `/reset` | Forgets the current conversation (this DM, or this whole group). |
| `/model` | Shows which Ollama model the bot uses.                           |

In groups, mention the bot before the command: `nostr:npub1... /reset`. The model can only be changed by the operator in `.env`; there is no chat command for it. Other messages go to the model.

## Conversation memory

- **Separate conversations.** Each DM partner has their own history. Each private group and each public group has one shared history (everyone in that group can see those messages anyway). Histories are never mixed, and nothing from one conversation is sent to the model in another.
- **Only messages to the bot are remembered:** in groups, only messages that mention it, plus its answers. Other group chatter is not read.
- **Bounded.** The newest `HISTORY_MAX_MESSAGES` messages (default 20) and at most `HISTORY_MAX_CHARS` characters (default 8,000) are kept. Older exchanges are dropped first. A conversation idle for `HISTORY_IDLE_MINUTES` (default 60) is forgotten. At most 200 conversations are kept.
- **In memory only.** History is never written to disk, so decrypted private messages do not end up in `state.json` or backups. **Restarting the bot clears all memory.** This is the deliberate trade-off for the first version: simple and private, but conversations do not survive a restart.
- In groups, each question is labelled with a short sender id (for example `[npub1abc…wxyz]`) so the model can tell people apart.
- Failed answers are not stored in history.

Keep the model's context window in mind: Ollama truncates very long prompts. If you raise `HISTORY_MAX_CHARS`, also raise Ollama's context length (`OLLAMA_CONTEXT_LENGTH=8192 ollama serve`).

## Configuration reference

All settings are in `.env.example` with comments. The most important:

| Variable                 | Default                  | Meaning                                                |
| ------------------------ | ------------------------ | ------------------------------------------------------ |
| `ALLOWED_NPUBS`          | _(empty: nobody)_        | Who may use the bot                                    |
| `ALLOWED_PRIVATE_GROUPS` | _(empty)_                | Private groups (group npubs) the bot may join          |
| `ALLOWED_PUBLIC_GROUPS`  | _(empty)_                | Public groups (naddr or link) the bot may join         |
| `OLLAMA_MODEL`           | `llama3.2`               | Model name as shown by `ollama list`                   |
| `OLLAMA_URL`             | `http://127.0.0.1:11434` | Ollama server                                          |
| `OLLAMA_ALLOW_REMOTE`    | `false`                  | Must be `true` for a server that is not this computer  |
| `OLLAMA_TIMEOUT_SECONDS` | `120`                    | Maximum time for one answer                            |
| `MAX_INPUT_CHARS`        | `4000`                   | Longer questions are refused                           |
| `MAX_OUTPUT_CHARS`       | `4000`                   | Longer answers are shortened                           |
| `MAX_REQUESTS_PER_HOUR`  | `30`                     | Per person, commands included                          |
| `MAX_QUEUE`              | `10`                     | Questions waiting for the model; more get "busy"       |
| `SYSTEM_PROMPT`          | _(built-in)_             | Persona/instructions; users cannot change it from chat |

Identity and relay settings (`NSEC`, `NAME`, `RELAYS`, `DATA_DIR`, `PICTURE_URL`, `NIP05`) work like in the dad-jokes example.

## Security

This bot can run on a personal computer, so it is locked down by default.

**Access control.** Every sender must be in `ALLOWED_NPUBS`, in every context. Groups need a separate allowlist entry. Unknown senders get no reply at all; the bot logs their npub (never their text) at most once an hour, so you can add people you know. Messages are authenticated by Nostr signatures (and NIP-171 invitation proofs in private groups), so a sender cannot pretend to be someone on the list without their private key.

**Ollama endpoint.** Only loopback addresses (`127.0.0.0/8`, `::1`, `localhost`) are accepted unless you set `OLLAMA_ALLOW_REMOTE=true`. URLs with credentials, queries or non-HTTP schemes are rejected. When the URL uses a host name, every connection checks the resolved address is still loopback, so a DNS change cannot redirect the bot elsewhere (DNS rebinding). Redirects are refused. The bot only calls two fixed paths (`/api/chat`, and `/api/tags` once at startup); chat users and the model cannot choose where requests go. Each request has a timeout, a 1 MiB response limit and a token limit.

With `OLLAMA_ALLOW_REMOTE=true` the bot trusts the configured host and its DNS. Use HTTPS or a private network (VPN, SSH tunnel), because prompts and answers travel to that host.

**What the model can do: only write text.** The bot sends the model the system prompt, the conversation's history and the new question. It never sends keys, environment variables, file contents or other conversations. There is no tool calling, shell, file, web, GitHub or LNbits access, and model output is never executed or parsed as instructions; it is only posted as a reply. Mentions in the output are shortened so the model cannot ping other accounts.

**Prompt handling.** Operator instructions go in the `system` role; chat text only ever goes in `user` messages. Users cannot change configuration from chat; commands only read the model name or clear their own conversation. Prompt injection can still make the model _say_ odd things, but it cannot make the bot _do_ anything else. Treat answers as untrusted text, especially in public groups.

**Operations.** Logs contain no message text and no secrets. `state.json` (which holds the bot's **nsec**) is mode `0600` in a `0700` directory and excluded from Git. One process per data directory. The work queue, generation queue, rate counters, history and outbox are all bounded. SIGTERM/SIGINT cancels the answer in progress and shuts down cleanly.

**Loop protection.** The bot ignores its own messages, edits and old history, answers in groups only when mentioned, never mentions anyone in its replies, handles each message once, and limits each sender per hour. After the limit it sends one notice per hour, then stays silent, so two bots cannot keep each other talking.

**Public groups are public.** Questions and answers there are visible to everyone, and the group's shared history contains only those public messages.

## Restarts and delivery

- A message is marked as handled (in `state.json`) as soon as the bot accepts it, before asking the model. Relays resend recent history after reconnects and restarts; marked messages are never answered twice.
- Answers are saved to the outbox before sending and retried with identical event IDs. One relay acknowledgement is enough.
- If the bot stops while the model is answering, that question (and any waiting ones) is dropped; the user just asks again. This avoids running an expensive model twice for one message.
- Messages older than 24 hours, or sent before the bot's first start, are not answered.
- **Access counts from the moment it is granted.** `state.json` records when each entry in `ALLOWED_NPUBS`, `ALLOWED_PRIVATE_GROUPS` and `ALLOWED_PUBLIC_GROUPS` was first seen at startup. Messages written before that time are never answered, even though relays resend them after a restart. So a person who wrote to the bot before you allowed them will not get answers to those old messages; they just write again. In a group, both the sender and the group must have been allowed when the message was written.
- People who were already allowed keep their time across restarts, so messages they send while the bot is offline are answered when it comes back (within the 24-hour limit).
- Removing an entry deletes its time. Adding it back later starts again from that restart; messages from the removed period stay unanswered.
- Ignored messages are not saved to `state.json`, so strangers cannot make the bot write to disk.
- When upgrading from a version without access times, every allowed entry starts at the first start after the upgrade. Messages sent while the bot was down for the upgrade are not answered.
- Relay failures retry automatically with increasing delays; network outages do not need a restart.

## Running on a server

Install Ollama on the server (the Linux install script sets up an `ollama` systemd service), pull your model, then copy this folder to `/opt/ollama-bridge`:

```sh
sudo cp -r bot-example/ollama-bridge /opt/ollama-bridge
cd /opt/ollama-bridge
sudo npm ci --omit=dev
sudo cp .env.example .env && sudo chmod 600 .env   # then edit .env
sudo cp ollama-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ollama-bridge
sudo journalctl -u ollama-bridge -f
```

Adjust the Node path in the unit if `which node` is not `/usr/bin/node`. The service runs as a dynamic, unprivileged user with a read-only system, no home directory access and state in `/var/lib/anagram-ollama-bridge`. Keep Ollama bound to `127.0.0.1` (its default); do not expose port 11434 to the internet.

Back up `state.json` while the bot is stopped: it contains the bot's **nsec** and private-group keys. **Use the same data directory to keep the same identity when moving deployments.**

## Make it your own

- **ollama.js** — the Ollama HTTP client (endpoint checks, timeouts, limits). It knows nothing about Nostr.
- **conversations.js** — bounded per-conversation memory and prompt building.
- **commands.js** — commands, mention handling, answer formatting, user-facing errors.
- **access.js / config.js** — allowlists and environment validation.
- **bot.js** — access, limits and the generation queue in `handle()` and `generate()`; startup, outbox and relays.
- **direct-messages.js / private-groups.js / public-groups.js** — Nostr protocol handling (NIP-17, NIP-171, NIP-C7), the same as the dad-jokes example plus allowlist checks.
- **runtime.js** — identity, state file, encryption and relay connections, copied from dad-jokes. The state file also stores when each allowlist entry was granted (`grants`).

## Checks

```sh
npm run check
npm test
```

Tests use a mock Ollama HTTP server and local WebSocket relays. They need no Ollama install, real keys, internet or external relays.

When this folder is inside the Anagram repository, an optional browser test drives the real client through a DM and both group flows (with the mock model). From the repository root, with dependencies and Chromium installed:

```sh
npm run test:e2e:local -- --config bot-example/ollama-bridge/playwright.config.js
```
