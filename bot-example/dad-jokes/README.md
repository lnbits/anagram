# Dad Jokes bot

A standalone Node daemon that talks to Anagram through Nostr relays. No Anagram installation, browser, web server or database service is needed. Copy this folder to start your own bot.

## Run

Use **Node 24 or later**:

```sh
cd bot-example/dad-jokes
npm ci
npm start
```

On first start it saves a new identity, prints its **npub**, publishes a **Dad Jokes (Example Anagram Bot)** profile using the [hosted profile picture](https://npub1c878wu04lfqcl5avfy3p5x83ndpvedaxv0dg7pxthakq3jqdyzcs2n8avm.blossom.band/2b21dde65f33c3a05e5ef9147db2463cdac8698aad29a106770eab044dbe33db.png) and advertises its DM inbox relays. No image upload is needed; `PICTURE_URL` can override the default. Later starts reuse the same identity and picture URL. Publication retries automatically if the network is unavailable.

For configuration, copy `.env.example` to `.env` and uncomment the settings you need. `RELAYS` should overlap the Anagram users' app relays. The default relay list matches Anagram; room and inbox relay hints are also used.

Set `NSEC=nsec1...` to use your own private key and `NAME="Your Bot Name"` to change the profile name. Without `NSEC`, the bot reuses its saved identity or generates one on first start. Without `NAME`, it uses **Dad Jokes (Example Anagram Bot)**. A configured key must match the saved identity; use a different `DATA_DIR` to switch accounts without mixing group state. Keep `.env` private (`chmod 600 .env`). Restart to apply changes.

Set `NIP05=dad@your-domain.example` in `.env` to include that identifier in the bot profile. The domain must serve `/.well-known/nostr.json` mapping `dad` to the bot’s hex public key; setting the variable alone does not verify the identifier. Restart the bot to publish profile changes.

## Talk to it

- **DM:** add the printed npub as a contact and send a message. It replies with a joke.
- **Private group:** invite that npub through Anagram's member picker. The bot accepts its encrypted invitation automatically. Mention its account to get a joke.
- **Public group:** add the npub to **Trusted**. The bot watches signed group profiles on its configured relays and joins when it sees itself added. Mention it to get a joke.

Use Anagram's mention picker, or paste the bot's `npub` (with or without `nostr:`); plain `@Dad Jokes` is only text.

For a public group that isn't discovered, **DM its public group link to the bot**, or put its link/naddr in `PUBLIC_GROUPS`. Public groups have no addressed invitation; automatic discovery can only see profiles on reachable relays. A link carries relay hints and identifies the exact group. Anyone may send a link; text-only replies do not require trusted status. Blocking the bot stops replies. Removing trust stops automatically joined rooms; explicitly joined rooms continue unless blocked. After an ownership transfer, send the new group link.

## Make it your own

Change `reply(message)` in **bot.js**. The example picks a random entry from the bundled collection; your implementation can use the message's author and content. Keep it synchronous, or make the handlers await your replacement.

- **direct-messages.js** — NIP-17 encrypted DMs and reply tags.
- **private-groups.js** — Anagram's NIP-171 tickets, membership proofs and epoch rotation.
- **public-groups.js** — signed room discovery, mentions and NIP-C7 replies.
- **bot.js / runtime.js** — startup, profile publication, durable state, relay connections and encryption.

The bot runs as an ordinary member. It does not need group owner keys. Private invitation signatures travel in the seal's `invitation_proof` tag, matching Anagram's current wire format. Public replies use `kind:9`, `a` and `q`; private replies use wrapped `kind:14` with an `e` reply tag.

## Keep it running

For a Linux server, copy this folder to `/opt/dad-jokes`, run `npm ci` there, and install the included `dad-jokes.service` in `/etc/systemd/system/`. Adjust its Node path if necessary, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dad-jokes
sudo journalctl -u dad-jokes -f
```

The service uses a dedicated dynamic user and saves its state in `/var/lib/anagram-dad-jokes`. A manually started bot defaults to this folder's `data/` directory. **Use the same data directory to preserve an existing identity when moving deployments.**

Back up `state.json` while the bot is stopped: it contains the **nsec and private-group epoch keys**. It is stored with mode `0600` in a `0700` directory and excluded from Git. Run one process per data directory. Invalid state stops startup instead of generating a replacement identity. A stale process lock is recovered after a crash.

Relay failures retry automatically with increasing delays (up to a minute), independently of healthy relays. Heartbeats detect silent connections; reconnects restore subscriptions and authentication. Network outages do not require restarting the bot.

Replies are saved before sending and retried with the same event IDs. One relay acknowledgement is sufficient. Private replies queued for an old or conflicting epoch are discarded. SIGTERM/SIGINT shuts down cleanly. This does not guarantee that a relay will retain a message after acknowledging it.

The example answers messages from the last 24 hours, never before its first start, with a default 5-second cooldown per sender. Reconnect reads are bounded to 1,000 messages and public discovery to 500 room profiles; private invitations are processed regardless of age within the retrieved inbox. State allows up to 100 groups of each type and about 1,000 queued deliveries. This is intended for a small bot, not archival replay or bulk messaging. Local/private relay endpoints must be explicitly configured in `RELAYS`; untrusted hints cannot reach the server's private network.

## Checks

```sh
npm run check
npm test
```

Tests cover encryption, ticket authorization, rotation/conflicts, mentions, persistent identity, replay suppression, failed deliveries, profile publication and real local WebSocket relays.

When this folder is inside the Anagram repository, the optional browser test drives the actual client through a DM and both group invitation flows. From the repository root, with Chromium installed:

```sh
npm run test:e2e:local -- --config bot-example/dad-jokes/playwright.config.js
```

## Joke collection

The 649 jokes are saved unchanged from [ShivamJoker's supplied collection](https://gist.githubusercontent.com/ShivamJoker/2ca8daacab7a4fe0615f535cd9d7fd78/raw/4d59cf01daa00a1a83f3d52f676638f769b0ea0f/dad-jokes-collection.json). No joke API is called at runtime.
