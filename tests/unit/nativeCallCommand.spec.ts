import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

// Exercise real subprocess termination outside Vite's browser module resolver.
it('bounds a hung native setup command and preserves successful output and failures', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { runCommand } from './scripts/native-calls/command.mjs';
      assert.equal(runCommand(process.execPath, ['-e', 'process.stdout.write("ready")']), 'ready');
      assert.throws(
        () => runCommand(process.execPath, ['-e', 'process.exit(7)']),
        error => error.status === 7,
      );
      assert.throws(
        () => runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 250 }),
        error => error.code === 'ETIMEDOUT',
      );
      // The watchdog must return control so the harness can write failure.json.
      assert.equal(runCommand(process.execPath, ['-e', 'process.stdout.write("after timeout")']), 'after timeout');
      `,
    ],
    { timeout: 10000 },
  );
});
