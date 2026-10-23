import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { OllamaBridge } from '../bot.js';
import { Access } from '../access.js';
import { Conversations } from '../conversations.js';
import { OllamaClient } from '../ollama.js';
import { Network, now, sign, State, wrap } from '../runtime.js';
import { relay, until } from './relay.js';
import { chat, ollamaServer } from './ollama-server.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

test(
  'over real relay sockets and HTTP: DM, private and public groups, denial and restart',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    const ollama = await ollamaServer((request, res) =>
      chat(res, `Model says: ${request.body.messages.at(-1).content}`),
    );
    const dir = mkdtempSync(`${parent}relay-test-`);
    const user = generateSecretKey(),
      stranger = generateSecretKey(),
      owner = generateSecretKey();
    const userPubkey = getPublicKey(user),
      group = getPublicKey(owner);
    const address = `34550:${group}:public-room`;
    let bot, store;
    const start = async () => {
      store = new State(dir);
      bot = new OllamaBridge({
        store,
        net: new Network([local.url]),
        ollama: new OllamaClient({ url: ollama.url, model: 'test-model', timeoutMs: 5000 }),
        access: new Access({
          senders: [userPubkey],
          privateGroups: [group],
          publicGroups: [address],
        }),
        conversations: new Conversations(),
        log() {},
        onFatal: (error) => {
          throw error;
        },
      });
      await bot.start();
    };
    t.after(async () => {
      await bot?.close();
      await local.close();
      await ollama.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await start();
    const replies = (key) =>
      [...local.events.values()]
        .filter((e) => e.kind === 1059)
        .flatMap((event) => {
          try {
            const message = unwrapEvent(event, key);
            return message.pubkey === bot.pubkey ? [message] : [];
          } catch {
            return [];
          }
        });
    const sendDM = (key, content) =>
      local.emit(
        wrapEvent(
          { kind: 14, tags: [['p', bot.pubkey]], content, created_at: now() },
          key,
          bot.pubkey,
        ),
      );

    sendDM(stranger, 'Let me in');
    sendDM(user, 'Explain Bitcoin mining in simple terms.');
    await until(() => replies(user).length === 1, 'DM answer');
    assert.equal(replies(user)[0].content, 'Model says: Explain Bitcoin mining in simple terms.');
    assert.equal(replies(stranger).length, 0);
    assert.equal(ollama.requests.length, 1, 'the stranger never reached Ollama');

    const epochKey = generateSecretKey();
    const groupTicket = (member) =>
      sign(
        owner,
        1014,
        [
          ['p', member],
          ['epoch', '0'],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
    const { sig, ...invitation } = groupTicket(bot.pubkey);
    local.emit(wrap(invitation, owner, bot.pubkey, [['invitation_proof', sig]]));
    await until(() => store.data.groups[group]?.epoch === 0, 'private invitation');
    const proof = groupTicket(userPubkey);
    local.emit(
      wrapEvent(
        {
          kind: 14,
          created_at: now(),
          content: `nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey })} private question`,
          tags: [
            ['p', getPublicKey(epochKey)],
            ['h', group],
            ['epoch', '0'],
            ['invited_at', String(proof.created_at)],
            ['invitation_proof', proof.sig],
          ],
        },
        user,
        getPublicKey(epochKey),
      ),
    );
    await until(() => replies(epochKey).length === 1, 'private group answer');
    assert.match(
      replies(epochKey)[0].content,
      /^Model says: \[npub1\w{7}…\w{4}\] private question$/,
    );

    local.emit(
      sign(owner, 34550, [
        ['d', 'public-room'],
        ['name', 'Public room'],
        ['anagram-room', '1'],
        ['relay', local.url],
        ['trusted', bot.pubkey],
      ]),
    );
    await until(() => store.data.rooms[address], 'public join via trusted tag');
    const question = sign(
      user,
      9,
      [['a', address]],
      `${nip19.npubEncode(bot.pubkey)} public question`,
    );
    local.emit(question);
    const publicReplies = () =>
      [...local.events.values()].filter((e) => e.kind === 9 && e.pubkey === bot.pubkey);
    await until(() => publicReplies().length === 1, 'public answer');
    assert.equal(publicReplies()[0].tags.find((tag) => tag[0] === 'q')[1], question.id);

    // Restart: relays replay recent history, but nothing is answered twice.
    await bot.close();
    await start();
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(replies(user).length, 1);
    assert.equal(replies(epochKey).length, 1);
    assert.equal(publicReplies().length, 1);
    assert.equal(ollama.requests.length, 3);
    sendDM(user, 'Still there?');
    await until(() => replies(user).length === 2, 'post-restart DM answer');
    // History is in memory only, so the new prompt holds just the system prompt and question.
    assert.equal(ollama.requests.at(-1).body.messages.length, 2);
  },
);
