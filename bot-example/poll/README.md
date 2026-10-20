# Poll bot

A standalone bot using Node 24 or later. Copy this whole folder anywhere; no Anagram installation is needed. From this folder:

```sh
npm ci
cp .env.example .env
npm start
```

It publishes its own profile and DM inbox on startup, retrying failed publication every 60 seconds. Set `PICTURE_URL` to override the hosted avatar.

Configuration: `NSEC`, `NAME`, `RELAYS`, `DATA_DIR`, `PICTURE_URL`, `NIP05`, `PUBLIC_GROUPS` and `COOLDOWN_SECONDS`. See `.env.example`. `PICTURE_URL` must use HTTPS; NIP-05 requires your domain to map the identifier to the bot's public key. The default reply cooldown is 2 seconds; `0` disables it. Votes are unaffected. Restart to apply settings.

The bot prints its public key. Mention it in a group, with the question on the first line and each option on its own line:

```text
@AnagramPollBot What should we watch?
The Wire
The Sopranos
```

Select the actual bot from Anagram's @mention picker. Mention it alone to see this format using its configured `NAME`, converted to a composer handle (for example, `Anagram Poll Bot` → `@AnagramPollBot`). In a DM, the mention is optional. No command or separators needed.

For private groups, invite the bot normally. For public groups, trust its public key and DM it the group's link.

Buttons submit private votes. Results appear only to the person clicking; repeat votes return results. Votes are keyed by public key, not person, and are visible to the bot operator. Polls close after seven days. Limits: 8 options, 100 retained polls, 10,000 voters per poll.

Successful polls collapse the original command in Anagram; use the poll's message menu to show it again. Help replies leave the command visible. Messages are not deleted.

Back up `data/`: it contains the bot's secret identity, group credentials and votes. Keep it private. No external API or database service is needed. Existing `.env` and `data/` should be preserved when updating.

Run `npm test` to check messaging and voting against local fixtures. The transport in `vendor/` belongs to this standalone example. CI checks its bundled keyboard protocol against the client and tests a copy of the bot outside the repository.
