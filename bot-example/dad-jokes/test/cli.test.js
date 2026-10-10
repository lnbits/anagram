import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import { now } from '../runtime.js';
import { relay, until } from './relay.js';

// Run the real executable with production defaults, substituting only local relays
// and a hosted image URL so the check never publishes a test identity to the internet.
test(
  'CLI starts, publishes, answers a DM, survives relay outages, stops on SIGTERM and restores its identity',
  { timeout: 90000 },
  async (t) => {
    const local = await relay();
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(`${cwd}data`, { recursive: true });
    const dir = mkdtempSync(`${cwd}data/cli-test-`);
    const key = generateSecretKey();
    const config = `${dir}/bot.env`;
    writeFileSync(config, `NSEC=${nip19.nsecEncode(key)}\nNAME="Custom Joke Bot"\n`, {
      mode: 0o600,
    });
    let child;
    t.after(async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      await local.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const start = async () => {
      let output = '';
      const env = { ...process.env };
      delete env.NSEC;
      delete env.NAME;
      child = spawn(process.execPath, [`--env-file=${config}`, 'bot.js'], {
        cwd,
        env: {
          ...env,
          DATA_DIR: dir,
          RELAYS: local.url,
          PICTURE_URL: 'https://example.org/dad.png',
          PUBLIC_GROUPS: '',
          NIP05: 'dad@example.org',
          COOLDOWN_SECONDS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      await until(() => output.includes('Profile and DM inbox published.'), 'CLI startup');
      assert.ok(!output.includes('nsec1'), 'private key must never be logged');
      return output.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/)[0];
    };
    const stop = async () => {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    };
    const identity = await start();
    const profile = [...local.events.values()].find((e) => e.kind === 0);
    assert.equal(identity, nip19.npubEncode(getPublicKey(key)));
    assert.equal(JSON.parse(profile.content).name, 'Custom Joke Bot');
    assert.equal(JSON.parse(profile.content).display_name, 'Custom Joke Bot');
    assert.equal(JSON.parse(profile.content).nip05, 'dad@example.org');
    const sender = generateSecretKey();
    local.emit(
      wrapEvent(
        { kind: 14, content: 'Hello daemon', created_at: now(), tags: [['p', profile.pubkey]] },
        sender,
        profile.pubkey,
      ),
    );
    await until(
      () =>
        [...local.events.values()].some((e) => {
          if (e.kind !== 1059) return false;
          try {
            const reply = unwrapEvent(e, sender);
            return reply.pubkey === profile.pubkey && reply.content.length > 0;
          } catch {
            return false;
          }
        }),
      'CLI DM response',
    );
    // Run the actual daemon through complete relay outages, including recovery of
    // messages received by the relay while the bot had no connection.
    for (let i = 0; i < 2; i++) {
      local.online = false;
      local.disconnect();
      const message = wrapEvent(
        {
          kind: 14,
          content: `During outage ${i}`,
          created_at: now(),
          tags: [['p', profile.pubkey]],
        },
        sender,
        profile.pubkey,
      );
      local.emit(message);
      const attempts = local.connections.length;
      await until(() => local.connections.length > attempts, 'daemon retry during outage');
      assert.equal(child.exitCode, null, 'relay outage must not exit the daemon');
      local.online = true;
      await until(
        () =>
          [...local.events.values()].filter((e) => {
            if (e.kind !== 1059) return false;
            try {
              return unwrapEvent(e, sender).pubkey === profile.pubkey;
            } catch {
              return false;
            }
          }).length ===
          i + 2,
        'DM reply after relay recovery',
        30000,
      );
    }
    await stop();
    writeFileSync(config, 'NAME="Custom Joke Bot"\n');
    assert.equal(await start(), identity);
    await stop();
  },
);
