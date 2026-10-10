import { ClientEvent, type NostrEvent } from '#src/lib/nostr/client.ts';

export interface GroupMessageEpoch {
  groupPublicKey: string;
  epochNumber: number;
  epochPublicKey: string;
  epochPrivateKey: string;
}

export function singleGroupTag(tags: string[][], name: string): string | null {
  const matches = tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0].length === 2 ? matches[0][1] : null;
}

export function groupInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function groupTicketTemplate(
  epoch: GroupMessageEpoch,
  member: string,
  invitedAt: number,
) {
  return {
    pubkey: epoch.groupPublicKey,
    kind: 1014,
    created_at: invitedAt,
    content: epoch.epochPrivateKey,
    tags: [
      ['p', member],
      ['epoch', String(epoch.epochNumber)],
    ],
  };
}

export async function verifyGroupMembershipProof(
  epoch: GroupMessageEpoch,
  member: string,
  invitedAt: number,
  proof: string,
): Promise<string | null> {
  if (!Number.isSafeInteger(invitedAt) || invitedAt < 0 || !/^[0-9a-f]{128}$/.test(proof))
    return null;
  try {
    const ticket = new ClientEvent(undefined, {
      ...groupTicketTemplate(epoch, member, invitedAt),
      sig: proof,
    });
    await ticket.toNostrEvent();
    return ticket.verifySignature() ? ticket.id : null;
  } catch {
    return null;
  }
}

// The adapter authenticates the seal and binds its author to this unsigned rumor.
// Historical hydration supplies the historical epoch, never the current epoch key.
export async function verifyGroupMessage(
  rumor: Pick<NostrEvent, 'pubkey' | 'kind' | 'content' | 'tags' | 'sig'>,
  epoch: GroupMessageEpoch,
): Promise<boolean> {
  if (rumor.sig || rumor.pubkey === epoch.epochPublicKey) return false;
  if (
    singleGroupTag(rumor.tags, 'p') !== epoch.epochPublicKey ||
    singleGroupTag(rumor.tags, 'h') !== epoch.groupPublicKey ||
    groupInteger(singleGroupTag(rumor.tags, 'epoch')) !== epoch.epochNumber
  )
    return false;
  if (rumor.pubkey === epoch.groupPublicKey) {
    const members = rumor.tags.filter((tag) => tag[0] === 'member');
    return (
      rumor.kind === 14 &&
      ['+', '-'].includes(rumor.content) &&
      members.length > 0 &&
      members.every((tag) => tag.length === 2 && /^[0-9a-f]{64}$/.test(tag[1])) &&
      !rumor.tags.some((tag) => ['invited_at', 'invitation_proof'].includes(tag[0]))
    );
  }
  // Kind 5 is Anagram's wrapped deletion, subject to the same posting rights.
  if (![14, 15, 7, 5].includes(rumor.kind)) return false;
  const invitedAt = groupInteger(singleGroupTag(rumor.tags, 'invited_at'));
  const proof = singleGroupTag(rumor.tags, 'invitation_proof');
  return (
    invitedAt !== null &&
    proof !== null &&
    Boolean(await verifyGroupMembershipProof(epoch, rumor.pubkey, invitedAt, proof))
  );
}
