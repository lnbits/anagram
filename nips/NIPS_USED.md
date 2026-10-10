# NIPs used by Anagram

This is an overview of the protocols Anagram uses, not a claim of full support for every feature in each NIP.

| NIP | Used for                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| 01  | Events, signatures and basic profile metadata.                                                                             |
| 05  | Resolving `name@domain` identifiers to public keys.                                                                        |
| 07  | Browser-extension login and signing.                                                                                       |
| 11  | Displaying relay information.                                                                                              |
| 17  | Private messages, reactions, deletions and edits.                                                                          |
| 19  | `nsec`, `npub`, `nprofile` and `naddr` identifiers.                                                                        |
| 24  | Additional profile fields, such as display name, website and banner.                                                       |
| 44  | Encrypting private messages and account data.                                                                              |
| 46  | Remote signing through `bunker://` and `nostrconnect://`.                                                                  |
| 50  | Searching relay-hosted profiles and public groups.                                                                                           |
| 51  | Encrypted mute lists, private-storage relay lists and group membership lists.                                              |
| 59  | Gift-wrapping private messages and group invitations.                                                                      |
| 65  | Relay lists for users, contacts and groups.                                                                                |
| 78  | Encrypted account preferences, group secrets and recovery records.                                                         |
| B7  | Blossom uploads with signed upload authorization. The server choice stays private; Anagram does not publish a server list. |

## Chat protocol specs

- [Direct messages](../docs/direct-messages.md)
- [Private groups](../docs/private-groups.md)
- [Public groups](../docs/public-groups.md)
- [Nostr + Iroh calls](iroh-calls.md)

## Private groups: NIP-171 draft

Anagram uses the local [NIP-171 draft](nip171.md), built on NIP-17 and NIP-59. A stable group identity signs invitations (`kind:1014`), and members exchange messages through a shared epoch key. Each member's message carries a signed invitation proof that receivers verify.

Removing a member rotates the epoch key. Adding members can also rotate it to hide earlier messages. Owners manage membership and recover group keys using a 12-word recovery master and encrypted recovery records.

The `group` profile field is part of this draft.

## Public groups

Public groups use NIP-72 metadata (`kind:34550`), NIP-C7 messages/replies (`kind:9`), NIP-25 reactions, NIP-09 deletion requests, NIP-19 links and NIP-92 attachments. Edits reuse the private-group delete-and-replace flow and edit-link extension. Anagram adds trust/block tags and signed ownership-handover pointers. It does not implement NIP-72 approval moderation or NIP-29.

See [Public groups](../docs/public-groups.md) for the format and limitations.

## Other Anagram extensions

- **Group pins:** one owner-controlled message reference in the signed group profile, as described in the chat specs above. Private profiles include only the rumor ID and timestamp hint, never message text.

- **Message edits:** NIP-17 delete-and-replace messages include an `e` tag marked `edit` to link the replacement to the original.
- **Calls:** Iroh call signalling uses encrypted `kind:21117` messages; call-history messages use an `anagram-call` tag. These are application extensions, not assigned Nostr standards. See [Iroh call protocol](iroh-calls.md).
