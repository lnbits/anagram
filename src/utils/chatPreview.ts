import type { Chat } from '#src/types/chat.ts';
import { buildGroupMemberMentionProfiles } from '#src/utils/nostrMentions.ts';
import { formatCompactPublicKey } from '#src/utils/publicKeyText.ts';

export function resolveChatPreviewAuthorLabel(
  chat: Chat,
  loggedInPublicKey: string,
  selfLabel: string
): string {
  const authorPublicKey = chat.lastMessageAuthorPublicKey?.trim().toLowerCase() ?? '';
  if (!authorPublicKey || !chat.lastMessage.trim()) {
    return '';
  }

  if (authorPublicKey === loggedInPublicKey.trim().toLowerCase()) {
    return selfLabel.trim();
  }

  if (chat.type !== 'group') {
    return '';
  }

  const memberProfile = buildGroupMemberMentionProfiles(chat.meta).find(
    (profile) => profile.publicKey === authorPublicKey
  );
  return memberProfile?.displayName.trim() || formatCompactPublicKey(authorPublicKey);
}
