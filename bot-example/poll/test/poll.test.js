import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, getEventHash, nip19 } from 'nostr-tools';
import { PollBot, publishProfile, DEFAULT_PICTURE_URL } from '../bot.js';
import { State, now, rumor, wrap, unwrap, sign } from '../vendor/runtime.js';
import { directMessage } from '../vendor/direct-messages.js';
import { acceptTicket, privateMessage } from '../vendor/private-groups.js';
import { acceptRoom, publicMessage } from '../vendor/public-groups.js';
import {
  BOT_CONTROL_KIND,
  controlTag,
  keyboardFromTags,
  commandFromTags,
  parseControl,
} from '../vendor/botKeyboardProtocol.ts';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-'));
  const store = new State(dir);
  const net = {
    configured: ['wss://relay.example/'],
    routes: () => ['wss://relay.example/'],
    query: async () => [],
    publish: async () => {},
    close() {},
    watch: () => () => {},
  };
  let bot = new PollBot({ store, net, cooldown: 0, log() {} });
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get bot() {
      return bot;
    },
    restart: async () => {
      await bot.close();
      bot = new PollBot({ store: new State(dir), net, cooldown: 0, log() {} });
    },
  };
}
function ticket(group, epoch, member) {
  return sign(
    group,
    1014,
    [
      ['p', member],
      ['epoch', '0'],
    ],
    Buffer.from(epoch).toString('hex'),
  );
}
function callback(user, bot, poll, data = 'vote:0', extra = {}) {
  const id = Buffer.from(generateSecretKey()).toString('hex').slice(0, 32);
  const request = { op: 'request', id, target: poll.target, expires: now() + 300, data, ...extra };
  const event = {
    ...rumor(user, [['p', bot.pubkey], controlTag(request)], ''),
    kind: BOT_CONTROL_KIND,
  };
  event.id = getEventHash(event);
  return event;
}
async function deliver(bot, event, user) {
  bot.receive(wrap(event, user, bot.pubkey), bot.key);
  await bot.work;
}
for (const type of ['dm', 'private', 'public']) {
  test(`${type}: keyboard, authenticated vote, private results, restart and duplicate delivery`, async (t) => {
    const fixture = setup(t),
      bot = fixture.bot;
    const user = generateSecretKey(),
      pub = getPublicKey(user),
      group = generateSecretKey(),
      epoch = generateSecretKey();
    let membership;
    const command = `Tea or coffee?\nTea\nCoffee`;
    if (type === 'dm') await directMessage(bot, rumor(user, [['p', bot.pubkey]], command), {});
    if (type === 'private') {
      const botTicket = ticket(group, epoch, bot.pubkey),
        { sig, ...inner } = botTicket;
      acceptTicket(bot, inner, { tags: [['invitation_proof', sig]] });
      const userTicket = ticket(group, epoch, pub);
      membership = {
        epoch: 0,
        invited_at: userTicket.created_at,
        invitation_proof: userTicket.sig,
      };
      await privateMessage(
        bot,
        rumor(
          user,
          [
            ['p', getPublicKey(epoch)],
            ['h', getPublicKey(group)],
            ['epoch', '0'],
            ['invited_at', String(userTicket.created_at)],
            ['invitation_proof', userTicket.sig],
          ],
          `nostr:${nip19.npubEncode(bot.pubkey)} ${command}`,
        ),
        getPublicKey(group),
        getPublicKey(epoch),
      );
    }
    if (type === 'public') {
      const room = sign(group, 34550, [
        ['d', 'polls'],
        ['name', 'Polls'],
        ['anagram-room', '1'],
        ['relay', 'wss://relay.example/'],
        ['trusted', bot.pubkey],
      ]);
      acceptRoom(bot, room, true);
      publicMessage(
        bot,
        sign(
          user,
          9,
          [
            ['a', `34550:${getPublicKey(group)}:polls`],
            ['p', bot.pubkey],
          ],
          command,
        ),
        `34550:${getPublicKey(group)}:polls`,
      );
    }
    const poll = Object.values(bot.state.polls)[0];
    assert.ok(poll);
    const delivery = bot.state.outbox[0].event;
    const card =
      type === 'public' ? delivery : unwrap(delivery, type === 'private' ? epoch : user).message;
    assert.equal(keyboardFromTags(card.tags).inline_keyboard[0][0].text, 'Tea');
    assert.equal(card.content, '**Tea or coffee?**');
    assert.equal(commandFromTags(card.tags), poll.command);
    assert.ok(!card.tags.some(([name]) => name === 'e' || name === 'q'));
    assert.ok(!card.content.includes('callback_data'));
    const request = callback(user, bot, poll, 'vote:0', membership ? { membership } : {});
    await deliver(bot, request, user);
    assert.equal(Object.keys(poll.votes).length, 1);
    const resultWrap = bot.state.outbox.at(-1).event;
    assert.equal(resultWrap.tags[0][1], pub);
    const result = unwrap(resultWrap, user).message;
    assert.equal(result.kind, BOT_CONTROL_KIND);
    assert.equal(result.content, '**Tea or coffee?**\n\nTea: **1**\nCoffee: **0**\n\n*1 vote(s)*');
    assert.equal(parseControl(result.tags).id, parseControl(request.tags).id);
    assert.deepEqual(keyboardFromTags(result.tags), { inline_keyboard: [] });
    await fixture.restart();
    await deliver(fixture.bot, request, user);
    assert.equal(JSON.stringify(fixture.bot.state.outbox.at(-1).event), JSON.stringify(resultWrap));
    const newRequest = callback(
      user,
      fixture.bot,
      poll,
      'vote:1',
      membership ? { membership } : {},
    );
    await deliver(fixture.bot, newRequest, user);
    const repeat = unwrap(fixture.bot.state.outbox.at(-1).event, user).message;
    assert.equal(repeat.content, result.content);
    assert.equal(fixture.bot.state.polls[poll.target.root].votes[pub], 0);
    const refresh = callback(user, fixture.bot, poll, 'results', {
      ...(membership ? { membership } : {}),
    });
    await deliver(fixture.bot, refresh, user);
    assert.match(unwrap(fixture.bot.state.outbox.at(-1).event, user).message.content, /Tea: \*\*1\*\*/);
    if (type !== 'dm') {
      const voter = generateSecretKey(),
        voterPub = getPublicKey(voter);
      const voterTicket = ticket(group, epoch, voterPub);
      const voterMembership =
        type === 'private'
          ? {
              membership: {
                epoch: 0,
                invited_at: voterTicket.created_at,
                invitation_proof: voterTicket.sig,
              },
            }
          : {};
      const live = fixture.bot,
        saved = live.state.polls[poll.target.root];
      if (type === 'private') {
        await deliver(live, callback(voter, live, poll, 'vote:1', { membership }), voter);
        assert.equal(
          Object.keys(saved.votes).length,
          1,
          'another member cannot borrow the first voter ticket',
        );
      }
      await deliver(live, callback(voter, live, poll, 'vote:1', voterMembership), voter);
      assert.equal(saved.votes[voterPub], 1);
      assert.match(unwrap(live.state.outbox.at(-1).event, voter).message.content, /2 vote\(s\)/);
      assert.equal(
        unwrap(live.state.outbox.at(-1).event, user),
        null,
        'personal results are encrypted to the clicking voter',
      );
      const count = live.state.outbox.length;
      if (type === 'private') live.state.groups[poll.target.chat].conflict = true;
      else {
        const before = live.state.rooms[poll.target.chat].event;
        acceptRoom(
          live,
          sign(group, 34550, [...before.tags, ['blocked', voterPub]], '', before.created_at + 1),
        );
      }
      await deliver(live, callback(voter, live, poll, 'results', voterMembership), voter);
      assert.equal(
        live.state.outbox.length,
        count,
        'revoked or blocked membership stops callback responses',
      );
    }
  });
}
test('rejects callbacks from other DM users, altered targets, nonexistent buttons and expired requests', async (t) => {
  const { bot } = setup(t),
    user = generateSecretKey(),
    attacker = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], '/poll Choose | A | B'), {});
  const poll = Object.values(bot.state.polls)[0];
  for (const [key, request] of [
    [attacker, callback(attacker, bot, poll)],
    [user, callback(user, bot, poll, 'vote:9')],
    [
      user,
      callback(user, bot, poll, 'vote:0', { target: { ...poll.target, version: 'e'.repeat(64) } }),
    ],
    [user, callback(user, bot, poll, 'vote:0', { expires: now() - 1 })],
    [user, callback(user, bot, poll, 'vote:0', { view: 'f'.repeat(64) })],
  ])
    await deliver(bot, request, key);
  assert.deepEqual(poll.votes, {});
});

const HELP = '**Bot expects format:**\n\n@AnagramPollBot What should we watch?\nThe Wire\nThe Sopranos';
test('multiline polls accept selected mentions and DM text without changing option text', (t) => {
  const { bot } = setup(t);
  for (const prefix of [
    '',
    '@PollBot ',
    `@${bot.name} `,
    `@${bot.handle} `,
    `nostr:${nip19.npubEncode(bot.pubkey)} `,
    `${nip19.npubEncode(bot.pubkey)} `,
    `nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey, relays: [] })} `,
  ]) {
    const response = bot.response({
      id: 'creation',
      content: ` ${prefix}What should we watch?\r\n The Wire \r\n The Sopranos `,
    });
    assert.equal(bot.preparedPoll.question, 'What should we watch?');
    assert.deepEqual(bot.preparedPoll.options, ['The Wire', 'The Sopranos']);
    assert.equal(keyboardFromTags(response.tags).inline_keyboard[0][0].text, 'The Wire');
  }
  bot.response({ id: 'pipes', content: '@PollBot Which symbol?\nA | B\nC' });
  assert.deepEqual(bot.preparedPoll.options, ['A | B', 'C']);
  bot.response({
    id: 'maximum',
    content: `Choose\n${Array.from({ length: 8 }, (_, i) => i).join('\n')}`,
  });
  assert.equal(bot.preparedPoll.options.length, 8);
  bot.name = 'Movie Poll (v2)+';
  const help = bot.response({ id: 'help', content: `@${bot.name}` });
  assert.equal(
    help.text,
    '**Bot expects format:**\n\n@MoviePollv2 What should we watch?\nThe Wire\nThe Sopranos',
  );
  bot.response({ id: 'custom-name', content: help.text.split('\n\n')[1] });
  assert.equal(bot.preparedPoll.question, 'What should we watch?');
  assert.deepEqual(bot.preparedPoll.options, ['The Wire', 'The Sopranos']);
});
test('bare mentions and invalid polls return the expected format without a keyboard or poll', (t) => {
  const { bot } = setup(t);
  for (const content of [
    '@PollBot',
    `nostr:${nip19.npubEncode(bot.pubkey)}`,
    `nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey, relays: [] })}`,
    '',
    'Question only?',
    '@PollBot Question?\nOnly one option',
    '@PollBot Question?\nA\nA',
    '@PollBot Question?\nA\n\nB',
    `Question?\nA\n${'x'.repeat(129)}`,
    `Question?\nA\n${'😀'.repeat(33)}`,
    `Question?\n${Array.from({ length: 9 }, (_, i) => i).join('\n')}`,
  ]) {
    assert.deepEqual(bot.response({ id: 'invalid', content }), { text: HELP, tags: [] });
    assert.equal(bot.preparedPoll, undefined);
    assert.deepEqual(bot.state.polls, {});
  }
});

test('poll profile publishes its hosted avatar, optional NIP-05 and custom picture', async (t) => {
  const { bot } = setup(t);
  const sent = [];
  bot.net.publish = async (event) => {
    sent.push(event);
  };
  await publishProfile(bot);
  assert.equal(sent[0].kind, 10050);
  const profile = JSON.parse(sent[1].content);
  assert.equal(profile.name, bot.name);
  assert.equal(profile.display_name, bot.name);
  assert.equal(profile.picture, DEFAULT_PICTURE_URL);
  assert.equal(profile.nip05, undefined);
  assert.equal(profile.about, HELP);
  assert.equal(profile.bot, true);
  await publishProfile(bot, {
    pictureURL: 'https://example.org/poll.webp',
    nip05: ' poll@example.org ',
  });
  const custom = JSON.parse(sent[3].content);
  assert.equal(custom.picture, 'https://example.org/poll.webp');
  assert.equal(custom.nip05, 'poll@example.org');
  await assert.rejects(
    publishProfile(bot, { pictureURL: 'http://example.org/poll.webp' }),
    /HTTPS/,
  );
});
