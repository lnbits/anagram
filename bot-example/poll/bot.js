import { getEventHash } from 'nostr-tools';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { BotTransport, DEFAULT_RELAYS, publishProfile as publishBotProfile } from './vendor/bot.js';
import { State, Network, now, rumor, wrap, unwrap, single, mentions } from './vendor/runtime.js';
import { directMessage } from './vendor/direct-messages.js';
import { authorized } from './vendor/private-groups.js';
import { joinPublic, parseRoom } from './vendor/public-groups.js';
import {
  BOT_CONTROL_KIND,
  COMMAND_TAG,
  parseControl,
  controlTag,
  keyboardTag,
  hasCallback,
  targetKey,
} from './vendor/botKeyboardProtocol.ts';

export const DEFAULT_PICTURE_URL =
  'https://npub1c878wu04lfqcl5avfy3p5x83ndpvedaxv0dg7pxthakq3jqdyzcs2n8avm.blossom.band/7b47ff39a7f650e152c1af49d3a6a18a4b3961a61575601e803b3a7bba95d05f.png';

export class PollBot extends BotTransport {
  constructor(options) {
    super({ ...options, name: options.name || 'Anagram Poll Bot' });
    this.state.polls ??= {};
    this.state.callbacks ??= {};
  }
  get handle() {
    // Match Anagram's composer handle for this profile, rather than its display name.
    return (
      this.name
        .trim()
        .replace(/^@+/u, '')
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9_-]+/gu, '') || this.pubkey.slice(0, 12)
    );
  }
  get help() {
    return `**Bot expects format:**\n\n@${this.handle} What should we watch?\nThe Wire\nThe Sopranos`;
  }
  response(message) {
    for (const [id, poll] of Object.entries(this.state.polls))
      if (poll.closes < now() - 86400) delete this.state.polls[id];
    let content = message.content.trim();
    // Anagram stores selected @mentions as Nostr identifiers, not display names.
    const mention = content.match(/^(?:nostr:)?(?:npub|nprofile)1\S+(?=\s|$)/i)?.[0];
    if (mention && mentions(mention, this.pubkey)) content = content.slice(mention.length).trim();
    else {
      const prefix = [`@${this.name}`, `@${this.handle}`, '@PollBot'].find(
        (name) =>
          content.slice(0, name.length).toLowerCase() === name.toLowerCase() &&
          (!content[name.length] || /\s/.test(content[name.length])),
      );
      if (prefix) content = content.slice(prefix.length).trim();
    }
    // Retain the original command for existing users; new polls need only lines.
    const command = !content.includes('\n') && content.match(/^\/poll\s+(.+)$/)?.[1];
    const parts = command
      ? command.split('|').map((s) => s.trim())
      : content.split(/\r?\n/).map((s) => s.trim());
    if (
      !parts ||
      parts.length < 3 ||
      parts.length > 9 ||
      parts.some((p) => !p || Buffer.byteLength(p) > 128) ||
      new Set(parts.slice(1)).size !== parts.length - 1
    )
      return { text: this.help, tags: [] };
    if (Object.keys(this.state.polls).length >= 100)
      return { text: 'Poll capacity reached. Try again after older polls expire.', tags: [] };
    const [question, ...options] = parts;
    const keyboard = {
      inline_keyboard: [
        ...options.map((text, i) => [{ text, callback_data: `vote:${i}`, size: 'medium' }]),
        [{ text: 'View results', callback_data: 'results', size: 'medium' }],
      ],
    };
    // Eight rows includes the results row.
    if (options.length > 7)
      keyboard.inline_keyboard.splice(0, 2, [
        ...keyboard.inline_keyboard[0],
        ...keyboard.inline_keyboard[1],
      ]);
    this.preparedPoll = {
      command: message.id,
      question,
      options,
      votes: {},
      closes: now() + 7 * 86400,
      keyboard,
    };
    return {
      text: `**${question}**`,
      quote: false,
      tags: [keyboardTag(keyboard), [COMMAND_TAG, '1', message.id]],
    };
  }
  queue(message, deliveries, reply) {
    if (reply && this.preparedPoll?.command === message.id) {
      const type = reply.kind === 9 ? 'public' : single(reply, 'h') ? 'private' : 'dm';
      const chat =
        type === 'public'
          ? single(reply, 'a')
          : type === 'private'
            ? single(reply, 'h')
            : this.pubkey;
      this.state.polls[reply.id] = {
        ...this.preparedPoll,
        target: { type, chat, root: reply.id, version: reply.id, bot: this.pubkey },
        recipient: type === 'dm' ? message.pubkey : undefined,
      };
      this.preparedPoll = undefined;
    }
    super.queue(message, deliveries);
  }
  receive(event, key, group) {
    if (group) return super.receive(event, key, group);
    this.submit(event.id, async () => {
      const opened = unwrap(event, key);
      if (!opened) return;
      if (opened.message.kind === BOT_CONTROL_KIND) await this.callback(opened.message);
      else await directMessage(this, opened.message, opened.seal);
    });
  }
  async callback(message) {
    const request = parseControl(message.tags),
      time = now();
    if (
      request?.op !== 'request' ||
      single(message, 'p') !== this.pubkey ||
      message.pubkey === this.pubkey ||
      message.content !== '' ||
      request.target.bot !== this.pubkey ||
      request.expires <= time ||
      request.expires > message.created_at + 300 ||
      message.created_at > time + 60 ||
      message.created_at < time - 300 ||
      this.state.outbox.length >= 1000
    )
      return;
    const poll = this.state.polls[request.target.root];
    if (!poll || targetKey(poll.target) !== targetKey(request.target)) return;
    let membership;
    if (poll.target.type === 'dm' && poll.recipient !== message.pubkey) return;
    if (poll.target.type === 'public') {
      const saved = this.state.rooms[poll.target.chat];
      const room = saved && parseRoom(saved.event);
      if (
        !room ||
        room.blocked.includes(message.pubkey) ||
        room.blocked.includes(this.pubkey) ||
        (room.event.pubkey !== this.pubkey && !room.trusted.includes(this.pubkey))
      )
        return;
    }
    if (poll.target.type === 'private') {
      const epoch = this.state.groups[poll.target.chat],
        proof = request.membership;
      if (
        !epoch ||
        epoch.conflict ||
        !proof ||
        proof.epoch !== epoch.epoch ||
        !authorized(
          {
            ...message,
            kind: 14,
            tags: [
              ['p', epoch.pubkey],
              ['h', poll.target.chat],
              ['epoch', String(proof.epoch)],
              ['invited_at', String(proof.invited_at)],
              ['invitation_proof', proof.invitation_proof],
            ],
          },
          poll.target.chat,
          epoch,
        )
      )
        return;
      membership = {
        epoch: epoch.epoch,
        invited_at: epoch.ticket.created_at,
        invitation_proof: epoch.ticket.sig,
      };
    }
    for (const [id, value] of Object.entries(this.state.callbacks))
      if (value.expires < time - 300) delete this.state.callbacks[id];
    const cacheKey = `${message.pubkey}:${request.id}`;
    const cached = this.state.callbacks[cacheKey];
    if (cached) {
      if (cached.fingerprint !== message.id) return;
      if (!this.state.outbox.some((item) => item.event.id === cached.delivery.event.id)) {
        this.state.outbox.push({ ...cached.delivery, queuedAt: time });
        this.save();
      }
      return;
    }
    if (Object.keys(this.state.callbacks).length >= 2000) return;
    const previous = poll.views?.[message.pubkey];
    if (!previous && Object.keys(poll.views ?? {}).length >= 10000) return;
    const keyboard = request.view
      ? previous?.id === request.view
        ? previous.keyboard
        : null
      : poll.keyboard;
    if (!hasCallback(keyboard, request.data)) return;
    if (poll.closes > time && request.data.startsWith('vote:')) {
      const option = Number(request.data.slice(5));
      if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) return;
      if (!Object.hasOwn(poll.votes, message.pubkey) && Object.keys(poll.votes).length < 10000) {
        poll.votes[message.pubkey] = option;
      }
    }
    const votes = Object.values(poll.votes);
    const text = `**${poll.question}**\n\n${poll.options.map((label, i) => `${label}: **${votes.filter((v) => v === i).length}**`).join('\n')}\n\n*${votes.length} vote(s)*`;
    const answer = {
      op: 'answer',
      id: request.id,
      target: request.target,
      expires: request.expires,
      ...(membership ? { membership } : {}),
    };
    const resultKeyboard =
      Object.hasOwn(poll.votes, message.pubkey) || poll.closes <= time
        ? { inline_keyboard: [] }
        : poll.keyboard;
    const response = {
      ...rumor(
        this.key,
        [['p', message.pubkey], controlTag(answer), keyboardTag(resultKeyboard)],
        text,
      ),
      kind: BOT_CONTROL_KIND,
    };
    response.id = getEventHash(response);
    (poll.views ??= {})[message.pubkey] = { id: response.id, keyboard: resultKeyboard };
    const relays = await this.inbox(message.pubkey);
    const delivery = { event: wrap(response, this.key, message.pubkey), relays };
    this.state.callbacks[cacheKey] = {
      expires: request.expires,
      fingerprint: message.id,
      delivery,
      response,
      user: message.pubkey,
      root: request.target.root,
    };
    // Votes, exact response ciphertext and the replay marker commit together.
    this.queue(message, [delivery]);
  }
}

export async function publishProfile(bot, { pictureURL = DEFAULT_PICTURE_URL, nip05 = '' } = {}) {
  return publishBotProfile(bot, {
    pictureURL: pictureURL || DEFAULT_PICTURE_URL,
    nip05,
    about: bot.help,
  });
}

export async function main() {
  process.umask(0o077);
  let store, bot, profileTimer;
  let publishing = false,
    closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (bot) bot.stopped = true;
    clearInterval(profileTimer);
    while (publishing) await new Promise((r) => setTimeout(r, 50));
    if (bot) await bot.close();
    else store?.close();
  };
  try {
    const cooldown = Number(process.env.COOLDOWN_SECONDS ?? 2);
    if (!Number.isFinite(cooldown) || cooldown < 0)
      throw new Error('COOLDOWN_SECONDS must be non-negative.');
    store = new State(process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)), {
      nsec: process.env.NSEC,
    });
    const net = new Network(
      (process.env.RELAYS || DEFAULT_RELAYS.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    bot = new PollBot({
      store,
      net,
      cooldown,
      name: process.env.NAME,
      onFatal: () => {
        console.error('Poll bot stopped: storage or internal error.');
        process.exitCode = 1;
        void shutdown();
      },
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await bot.start();
    const profile = async () => {
      if (publishing || closing) return;
      publishing = true;
      try {
        await publishProfile(bot, {
          pictureURL: process.env.PICTURE_URL,
          nip05: process.env.NIP05,
        });
        console.log('Profile and DM inbox published.');
        clearInterval(profileTimer);
      } catch {
        console.error(
          'Profile/inbox publication pending. Check relays and PICTURE_URL; retrying in 60s.',
        );
      } finally {
        publishing = false;
      }
    };
    profileTimer = setInterval(profile, 60000);
    void profile();
    for (const link of (process.env.PUBLIC_GROUPS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      bot.submit(`join:${link}`, async () => {
        try {
          if (!(await joinPublic(bot, link)))
            console.error('Configured public group not found; check the link and relays.');
        } catch {
          console.error('Configured public group lookup failed.');
        }
      });
    }
  } catch {
    console.error('Could not start poll bot. Check configuration, data permissions and relays.');
    process.exitCode = 1;
    await shutdown();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
