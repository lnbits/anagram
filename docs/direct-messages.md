# Direct messages

Private messages use Nostr NIP-17, NIP-44 encryption and NIP-59 gift wraps.

## Envelope

- Text is an unsigned `kind:14` rumor with a `p` recipient tag.
- The sender encrypts the rumor in a signed `kind:13` seal, then encrypts the seal in a `kind:1059` gift wrap signed with a fresh random key.
- Separate wraps go to the recipient and the sender for history. Delivery always includes configured app relays alongside known receiving relays, including NIP-17 `kind:10050` inboxes. Missing recipient relay metadata does not require a per-contact opt-in.
- Receivers verify signatures and require the rumor author to match the seal author.

## Messages

- Replies use an `e` tag marked `reply`, referencing the original rumor ID.
- Reactions use wrapped `kind:7`; deletion requests use wrapped `kind:5` with the target `e` and `k` tags. Only the original author can delete a message.
- Edits delete the previous version and send a replacement at the original timestamp. Anagram's `e` tag marked `edit` links the versions; this marker is an application extension.
- Media uses Blossom URLs and `imeta` attachment tags. The message is encrypted; uploaded files are not encrypted by Anagram.

Deletion requests cannot erase copies already held by recipients.

## Double-ratchet messages

New conversations use **Auto**: Anagram checks for an owner-signed compatible device roster and uses `nostr-double-ratchet` with clients such as Iris, otherwise NIP-17. An active Auto conversation can upgrade future messages when a compatible device appears later. Existing NIP-17 conversations retain their mode until Auto or double ratchet is explicitly selected. **Settings → Private messages** controls whether Auto prefers double ratchet; each contact's **Private messages → Messaging mode** can override it. The chat header shows the current mode, and a message's **Nostr info** shows its original mode.

Auto checks only the active conversation with a bounded device-roster subscription, and checks again on reopening it. It does not poll for every message. Once double ratchet is selected, missing capability or a failed send never silently downgrades it. Choose NIP-17 explicitly to switch future messages; reactions, edits and deletions keep the original message's protocol.

The first double-ratchet send or explicit enablement authorizes a local device using the account's existing signer, preserving the owner's known device roster. The runtime starts only when needed and resumes on subsequent visits; the existing PWA cache includes its lazy-loaded code for offline use. Device keys, ratchet state, pending ciphertext and messages are stored in IndexedDB. Pending ciphertext retries after reconnect; session discovery backfills at most 200 events per subscription interest. Clearing browser data or signing out removes this local device's keys and message history.

The integration supports direct text messages, replies, reactions, kind-1009 edits and kind-5 deletions. It uses authenticated owner identities for conversations, retains original message IDs across edits, and ignores double-ratchet group messages. Anagram's private groups and calls keep their existing protocols. Delivery/read receipts, disappearing-message settings and Iris-specific encrypted attachments are not implemented.
