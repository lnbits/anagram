# Anagram bots

- [Dad jokes](dad-jokes/README.md): basic DMs, private groups and public groups.
- [Poll bot](poll/README.md): Telegram-compatible inline buttons, private votes and personal results.
- [GitHub issue agent](github-issue-agent/README.md): drafts GitHub issues with a local Ollama model and publishes them after explicit confirmation.
- [Telegram bridge](telegram-bridge/README.md): bridge Telegram and Anagram conversations.

Bots run under their own Nostr identity. Invite them to private groups or share a public-group link; interactive public bots must be trusted by the group owner.

For your own buttons, see the [inline keyboard protocol](../docs/bot-keyboards.md). Keep bot keys and data directories private.

## Building a bot

Each bot must install and run from a copy of its own folder using `npm ci` and `npm start`. Include dependencies, a lockfile, `.env.example`, setup instructions, assets and locally bundled helpers with their license notices. Do not depend on the app's source or packages. Verify startup from an isolated copy. See [agent instructions](AGENTS.md).

For button rows, sizes and positioning, see the [inline keyboard layout](../docs/bot-keyboards.md#button-layout).
