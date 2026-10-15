// Copied from the Ollama Bridge. Changes: passes `mentioned: true` instead of a deliver
// callback (bot.js sends replies), and sendDirect returns the reply id.
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
    // One conversation per sender: nobody else's drafts or issues are ever visible here.
    conversation: `dm:${message.pubkey}`,
    mentioned: true,
  });
}

// NIP-17 reply: a kind:14 rumor with an `e` reply tag, wrapped once for the sender and
// once for the bot itself (so the bot's other clients can show its sent messages).
// Returns the reply's rumor id, which the person's client references when replying to it.
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
  return reply.id;
}
