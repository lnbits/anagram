import { rumor, single, wrap } from './runtime.js';

// Personal messages and group invitations arrive in the same NIP-59 inbox.
export async function directMessage(bot, message, seal) {
  if (message.kind === 1014) return bot.privateTicket(message, seal);
  if (
    message.kind !== 14 ||
    single(message, 'p') !== bot.pubkey ||
    message.tags.some((t) => ['h', 'epoch', 'member'].includes(t[0]))
  )
    return;
  await bot.handle(message, {
    type: 'dm',
    // One conversation per sender: nobody else's messages are ever in this history.
    conversation: `dm:${message.pubkey}`,
    deliver: (text) => sendDirect(bot, message, text),
  });
}

// NIP-17 reply: a kind:14 rumor with an `e` reply tag, wrapped once for the sender and
// once for the bot itself (so the bot's other clients can show its sent messages).
export async function sendDirect(bot, message, text) {
  const relays = await bot.inbox(message.pubkey);
  const reply = rumor(
    bot.key,
    [
      ['p', message.pubkey],
      ['e', message.id, '', 'reply'],
    ],
    text,
  );
  bot.queue(message, [
    { event: wrap(reply, bot.key, message.pubkey), relays },
    { event: wrap(reply, bot.key, bot.pubkey), relays: bot.relays },
  ]);
}
