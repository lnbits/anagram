import { execFileSync } from 'node:child_process';

// These are short setup/focus/cleanup commands. The native build uses spawn
// and its own longer deadline. A hung synchronous command would otherwise
// prevent every JavaScript watchdog and artifact write from running.
export function runCommand(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...options,
  });
}
