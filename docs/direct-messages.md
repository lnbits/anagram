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
- Older media messages use Blossom URLs and `imeta` attachment tags on `kind:14`; those files are not encrypted. They keep rendering.

## Private media

- Images, video and audio are sent as `kind:15` file messages, in direct chats and groups alike. Allowed types, up to 20 MiB each: JPEG, PNG, GIF, WebP and AVIF images; MP4, MOV (QuickTime) and WebM video; MP3, MP4/AAC, Ogg, WebM, WAV and FLAC audio. SVG is never encrypted or rendered inline.
- The file is encrypted on the device with AES-256-GCM, with a fresh random 32-byte key and 12-byte nonce per encryption. Only the ciphertext is uploaded, as `application/octet-stream`, in a single PUT to the encrypted-media Blossom server (default `https://blossom.ditto.pub`). That server is chosen separately from the regular Blossom server and stored in the encrypted NIP-78 preferences. The returned hash must match the ciphertext and the blob URL must use HTTPS.
- The rumor content is the HTTPS blob URL. Tags: `file-type` (plaintext MIME type), `encryption-algorithm` (`aes-gcm`), `decryption-key` and `decryption-nonce` (lowercase hex), `x` (SHA-256 of the ciphertext), `ox` (SHA-256 of the original file) and `size` (ciphertext bytes). The key and nonce exist only inside the gift-wrapped rumor; the message-info view hides them. File metadata such as EXIF is encrypted with the file, not stripped.
- A failed upload names its cause (network, authorization, payment, size, file type, server, invalid response or hash mismatch) and offers Retry and Change server, which re-send the same ciphertext, key and nonce, Send without encryption, and Cancel. Nothing is retried or downgraded automatically. A server chosen during a retry is saved only after the `kind:15` message was sent.
- Media is only uploaded without encryption after the user chooses Send without encryption, for a failed upload or for a file type that cannot be encrypted (such as HEIC). A confirmation explains that the Blossom operator and anyone with the URL may see the file; "Don't ask again" skips only that confirmation and can be reset in Settings > Media & Data Storage. The original file then goes to the regular Blossom server and is sent as a `kind:14` message with an `imeta` tag, like other unencrypted media.
- Uploading needs explicit confirmation for picked, pasted and dropped media. Cancelling uploads nothing.
- An upload belongs to the account and chat it was chosen in. Switching chat, logging out or closing the chat view cancels it and drops the key; nothing is signed, sent or saved for a different account or chat, and a late result is discarded.
- Captions are not supported: the `kind:15` content is the blob URL, so the media is sent as its own message. Text in the composer is not included and stays in the draft to be sent as a separate message.
- Received `kind:15` rumors need a valid algorithm, 32-byte key, nonce (12 or 16 bytes), `file-type`, `x` and HTTPS URL; anything else is dropped and never shown as a link. Downloads are capped at the type's size limit plus the GCM tag, must match `x` before decryption, and a GCM authentication failure is a hard error. Supported media is rendered from a `blob:` URL typed with the allowlisted MIME type.
- Encrypted media follows the media trust setting: for the user's own messages and trusted senders it is decrypted once near the viewport; for others nothing is downloaded until the user chooses to load media.
- Reactions, deletions, relay retries and outbound replay treat `kind:15` like `kind:14`. `kind:15` messages are never edited. Forwarding re-sends the same URL, key and nonce in a new `kind:15` rumor without re-uploading. Clients that only understand `kind:14` do not show `kind:15` messages.

Deletion requests cannot erase copies already held by recipients.
