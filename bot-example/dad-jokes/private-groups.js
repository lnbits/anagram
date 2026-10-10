import { getEventHash, getPublicKey } from 'nostr-tools';
import { bytes, HEX, integer, mentions, newer, rumor, single, valid, wrap } from './runtime.js';

export function readTicket(message, seal, member) {
  const epoch = integer(single(message, 'epoch'));
  const proof = single(seal, 'invitation_proof');
  if (
    message.kind !== 1014 ||
    single(message, 'p') !== member ||
    epoch === undefined ||
    !HEX.test(message.content) ||
    JSON.stringify(message.tags) !==
      JSON.stringify([
        ['p', member],
        ['epoch', String(epoch)],
      ])
  )
    return null;
  const ticket = { ...message, sig: proof };
  if (!valid(ticket)) return null;
  try {
    const pubkey = getPublicKey(bytes(ticket.content));
    if (pubkey === ticket.pubkey || pubkey === member) return null;
    return { ticket, epoch, pubkey, conflict: false };
  } catch {
    return null;
  }
}

export function acceptTicket(bot, message, seal) {
  const incoming = readTicket(message, seal, bot.pubkey);
  if (!incoming) return;
  const group = message.pubkey;
  const previous = bot.state.groups[group];
  if (previous && incoming.epoch < previous.epoch) return;
  if (previous?.epoch === incoming.epoch) {
    if (previous.conflict) return; // Only a higher epoch can resolve a conflict.
    if (previous.ticket.content !== incoming.ticket.content) {
      previous.conflict = true;
      bot.save();
      bot.refreshPrivate(group);
      bot.log('Private group paused: conflicting epoch tickets.');
      return;
    }
    if (!newer(incoming.ticket, previous.ticket)) return;
  }
  if (!previous && Object.keys(bot.state.groups).length >= 100) return;
  bot.state.groups[group] = incoming;
  bot.save();
  bot.refreshPrivate(group);
  bot.log(`Private group joined/updated (epoch ${incoming.epoch}).`);
}

export function authorized(message, group, epoch) {
  if (
    message.pubkey === epoch.pubkey ||
    message.pubkey === group ||
    message.kind !== 14 ||
    message.sig ||
    single(message, 'p') !== epoch.pubkey ||
    single(message, 'h') !== group ||
    integer(single(message, 'epoch')) !== epoch.epoch
  )
    return false;
  const created_at = integer(single(message, 'invited_at'));
  if (created_at === undefined) return false;
  const ticket = {
    kind: 1014,
    pubkey: group,
    created_at,
    tags: [
      ['p', message.pubkey],
      ['epoch', String(epoch.epoch)],
    ],
    content: epoch.ticket.content,
    sig: single(message, 'invitation_proof'),
  };
  return valid({ ...ticket, id: getEventHash(ticket) });
}

export async function privateMessage(bot, message, group, receivingEpoch) {
  const epoch = bot.state.groups[group];
  if (
    !epoch ||
    epoch.conflict ||
    epoch.pubkey !== receivingEpoch ||
    !authorized(message, group, epoch) ||
    !mentions(message.content, bot.pubkey) ||
    !bot.shouldReply(message)
  )
    return;
  // Epoch keys must never author messages. The bot signs the seal using its own identity.
  const reply = rumor(
    bot.key,
    [
      ['p', epoch.pubkey],
      ['h', group],
      ['epoch', String(epoch.epoch)],
      ['invited_at', String(epoch.ticket.created_at)],
      ['invitation_proof', epoch.ticket.sig],
      ['e', message.id, '', 'reply'],
    ],
    bot.reply(message),
  );
  bot.queue(message, [
    {
      event: wrap(reply, bot.key, epoch.pubkey),
      relays: bot.groupRelays.get(group) ?? bot.relays,
      group,
      epoch: epoch.epoch,
    },
  ]);
}
