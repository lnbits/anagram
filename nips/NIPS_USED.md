# NIPs Used in This App

This list is based on the current app code, especially `src/stores/nostrStore.ts`, the profile/relay UI components, and the local group-chat draft docs in this repo.

## NIP-01

- Used for standard Nostr events and profile metadata.
- The app publishes and reads `kind:0` metadata for users and group identities, and it relies on normal event signing and signature verification when handling custom group tickets.

## NIP-05

- Used to resolve `name@domain` identifiers into pubkeys.
- The app accepts NIP-05 identifiers when adding contacts or group members, and stores the resolved `nip05` value in contact metadata.

## NIP-07

- Used for browser-extension login/signing.
- The app can log in through a NIP-07 extension via `NDKNip07Signer` and checks that the extension account matches the active session.

## NIP-11

- Used to inspect relay metadata.
- The relay settings/profile UI loads relay info with `fetchInfo()` and shows the returned NIP-11 details.

## NIP-17

- This is the app's main private-message transport.
- It sends and receives `kind:14` private message rumors inside gift wraps, and it also uses the same DM flow for wrapped reactions (`kind:7`) and deletions (`kind:5`).
- Group chat messages are also sent as NIP-17 DMs to the group's current epoch public key.

## NIP-19

- Used for bech32 Nostr identifiers.
- The app decodes `nsec` and `npub` inputs, and it encodes `npub` and `nprofile` values for stored/displayed contact identifiers.

## NIP-24

- Used for extra profile metadata fields on `kind:0` profiles.
- The profile editor reads and writes fields such as `display_name`, `website`, `banner`, and booleans like `bot`.
- The code also uses a `group` boolean on profiles; that part looks app-specific/draft-oriented rather than clearly standard.

## NIP-44

- Used for encryption throughout the app.
- It is used by the DM/gift-wrap pipeline, and also to self-encrypt private preferences, group identity secrets, per-contact cursor data, and the private contact-list payload.

## NIP-46

- Used for Nostr remote signing login.
- The app acts as a NIP-46 client and supports `bunker://` connection tokens and generated `nostrconnect://` pairing links.
- The NIP-46 local client key is persisted as a session token so refresh and app restart can restore the remote signer connection without storing the user's `nsec`.
- The app requests broad `sign_event`, `nip44_encrypt`, and `nip44_decrypt` permissions because private messaging, private app storage, profile updates, relay lists, and relay auth all need the active signer.

## NIP-51

- Used for private follow-set style lists.
- The app restores and publishes the user's `kind:10000` mute list with muted pubkeys stored as NIP-44-encrypted private `p` items in `content`.
- The app publishes a group-authored `kind:30000` follow set with `["d", "members"]` when a group is created and whenever the owner changes the effective group membership set.
- Group member pubkeys are stored only as NIP-44-encrypted private `p` items in `content`, and the latest event is used to restore the owner-side `group_members` snapshot for that group.

## NIP-59

- Used for gift wrapping.
- The app sends/receives `kind:1059` gift wraps and `kind:13` seals for private messaging.
- It also gift-wraps signed `kind:1014` group epoch tickets before sending them to members.

## NIP-65

- Used for relay list metadata.
- The app publishes, restores, and subscribes to relay lists using `kind:10002`.
- It uses those relay lists for the logged-in user, contacts, and groups when deciding where to read from or publish to.

## NIP-78

- Used for app-specific private storage on Nostr.
- The app uses `kind:30078` replaceable events for private preferences, group identity secrets, and per-contact cursor state.
- Those payloads are encrypted with NIP-44 before publication.

## NIP-98

- Used for HTTP authentication when registering Android push notification devices with the push gateway.
- The app signs `kind:27235` events that bind the request URL, method, and body hash to the logged-in pubkey.

## NIP-171

- This appears to be a repo-local draft/private-group scheme layered on top of NIP-17.
- The app implements `kind:1014` epoch tickets, verifies them on receipt, rotates epoch keys, stores epoch history, and routes group DMs through the current epoch public key.
