import { chatDataService } from '#src/services/chatDataService.ts';
import { normalizeChatGroupEpochKeysValue } from '#src/utils/groupEpochMetadata.ts';
import { verifyGroupMembershipProof } from './groupMessageAuthorization.ts';
import {
  parseKeyboard,
  type BotMembership,
  type BotTarget,
  type InlineKeyboard,
} from './botKeyboardProtocol.ts';

export function createBotKeyboardAccess(deps: {
  account(): string | null;
  blocked(key: string): boolean;
  decrypt(value: string): Promise<string | null>;
  derivePublicKey(key: string): string | null;
  publicKeyboard(target: BotTarget): Promise<InlineKeyboard>;
  issueOwnInvitation(
    group: string,
    epoch: string,
  ): Promise<{ proof: string; invitedAt: number } | null>;
}) {
  return async (target: BotTarget, responseProof?: BotMembership) => {
    const owner = deps.account();
    if (!owner || deps.blocked(target.bot)) throw new Error('Bot unavailable');
    if (target.type === 'public') return { keyboard: await deps.publicKeyboard(target) };
    const [chat, row] = await Promise.all([
      chatDataService.getChatByPublicKey(target.chat),
      chatDataService.getMessageByEventIdOrEditReference(target.root),
    ]);
    const keyboard = parseKeyboard(row?.meta.inline_keyboard);
    if (
      deps.account() !== owner ||
      !chat ||
      chat.meta.deleted_locally ||
      chat.meta.inbox_state === 'blocked' ||
      chat.meta.blocked ||
      deps.blocked(target.chat) ||
      !row ||
      row.chat_public_key !== target.chat ||
      row.author_public_key !== target.bot ||
      row.meta.deleted ||
      row.meta.inline_keyboard_version !== target.version ||
      !keyboard ||
      (chat.type === 'group') !== (target.type === 'private')
    )
      throw new Error('This menu is unavailable or has changed');
    if (target.type === 'dm') {
      if (target.chat !== target.bot) throw new Error('Wrong bot conversation');
      return { keyboard };
    }
    const entries = normalizeChatGroupEpochKeysValue(chat.meta.group_epoch_keys);
    const epoch = entries[0];
    if (
      !epoch ||
      Number(chat.meta.group_conflicting_epoch ?? -1) >= epoch.epoch_number ||
      entries.some(
        (e) =>
          e.epoch_number === epoch.epoch_number && e.epoch_public_key !== epoch.epoch_public_key,
      )
    )
      throw new Error('Current group membership is required');
    const key = await deps.decrypt(epoch.epoch_private_key_encrypted);
    if (!key || deps.derivePublicKey(key) !== epoch.epoch_public_key || deps.account() !== owner)
      throw new Error('Group unavailable');
    const context = {
      groupPublicKey: target.chat,
      epochNumber: epoch.epoch_number,
      epochPublicKey: epoch.epoch_public_key,
      epochPrivateKey: key,
    };
    const invitation =
      epoch.invitation_proof && epoch.invitation_created_at
        ? {
            proof: epoch.invitation_proof,
            invitedAt: Math.floor(Date.parse(epoch.invitation_created_at) / 1000),
          }
        : await deps.issueOwnInvitation(target.chat, epoch.epoch_public_key);
    if (!invitation || deps.account() !== owner)
      throw new Error('Current group invitation is required');
    const membership = {
      epoch: epoch.epoch_number,
      invited_at: invitation.invitedAt,
      invitation_proof: invitation.proof,
    };
    if (
      !(await verifyGroupMembershipProof(
        context,
        owner,
        membership.invited_at,
        membership.invitation_proof,
      ))
    )
      throw new Error('Invalid group membership');
    if (
      responseProof &&
      (responseProof.epoch !== epoch.epoch_number ||
        !(await verifyGroupMembershipProof(
          context,
          target.bot,
          responseProof.invited_at,
          responseProof.invitation_proof,
        )))
    )
      throw new Error('Bot is no longer a current member');
    if (deps.account() !== owner) throw new Error('Account changed');
    return { keyboard, membership };
  };
}
