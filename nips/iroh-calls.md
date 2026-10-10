# Nostr + Iroh calls

Nostr authenticates peers and exchanges connection details. Iroh carries encrypted audio, video and screen streams. These are Anagram extensions, not assigned Nostr standards.

## Signalling

- Direct call controls attempt delivery to configured app relays and any known recipient inboxes. Missing inbox metadata does not prevent a call. A single relay acknowledgement is sufficient; other publish attempts continue without delaying negotiation.
- An unsigned `kind:21117` rumor travels inside a NIP-44 `kind:13` seal and NIP-59 `kind:1059` gift wrap, with one intended `p` recipient. The rumor author must match the seal signer.
- JSON uses `protocol: "anagram/iroh-call/1"`, UUID `callId`, `action` (`invite`, `ringing`, `accept`, `end`), `mode` (`audio`, `video`) and ISO `expiresAt`.
- Invites and accepts include `address: { id, relayUrl }` and `mimeType`. End controls include a reason. Signals expire within 60 seconds; future timestamps beyond 10 seconds are rejected.
- Each call creates fresh Iroh endpoints. Peers accept only the endpoint authenticated by the other's Nostr signal, exchange the call UUID over ALPN `anagram/call/1`, then exchange ready frames before sending media.

## Media

- QUIC/TLS protects transport, including through Iroh relays. Frames have a big-endian 32-bit length prefix and a 1 MiB maximum.
- Frame types: `0` audio, `1` heartbeat, `2` ready, `3` video, `4` audio reset, `5` camera off/on, `6` screen video, `7` screen off/on, `8` microphone mute state. State frames carry one byte (`0` or `1`).
- Both peers negotiate `mediaVersion: 2` for separate WebM Opus audio and VP8 video. Screen and mute-state frames additionally require mutual `screenSupported` and `muteStateSupported`. Version 1 uses combined WebM media.
- Heartbeats run every 3 seconds; 15 seconds without a frame ends the connection. Media never travels through Nostr relays.

## Group calls

- Links contain a room UUID, host pubkey, random 256-bit admission secret, inbox relay hints and expiry. The capability stays in the URL fragment; it contains no Iroh keys.
- Recipient-only controls use `anagram/iroh-room/1`: `join`, `roster`, `signal`, `leave`, `closed`, `rejected`. The host admits members and signs monotonically increasing roster revisions through the same encrypted envelopes.
- Each join has a fresh session UUID. Pair signals bind both sessions; the lower pubkey initiates. Current members form a full mesh of separately authenticated Iroh connections.
- Rooms allow six participants, expire within eight hours and end when the host leaves. Possession of the link grants admission, subject to host checks.

## Call history

Optional encrypted `kind:14` summaries carry `anagram-call`, version `1`, call UUID, mode, end reason, duration in seconds and an active flag (`0` or `1`). They contain no media or endpoint addresses and never initiate a call.
