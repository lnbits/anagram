import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLinuxProbeWindow } from './window.mjs';

test('window lookup recovers from transient X11 destruction and not-yet-mapped windows', async () => {
  let attempts = 0;
  const window = await findLinuxProbeWindow(42, (file, args) => {
    assert.equal(file, 'xdotool');
    assert.deepEqual(args, ['search', '--pid', '42']);
    attempts++;
    if (attempts === 1)
      throw Object.assign(new Error('X11 race'), { stderr: 'BadWindow', status: 1 });
    if (attempts === 2) throw Object.assign(new Error('not mapped'), { stderr: '', status: 1 });
    return '123\n456\n';
  });
  assert.equal(window, '456');
  assert.equal(attempts, 3);
});

test('window lookup preserves display and executable errors', async () => {
  for (const error of [
    Object.assign(new Error('display'), { status: 1, stderr: "Can't open display" }),
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      findLinuxProbeWindow(42, () => {
        attempts++;
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(attempts, 1);
  }
});

test('a permanently absent window fails within its deadline', async () => {
  await assert.rejects(
    findLinuxProbeWindow(42, () => '', 0),
    /Timed out finding native window/,
  );
});
