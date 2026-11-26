import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // Mock price provider: the daemon is run with PRICE_URL pointing here, never at mempool.space.
    const provider = createServer((request, response) => response.end('{"USD":67123}'));
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const price = { url: `http://127.0.0.1:${provider.address().port}/prices` };
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(`${cwd}data`, { recursive: true });
    const dir = mkdtempSync(`${cwd}data/cli-test-`);
    const key = generateSecretKey();
    const config = `${dir}/bot.env`;
    writeFileSync(config, `NSEC=${nip19.nsecEncode(key)}\nNAME="Custom Price Bot"\n`, {
      mode: 0o600,
    });
    let child;
    t.after(async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      await local.close();
      provider.closeAllConnections();
      provider.close();
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
          PICTURE_URL: 'https://example.org/btc.png',
          PRICE_URL: price.url,
          PRICE_ALLOW_HTTP: '1',
          PUBLIC_GROUPS: '',
          NIP05: 'btc@example.org',
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
    assert.equal(JSON.parse(profile.content).name, 'Custom Price Bot');
    assert.equal(JSON.parse(profile.content).display_name, 'Custom Price Bot');
    assert.equal(JSON.parse(profile.content).nip05, 'btc@example.org');
    const sender = generateSecretKey();
    local.emit(
      wrapEvent(
        { kind: 14, content: 'price', created_at: now(), tags: [['p', profile.pubkey]] },
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
            return reply.pubkey === profile.pubkey && reply.content === 'BTC: $67,123 USD';
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
    writeFileSync(config, 'NAME="Custom Price Bot"\n');
    assert.equal(await start(), identity);
    await stop();
  },
);

test('CLI refuses invalid price settings at startup', async (t) => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'price-bot-config-'));
  const provider = createServer((request, response) => response.end('{"USD":67123,"EUR":58234}'));
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const local = {
    PRICE_URL: `http://127.0.0.1:${provider.address().port}/prices`,
    PRICE_ALLOW_HTTP: '1',
  };
  const cache = /PRICE_CACHE_SECONDS must be a whole number from 0 to 300\./;
  const cases = [
    [{ PRICE_CACHE_SECONDS: '3600' }, cache],
    [{ PRICE_CACHE_SECONDS: '301' }, cache],
    [{ PRICE_CACHE_SECONDS: 'abc' }, cache],
    [{ PRICE_DEFAULT_CURRENCY: 'euro' }, /PRICE_DEFAULT_CURRENCY must be a three-letter code\./],
    [
      { ...local, PRICE_DEFAULT_CURRENCY: 'GBP' },
      /PRICE_DEFAULT_CURRENCY GBP is not offered by the price provider\. Available: EUR, USD\./,
    ],
  ];
  const env = { ...process.env };
  delete env.NSEC;
  delete env.PRICE_URL;
  delete env.PRICE_ALLOW_HTTP;
  delete env.PRICE_CACHE_SECONDS;
  delete env.PRICE_DEFAULT_CURRENCY;
  for (const [settings, message] of cases) {
    let output = '';
    const child = spawn(process.execPath, ['bot.js'], {
      cwd,
      // Unreachable relay: configuration fails before any connection is attempted.
      env: { ...env, DATA_DIR: dir, RELAYS: 'wss://127.0.0.1:9', ...settings },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, JSON.stringify(settings));
    assert.match(output, message, JSON.stringify(settings));
    assert.ok(!output.includes('nsec1'), 'private key must never be logged');
  }
});
