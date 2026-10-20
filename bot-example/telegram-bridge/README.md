# Telegram Bridge

A standalone Node.js bot connecting **one Telegram public supergroup** to **one Anagram public group**. Copy this directory to install and run it independently.

New Telegram messages appear in Anagram as:

```text
Alice said:
"Hello everyone"
```

Use Anagram's **Reply** action on that message. The bridge sends a Telegram reply to the original message, rendered as:

```text
Ben replied:
"Hello Alice"
Join the group at anagram.chat
```

`anagram.chat` links to the Anagram group's public share URL. Ordinary Anagram messages and mentions do not cross the bridge. Only direct replies to a Telegram message imported by this bot do. Telegram forum replies retain the original topic.

## Setup

Requires Node.js 24 or later and npm.

1. Create a Telegram bot using **@BotFather** and save its token. Add it to a **public supergroup with a username**. Give it permission to send messages. Disable group privacy using BotFather's `/setprivacy` and re-add the bot, or make it a group administrator. The bot needs access to ordinary group messages; see [Telegram's FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
2. Create or choose an Anagram public group and copy its `naddr1...` address. You can take the address from the end of its share link.
3. Install and configure:

   ```sh
   cd bot-example/telegram-bridge
   npm ci
   cp .env.example .env
   ```

   Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT` (for example `@my_public_group`), and `PUBLIC_GROUP=naddr1...` in `.env`. The NIP-19 address identifies the public group and its relay hints independently of any client or website. Full share links are also accepted, but must be quoted because `.env` treats an unquoted `#` as a comment. The `anagram.chat` URL is generated only for the invitation included in Telegram replies. A numeric `-100…` supergroup ID also works. Set `RELAYS` if your Anagram group uses other relays. `NSEC` is optional: without it, the bot creates an identity once and saves it.

4. Run `npm start`. Copy the printed `npub`.
5. As the Anagram group owner, open **Public group settings → Trusted → Add trusted users**, find the bot by its `npub`, and add it. The bridge activates when it receives that signed group update. Send a new Telegram message to test it.

Removing the bot from Trusted or blocking it stops bridging when the updated room metadata arrives. Blocked Anagram authors cannot send replies through it. The bot never subscribes to DMs or accepts private-group invitations.

One process and one Telegram polling consumer per token. An existing webhook must be removed by the operator before starting; this bot does not alter webhook configuration. Use another bot token and another `DATA_DIR` for another group pair. Changing the saved Telegram account, Telegram group, Anagram group, or Nostr identity requires a separate data directory.

## Deletion syncing (optional)

Add both values from [Telegram API development tools](https://my.telegram.org/apps) to your existing `.env`:

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your_32_character_api_hash
```

Keep the existing bot token and `data/` directory. Run `npm ci` after updating, then restart the bot. MTProto authenticates as the bot; no personal Telegram account is required.

The [Bot API update feed](https://core.telegram.org/bots/api#update) does not report ordinary group deletions. A separate MTProto module uses the same bot identity to watch the configured group for deletion updates. With both API settings empty, the existing message/reply bridge runs without deletion syncing. Partial or invalid settings stop startup with a configuration error.

At every startup and MTProto reconnect, it checks the **50 most recently bridged Telegram message IDs** still in its saved mappings. It requests those exact IDs using [channels.getMessages](https://core.telegram.org/method/channels.getMessages); it does not import or scan group history. Only explicit `MessageEmpty` responses for requested IDs cause cleanup. Permission/network errors, omitted results, and inaccessible groups do not cause deletions. A failed startup check stops startup so the supervisor can retry.

Live deletion updates can remove any imported message whose mapping is still saved, not just the latest 50. The module uses Teleproto's channel update recovery while connected; the 50-message check covers restarts and reconnects. This is bounded recovery: older deletions missed during downtime may remain, and pruned mappings cannot be recovered. Keep `data/state.json` and the original Nostr identity.

The bridge signs NIP-09 deletion requests only for its own corresponding Anagram posts. Pending copies and queued replies to deleted originals are cancelled. Anagram displays its usual deleted-message state; other people's Anagram replies remain. Relay retries reuse the saved signed request. Deletion is a request to relays and clients, not a guarantee that all public copies disappear.

## Messages and delivery

- Text is copied in the format above. Names come from the Telegram sender (including anonymous admin/sender-chat names) or the replying author's signed Nostr profile, with an `npub` fallback.
- Media posts use the caption, a media label, and a public `t.me` source link. Attachment binaries are not copied. Membership/pinning service updates and edits are not synchronized. Deletions are synchronized when the optional MTProto credentials above are configured. Protected Telegram content is ignored. Telegram controls which other bots' messages are delivered through the Bot API.
- Replies use Telegram HTML with escaped names and message text. Long replies are split into complete Telegram messages; every part replies to the original and includes the invitation. A deleted original is never silently replaced with an unthreaded post.
- Only messages newer than this data directory's first start are eligible. Messages received while the Anagram bot is untrusted are skipped. There is no Telegram history import. The [Bot API](https://core.telegram.org/bots/api#getupdates) retains undelivered updates for at most 24 hours; long downtime can lose messages.
- Nostr subscriptions replay at most the latest 1,000 messages per relay in a 24-hour window. This is an example for modest group traffic, not a guaranteed full-history catch-up service.
- Reply/deletion mappings survive restarts for up to 30 days, capped at 50,000 imported messages. Replies to older/pruned mappings are ignored. Duplicate Anagram event IDs and Telegram update IDs are suppressed.
- Signed Nostr events and mappings are saved before publication. Relay retries use the same event ID. Telegram sends are retried with backoff, honoring `retry_after`; successful parts are checkpointed. **Telegram has no idempotency key for `sendMessage`: a lost response or crash after acceptance but before checkpointing can produce a duplicate reply.**
- Pending messages/replies expire after 24 hours. Revoking trust discards pending messages/replies. Deletion requests for the bot's own imports continue retrying until a relay acknowledges them, including after trust is revoked. The outbox is limited to 1,000 entries; reaching that limit stops the bot so the operator can repair delivery and restart. Relay data can be stale, so owner policy changes take effect only when received.

`data/state.json` contains the bot's private key, Telegram update cursor, public-group metadata, reply mappings, duplicate IDs, pending messages and, when deletion sync is enabled, an MTProto authorization session and deletion tombstones. The session grants access as the bot and must be protected like the private key. State is written atomically with restricted permissions. Keep it private and back it up; do not delete it to fix a startup error. It is bound to the configured bridge so queued replies cannot accidentally move to another group. `data/` and `.env` are ignored by Git. The Telegram token and API credentials stay in `.env`; they are never persisted in state or included in logs. The authorization session is stored only in the restricted state file (0600, with a 0700 directory). Keep `.env` private too (`chmod 600 .env`). MTProto library diagnostics are suppressed; operational errors use generic messages.

Stop with Ctrl-C or SIGTERM. To run continuously, use your usual process supervisor with this directory as its working directory and `npm start` as the command.

## Validation

```sh
npm run check
npm test
```

The tests use a local WebSocket Nostr relay and a simulated Telegram API, without posting to real groups. They cover message formatting, public-only routing, trust/block changes, actual reply references, forum topics, deduplication, restart recovery, relay failures, rate limits, HTML escaping, long replies, live deletions, the 50-message startup check, wrong-channel events, failed lookups, deletion retries, and deletion-before-import races.

When this directory is inside the Anagram repository, run the browser interoperability test from the repository root:

```sh
npm run test:e2e:local -- --config bot-example/telegram-bridge/playwright.config.js
```

It creates a public group in Anagram, adds the bot using the Trusted picker, displays an incoming Telegram message, sends a reply through the UI to the simulated Telegram API, and checks that startup reconciliation removes the imported text while preserving Anagram replies, including after reload. Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if system Chrome is required. This is not validation against a live Telegram group.
