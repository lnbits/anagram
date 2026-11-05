# LNbits Wallet bot

A standalone Node daemon (Node 24 or later) that lets people use **their own LNbits wallet** from an Anagram direct message. By default it can **receive but never send**: it holds only wallet _invoice_ keys, which LNbits refuses for payments. [Sending through Nostr Wallet Connect](#sending-send-payments-off-by-default) exists, off unless the operator turns it on, and unproven against real wallets.

The folder is self-contained: dependencies, lockfile, configuration examples, the Nostr transport and Anagram's inline keyboard validator in `vendor/` (from the [poll](../poll) example) and the [license](LICENSE). Copy it anywhere and run it from there.

> **Status: receive-only release candidate, not yet tried in production.** The core, [database mode](#database-mode), wallet management and self-service connections have been tested by hand in Anagram against a local FakeWallet, on a local relay. `/invoices` has automated tests, and its LNbits calls were checked against a real v1.6.2 instance. None of it has run yet behind a real reverse proxy, on public relays or against a real Lightning backend. NWC, `/send` and `/payments` are off by default. They have run in a real browser and a real bot process, against local mock wallets only, never a real wallet.

There are two ways to run it. **`wallets.json`** (below) is the simplest: you, the operator, link each person to a wallet by editing a file. **[Database mode](#database-mode)** keeps keys encrypted, and with [`/connect`](#self-service-connections-connect) people connect and disconnect their own wallets.

## Install and run

```sh
npm ci
cp .env.example .env
cp wallets.example.json wallets.json
chmod 600 .env wallets.json   # then edit both
npm start
```

On first start the bot creates a Nostr identity, prints its **npub**, publishes its profile and DM inbox relays, and reports how many wallets are linked. It then asks LNbits about each link and logs `LNbits accepted N of M wallet link(s).` (an unreachable LNbits does not stop the bot). `state.json` in `DATA_DIR` holds the bot's nsec (mode `0600`); back it up while the bot is stopped.

## Linking wallets (operator only)

`wallets.json` maps each person's npub to **one** wallet's invoice key:

```json
{ "npub1...": { "label": "Alice's wallet", "invoiceKey": "<32-character invoice key>" } }
```

- Use the wallet's **invoice/read key**, never its admin key. LNbits v1.6.2 reveals an admin key (its wallet response includes the wallet `id`); the bot then switches that link off, logs it, and tells the person. See [Limitations](#limitations) for what this check cannot guarantee.
- Each npub gets one wallet, and each wallet one npub. Duplicates stop startup.
- The file must be private (`chmod 600`), or the bot refuses to start. Keys are never logged or sent in messages.
- Linking is done by you, the operator, by editing this file and restarting. **The bot never accepts keys in chat.** A message that looks like a key, login id or private key is refused with a warning to rotate it, and is not stored.
- To revoke access, remove the entry and restart, or reset the wallet's keys in LNbits.

Messages a person wrote before their wallet was linked are never answered, even when relays resend them after a restart.

## Using it

Add the printed npub in Anagram and send a DM. Only linked people get an answer; everyone else is ignored and logged by npub only, never by message text. Group invitations are ignored: wallet information is only ever sent by DM.

| Command                | Reply                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `/balance`             | `Balance (Alice's wallet): 2,100.5 sats`                              |
| `/history`             | The last `HISTORY_DEFAULT` (5) settled payments, newest first         |
| `/history 1-20`        | That many settled payments                                            |
| `/help`                | The commands and the linked wallet's label                            |
| `/invoice 1000 coffee` | A Lightning invoice for 1,000 sats with the memo `coffee`, as text    |
| `/invoices`            | The [invoices made here](#invoice-history-invoices), and their status |
| `/menu`                | Buttons for all of the above                                          |
| `/cancel`              | Stops something unfinished, such as a Custom amount                   |

In Anagram, these replies also carry [buttons](#buttons).

Every command works only on the sender's own linked wallet; words after a command cannot select another one. Amounts are exact: LNbits counts millisatoshis and the bot shows sats with up to three decimals, never rounded. A history line shows only the amount (and fee, for payments sent), the time in UTC and a short memo. Memos are written by whoever created the invoice, so they are reduced to plain text: links, Nostr and Lightning references, key-like strings, formatting and invisible or direction-changing characters are removed, and they are cut to 48 characters. Pending and failed payments are not listed.

When LNbits rejects the key, is unreachable, is slow (`LNBITS_TIMEOUT_SECONDS`) or answers something unexpected, the person gets a short message and the log gets a code (`rejected 404`, `timeout`, `unavailable 502`, `bad_response`), never a key, URL or server text.

Plain text gets the help message, except for replies (so two bots cannot message each other forever). Each person may send `MAX_REQUESTS_PER_HOUR` messages per hour; over the limit they get one notice, then silence.

## Buttons

Anagram shows [inline buttons](../../docs/bot-keyboards.md) under the bot's replies. Every button does something a command also does, and the reply text is the same as without buttons, so apps that do not support them simply show the text.

| Under                         | Buttons                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/balance`, `/help`, `/menu`  | **Refresh balance**, **History**, a button per preset amount (`INVOICE_PRESETS`), **Custom**, **Invoices** |
| `/history`                    | **Older** / **Newer** (`HISTORY_DEFAULT` payments per page, ten pages), then the same as above             |
| `/invoice` and preset invoice | **Copy invoice** (copies the BOLT11 text on the device; the bot is not told), **Check status**             |
| `/invoices`                   | A number per invoice for its details, **Older** / **Newer**, **Refresh**                                   |
| Payment notification          | **Refresh balance**, **History**                                                                           |

A press is answered privately: the answer replaces the reply's text for that person, in that chat, without a new message or notification, and brings its own buttons. A press works only when all of this holds; otherwise it gets no answer:

- It arrives as an encrypted request whose seal is signed by the sender (the same check as a DM), for this bot, in its DM, not expired (Anagram's requests last five minutes) and not written before the sender was linked.
- The reply it belongs to was sent by this bot **to that same person**, and the button is really on that reply or on the bot's answer to an earlier press there. The request cannot name a wallet, an amount or a key: the button's data is short and fixed (`bal`, `hist:2`, `inv:1000`, `st:<12 hex>`), and the key still comes only from `wallets.json`.
- The person is still linked to **the wallet the reply was made for**. After the operator links a different wallet, old buttons answer that the menu is stale and read nothing; after a link is switched off, they say so.
- Presses count against `MAX_REQUESTS_PER_HOUR`. With sending off, the default, buttons cannot send a payment, and the bot holds only invoice keys. With it on, each payment still needs its own preview and press.

**Idempotent.** The exact encrypted answer to each request is kept (five minutes past its expiry), so when Anagram retries a request, the same answer is sent again and nothing is asked or done twice; a reused request id with different contents is refused. A **preset invoice** follows the [invoice](#invoices) lifecycle and limits, and one button on one menu creates at most one invoice at a time, while that invoice can still be paid: pressing it again, or Anagram retrying it as a new request after it expired, shows that invoice again while it can still be paid. An unconfirmed preset invoice is looked up, never resent, and its result arrives as an ordinary message. If fewer than 30 seconds of the request remain when LNbits would be asked, nothing is created and the person is asked to press again; an invoice that LNbits confirms only after the request expired is sent as an ordinary message (Anagram would ignore a late answer).

**A preset invoice arrives as a message of its own,** so it stays easy to find, and the menu it came from stays a menu. **Custom** asks for an amount: the person's next message, a whole number of sats with an optional note, makes one invoice in the wallet that menu was for, even if another wallet was chosen meanwhile. The question lasts five minutes. `/cancel`, its **Cancel** button or any other command ends it; a restart forgets it. Anything but a whole number, an amount over the limit or a note over 100 characters gets asked again and creates nothing; retrying does not extend the five minutes.

**Check status** opens that invoice's [details](#invoice-history-invoices). It never creates anything.

`state.json` keeps, per reply with buttons, who it was for, a digest of the wallet link and the buttons' data (never copy texts or invoice text), for 30 days (at most 100 per person). Answers are encrypted to the person; Anagram stores them on that device only, so other devices show the original reply and ask again.

## Invoices

`/invoice <sats> [memo]` creates one incoming invoice in the sender's own wallet and returns it as text, with the BOLT11 invoice on a line of its own. The amount is a plain whole number of sats from 1 to `MAX_INVOICE_SATS` (no `1.5`, `1e3`, `1,000` or leading zeros); the memo is what payers see, so it is sent as written, with invisible and control characters turned into spaces, and a memo over 100 characters (or 300 bytes) is refused rather than shortened. Each person may create `MAX_INVOICES_PER_HOUR` invoices per hour.

**One message creates at most one invoice, ever.** LNbits does not reject a repeated `external_id`, so it cannot prevent duplicates by itself. The bot keeps a record per request in `state.json` and moves it through these states:

| State       | Meaning                                                                                                                                                                        | Next                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `queued`    | written before LNbits is asked                                                                                                                                                 | `sending`; after a restart: `failed` (it never left the bot)     |
| `sending`   | the single creation request is about to be sent                                                                                                                                | `created`, `failed` or `uncertain`; after a restart: `uncertain` |
| `created`   | LNbits answered with the invoice, which was sent in the same save                                                                                                              | final                                                            |
| `failed`    | LNbits certainly created nothing: key rejected, invalid request (400), LNbits' own refusal (520 with its error body; a proxy's bare 520 is uncertain), or no connection at all | final                                                            |
| `uncertain` | timeout, dropped connection, server error or an unreadable answer: LNbits may have created it                                                                                  | `created`, `failed` or `review`                                  |
| `review`    | cannot be settled automatically: an invoice that does not match the request, more than one for it, or no key left to look with                                                 | the operator decides                                             |

An uncertain request is **never sent again**. Each request carries a unique external id (`alw-<uuid>`, no Nostr data), and the bot looks for it in the wallet's payments after 5 s, 30 s, 2 min and 10 min. LNbits ignores filters it does not understand, so only an exact external-id match counts. A lookup that cannot reach LNbits is not counted: it is retried with a growing delay, so an outage alone settles nothing. Found: the invoice is sent (marked as confirmed late), or, if it can no longer be paid, the person is told so. Every lookup answered and none found it: the request is `failed` and the person can ask again, because nobody ever saw an invoice, so nobody can pay it. In `review`, **no new invoice is created for that person in that wallet until the operator has checked**. While a request of theirs is unsettled, a person's next `/invoice` waits for it. An `/invoice` over an hour old is refused rather than acted on late.

`state.json` holds the request (amount, state, wallet, external id, payment hash once known, the last status seen) but never the memo or the invoice text; the invoice exists only in the encrypted reply and in LNbits.

### Invoice history (`/invoices`)

`/invoices` lists what was made through this bot in one wallet: the one in use, or, from an older menu, the one that menu was made for, as with `/history`. Five to a page, newest first: amount, status, date and memo, under the wallet's name. A number opens the details, with the invoice and **Copy invoice** while it can still be paid. **Refresh** asks again. To see another wallet's invoices, choose it in `/wallets`.

| Status                  | Meaning                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending                 | The wallet says unpaid, and it has not expired                                                                                                                                                    |
| Paid                    | The wallet says it settled                                                                                                                                                                        |
| Expired                 | The wallet says it expired, or says unpaid after asking its funding source, and its time is up                                                                                                    |
| Failed                  | No invoice was created, or the wallet gave up on it                                                                                                                                               |
| Unknown                 | No answer, or none that can be trusted: LNbits unreachable, the row gone, or an answer that contradicts a payment already seen. If one was seen, it adds `last seen: …`, and that is all it means |
| Unknown, still checking | The bot is still finding out whether it was created (see the table above)                                                                                                                         |
| Needs review            | The operator has to decide (see below)                                                                                                                                                            |

**Where the status comes from.** Only the wallet's own answer, read with that wallet's key on every view: never a socket frame, a Nostr message or a guess. A failed lookup is never shown as Failed or Paid. A row that has gone from LNbits is Unknown, not Expired, because LNbits v1.6.2 keeps expired invoices.

**How Expired is known.** LNbits v1.6.2 does not delete an expired invoice. The next time it looks, it marks it `failed` with the label `expired`; until then the row stays `pending`, even if it was in fact paid and LNbits missed it. So a pending row past its expiry is first checked with `GET /api/v1/payments/{hash}`, which has LNbits ask its funding source, and a view of one invoice always does this. That request can change LNbits' own row, as its own interface does.

A created invoice's last answer is kept as its `payment`, which only moves forward:

| From    | To                             |
| ------- | ------------------------------ |
| (none)  | pending, paid, expired, failed |
| pending | paid, expired, failed          |
| expired | paid                           |
| failed  | paid                           |
| paid    | final                          |

**Limits.** A history belongs to one exact wallet link. After a disconnect it cannot be seen, its old buttons stay dead, and connecting the same wallet again starts an empty list: this is the same rule as old menus, and LNbits still has every payment under `/history`. Records from before this release do not say which wallet they were made in, so the first view asks the wallet, and shows only what it holds. Finished requests are kept 90 days, at most 200 per person. If LNbits cannot be reached, memos are missing and statuses are Unknown, because neither is kept here. Each page costs up to five LNbits lookups (ten for pages of invoices past their expiry), and each press counts against `MAX_REQUESTS_PER_HOUR`.

### Operator review

Stop the bot, then:

```sh
npm run review                         # requests that are not settled, with their external ids
npm run review -- created <request>    # LNbits has an invoice with that external id
npm run review -- failed <request>     # LNbits has none
```

Check in LNbits first: the wallet's payments, searched for the external id. The bot logs the same instruction when a request goes to review.

## Payment notifications

Every linked wallet that LNbits accepts as an invoice (non-admin) key is watched. When it receives a settled payment, its person gets a DM such as `Received (Alice's wallet): +2,100 sats · 2026-11-01 18:04 UTC · coffee`; several at once arrive as one list. Outgoing payments, pending invoices and other wallets' payments are never announced, and nothing goes to a link that was switched off.

- **The history decides, not the socket.** The bot keeps LNbits' payment socket open for each wallet, but only as a hint to look: it sends each internal payment twice, and it never replays what was missed. After a frame (and again ten seconds later), after every reconnect and every five minutes, the bot reads the wallet's settled incoming payments with its invoice key, newest settlement first.
- **First start: a baseline.** The payments that exist when a wallet is first watched are recorded and never announced; one baseline records up to the newest 250. The same happens when the operator links a different wallet to a person, or links the same wallet to a different person.
- **Exactly once.** Each wallet's newest settlement time and the payment hashes already handled are kept in `state.json`. A notification is queued in the same save that records its payments, so a crash before that save just means the next check finds them again, and a crash after it means the notification is already in the durable outbox.
- **Missed while offline.** After a restart, a dropped socket or LNbits downtime, the next check reads back to ten minutes before the last known settlement, so payments made meanwhile are announced once.
- **Bounded.** One check reads at most five pages of 50 payments. If more settled while the bot could not look, the newest 20 are listed and the rest summarized with a pointer to `/history`.
- Socket URLs contain the invoice key: they are never logged, and socket errors are not logged at all. Sockets reconnect with backoff (1 s to 1 min) and are pinged every 30 s.

## LNbits API

These are the only requests made, all to the wallet's LNbits, with its invoice key in the `X-Api-Key` header. None of them can send a payment:

| Request                                                                                       | Used for                      | Checked                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/wallet`                                                                          | `/balance`, admin-key check   | `balance` must be a whole, non-negative msat amount; an `id` or `adminkey` field means an admin key                                                                                               |
| `GET /api/v1/payments?limit=N&offset=M&sortby=time&direction=desc&status=success`             | `/history`, history pages     | an array of payments with whole-msat `amount`, `fee`, a string or empty `memo` and a valid `time`; other fields are ignored                                                                       |
| `POST /api/v1/payments` `{out: false, amount, unit: "sat", memo, expiry, external_id}`        | `/invoice` (once per request) | 201 with a BOLT11 invoice for exactly the requested msat and our external id; anything else is not shown                                                                                          |
| `GET /api/v1/payments/paginated?external_id=…&limit=10`                                       | uncertain requests, status    | only payments whose `external_id` matches exactly                                                                                                                                                 |
| `GET /api/v1/payments/{hash}`                                                                 | status of a pending invoice   | only what comes with `details`, which LNbits includes only for the wallet that owns the payment; LNbits may update its own row                                                                    |
| `GET /api/v1/payments/paginated?status=success&amount[gt]=0&sortby=updated_at&direction=desc` | payment notifications         | settled, positive payments with zoned `updated_at`/`time`; anything else is dropped. LNbits sets `updated_at` on settlement but cannot filter on it, so the bot pages and stops at its own cursor |
| WebSocket `/api/v1/ws/{invoice key}`                                                          | a hint to check the history   | frames are never read                                                                                                                                                                             |

Redirects are never followed (they could forward the key), responses over 256 KB are refused, at most four requests run at once with 100 waiting, and requests in progress are cancelled on shutdown. A wrong or reset key gets `404 Wallet not found.`; in v1.6.2 a reset takes effect immediately, including on the cached payments endpoint (checked against a local FakeWallet instance).

## Limitations

- **Notifications are best effort in these cases:** a payment created more than 30 days before the newest known settlement is treated as old and not announced (this keeps old payments whose rows are later updated, for example labelled, from looking new; LNbits invoices expire long before that); more payments in one ten-minute window than one check reads (250) are summarized, not listed; and rows LNbits commits more than ten minutes out of order would not be re-read. A notification can only arrive as fast as relays deliver it, and the person's Nostr client must be able to reach the relays of their inbox.

- **Duplicate invoices are prevented by the bot, not by LNbits.** A request that LNbits stored only after every check (more than ten minutes late) stays in `review` until the operator looks; the bot never resends it. A LNbits backend that creates a Lightning invoice but fails to store it leaves an invoice nobody receives; it cannot be paid into the wallet.
- LNbits' `expiry` field in its answer has no time zone, so the bot states the validity it asked for (`INVOICE_EXPIRY_MINUTES`) instead of reading it back.

- **Admin-key detection is a check, not a guarantee.** It relies on LNbits v1.6.2 adding the wallet `id` only for admin keys. The same check runs when the bot starts, before a key is used, and in `migrate`, which then stores nothing. Another LNbits version could behave differently; linking an invoice key is the operator's responsibility. An invoice key itself cannot pay: LNbits refuses `out: true` with it (403).
- The balance must fit JavaScript's exact integer range (about 90 000 BTC in msat); a larger value is refused as unexpected rather than shown wrongly.
- Replies and notifications that relays do not accept for a day are dropped by the transport; the bot logs `Dropping N delivery(ies)...` when that happens. An unreadable payment row in the history is skipped and logged (`Skipped N unreadable payment row(s)`) and is not announced.
- Every message from a linked person within the hourly limit rewrites `state.json` (the dedupe record is written before anything slow). Over the limit, and from strangers, nothing is written. On slow disks, keep `MAX_REQUESTS_PER_HOUR` modest.
- A notification relays do not accept for a day is dropped, and its payment stays recorded as announced: only `/history` shows it then.
- Notifications rely on LNbits ordering the history by `updated_at` (verified against v1.6.2: newest settlement first, including an invoice created before others but paid last). A row dated in the future is announced once, and cannot hide later ones.
- A wallet gets at most one notification every ten seconds; the next one lists what arrived meanwhile. When the outbox holds 500 items, notifications wait for it to drain, so replies always have room. A person can finish disconnecting from a card they already have, even over the hourly limit or with the outbox full, with up to 20 steps an hour; otherwise, the operator can use `connections revoke`.
- A wallet command is recorded as handled before LNbits is asked, so a crash at that moment loses the answer (never duplicates it); the person can ask again.
- A message dropped silently over the hourly limit is not recorded. If relays resend it after a restart, it is handled then, within the same limits, and an `/invoice` over an hour old is refused.
- LNbits sees the bot's IP address and every request; the operator of the bot can read every linked wallet's balance and history.

## Database mode

`wallets.json` stays the default. Database mode keeps links in an encrypted SQLite database (`DATA_DIR/connections.db`) instead, so wallets can be connected and disconnected while the bot runs. Which one applies is never ambiguous: with a `connections.db` the bot uses it and refuses to start if `WALLETS_FILE` is also set; without one it reads `wallets.json`, exactly as before.

**Secrets live apart from the data.** `SECRETS_DIR` (mode 0700, outside `DATA_DIR`, or the bot refuses to start) holds:

- `keyring.json`: the keys that encrypt stored credentials. **Back it up offline after `init` and after every `rotate`.** Without it, stored credentials cannot be read.
- `revocations.log`: an append-only, signed record of every disconnected wallet. It is what keeps a disconnected wallet disconnected through a restore or rollback. Do not restore old copies of it.

### Self-service connections (`/connect`)

With `CONNECT_PUBLIC_URL` set, people connect their own wallets. It needs database mode: `npm run keyring -- init`, then `npm run connections -- init` (or `migrate`, if you have a `wallets.json`).

1. The person sends `/connect`. The bot answers with a private one-time link, valid for ten minutes.
2. On the page they enter their LNbits address and **invoice key** (never in chat). The bot checks it with LNbits and refuses admin keys.
3. The bot sends a code in an encrypted DM to their Nostr account.
4. They type the code on the page. Only then is the wallet connected and its key encrypted and stored. They get a confirmation in chat.

**Holding the link is not enough.** Someone with a leaked link gets no code, because it goes to the account's encrypted DMs. And a link someone else sent you sends the code to _them_, while what you typed stays in your browser's session, so neither side can finish alone. The page always names the account being connected, and says to stop if someone sent you the link. One thing it cannot fully stop: an attacker who sends you their link _and_ talks you through typing the code they received. That links your wallet to their account, with read access, or the power to spend if the connection allows it and sending is on. The warning on the page is the defence.

Until the code is confirmed nothing is on disk: the key is held in memory, and a restart cancels whatever was unfinished. Tokens and codes are stored only as hashes. People with no wallet can only get `/connect`, `/help` and the warning about pasted keys, within limits per person and overall; anything else is ignored without a disk write.

| Variable                   | Meaning                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONNECT_PUBLIC_URL`       | The address people see, `https://` only. Unset: the feature is off, and the page does not start                                                                             |
| `CONNECT_PORT`             | Local port, 8787 by default. **The page listens on this computer only.** Put a TLS-terminating reverse proxy in front, passing the `Host` header unchanged (example below)  |
| `LNBITS_ALLOWED_ORIGINS`   | Which LNbits servers people may use. Empty: only `LNBITS_URL`. A comma-separated list adds servers you trust as they are, private ones included. `*` adds any public server |
| `CONNECT_ALLOW_HTTP_LOCAL` | Local testing only: allows `http://127.0.0.1...` as `CONNECT_PUBLIC_URL`, with the link as text because Anagram's buttons are HTTPS only                                    |

**With `*`, the bot connects to servers people name, so these apply to everything but your own listed servers:** HTTPS on port 443 only; real host names only, no addresses and no `localhost` or `.local`-style names; every address the name resolves to must be public, checked as the connection is made, so DNS rebinding finds no second lookup; no redirects; time and size limits; and one error message for anything that might reveal a private network.

**The page itself:** a strict content security policy with no inline code and no third-party code, no framing, no referrers, no caching and no browser storage. The session cookie is `__Host-`, `Secure`, `HttpOnly` and `SameSite=Strict`. Requests need the page's own origin, a JSON body and a CSRF token, and a request under any other `Host` is refused.

**The reverse proxy.** It only has to end TLS and pass requests on, keeping the `Host` header. For example, with Caddy (not yet run as part of this repository's checks: try it before relying on it):

```text
connect.example {
	reverse_proxy 127.0.0.1:8787
}
```

Or with nginx, inside your TLS `server` block for that name:

```text
location / {
	proxy_pass http://127.0.0.1:8787;
	proxy_set_header Host $host;
}
```

### Nostr Wallet Connect (`NWC_ENABLED=true`)

Off by default. **It has been tested only against a local mock of the protocol, not against real wallets,** so try it with your wallet before relying on it.

With it on, the connection page also accepts an NWC **connection string** (`nostr+walletconnect://...`), with the same code confirmation as LNbits. The wallet's relays go through the same address checks, as public `wss://` only. The connection is kept in the encrypted store, with its scope and what it offers. The page lists what a connection allows before the code step.

| Kind                                     | Must offer                                                                        | Must not offer                                         | Notes                               |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| Receive only                             | `get_info` and at least one of `get_balance`, `make_invoice`, `list_transactions` | Any way to pay                                         | The default                         |
| Can send payments (needs `SEND_ENABLED`) | `get_info`, `pay_invoice`, `lookup_invoice`, and `get_budget` reporting a limit   | `pay_keysend`, `multi_pay_*`, or anything else unknown | The person ticks an acknowledgement |

A payment and a new invoice go on one relay only, whichever is ready first: a relay can pass an event on and still say it refused it, and a wallet may not notice the same event arriving twice. If that relay does not reach the wallet, the request fails, and nothing is tried on another. NIP-47 itself defines only `get_info`, `get_balance`, `make_invoice`, `lookup_invoice` and `pay_invoice`. A wallet offering only part of them works for what it offers: `/balance` and `/history` say when they are not offered, and without `list_transactions` there are no payment notifications. What a connection may do is checked again regularly, and one that gains more is switched off.

**Testing on one computer.** A connection's relay must be public `wss://`, so a relay on this computer is refused, `localhost` included. `NWC_LOCAL_TEST_RELAYS=ws://127.0.0.1:7791` lists relays that may be used anyway: on this computer, by number, exact address, at most three. It needs `NWC_ENABLED` and a `CONNECT_PUBLIC_URL` on this computer, and the bot says so when it starts. A connection stored while its relay was listed cannot reach it once it no longer is. Never set this in a real deployment.

`test/mock-wallet.js` (`npm run mock-wallet`) is a pretend wallet for such a relay: no money exists in it, it never touches LNbits or Lightning, and it refuses any relay not on this computer. It can only pay invoices it made itself, enforces its limit, can be told to lose answers or fail, and counts `pay_invoice` requests per payment hash, including any sent while it was stopped. The top of the file lists its commands. Its connection string goes to a private file, never to the terminal.

**Known limitations:**

- **NIP-44 only.** A wallet that offers only the deprecated NIP-04 is refused.
- **No Nostr Wallet Auth.** It is not in the merged NIP-47, and in the implementation checked (Alby's SDK) the wallet's approval is a plain event tagged with the app's public key, which appears in the link. Anyone who sees that key, including a relay, could publish a forged approval and pose as the wallet, and invoices would then pay them. So connection strings are the only way in for now.
- **Relays that require AUTH do not work.**
- **Payment notifications come from checking every minute,** not from a socket.
- **An invoice whose answer was lost cannot be found again,** because NWC has no external id. The person is told and can ask again. It was never shown, so it can never be paid.
- **Disconnecting here does not revoke it in the wallet.** Only the wallet can do that, and the person is told to.

### Sending (`/send`, `/payments`): off by default

`SEND_ENABLED=true` needs database mode and `NWC_ENABLED=true`. **It has only ever run against a local mock wallet. No real payment has been made with it. Treat it as unproven.**

**How a payment happens.** `/send <invoice>`, or just pasting the invoice, or the **Send** button, shows a preview: the amount, the wallet, what the invoice says, its expiry, and who it pays if the invoice names them and its signature verifies. Nothing is paid. The person presses **Pay**, on that card, within five minutes. Right then, the bot checks its limits, the wallet's limit and the wallet's records for that payment, and any doubt stops it. Then one request goes to the wallet, on one relay, and never on another, even if that relay refuses it.

**The bot never holds a key that spends otherwise,** and there is no way to use an LNbits admin key to send.

**Limits, per person:**

| Variable          | Default | Meaning                                              |
| ----------------- | ------- | ---------------------------------------------------- |
| `SEND_MAX_SATS`   | 10,000  | One payment                                          |
| `SEND_DAILY_SATS` | 50,000  | In 24 hours. Anything that may have been paid counts |
| `SEND_PER_HOUR`   | 5       | Payments an hour                                     |

One payment waits for confirmation at a time, one is in flight at a time, and previews are capped at 30 an hour. A wallet has 60 seconds to answer a payment, and that person's other commands wait their turn behind it. Only the final Yes of a disconnect goes straight through. Records that count against a limit, or block an invoice that can still be paid, are never evicted: past 300 of them, new payments for that person are refused instead, and with 5,000 records in all, for anyone holding more than 20. Older records that block a payment hash are kept 90 days, at most 1,000 per person. With the bot full, such older records go from whoever holds the most, and nobody loses their latest 20 that way. Someone holding more can lose older ones if others fill the bot with records that must stay, and then only the wallet's own lookup and refusal stop a repeat of those. An invoice lasting over 90 days is refused. Routing fees count in full toward the daily limit once they are known, and the 24 hours run from when a payment was sent. These limits are for mistakes. **Only the wallet's own limit binds if this bot or its host is compromised,** because they hold the connection string. So a spending connection needs a limit reported by the wallet, at connecting and at every payment, with no setting to turn that off. Keep it low.

**Statuses under `/payments`:**

| Status    | Meaning                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pending   | On its way, or being checked. It will not be sent again                                                                                                                        |
| Confirmed | The wallet produced the preimage of the invoice's payment hash                                                                                                                 |
| Failed    | The wallet definitely did not pay: it refused first, or nothing was sent, or it reports failure after the invoice can no longer be paid, which keeps blocking its payment hash |
| Unknown   | Checks ran out. It counts as spent and that invoice stays refused. **Refresh** can settle it, by looking only                                                                  |

States, in full: `prepared` to `sending` or `cancelled`; `sending` to `paid`, `failed` or `uncertain`; `uncertain` to `paid`, `failed` or `unknown`; `unknown` to `paid` or `failed`.

**What is and is not promised.** NIP-47 says nothing about idempotency, so **this is not exactly-once.** The bot sends at most one request for a payment, and never another while one may have succeeded: not after a timeout, a lost answer, `PAYMENT_FAILED` (NIP-47 says that may be a timeout), a restart or a disconnect. Whether that request can be carried out twice depends on the wallet and on Lightning, where paying one payment hash twice is normally refused. The `expiration` tag on the request asks a wallet that sees it late to ignore it; that too depends on the wallet. A relay cannot confirm a payment: only an answer signed by the wallet, with the preimage, counts.

**What can go wrong:**

- **The wallet does not record outgoing payments under `lookup_invoice`.** A lost answer then stays Unknown for good. Check the wallet's own history.
- **A wallet that knows an invoice in any state, even failed, is not asked to pay it.** NIP-47 lets a wallet call a timeout a failure. Check the wallet's history first; if a payment really failed, ask for a new invoice.
- **A relay refusing the request leaves it Unknown,** not retried elsewhere: it may have passed it on anyway. That can happen with a working wallet, and a lookup usually settles it.
- **No fee estimate exists in NWC.** The preview says a routing fee applies, and the result says what it was, if the wallet reports it. Only the wallet's limit bounds the fee.
- **The preview shows what the invoice says.** Its description is the payee's own words, and who it pays is shown only if the invoice names a node and the signature verifies. Without that, the wallet checks it when it pays.
- **Someone holding the person's Nostr key can do everything the person can,** including pressing Pay. The wallet's limit is what bounds that.
- **Being talked through someone else's code** connects a wallet to their account, with a spending connection too. The page warns about it, and the wallet's limit bounds the loss.
- **Another invoice with the same payment hash can only be paid again after its record has gone** (90 days, or 1,000 newer ones), the wallet does not know the hash, and the person confirms. The payee already has the money by then.
- **A state.json restored by hand forgets what was paid.** The wallet's own records are asked before paying, which catches what it knows about, but this is not a guarantee. `npm run restore` also stops old messages being acted on.
- **Disconnected during a payment:** the request is cancelled here, but it may have gone out already. The person is told, and it counts as spent.

**History belongs to one connection,** like `/invoices`. After a disconnect it cannot be seen, even if the same wallet is connected again. What was spent still counts against the limits. Records are kept 90 days, at most 200 per person. `state.json` holds the amount, payment hash, status, times, fee and wallet. **It never holds the invoice, its description or the preimage:** the invoice waits in memory, so a restart cancels what was waiting.

### Remaining limits of self-service

- **New people must share a relay with the bot.** Someone with no wallet yet does not get to choose which relays the bot connects to, so their link and code go to the bot's own `RELAYS`.
- **The overall budget for strangers can be used up.** Each stranger gets five answers an hour, but keys are free, and 120 answers an hour in all can be spent by someone using many keys. New people then wait up to an hour. People already connected are unaffected. `MAX_CONNECTIONS_TOTAL` bounds what connecting costs in the same way.
- **Turning `NWC_ENABLED` off switches off NWC connections already stored, for that run.** Nothing is deleted or revoked, in the bot or the wallet, and they work again when it is turned on. Turning `SEND_ENABLED` off does the same to spending connections. To end one for good, use `connections revoke`, and delete it in the wallet too.
- **Connected people choose relays the bot talks to.** A connected person's published inbox relays are used to reach them, so the bot connects to whatever they publish.
- **Not tried yet:** a real reverse proxy, a public deployment, or more than a few simultaneous users.

### Moving to database mode and back

Stop the bot first. Every tool below except `backup` and `connections revoke` takes the same lock as the bot and refuses to run while it does.

```sh
export SECRETS_DIR=/var/lib/anagram-lnbits-wallet-secrets
npm run keyring -- init                # creates SECRETS_DIR; store keyring.json offline now
npm run migrate -- ./wallets.json      # checks every key with LNbits; keeps menus, notification state, invoices and link times
# unset WALLETS_FILE, set SECRETS_DIR, start the bot
```

`migrate` asks LNbits about every key it would store, before it writes any wallet data. Wallets it skips anyway (disconnected earlier, or connected already) are not asked about. **An admin key stops it**, naming whose entry it is: put that wallet's invoice key in the file and run it again. A key LNbits does not confirm (LNbits unreachable, or a key it rejects) stops it too. `--unchecked` migrates those anyway, and the bot then checks them at every start, as in `wallets.json` mode. An admin key is refused either way.

`migrate` backs up `state.json` to `DATA_DIR/backups/` and leaves `wallets.json` as it is, without copying it. **Delete the original `wallets.json` once the new setup has run well:** it holds every key in the clear. Deleting a file does not reliably erase it from disks, snapshots or backups, so if a copy may have been exposed, reset that wallet's keys in LNbits as well. Earlier releases also copied `wallets.json` into `DATA_DIR/backups/pre-migrate-*/`. The bot reminds you at startup while such a copy exists: delete it too.

```sh
npm run rollback -- ./wallets-new.json # back to wallets.json mode, with what is still connected
# set WALLETS_FILE to that file and start the previous release
```

Rollback refuses connections `wallets.json` cannot express (several wallets per person, other LNbits instances); `--revoke-unrepresentable` disconnects them first. It never writes a disconnected wallet, and removes their menus and notification state. **Use the file it writes, and delete older ones:** `wallets.json` mode has no ledger, so a wallet listed in an older file is linked again.

Migrating again later skips any wallet that was disconnected, even if an older `wallets.json` still lists it, and says so. Only `--relink-disconnected` links one again, and that is a new link: its old menus stay dead.

### What a disconnect does, and what it does not

**Immediately and for good:**

- The bot stops using the wallet: its requests in progress are cancelled and its unsent replies are dropped. A reply that relays already accepted cannot be recalled; it was valid when it was made.
- Its old menus never work again, even if the same wallet is connected later (a new connection gets a new random reference), and notifications start fresh, so payments made in between are not announced.
- It does not come back through a restart, a restore, a rollback or a re-migration, unless you ask for that with `--relink-disconnected`, or put back a `wallets.json` that lists it. Replies still waiting to be sent are dropped, including after a restart or restore.
- The database row no longer holds its credential.

**Not guaranteed:** that no old copy of the encrypted credential remains. SQLite write-ahead log frames, freed pages, filesystem journals, SSD remapped blocks, swap, disk snapshots and your backups can all keep one. The bot does not claim to erase those.

**If the ledger and the database are both gone** and you run `migrate` as if for the first time, nothing remembers what was disconnected, so the wallets in the file you give it are linked, with their old menus. Use only a current file.

**What makes such copies useless:** a copy can only be read with a keyring that still holds the key that encrypted it. Rotate the key regularly (`KEY_ROTATION_DAYS`, 30 by default; the bot reminds you at startup) and retire old keys once backups made under them have aged out (`BACKUP_RETENTION_DAYS`, 30 by default). Every leftover copy is then undecryptable, about 60 days after a disconnect at those settings:

```sh
npm run keyring -- rotate              # bot stopped; new key first, then one re-encrypting transaction
npm run keyring -- retire k1           # refused while a connection or a recent backup needs it
```

**To make the old key useless everywhere right away,** reset the wallet's invoice key in LNbits. That is the only complete revocation.

Encryption at rest protects copies of the data folder. It does not protect against someone who controls the running bot or its host.

### Backups, restore and recovery

```sh
npm run backup                         # safe while the bot runs; never includes SECRETS_DIR
npm run restore -- <backup folder>     # bot stopped
```

A backup holds the database and `state.json`, which includes the bot's Nostr private key, so keep it private. A restore applies the current `revocations.log` first, so anything disconnected since the backup stays disconnected. An older `state.json` may announce payments again and does not know newer invoice requests. After a restore, messages written before it are not acted on, so relays resending them cannot create a second invoice. A restore that is refused changes nothing. After `recover-ledger`, `reset-lost-keyring` or `--lost-ledger`, backups from before it no longer restore normally, because they could hold a wallet the new ledger has never heard of. Only `--lost-ledger` takes them, with everything disconnected; make a new backup right away.

| Situation                                   | What happens                                                                                                                                                                         | What to do                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revocations.log` cannot be read            | The bot refuses to start. While running, it suspends every wallet and holds replies, losing nothing, and carries on by itself if the file can be read again (a permission slip, say) | Fix the file's permissions                                                                                                                                                                                                                                |
| `revocations.log` missing or damaged        | As above, until it is put right. A restore does nothing                                                                                                                              | `npm run connections -- recover-ledger` disconnects **everything**, so nothing disconnected can return. Link operator wallets again with `migrate --relink-disconnected`; people reconnect                                                                |
| The host is lost; you have a backup         | `restore` wants a ledger, which is never in a backup                                                                                                                                 | Put `keyring.json` back (or `npm run keyring -- init` if lost), then `npm run restore -- <backup folder> --lost-ledger`. The identity and history return with **everything** disconnected, because what was disconnected since the backup cannot be known |
| `keyring.json` lost, offline copy exists    | The bot refuses to start                                                                                                                                                             | Put the copy back                                                                                                                                                                                                                                         |
| `keyring.json` lost, no copy                | The bot refuses to start                                                                                                                                                             | `npm run connections -- reset-lost-keyring` disconnects everything under a new keyring                                                                                                                                                                    |
| A connection needs a key not in the keyring | The bot refuses to start, naming the key                                                                                                                                             | Usually the wrong keyring: check `SECRETS_DIR`                                                                                                                                                                                                            |
| One credential fails to decrypt             | That connection is disconnected and logged; the others continue                                                                                                                      | The person reconnects                                                                                                                                                                                                                                     |

To disconnect someone while the bot runs (noticed within about 2 seconds, no restart):

```sh
npm run connections -- list
npm run connections -- revoke <connection id>
```

Each person can have `MAX_CONNECTIONS_PER_USER` (5) active wallets, and one wallet can be connected to one person at a time. Switching a wallet off for an admin key lasts until the next start, as in `wallets.json` mode, where it is detected again.

## Deploy with systemd

`lnbits-wallet.service` is an example unit for a Linux server. It runs `node` directly as a dedicated user (not `DynamicUser`, because the private wallet file and `npm run review` need a fixed owner) with a strict sandbox. It has not been tested on Linux as part of this repository's checks: run `systemd-analyze security lnbits-wallet` and a test start on your system.

```sh
sudo useradd --system --home-dir /var/lib/anagram-lnbits-wallet --shell /usr/sbin/nologin anagram-wallet
sudo mkdir -p /opt/lnbits-wallet /etc/anagram-lnbits-wallet
# Copy only the committed files: never a local data/ (it holds an nsec) or node_modules.
# Run this in bot-example/lnbits-wallet inside a git checkout: there, git archive packs only this folder.
git archive HEAD | sudo tar -x -C /opt/lnbits-wallet && cd /opt/lnbits-wallet && sudo npm ci --omit=dev
# Settings: the same variables as .env.example, read by systemd as root.
sudo install -m 0600 -o root -g root .env.example /etc/anagram-lnbits-wallet/env
# Wallet links: must be private to the bot's user, or the bot refuses to start.
sudo install -m 0600 -o anagram-wallet -g anagram-wallet wallets.example.json /etc/anagram-lnbits-wallet/wallets.json
sudoedit /etc/anagram-lnbits-wallet/env /etc/anagram-lnbits-wallet/wallets.json
sudo cp lnbits-wallet.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lnbits-wallet
sudo journalctl -u lnbits-wallet -f
```

`DATA_DIR` and `WALLETS_FILE` are set by the unit; in `env` set at least `LNBITS_URL` (HTTPS). The identity, link times, dedupe markers, invoice requests, notification cursors and unsent replies live in `/var/lib/anagram-lnbits-wallet/state.json` (mode 0600). Do not put the folder under a home directory (`ProtectHome=yes`).

## Operations

**Requirements.** Node 24 or later (an older one fails at startup with a raw error about file extensions); an LNbits instance reachable over HTTPS (verified against LNbits v1.6.2 only); one invoice key per linked wallet; relays that overlap your users' DM inbox relays. The bot needs outbound HTTPS/WSS to LNbits and to relays. It needs nothing inbound, except the reverse proxy in front of the connection page if `/connect` is on.

**Run it under systemd, not in a container with a fixed process id.** The lock file records the process id, and a stale lock holding the bot's own id refuses to start.

**What a healthy start logs.**

```text
LNbits Wallet: npub1...
2 linked wallet(s).
LNbits accepted 2 of 2 wallet link(s).
Payment notifications for npub1... started; 3 recent payment(s) are the baseline and are not announced.
Profile and DM inbox published.
```

Watch for: `Switched off the wallet link ... admin key` (link the invoice key instead), `Wallet link ... not checked` (LNbits unreachable or key rejected; retried every five minutes), `Payment check ... failed` (notifications are delayed, not lost), `... needs operator review` (see below), `revocations.log ...` (wallets are suspended until it can be read) and `N deliveries pending` (relays are not accepting replies).

**Stop, restart and upgrade.** `sudo systemctl restart lnbits-wallet` is safe at any time: SIGTERM cancels LNbits requests in progress, keeps unsent replies in `state.json` and releases the lock. An invoice request cut off this way is looked up again at the next start; payments received while the bot is stopped are announced after it starts. To upgrade, stop the bot, replace `/opt/lnbits-wallet` (keep `state.json` and the files in `/etc`), run `npm ci --omit=dev` and start it again.

**Backups.** Back up `state.json` while the bot is stopped: it contains the bot's Nostr private key. Restoring an older copy keeps the identity, but anything recorded after that copy is forgotten: payments announced since then can be announced again, and invoice requests made since then are unknown to the bot (their invoices still exist in LNbits). By hand, unlike `npm run restore`, it also lets relays resend commands from the last day, though an `/invoice` over an hour old is refused.

**Changing links.** Edit `wallets.json` and restart. A removed person is no longer answered or notified, and their old messages stay unanswered if they are linked again. Linking a different wallet to someone starts a new notification baseline for it.

**Revoking or rotating a key.** Reset the wallet's keys in LNbits (the old invoice key stops working at once; checked against v1.6.2), put the new invoice key in `wallets.json` and restart. If a key leaked in a chat, the bot refused it and did not store it, but rotate it anyway.

**Invoice requests in review.** When LNbits holds something the bot cannot settle by itself, such as an invoice that does not match the request, the bot logs the request and its external id. Stop the bot, search the wallet's payments in LNbits for that external id, then run, as the bot's user:

```sh
sudo -u anagram-wallet env DATA_DIR=/var/lib/anagram-lnbits-wallet node /opt/lnbits-wallet/review.js
sudo -u anagram-wallet env DATA_DIR=/var/lib/anagram-lnbits-wallet node /opt/lnbits-wallet/review.js created <request>
```

**State file problems.** The bot refuses to start, rather than guess, if `state.json` is invalid or `process.lock` belongs to a running process. Never delete `state.json` to "fix" a start: it holds the identity and the records that prevent duplicate invoices and notifications. Restore it from a backup instead.

## Checks

```sh
npm run check   # syntax only
npm test        # full suite, about 7 minutes: test/integration.test.js runs real bot processes
```

Tests never leave this computer. `test/no-network.js` is preloaded into the test runner and every bot the tests spawn; it refuses any TCP connection or DNS lookup that is not loopback, so a default relay list or a stray URL fails the test instead of reaching a public relay. Relay tests use a local relay fixture. Temporary files go to the OS temp directory (`anagram-lnbits-wallet-test-*`): removed after a passing test, kept for inspection after a failing one.
