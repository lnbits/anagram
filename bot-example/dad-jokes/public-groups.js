import { nip19 } from 'nostr-tools';
import { HEX, mentions, newer, relayURLs, sign, single, valid } from './runtime.js';

export function roomLink(value) {
  try {
    const match = value.match(/naddr1[023456789acdefghjklmnpqrstuvwxyz]+/i);
    const decoded = nip19.decode(match?.[0] ?? value.replace(/^nostr:/, ''));
    if (
      decoded.type !== 'naddr' ||
      decoded.data.kind !== 34550 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(decoded.data.identifier)
    )
      return null;
    return {
      owner: decoded.data.pubkey,
      slug: decoded.data.identifier,
      relays: decoded.data.relays.slice(0, 8),
    };
  } catch {
    return null;
  }
}
export function parseRoom(event) {
  if (
    event.kind !== 34550 ||
    !valid(event) ||
    single(event, 'anagram-room') !== '1' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(single(event, 'd') ?? '') ||
    !single(event, 'name')?.trim()
  )
    return null;
  const relays = event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]);
  if (!relays.length || relays.length > 8) return null;
  const keys = (name) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const trusted = keys('trusted'),
    blocked = keys('blocked');
  if (
    [...trusted, ...blocked].some((key) => !HEX.test(key)) ||
    trusted.length > 1024 ||
    blocked.length > 1024
  )
    return null;
  return {
    event,
    address: `34550:${event.pubkey}:${single(event, 'd')}`,
    relays,
    trusted,
    blocked,
  };
}

export function acceptRoom(bot, event, explicit = false) {
  const room = parseRoom(event);
  if (!room) return;
  const old = bot.state.rooms[room.address];
  if (!old && !explicit && !room.trusted.includes(bot.pubkey)) return;
  if (old && !newer(event, old.event)) {
    if (explicit && !old.explicit) {
      old.explicit = true;
      bot.save();
      bot.refreshPublic(room.address);
    }
    return;
  }
  if (!old && Object.keys(bot.state.rooms).length >= 100) return;
  bot.state.rooms[room.address] = { event, explicit: explicit || old?.explicit || false };
  bot.save();
  bot.refreshPublic(room.address);
  bot.log('Public group joined/updated.');
}

export async function joinPublic(bot, link) {
  const target = roomLink(link);
  if (!target) return false;
  const events = await bot.net.query(relayURLs(target.relays, bot.relays), {
    kinds: [34550],
    authors: [target.owner],
    '#d': [target.slug],
    limit: 10,
  });
  let latest;
  for (const event of events) {
    const room = parseRoom(event);
    if (
      room &&
      event.pubkey === target.owner &&
      single(event, 'd') === target.slug &&
      newer(event, latest)
    )
      latest = event;
  }
  if (!latest) return false;
  acceptRoom(bot, latest, true);
  return true;
}

export function publicMessage(bot, event, address) {
  const saved = bot.state.rooms[address];
  const room = saved && parseRoom(saved.event);
  if (
    !room ||
    room.blocked.includes(bot.pubkey) ||
    room.blocked.includes(event.pubkey) ||
    (!saved.explicit && !room.trusted.includes(bot.pubkey)) ||
    event.kind !== 9 ||
    !valid(event) ||
    single(event, 'a') !== address ||
    !event.content ||
    event.content.length > 8000 ||
    !(
      mentions(event.content, bot.pubkey) ||
      event.tags.some((t) => t[0] === 'p' && t[1] === bot.pubkey)
    ) ||
    !bot.shouldReply(event)
  )
    return;
  const reply = sign(
    bot.key,
    9,
    [
      ['a', address],
      ['q', event.id, '', event.pubkey],
    ],
    bot.reply(event),
  );
  bot.queue(event, [{ event: reply, relays: room.relays, room: address }]);
}
