import { rumor, single, wrap } from './runtime.js';

// Personal messages and group invitations arrive in the same NIP-59 inbox.
export async function directMessage(bot, message, seal) {
  if (message.kind === 1014) return bot.privateTicket(message, seal);
  if (
    message.kind !== 14 ||
    single(message, 'p') !== bot.pubkey ||
    message.tags.some((t) => ['h', 'epoch', 'member'].includes(t[0])) ||
    !bot.shouldReply(message)
  )
    return;

  // Public rooms have no addressed invitation. Sharing a link is an explicit join request.
  await bot.joinPublicLinks(message.content);
  // The message is only marked as handled by bot.queue() below, after the text exists.
  const response = await bot.reply(message);
  if (response === null) return bot.skip(message);
  const relays = await bot.inbox(message.pubkey);
  const reply = rumor(
    bot.key,
    [['p', message.pubkey], ['e', message.id, '', 'reply'], ...bot.cardTags(response, message)],
    response.text,
  );
  bot.queue(
    message,
    [
      { event: wrap(reply, bot.key, message.pubkey), relays },
      { event: wrap(reply, bot.key, bot.pubkey), relays: bot.relays },
    ],
    // A DM card belongs to the person it was sent to; nobody else can press its buttons.
    response.keyboard && {
      root: reply.id,
      type: 'dm',
      chat: bot.pubkey,
      recipient: message.pubkey,
      keyboard: response.keyboard,
    },
  );
}
