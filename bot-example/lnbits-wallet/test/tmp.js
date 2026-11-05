// Temporary directories for tests: created in the OS temp directory, removed only after a
// passing test, and only when they are provably one this process created.
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const PREFIX = 'anagram-lnbits-wallet-test-';
const ROOT = realpathSync(tmpdir());
const owned = new Set();
const stacks = new WeakMap();

// Runs cleanup steps after the test, last registered first: a bot is closed before the
// directory holding its state is removed.
export function defer(t, step) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      while (stack.length) await stack.pop()();
    });
  }
  stack.push(step);
}

// A fresh directory for one test. Kept (and reported) when the test fails.
export function tempDir(t, label) {
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('Invalid temporary directory label.');
  const dir = mkdtempSync(join(ROOT, `${PREFIX}${label}-`));
  owned.add(dir);
  defer(t, () => {
    if (t.passed) removeOwned(dir);
    else t.diagnostic(`Test files kept for inspection: ${dir}`);
  });
  return dir;
}

// Refuses anything that is not exactly a directory this process created under ROOT.
export function removeOwned(dir) {
  const stat = lstatSync(dir);
  if (
    !owned.has(dir) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(dir) !== dir ||
    dirname(dir) !== ROOT ||
    !basename(dir).startsWith(PREFIX)
  )
    throw new Error(`Refusing to remove ${dir}: not a test-owned temporary directory.`);
  rmSync(dir, { recursive: true });
  owned.delete(dir);
}
