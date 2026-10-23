// User-facing text. Nothing here includes tokens, URLs of the bot's services, stack traces
// or configuration beyond the repositories a user may use.
import { nip19 } from 'nostr-tools';
import { footer } from './drafting.js';

const date = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const hours = (ms) => Math.max(1, Math.round(ms / 3600000));

export function helpText({ repos, showRepos, group }) {
  return [
    'I turn your requests into GitHub issue drafts. Nothing is published until you send /confirm with the draft code.',
    '',
    'Commands:',
    '/new owner/repo <description> — draft a new issue',
    '/drafts — your drafts in this conversation',
    '/edit CODE <instructions> — change a draft (or reply to the draft message)',
    '/confirm CODE — publish a draft to GitHub',
    '/cancel CODE — delete a draft',
    '/issues — the 10 most recent issues created in this conversation',
    '/who AG-XXXX — who requested an issue, and where it is',
    '/help — this message',
    '',
    'You can also just write, for example: "create an issue in owner/repo about the login bug".',
    group
      ? 'In groups, mention me or reply to my messages. Answers here are visible to the whole group.'
      : '',
    showRepos && repos.length ? `Your repositories: ${repos.join(', ')}` : '',
  ]
    .filter((line, i, all) => line || (all[i - 1] && all[i + 1]))
    .join('\n')
    .trim();
}

export function formatDraft(draft, { now = Date.now(), revised = false } = {}) {
  const lines = [
    `${revised ? 'Updated draft' : 'Draft'} ${draft.ref} for ${draft.repo} — code ${draft.code}`,
    '',
    `Title: ${draft.title}`,
    '',
    draft.body || '(no description)',
    '',
    footer(draft.ref),
  ];
  if (draft.warnings?.length) lines.push('', ...draft.warnings.map((w) => `⚠️ ${w}`));
  if (draft.similar?.length) {
    lines.push('', '⚠️ Possible duplicates (check before confirming):');
    for (const item of draft.similar) lines.push(`• ${item}`);
  }
  if (draft.missing?.length) {
    lines.push('', 'Useful details you could add:');
    for (const item of draft.missing) lines.push(`• ${item}`);
  }
  lines.push(
    '',
    `/confirm ${draft.code} — publish this issue to ${draft.repo}`,
    `/edit ${draft.code} <changes> — or reply to this message with the changes`,
    `/cancel ${draft.code} — delete this draft`,
    `Expires in ${hours(draft.expiresAt - now)} hours.`,
  );
  return lines.join('\n');
}

export function draftList(drafts, now = Date.now()) {
  if (!drafts.length) return 'You have no drafts in this conversation.';
  return [
    'Your drafts in this conversation:',
    ...drafts.map(
      (d) =>
        `• ${d.code} — ${d.ref} ${d.repo}: ${d.title}${d.publishing ? ' (publishing)' : d.editing ? ' (being edited)' : ` (expires in ${hours(d.expiresAt - now)} h)`}`,
    ),
  ].join('\n');
}

const STATUS = {
  publishing: 'being published',
  published: 'published',
  failed: 'not published',
  review: 'outcome uncertain, waiting for the bot operator',
};

export function issueLine(r) {
  const where =
    r.state === 'published' ? `${r.repo}#${r.number} ${r.url}` : `${r.repo} (${STATUS[r.state]})`;
  return `• ${r.ref} ${where} — ${r.title} (${date(r.createdAt)})`;
}

export function issueList(records) {
  if (!records.length) return 'No issues have been created in this conversation yet.';
  return ['Issues created in this conversation, newest first:', ...records.map(issueLine)].join(
    '\n',
  );
}

export function whoText(r) {
  return [
    `${r.ref}: ${r.state === 'published' ? `${r.repo}#${r.number} ${r.url}` : `${r.repo}, ${STATUS[r.state]}`}`,
    `Title: ${r.title}`,
    `Requested by ${nip19.npubEncode(r.requester)} in this conversation on ${date(r.createdAt)}.`,
  ].join('\n');
}

export function publishedText(r) {
  return `Published ${r.ref} as ${r.repo}#${r.number}: ${r.url}`;
}

export function reviewText(r) {
  return `I could not confirm whether ${r.ref} was created on GitHub. Please do not confirm it again: the bot operator will check and resolve it.`;
}

export function uncertainText(r) {
  return `GitHub did not answer clearly for ${r.ref}. I am checking whether the issue was created. Please do not confirm it again.`;
}

export function githubFailureText(error, r) {
  switch (error?.code) {
    case 'unauthorized':
    case 'forbidden':
      return `GitHub refused to create ${r.ref} in ${r.repo} (permission problem). The bot operator needs to check the token. The draft is still available.`;
    case 'not_found':
      return `GitHub could not find ${r.repo}, or the token cannot access it. The draft is still available.`;
    case 'rate_limited':
      return `GitHub's rate limit was reached. Nothing was published. Try /confirm ${r.code} again later.`;
    case 'validation':
      return `GitHub rejected ${r.ref} (for example, issues may be disabled in ${r.repo}). Nothing was published. The draft is still available.`;
    default:
      return `${r.ref} could not be sent to GitHub. Nothing was published. Try /confirm ${r.code} again later.`;
  }
}

export function modelFailureText(error, model) {
  switch (error?.code) {
    case 'model_not_found':
      return `The model "${model}" is not installed on the bot's Ollama server. Ask the bot operator to run: ollama pull ${model}`;
    case 'timeout':
      return 'The model took too long to answer. Please try again, perhaps with a shorter request.';
    case 'unavailable':
      return 'The AI model is not reachable right now. Please try again later.';
    case 'too_long':
      return 'The model wrote more than its length limit allows. Please try a shorter request.';
    default:
      return 'The model did not return a usable draft. Please try again or rephrase the request.';
  }
}
