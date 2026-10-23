# Bitcoin Price bot

A standalone Node daemon that answers Anagram messages with the current Bitcoin price. It is based on the [Dad Jokes](../dad-jokes) example, so it works in DMs, private groups and public groups, and it talks to Anagram only through Nostr relays. No Anagram installation, browser, web server or database is needed.

The folder is self-contained: its dependencies, lockfile, configuration example, Nostr helpers and [license](LICENSE) are all inside it. Copy it anywhere and run it from there.

```text
You: price
Bot: BTC: $67,123 USD

You: price EUR
Bot: BTC: €58,234 EUR
```

(The prices above are illustrative.)

## Install and run

Use **Node 24 or later**. From this folder, or from a copy of it anywhere:

```sh
npm ci
cp .env.example .env
npm start
```

On first start the bot creates a Nostr identity, prints its **npub**, publishes a **Bitcoin Price (Example Anagram Bot)** profile and advertises its DM inbox relays. Later starts reuse the same identity. No picture is published unless you set `PICTURE_URL`. Publication retries automatically if the network is unavailable.

## Nostr identity

- **Default:** the bot saves a new key in `data/state.json` on first start and reuses it.
- **Your own key:** set `NSEC=nsec1...` in `.env`. It must match the saved identity; use a different `DATA_DIR` to switch accounts.
- **Keep it private:** `state.json` contains the nsec and private-group keys. It is stored with mode `0600`, excluded from Git, and must be backed up while the bot is stopped. Run `chmod 600 .env`.

## Configure

Copy `.env.example` to `.env` and uncomment what you need. Restart to apply changes.

| Variable                       | Default                               | Meaning                                                 |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------- |
| `PRICE_URL`                    | `https://mempool.space/api/v1/prices` | Price provider. HTTPS only.                             |
| `PRICE_CACHE_SECONDS`          | `60`                                  | Seconds a price is reused: whole number, 0 to 300.      |
| `PRICE_DEFAULT_CURRENCY`       | `USD`                                 | Currency when a message names none. Checked at startup. |
| `PRICE_ALLOW_HTTP`             | unset                                 | `1` allows `http://` and private addresses (local use). |
| `RELAYS`                       | Anagram's app relays                  | Should overlap your users' relays.                      |
| `NAME`, `PICTURE_URL`, `NIP05` | see `.env.example`                    | Profile fields.                                         |
| `DATA_DIR`                     | `./data`                              | Identity, group state and delivery queue.               |
| `COOLDOWN_SECONDS`             | `5`                                   | One reply per sender per this many seconds.             |

## Use it in Anagram

- **DM:** add the printed npub as a contact and send a message such as `price`.
- **Private group:** invite the npub from Anagram's member picker. The bot accepts the invitation automatically. Mention it in the message: `price EUR @bot`.
- **Public group:** add the npub to **Trusted** in the group settings, or DM the bot the group's `naddr` link. Mention it in the message.

Use Anagram's mention picker, or paste the bot's `npub` (with or without `nostr:`). Plain `@Bitcoin Price` is only text. In groups the bot ignores every message that does not mention it.

## Commands

Commands are not case sensitive. A leading `/` or `!` and a trailing `?` are ignored, and so are mentions.

| Message                   | Reply                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `price`, `btc`, `bitcoin` | Price in `PRICE_DEFAULT_CURRENCY`                                     |
| `price EUR`, `btc JPY`    | Price in that currency                                                |
| `price XYZ`               | Says the currency is unsupported and lists those the provider returns |
| anything else             | A short help message, unless the message is a reply                   |

Supported currencies are whatever the provider returns. mempool.space currently returns USD, EUR, GBP, CAD, CHF, AUD and JPY.

Help is not sent in answer to replies, such as a reply to the bot or another bot's answer. This stops two bots that answer everything from messaging each other forever. Commands are always answered.

## Caching and provider outages

A successful price is reused for `PRICE_CACHE_SECONDS`. After that, the next command asks the provider again; concurrent commands share that one request.

If the provider fails (error, timeout, bad response):

- The bot replies with its last good price, if it is at most 5 minutes old, followed by `Stale price from N min ago: the price provider is not responding.`
- With nothing that recent, it replies `The Bitcoin price is temporarily unavailable. Please try again soon.`
- It does not ask the provider again for 10 seconds. Messages are handled one at a time, so a provider that times out delays all chats by up to 5 seconds per attempt.

`PRICE_CACHE_SECONDS` cannot exceed 300, because a cached price must never be older than the oldest price the bot will show.

`PRICE_CACHE_SECONDS=0` disables the cache: every price command makes a provider request. The per-sender cooldown does not limit many different senders, so a busy or abused bot can then exceed the provider's rate limits and get the server's IP blocked, after which users see stale or unavailable prices. Keep the default 60 seconds for public bots, and use 0 only for testing or a provider you control. The stale fallback works the same with 0: the last good price is still shown, marked as stale, for 5 minutes.

## Default currency

`PRICE_DEFAULT_CURRENCY` must be three letters. At startup the bot fetches one price and stops with an error if the provider does not offer that currency, for example `PRICE_DEFAULT_CURRENCY GBP is not offered by the price provider. Available: EUR, USD.` If the provider cannot be reached at startup, the bot logs a warning and starts anyway; a plain `price` then answers that the currency is unsupported until you fix the setting.

## Change the price provider

Set `PRICE_URL` to any HTTPS endpoint that returns a JSON object with three-letter uppercase currency codes as keys and positive numbers as values. Other keys, such as `time`, are ignored. One invalid price rejects the whole response. For a different response format, change `parsePrices()` in **price.js**.

To test against a local or self-hosted provider, set `PRICE_ALLOW_HTTP=1`. This permits plain HTTP and private addresses for the configured URL only.

## Security notes

- The provider URL comes only from your configuration. Nothing in a chat message reaches it.
- HTTPS is required by default. URLs with embedded credentials, `localhost`, `.local` names and private IP addresses are rejected unless `PRICE_ALLOW_HTTP=1`.
- The address is checked again when the connection is made, so a hostname that later resolves to a private address (DNS rebinding) is refused.
- Redirects are never followed. Any answer other than HTTP 200, a response over 64 KB (counted in bytes), or a request over 5 seconds is a failure.
- Prices must be finite numbers above zero and below 1e12. Anything else is rejected.
- Many users asking at once cause one provider request per cache period (unless `PRICE_CACHE_SECONDS=0`, see above). Failures are not retried for 10 seconds, so an outage cannot stall message handling.
- Logs never contain the provider URL, since it may hold an API token.
- Prices are informational. Do not use them to settle payments.
- All the protections of the Dad Jokes bot apply: signed and encrypted messages are verified, replies are saved before sending and retried, duplicates and old messages are ignored, and relay hints from strangers cannot reach private networks.

## Keep it running

For a Linux server, copy this folder to `/opt/bitcoin-price`, run `npm ci` there, install `bitcoin-price.service` in `/etc/systemd/system/` and adjust the Node path if needed:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now bitcoin-price
sudo journalctl -u bitcoin-price -f
```

State is saved in `/var/lib/anagram-bitcoin-price`. Run one process per data directory. Relay failures retry automatically with increasing delays.

## Make it your own

The bot is a copy of Dad Jokes with three changes. `reply()` in **bot.js** is now `async` and may return `null` to stay silent. The handlers await it before queueing a reply, and **price.js** and **commands.js** replace the joke collection. Change `priceReply()` in **commands.js** to answer something else. Keep `reply()` from throwing, because an error in a handler stops the bot. If your bot answers every message, keep it silent for replies so it cannot loop with another bot.

## Checks

```sh
npm run check   # syntax only, instant
npm test        # full suite, about two minutes
```

Tests use mocked or local providers and never contact mempool.space. They cover price parsing and validation, caching, request sharing, stale fallback, URL and private-address rules, command parsing, provider failures in DMs, private groups and public groups, and everything the Dad Jokes tests cover. When this folder is inside the Anagram repository, the optional browser test drives the real client. From the repository root, with Chromium installed:

```sh
npm run test:e2e:local -- --config bot-example/bitcoin-price/playwright.config.js
```
