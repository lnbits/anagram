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
