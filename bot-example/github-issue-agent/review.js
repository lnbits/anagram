// Operator tool for publications whose outcome the bot could not determine ("review").
// Run it while the bot is stopped: it takes the same data-directory lock as the bot.
//
//   npm run review                                   list records that need a decision
//   npm run review -- published AG-7K92 <issue URL>  the issue exists on GitHub
//   npm run review -- failed AG-7K92                 no issue was created
//
// After a decision, the bot tells the requester at its next start.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { State } from './vendor/runtime.js';
import { Issues } from './issues.js';
import { normalizeRef } from './ids.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export function review(state, args, log = console.log) {
  const issues = new Issues(state);
  const [action, rawRef, url] = args;
  if (!action) {
    const open = issues.all.filter((r) => r.state === 'review' || r.state === 'publishing');
    if (!open.length) return log('Nothing needs review.');
    for (const r of open)
      log(
        `${r.ref}  ${r.state}  ${r.repo}  "${r.title}"  attempted ${new Date(r.createdAt * 1000).toISOString()}  marker anagram-issue-agent:${r.attempt}`,
      );
    log('Search the repository for the marker (it is in the issue body), then record the result.');
    return;
  }
  const ref = normalizeRef(rawRef);
  const record = ref && issues.all.findLast((r) => r.ref === ref && r.state === 'review');
  if (!record) throw new Error(`No record in review with reference ${rawRef ?? ''}.`);
  if (action === 'published') {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url ?? '');
    if (!match || match[1].toLowerCase() !== record.repo.toLowerCase())
      throw new Error(
        `Give the issue URL in ${record.repo}, e.g. https://github.com/${record.repo}/issues/123`,
      );
    Object.assign(record, { state: 'published', number: Number(match[2]), url });
  } else if (action === 'failed') {
    record.state = 'failed';
    record.error = 'operator';
  } else throw new Error('Use: review [published REF URL | failed REF]');
  record.updatedAt = Math.floor(Date.now() / 1000);
  record.notified = false;
  log(`${record.ref} marked ${record.state}. The requester is told at the bot's next start.`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store;
  try {
    store = new State(process.env.DATA_DIR?.trim() || resolve(HERE, 'data'));
    const changed = review(store.data, process.argv.slice(2));
    if (changed) store.save();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
