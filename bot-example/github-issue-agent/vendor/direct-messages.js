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
  const relays = await bot.inbox(message.pubkey);
  const response = bot.response(message);
  const reply = rumor(
    bot.key,
    [
      ['p', message.pubkey],
      ...(response.quote === false ? [] : [['e', message.id, '', 'reply']]),
      ...response.tags,
    ],
    response.text,
  );
  bot.queue(
    message,
    [
      { event: wrap(reply, bot.key, message.pubkey), relays },
      { event: wrap(reply, bot.key, bot.pubkey), relays: bot.relays },
    ],
    reply,
  );
}
