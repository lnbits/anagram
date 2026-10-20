# Bot example instructions

- Read [README.md](README.md) and the target bot's README before making changes.
- Every bot must run independently after its folder is copied outside this repository. Keep dependencies, lockfile, configuration examples, required assets and runtime helpers inside that folder; no imports from Anagram `src/`, parent folders or sibling bots, and no reliance on root `node_modules`.
- Bundle shared helpers locally (for example, under `vendor/`) with their license notices. Verify installation and startup from an isolated copy; Node examples must support `npm ci` and `npm start` there.
- Change only the requested bot and directly relevant documentation/tests. Do not modify another bot to support it. Preserve existing `.env` and data; never commit secrets or runtime state.
- Document button layouts using the [inline keyboard protocol](../docs/bot-keyboards.md#button-layout): each inner array is one row.
