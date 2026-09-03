# Configurable mock relay

The development mock relay is a Nostr-aware WebSocket proxy for human and automated testing. It forwards traffic to a real `nostr-rs-relay`, while independently delaying or dropping connection handshakes, client requests, publish acknowledgements, events, and EOSE messages.

## Start the complete stack

From the repository root, run:

```bash
npm run dev:mock-relay
```

This starts:

- a normal relay at `ws://127.0.0.1:7000`
- the configurable mock relay at `ws://127.0.0.1:7002`

The mock relay adds 1000 ms to every WebSocket phase by default. In a second terminal, start Anagram with `npm run dev`, then add `ws://127.0.0.1:7002` in the app's relay settings.

Stop the stack with Ctrl+C or:

```bash
npm run dev:mock-relay:stop
```

The relay data volume is preserved by the stop command. To reset it, run:

```bash
docker compose -f docker-compose.mock-relay.yml down -v
```

## Configure delays

`MOCK_RELAY_DELAY_MS` is the default for every phase. A phase-specific value overrides it:

| Variable | Behavior |
| --- | --- |
| `MOCK_RELAY_DELAY_MS` | Default delay for every phase |
| `MOCK_RELAY_HANDSHAKE_DELAY_MS` | Delay before completing the browser WebSocket handshake |
| `MOCK_RELAY_REQUEST_DELAY_MS` | Delay before forwarding client messages to the real relay |
| `MOCK_RELAY_ACK_DELAY_MS` | Delay for Nostr `OK` publish acknowledgements |
| `MOCK_RELAY_EVENT_DELAY_MS` | Delay for Nostr `EVENT` messages |
| `MOCK_RELAY_EOSE_DELAY_MS` | Delay for Nostr `EOSE` messages |
| `MOCK_RELAY_OTHER_DELAY_MS` | Delay for other relay messages, including `NOTICE`, `AUTH`, `CLOSED`, and `COUNT` |
| `MOCK_RELAY_JITTER_MS` | Add a random delay between zero and this value to every delayed phase |

Examples:

```bash
MOCK_RELAY_DELAY_MS=0 MOCK_RELAY_ACK_DELAY_MS=3000 npm run dev:mock-relay
```

```bash
MOCK_RELAY_DELAY_MS=500 MOCK_RELAY_EVENT_DELAY_MS=4000 MOCK_RELAY_JITTER_MS=750 npm run dev:mock-relay
```

## Drop or hang responses

These switches simulate partial or permanent relay failures:

| Variable | Behavior |
| --- | --- |
| `MOCK_RELAY_DROP_ACKS=true` | Drop `OK` acknowledgements while still publishing upstream |
| `MOCK_RELAY_DROP_EVENTS=true` | Drop subscription events |
| `MOCK_RELAY_DROP_EOSE=true` | Keep queries waiting for EOSE |
| `MOCK_RELAY_HANG_MODE=handshake` | Accept TCP connections without completing WebSocket handshakes |
| `MOCK_RELAY_HANG_MODE=responses` | Complete connections and forward requests, but never return relay messages |
| `MOCK_RELAY_VERBOSE=true` | Log each response category and its selected delay |

## Run only the proxy

If a relay is already running, start only the proxy process:

```bash
npm run dev:mock-relay:proxy -- --target ws://127.0.0.1:7000 --delay-ms 1000
```

Command-line options override environment variables. Run the following for the complete option list:

```bash
npm run dev:mock-relay:proxy -- --help
```

While it is running, `http://127.0.0.1:7002/__mock-relay` returns the active configuration and accepted WebSocket connection count. Other HTTP requests, including NIP-11 relay information requests, are forwarded to the real relay.
