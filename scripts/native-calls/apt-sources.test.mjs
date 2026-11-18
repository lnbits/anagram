import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('apt mirror replacement preserves signatures, suites and unrelated sources in both formats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'call-sources-'));
  try {
    const source = join(directory, 'system');
    const destination = join(directory, 'copy');
    await mkdir(join(source, 'sources.list.d'), { recursive: true });
    const legacy =
      'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://us-east-2.ec2.archive.ubuntu.com/ubuntu noble main universe\n';
    const deb822 =
      'Types: deb\nURIs: https://eu-west-1.ec2.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
    const other =
      'deb http://security.ubuntu.com/ubuntu noble-security main\ndeb [signed-by=/example/key.gpg] https://packages.example.com/ubuntu noble main\n';
    await writeFile(join(source, 'sources.list'), legacy);
    await writeFile(join(source, 'sources.list.d/ubuntu.sources'), deb822);
    await writeFile(join(source, 'sources.list.d/other.list'), other);
    const run = () =>
      spawnSync(process.execPath, ['scripts/native-calls/apt-sources.mjs', source, destination], {
        encoding: 'utf8',
      });
    assert.equal(run().status, 0);
    assert.equal(
      await readFile(join(destination, 'sources.list'), 'utf8'),
      legacy.replace('http://us-east-2.ec2.archive.ubuntu.com', 'https://archive.ubuntu.com'),
    );
    assert.equal(
      await readFile(join(destination, 'sources.list.d/ubuntu.sources'), 'utf8'),
      deb822.replace('https://eu-west-1.ec2.archive.ubuntu.com', 'https://archive.ubuntu.com'),
    );
    assert.equal(await readFile(join(destination, 'sources.list.d/other.list'), 'utf8'), other);
    assert.equal(await readFile(join(source, 'sources.list'), 'utf8'), legacy);
    // Current runner images may only have deb822 source parts.
    await rm(join(source, 'sources.list'));
    assert.equal(run().status, 0);
    assert.equal(await readFile(join(destination, 'sources.list'), 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rewrites the Ubuntu runner mirror list and preserves its priorities and other sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'call-apt-mirrors-'));
  try {
    const source = join(directory, 'original');
    const destination = join(directory, 'copy');
    await mkdir(join(source, 'sources.list.d'), { recursive: true });
    const list =
      'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/ priority:1\nhttps://other.example/ubuntu/ priority:2\n';
    const entry =
      'Types: deb\nURIs: mirror+file:///etc/apt/apt-mirrors.txt\nSuites: noble\nSigned-By: /key.gpg\n';
    await writeFile(join(source, 'apt-mirrors.txt'), list);
    await writeFile(join(source, 'sources.list.d', 'ubuntu.sources'), entry);
    await writeFile(
      join(source, 'sources.list'),
      'deb mirror+file:/etc/apt/custom.txt noble main\n',
    );
    const result = spawnSync(process.execPath, [
      'scripts/native-calls/apt-sources.mjs',
      source,
      destination,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(await readFile(join(source, 'apt-mirrors.txt'), 'utf8'), list);
    assert.equal(
      await readFile(join(destination, 'apt-mirrors.txt'), 'utf8'),
      list.replace('http://us-east-2.ec2.archive.ubuntu.com', 'https://archive.ubuntu.com'),
    );
    assert.equal(
      await readFile(join(destination, 'sources.list.d', 'ubuntu.sources'), 'utf8'),
      entry.replace(
        'file:///etc/apt/apt-mirrors.txt',
        pathToFileURL(join(destination, 'apt-mirrors.txt')).href,
      ),
    );
    assert.equal(
      await readFile(join(destination, 'sources.list'), 'utf8'),
      'deb mirror+file:/etc/apt/custom.txt noble main\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
