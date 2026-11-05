// Operator tool for invoice requests whose outcome the bot could not determine ("review").
// Run it while the bot is stopped: it takes the same data-directory lock as the bot.
//
//   npm run review                       list requests that are not settled
//   npm run review -- created <request>  LNbits has an invoice with that external id
//   npm run review -- failed <request>   LNbits has no invoice with that external id
//
// Check in LNbits first: open the person's wallet, list its payments and look for the
// external id the list shows (alw-...). A resolved request no longer blocks new invoices.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { nip19 } from 'nostr-tools';
import { State } from './vendor/runtime.js';
import { externalId, Invoices, OPEN } from './invoices.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export function review(state, args, log = console.log) {
  const invoices = new Invoices(state);
  const [action, id] = args;
  if (!action) {
    const open = invoices.all.filter((r) => OPEN.includes(r.state));
    if (!open.length) return log('Nothing needs review.');
    for (const r of open)
      log(
        `${r.op}  ${r.state}  ${r.sats} sats  ${nip19.npubEncode(r.requester)}  asked ${new Date(r.createdAt * 1000).toISOString()}  external id ${externalId(r)}`,
      );
    log(
      'Only "review" requests can be resolved here; "uncertain" ones are still checked by the bot.',
    );
    return;
  }
  if (!['created', 'failed'].includes(action))
    throw new Error('Use: review [created <request> | failed <request>]');
  const record = invoices.byOp(String(id ?? '').trim());
  if (!record || record.state !== 'review')
    throw new Error(`No request in review with id ${id ?? ''}.`);
  invoices.move(record, action, { error: action === 'failed' ? 'operator' : record.error });
  log(`Request ${record.op} marked ${action}. The person can ask for new invoices again.`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let store;
  try {
    store = new State(process.env.DATA_DIR?.trim() || resolve(HERE, 'data'));
    if (review(store.data, process.argv.slice(2))) store.save();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
