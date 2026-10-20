import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { now, rumor, unwrap, wrap, sign } from '../vendor/runtime.js';
import {
  BOT_CONTROL_KIND,
  controlTag,
  keyboardFromTags,
  parseControl,
} from '../vendor/botKeyboardProtocol.ts';
import { relay, until } from './relay.js';

test(
  'standalone CLI starts, answers, records a private vote and retains its identity on restart',
  { timeout: 30000 },
  async (t) => {
    const local = await relay();
    const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-cli-'));
    const botKey = generateSecretKey();
    const owner = generateSecretKey();
    const room = sign(owner, 34550, [
      ['d', 'configured-polls'],
      ['name', 'Configured polls'],
      ['anagram-room', '1'],
      ['relay', local.url],
    ]);
    local.emit(room);
    const roomAddress = `34550:${room.pubkey}:configured-polls`;
    const config = join(dir, 'bot.env');
    writeFileSync(
      config,
      [
        `NSEC=${nip19.nsecEncode(botKey)}`,
        'NAME="Standalone poll test"',
        `DATA_DIR=${dir}`,
        `RELAYS=${local.url}`,
        'PICTURE_URL=https://example.org/poll.webp',
        'NIP05=poll@example.org',
        `PUBLIC_GROUPS=${nip19.naddrEncode({ kind: 34550, pubkey: room.pubkey, identifier: 'configured-polls', relays: [local.url] })}`,
        'COOLDOWN_SECONDS=0',
      ].join('\n'),
      { mode: 0o600 },
    );
    let child;
    let output = '';
    t.after(async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await local.close();
      rmSync(dir, { recursive: true, force: true });
    });
    async function start() {
      output = '';
      const env = { ...process.env };
      for (const name of [
        'NSEC',
        'NAME',
        'DATA_DIR',
        'RELAYS',
        'PICTURE_URL',
        'NIP05',
        'PUBLIC_GROUPS',
        'COOLDOWN_SECONDS',
      ])
        delete env[name];
      child = spawn(process.execPath, [`--env-file=${config}`, 'bot.js'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      await until(() => output.includes('Profile and DM inbox published.'), 'CLI startup');
      assert.ok(!output.includes('nsec1'), 'startup must not log secret keys');
      return output.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/)[0];
    }
    async function stop() {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    }
    const identity = await start();
    await until(() => [...local.events.values()].some((e) => e.kind === 0), 'profile publication');
    const profile = [...local.events.values()].find((e) => e.kind === 0);
    const bot = profile.pubkey;
    assert.equal(bot, getPublicKey(botKey));
    const metadata = JSON.parse(profile.content);
    assert.equal(metadata.name, 'Standalone poll test');
    assert.equal(metadata.display_name, 'Standalone poll test');
    assert.equal(metadata.picture, 'https://example.org/poll.webp');
    assert.equal(metadata.nip05, 'poll@example.org');
    assert.equal(metadata.bot, true);
    assert.match(metadata.about, /Bot expects format:/);
    assert.match(metadata.about, /@Standalonepolltest What should we watch\?/);
    const inbox = [...local.events.values()].find((e) => e.kind === 10050);
    assert.deepEqual(inbox.tags, [['relay', local.url]]);
    await until(
      () =>
        [...local.subscriptions.values()].some((subs) =>
          [...subs.values()].some((filters) => filters.some((f) => f['#a']?.includes(roomAddress))),
        ),
      'PUBLIC_GROUPS subscription',
    );
    const replies = (key) =>
      [...local.events.values()]
        .map((event) => unwrap(event, key)?.message)
        .filter((event) => event?.pubkey === bot);
    const helpUser = generateSecretKey();
    local.emit(wrap(rumor(helpUser, [['p', bot]], '@PollBot'), helpUser, bot));
    await until(
      () => replies(helpUser).some((e) => e.content.startsWith('**Bot expects format:**')),
      'format help',
    );
    assert.equal(
      replies(helpUser).find((e) => e.content.startsWith('**Bot expects format:**')).content,
      '**Bot expects format:**\n\n@Standalonepolltest What should we watch?\nThe Wire\nThe Sopranos',
    );
    const user = helpUser;
    local.emit(
      wrap(rumor(user, [['p', bot]], 'What should we watch?\nThe Wire\nThe Sopranos'), user, bot),
    );
    await until(() => replies(user).some((e) => keyboardFromTags(e.tags)), 'poll keyboard');
    const card = replies(user).find((e) => keyboardFromTags(e.tags));
    const request = {
      ...rumor(
        user,
        [
          ['p', bot],
          controlTag({
            op: 'request',
            id: 'a'.repeat(32),
            expires: now() + 300,
            data: 'vote:0',
            target: { type: 'dm', chat: bot, root: card.id, version: card.id, bot },
          }),
        ],
        '',
      ),
      kind: BOT_CONTROL_KIND,
    };
    request.id = getEventHash(request);
    local.emit(wrap(request, user, bot));
    await until(
      () => replies(user).some((e) => e.kind === BOT_CONTROL_KIND),
      'private vote result',
    );
    const result = replies(user).find((e) => e.kind === BOT_CONTROL_KIND);
    assert.match(result.content, /The Wire: \*\*1\*\*/);
    assert.equal(result.tags.find((tag) => tag[0] === 'p')[1], getPublicKey(user));
    if (process.platform !== 'win32')
      assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
    await stop();
    assert.equal(await start(), identity);
    const refresh = {
      ...request,
      tags: [
        ['p', bot],
        controlTag({ ...parseControl(request.tags), id: 'b'.repeat(32), data: 'results' }),
      ],
    };
    refresh.id = getEventHash(refresh);
    local.emit(wrap(refresh, user, bot));
    await until(
      () =>
        replies(user).some(
          (e) => parseControl(e.tags)?.id === 'b'.repeat(32) && e.content.includes('The Wire: **1**'),
        ),
      'persisted vote after restart',
    );
    await stop();
  },
);
