import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('collects expensive native-call diagnostics only on failure and preserves the error', () => {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import check from 'node:assert/strict';
    import { assert } from './scripts/native-calls/assert.mjs';
    let reads = 0;
    const snapshot = () => { reads++; return 'Decoded audio went silent: sample'; };
    for (let player = 0; player < 24; player++) assert(true, snapshot);
    check.equal(reads, 0);
    check.throws(() => assert(false, snapshot), { message: 'Decoded audio went silent: sample' });
    check.equal(reads, 1);
    check.throws(() => assert(false, 'A media lane disappeared'), { message: 'A media lane disappeared' });
    `,
  ]);
});
