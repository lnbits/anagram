# Private groups

Private groups use Nostr NIP-171 (currently in draft) over NIP-17, NIP-44 and NIP-59.

## Identity and membership

- Owner has a master-key created by the owner from which epoch keys are derived.
- New epochs can be triggered by the owner and automatically happen on a user removal.
- The group signs a `kind:1014` ticket for each member: one `p` member tag, one `epoch` tag and the epoch private key as content. Tickets travel inside NIP-59 gift wraps.
- Use the highest valid epoch. 
- Conflicting keys for the same epoch prevent sending until an owner resolves them.
- Owners can restore groups using the master-key.
- One owner per group is recommended. Sharing the master-key grants permanent co-owner access.
- Recovery changes try all configured relays and need one relay to save the complete update. Unavailable replicas do not block a healthy one; known conflicts still require reconciliation.
- Ordinary sending uses locally verified membership and epoch keys. An unavailable relay may hold an unseen newer change.

## Messages

- Members use the direct-message envelope and actions, addressed to the epoch public key.
- Each rumor carries `p` (epoch key), `h` (group identity), `epoch`, `invited_at` and `invitation_proof` (ticket signature).
- Receivers bind the sender to the seal, reconstruct the sender's ticket and verify the group signature. Epoch keys cannot author messages.
- Group-authored `+` / `-` announcements use `member` tags; announcements alone do not grant or revoke access.

## Pinned message

Anagram adds optional `pinned` (rumor event ID) and `pinned_created_at` (Unix timestamp hint) to the group-signed `kind:0` profile. Owners replace or clear the pin. Only the reference is public; message content remains encrypted. Clients resolve it only within that group and the history they can decrypt.

The full key derivation, recovery format and validation rules are defined in NIP-171.
