import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { createBotKeyboardAccess } from '#src/stores/nostr/botKeyboardAccess.ts';
import type { BotTarget } from '#src/stores/nostr/botKeyboardProtocol.ts';
const db = vi.hoisted(() => ({
  getChatByPublicKey: vi.fn(),
  getMessageByEventIdOrEditReference: vi.fn(),
}));
vi.mock('#src/services/chatDataService.ts', () => ({ chatDataService: db }));
beforeEach(() => vi.clearAllMocks());
function setup() {
  const user = getPublicKey(generateSecretKey()),
    bot = getPublicKey(generateSecretKey());
  const group = generateSecretKey(),
    epoch = generateSecretKey();
  const key = Buffer.from(epoch).toString('hex');
  const ticket = (member: string) =>
    finalizeEvent(
      {
        kind: 1014,
        created_at: 1700000000,
        content: key,
        tags: [
          ['p', member],
          ['epoch', '3'],
        ],
      },
      group,
    );
  const mine = ticket(user),
    theirs = ticket(bot);
  const membership = { epoch: 3, invited_at: theirs.created_at, invitation_proof: theirs.sig };
  const entry = {
    epoch_number: 3,
    epoch_public_key: getPublicKey(epoch),
    epoch_private_key_encrypted: 'encrypted',
    invitation_proof: mine.sig,
    invitation_created_at: new Date(mine.created_at * 1000).toISOString(),
  };
  const chat = { type: 'group', meta: { group_epoch_keys: [entry], group_conflicting_epoch: -1 } };
  const target: BotTarget = {
    type: 'private',
    chat: getPublicKey(group),
    bot,
    root: 'a'.repeat(64),
    version: 'b'.repeat(64),
  };
  const keyboard = { inline_keyboard: [[{ text: 'Vote', callback_data: 'vote' }]] };
  const row = {
    chat_public_key: target.chat,
    author_public_key: bot,
    meta: { inline_keyboard: keyboard, inline_keyboard_version: target.version } as Record<
      string,
      unknown
    >,
  };
  db.getChatByPublicKey.mockResolvedValue(chat);
  db.getMessageByEventIdOrEditReference.mockResolvedValue(row);
  const access = createBotKeyboardAccess({
    account: () => user,
    blocked: () => false,
    decrypt: async () => key,
    derivePublicKey: () => getPublicKey(epoch),
    publicKeyboard: vi.fn(),
    issueOwnInvitation: async () => null,
  });
  return { access, target, chat, row, membership, mine, keyboard };
}
it('checks both current group tickets without including the epoch key in a request', async () => {
  const s = setup();
  const result = await s.access(s.target, s.membership);
  expect(result.keyboard).toEqual(s.keyboard);
  expect(result.membership).toEqual({
    epoch: 3,
    invited_at: s.mine.created_at,
    invitation_proof: s.mine.sig,
  });
  expect(Object.keys(result.membership!)).toEqual(['epoch', 'invited_at', 'invitation_proof']);
});
it('rejects forged, wrong-member, stale and conflicting epoch proofs', async () => {
  const s = setup();
  await expect(
    s.access(s.target, { ...s.membership, invitation_proof: 'f'.repeat(128) }),
  ).rejects.toThrow('member');
  await expect(
    s.access(s.target, { ...s.membership, invitation_proof: s.mine.sig }),
  ).rejects.toThrow('member');
  await expect(s.access(s.target, { ...s.membership, epoch: 2 })).rejects.toThrow('member');
  s.chat.meta.group_conflicting_epoch = 3;
  await expect(s.access(s.target)).rejects.toThrow('membership');
});
it('rejects edited, deleted, wrong-author and wrong-conversation source cards', async () => {
  const s = setup();
  await expect(s.access({ ...s.target, version: 'c'.repeat(64) })).rejects.toThrow('changed');
  await expect(s.access({ ...s.target, bot: 'd'.repeat(64) })).rejects.toThrow('changed');
  await expect(s.access({ ...s.target, chat: 'd'.repeat(64) })).rejects.toThrow('changed');
  s.row.meta.deleted = true;
  await expect(s.access(s.target)).rejects.toThrow('changed');
});
