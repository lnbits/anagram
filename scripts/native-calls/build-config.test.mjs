import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createBuildConfig, probeSettings, probeUrl, readBuildConfig } from './build-config.mjs';

test('compiled and runtime URLs share the same nonce and scenario', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'call-config-'));
  try {
    const path = join(directory, 'build.json');
    const settings = probeSettings(false, {
      ANAGRAM_CALL_TEST_PARTICIPANTS: '6',
      ANAGRAM_CALL_TEST_SCENARIO: 'group',
      ANAGRAM_CALL_TEST_MEDIA: 'audio',
    });
    const config = createBuildConfig(settings);
    await writeFile(path, JSON.stringify(config));
    assert.equal(probeUrl(await readBuildConfig(path, settings)), probeUrl(config));
    assert.notEqual(createBuildConfig(settings).token, config.token);
    for (const change of [
      { participants: 4 },
      { scenario: 'direct' },
      { media: 'video' },
      { browserOnly: true },
      { platform: 'different-platform' },
    ]) {
      await assert.rejects(readBuildConfig(path, { ...settings, ...change }), /rebuild first/);
    }
    await writeFile(path, JSON.stringify({ ...config, token: 'bad&token' }));
    await assert.rejects(readBuildConfig(path, settings), /rebuild first/);
    await rm(path);
    await assert.rejects(readBuildConfig(path, settings), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('participant and media validation is preserved', () => {
  assert.equal(probeSettings(false, {}).participants, 4);
  assert.equal(probeSettings(true, {}).participants, 6);
  for (const participants of ['1', '7', '3.5', 'invalid'])
    assert.throws(() => probeSettings(false, { ANAGRAM_CALL_TEST_PARTICIPANTS: participants }));
  assert.throws(() => probeSettings(false, { ANAGRAM_CALL_TEST_SCENARIO: 'invalid' }));
  assert.throws(() => probeSettings(false, { ANAGRAM_CALL_TEST_MEDIA: 'invalid' }));
});

test(
  'Linux cache hits install runtime libraries but omit media build tools',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'call-apt-'));
    try {
      const commands = join(directory, 'commands');
      await writeFile(join(directory, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMANDS"\n', {
        mode: 0o755,
      });
      for (const hit of ['', 'false', 'true']) {
        await writeFile(commands, '');
        const result = spawnSync(
          'bash',
          ['scripts/native-calls/linux-dependencies.sh', join(directory, 'cache'), hit],
          {
            env: {
              ...process.env,
              PATH: `${directory}${delimiter}${process.env.PATH}`,
              COMMANDS: commands,
            },
            encoding: 'utf8',
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const calls = (await readFile(commands, 'utf8')).trim().split('\n');
        assert.equal(calls.length, 2);
        assert.match(calls[0], / update$/);
        assert.match(calls[1], /Acquire::Retries=3/);
        assert.match(calls[1], /libavcodec60/);
        assert.match(calls[1], /libwebkit2gtk-4.1-dev/);
        assert.equal(calls[1].includes('ninja-build'), hit !== 'true');
        assert.equal(calls[1].includes('libavcodec-dev'), hit !== 'true');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'build publishes its handoff only after successful compilation',
  {
    skip: process.platform === 'win32', // Fake POSIX cargo, not a real native build.
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'call-build-'));
    try {
      const path = join(directory, 'build.json');
      const captured = join(directory, 'compiled.json');
      await writeFile(
        join(directory, 'cargo'),
        '#!/bin/sh\nprintf "%s" "$TAURI_CONFIG" > "$CAPTURED_CONFIG"\nexit "$BUILD_EXIT"\n',
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        ANAGRAM_CALL_TEST_BUILD_CONFIG: path,
        CAPTURED_CONFIG: captured,
        BUILD_EXIT: '0',
      };
      const build = () =>
        spawnSync(process.execPath, [resolve('scripts/native-calls/build.mjs')], {
          cwd: directory,
          env,
          encoding: 'utf8',
          timeout: 10000,
        });
      const result = build();
      assert.equal(result.status, 0, result.stderr);
      const config = await readBuildConfig(path, probeSettings(false, env));
      assert.equal(JSON.parse(await readFile(captured, 'utf8')).build.devUrl, probeUrl(config));
      env.BUILD_EXIT = '1';
      assert.notEqual(build().status, 0);
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
