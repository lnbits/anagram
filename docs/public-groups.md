# Public groups

Joined rooms have unread-count badges and a three-dot menu for profile refresh, thread refresh, mute, block, mark-as-read, deletion and notification opt-in. A lightweight activity subscription watches rooms outside the displayed thread; the active thread uses its existing subscription. Recent activity is deduplicated in account-specific IndexedDB, separately from history coverage, with a bounded 50-event relay catch-up request. Opening a focused room marks its received messages read. This does not scan the archive or treat a pinned message as history coverage. Android can notify for opted-in groups through its existing background listener; other clients require the app to be running.

Public groups use signed, unencrypted events on ordinary Nostr relays.

## Room

- NIP-72 `kind:34550` defines the room: `d`, `name`, `description`, optional `image`, 1–8 `relay` tags and `["anagram-room", "1"]`.
- Its address is `34550:<owner>:<d>`. NIP-19 `naddr` links carry this identity and relay hints.
- Anagram's `trusted` and `blocked` tags define client-side policy. The owner is trusted; blocking wins. Untrusted posts display as text with web links removed and no message media. Author names and profile pictures load for all displayed participants, independently of posting trust. Text-only web previews are enabled for trusted public posts; DMs and private groups never fetch web previews, regardless of media trust.

## Messages

- NIP-C7 `kind:9` messages carry one `a` room address. Replies use `q`; attachments use NIP-92 `imeta`.
- Posts and edits are limited to 4,000 UTF-16 code units.
- NIP-25 `kind:7` reactions and NIP-09 `kind:5` deletion requests reference message IDs with `e` tags. Anagram adds an `h` room hint. Deletions never target the room address and require the original author.
- Edits delete the old version and publish a replacement with the same author, room and timestamp. Anagram's `e` tag marked `edit` links versions; an ordinary `e` preserves the original ID. This extends the NIP-17 edit flow to public messages.

## Pinned message

The owner can add one `["pinned", "<kind:9 event ID>"]` tag to the signed room definition, replace it, or remove it to unpin. Clients resolve the message in that room and apply the usual edits, deletion and trust rules. This is an Anagram extension.

The pin loads early and opens in a separate preview. Opening it preserves the thread's scroll position and loaded message window; surrounding history is reached by scrolling up normally.

## Relays and ownership

- Reopening a joined room enables posting from its verified cached definition while metadata refreshes in the background. Cached blocking and media trust still apply, and newer live policy takes effect as it arrives. New rooms wait for discovery; failed refreshes retain the existing read-only fallback.
- Reads and writes use preferred room relays plus app relays. One responding relay is enough for reads, and one publish acknowledgement is enough for writes. Clients retain the newest verified room definition when a relay returns older or empty metadata; signatures prove authorship, not that a relay returned the latest policy.
- Transfers require the old owner's signed `successor` and the new owner's reciprocal `predecessor`. Historical messages keep their original addresses and authors.

Trust, blocking and transfer tags are tags used by anagram specifically. NIP-72 approval moderation and NIP-29 are not used. Anyone can read public events; client-side blocking cannot prevent publication through other clients.

## Incoming event recovery

Verified public events are journaled in the account's public-group IndexedDB before processing. Duplicate deliveries merge relay receipts, and messages and actions drain in batches of at most 64 with a yield between batches. Entries are acknowledged only after processing succeeds; a receipt arriving during processing remains pending. Reopening a room resumes its unfinished inbox without requiring the relay to resend those events. Replay does not generate live-message scroll signals.

The journal is independent of history pagination: opening a room still requests a bounded recent page, and older messages load on demand. The thread header shows connection and storage failures. Disk failures still require recovery or a refresh; a committed inbox does not protect against clearing browser storage.

History follows the private-group paging approach without key discovery or decryption: independent per-relay cursors use the shared exhaustive `HistoryPager`, advance only after real EOSE and a successful storage commit, and retain unfinished reads for retry. Each paging action schedules at most four history page requests; healthy replicas can finish without waiting for a stalled one. There is no background archive scan. Fetched messages remain in IndexedDB, with batches of at most 64 writes and at most 200 displayed messages.

The pinned message is fetched separately as soon as the room is available. A pin, reply lookup, search jump, or sparse local cache never establishes history coverage or moves a relay cursor. Paging reconciles gaps inside the visible interval as well as loading its next edge, so caches made by earlier versions can recover without clearing account data.
