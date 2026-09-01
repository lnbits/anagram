# NIP-51 PR: Chat contacts list

This document is a copy-ready proposal for the
[`nostr-protocol/nips`](https://github.com/nostr-protocol/nips) repository.
It extends NIP-51 rather than creating a new NIP.

`10022` is proposed because it is currently unassigned in the NIPs event-kind
table and the official registry of kinds. Recheck the number immediately before
opening the PR and use the number chosen by the maintainers if it changes.

## Pull request title

```text
NIP-51: add chat contacts list
```

## Pull request body

```markdown
Adds a standard replaceable list for contacts a user wants to keep available
in messaging clients.

Chat contacts are distinct from the NIP-02 follow list. Saving a profile as a
messaging contact does not imply following, trust, endorsement, or interest in
that profile's public content. Reusing `kind:3` would conflate those meanings
and could cause messaging clients to replace a user's social follow list.

The proposed `kind:10022` list contains `p` items and uses NIP-51's existing
public/private item mechanism. Clients SHOULD store chat contacts as private
items by default because publishing them exposes the user's messaging social
graph. A user MAY explicitly make individual entries public.

This is a normal replaceable event, so there is one canonical chat contact list
per author and no `d` tag is needed. Relays require no behavior beyond the
replaceable-event handling defined by NIP-01.

[Nostr Chat](https://github.com/lnbits/anagram) currently uses an encrypted
`kind:30000` follow set with a client-selected `d` tag for the same purpose and
can migrate to this standard kind. During migration, clients can read both
formats, merge their entries, and publish `kind:10022` as the canonical list
without modifying the user's `kind:3` follow list.
```

## Proposed changes to `51.md`

Add this row to the **Standard lists** table, after `Media follows`:

```markdown
| Chat contacts        | 10022 | pubkeys the user wants to keep available in messaging clients   | `"p"` (pubkeys)                                                                                        |
```

Add the following subsection immediately after the Standard lists table and
before `### Sets`:

```markdown
#### Chat contacts

A `kind:10022` _chat contacts_ event contains public keys the author wants to
keep available in messaging clients. It is a saved contact list, not a history
of conversations.

Chat contacts are distinct from the [NIP-02](02.md) follow list. Clients MUST
NOT interpret inclusion in this list as a follow, trust, endorsement, or
interest signal, and MUST NOT modify the author's `kind:3` event when updating
this list.

Chat contacts use `"p"` items. As with other lists in this NIP, an item may be
public in the event's `tags` array or private in its NIP-44-encrypted
`.content`. Clients SHOULD make chat contact items private by default and MAY
publish an item publicly only when the user explicitly chooses to disclose it.

Clients MAY add a contact according to their own user-interface policy, such as
when the user explicitly saves a profile or initiates a conversation. Merely
receiving an unsolicited message does not require adding its author to this
list.
```

## Proposed change to `README.md`

Add this row to the **Event Kinds** table in numerical order:

```markdown
| `10022`       | Chat contacts list              | [51](51.md)                            |
```

## Interoperability and migration notes

- `kind:10022` is a normal replaceable event: clients fetch the latest event
  for the author and kind.
- Clients use the existing NIP-51 representation for private items: a JSON
  array of tag-shaped values encrypted with NIP-44 and stored in `.content`.
- Clients SHOULD decrypt and merge the latest list before publishing an update
  so concurrent clients do not unintentionally discard contacts.
- A legacy `kind:30000` contact set is not deleted automatically. Migration
  clients SHOULD read it only when they recognize its exact `d` identifier.
- Migration MUST NOT read from or publish to `kind:3` unless the user separately
  requests a change to their follow list.
- Unknown clients and relays remain compatible because they can ignore the new
  optional kind.

## Submission checklist

- Recheck that `10022` is still free in both the
  [NIPs event-kind table](https://github.com/nostr-protocol/nips#event-kinds)
  and the
  [registry of kinds](https://github.com/nostr-protocol/registry-of-kinds).
- Edit only `51.md` and `README.md` in the NIPs PR; recent accepted NIP-51 kind
  additions use this narrow two-file format.
- Keep the PR title and description short and explain why `kind:3` is not
  equivalent.
- Name the existing implementation and link it in the PR discussion.
- Identify a second interested client if possible. The NIPs repository's stated
  acceptance criteria prefer implementation in at least two clients and one
  relay where relay-specific behavior is applicable. This proposal requires no
  relay-specific changes.
- After the NIPs kind is accepted, submit or coordinate the corresponding entry
  in `nostr-protocol/registry-of-kinds`.

## References

- [NIP-51: Lists](https://github.com/nostr-protocol/nips/blob/master/51.md)
- [NIP-02: Follow List](https://github.com/nostr-protocol/nips/blob/master/02.md)
- [NIP-01 replaceable-event ranges](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIPs acceptance criteria](https://github.com/nostr-protocol/nips#criteria-for-acceptance-in-this-repository)
- [Official registry of kinds](https://github.com/nostr-protocol/registry-of-kinds)
- [Example merged NIP-51 kind addition: PR #1848](https://github.com/nostr-protocol/nips/pull/1848)
- [Example merged NIP-51 set addition: PR #2170](https://github.com/nostr-protocol/nips/pull/2170)
