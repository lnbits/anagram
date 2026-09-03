# Anagram Developer Guide

This file keeps the technical project notes that used to live in the README. For a short user-facing overview, see [README.md](./README.md).

## Project Snapshot

Anagram is a Quasar/Vue web and Electron client for Nostr private messaging. The current app supports direct chats, group chats, contact and profile management, relay controls, browser notifications, developer diagnostics, and local packaging for desktop builds.

## Current Features

- Account creation in the app, with generated `npub` and `nsec` export
- Login with a NIP-07 browser extension
- Local private-key login for `nsec` or raw hex keys
- Direct-message threads with search, reactions, deletions, unread tracking, and relay delivery status
- First-contact request inbox with accept, block, delete, and review flows
- Group chats with invite handling and epoch rotation support
- Contact list management, profile refresh, profile publishing, and contact lookup by identifier or pubkey
- Relay management for:
  - app relays
  - published NIP-65 relays
  - discovered contact relays
  - relay metadata and connection-state inspection
- Settings for profile, relays, theme, notifications, status, and developer diagnostics
- Startup and sync history view
- Browser-notification opt-in flow
- Developer tools for relay diagnostics, trace export, reconnects, and subscription restart
- Web, Electron, and Android build targets

## Protocol Notes

The app currently uses the Nostr flows documented in [NIPS_USED.md](./NIPS_USED.md), including:

- NIP-05 identifier lookup
- NIP-07 extension login
- NIP-11 relay metadata
- NIP-17 private messaging
- NIP-19 key and profile encoding
- NIP-24 profile metadata fields
- NIP-44 encryption
- NIP-51 private follow-set style group membership data
- NIP-59 gift wrapping
- NIP-65 relay lists
- NIP-78 private app storage
- repo-local NIP-171 draft notes for group messaging in [nip171.md](./nip171.md) and [nip171b.md](./nip171b.md)

## Tech Stack

- Quasar 2
- Vue 3.5
- Pinia 2
- TypeScript 5
- `@nostr-dev-kit/ndk`
- Vitest for unit tests
- Playwright for end-to-end tests
- Electron Builder for desktop packaging
- Biome for formatting and linting

## Getting Started

Node.js 24 and npm 11 are required for local development and CI. The repo declares support for Node.js 24.x.

If you use `nvm`, run:

```bash
nvm install
nvm use
```

Install dependencies:

```bash
npm install
```

Start the web app in development mode:

```bash
npm run dev
```

Start the Electron app in development mode:

```bash
npm run dev:electron
```

## Quality Checks

Typecheck:

```bash
npm run typecheck
```

Format check:

```bash
npm run format:check
```

Lint:

```bash
npm run lint
```

Full local quality sweep:

```bash
npm run quality:all
```

## Testing

Run unit tests:

```bash
npm run test:unit
```

Run unit tests with coverage:

```bash
npm run test:unit:coverage
```

Run the full local Playwright suite:

```bash
npm run test:e2e:local
```

Targeted local e2e smoke suites are also available:

- `npm run test:e2e:local:auth-smoke`
- `npm run test:e2e:local:contacts-smoke`
- `npm run test:e2e:local:dm-smoke`
- `npm run test:e2e:local:groups-smoke`
- `npm run test:e2e:local:relays-smoke`
- `npm run test:e2e:local:session-smoke`

### Local e2e environment

The local e2e runner uses Playwright plus the Docker stack in `docker-compose.e2e.yml`. `scripts/run-e2e-local.cjs` starts the relays, waits for ports `7000` and `7001`, runs Playwright, and tears the stack down again. Each run resets the relay volume so local runs start clean.

Playwright traces, screenshots, and videos are retained by default. After a run, inspect `test-results/` and `playwright-report/` for artifacts.

### Human testing with a slow relay

Run `npm run dev:mock-relay` to start a normal relay on port `7000` and a configurable, Nostr-aware relay proxy on port `7002`. The proxy delays every WebSocket phase by one second by default. Add `ws://127.0.0.1:7002` to Anagram's relay settings while testing.

Delay individual publish acknowledgements, events, EOSE responses, requests, or handshakes with environment variables. The proxy can also add jitter, drop selected message types, or keep a connection permanently hanging. See [docs/mock-relay.md](./docs/mock-relay.md) for commands and configuration.

## Build

Build the web app:

```bash
npm run build
```

Bump the app version across web, Electron, and Android metadata:

```bash
npm run version:bump -- patch
npm run version:bump -- minor
npm run version:bump -- major
npm run version:bump -- 0.2.0
```

The version bump command updates the root package metadata used by web and Electron builds, the Capacitor package metadata used by Android `versionName`, both npm lockfiles, and Android `versionCode`. Use `--android-version-code <number>` when you need to set a specific Android code.

Build Electron output without packaging into an installer:

```bash
npm run build:electron:dir
```

Build Electron packages:

```bash
npm run build:electron:mac
npm run build:electron:win
npm run build:electron:linux
```

Build Android outputs:

```bash
npm run build:android:apk:debug
npm run build:android:release
npm run build:android:aab:release
```

Android prerequisites:

- Docker with Compose support.
- Node/npm on the host so you can run the repo scripts.

Android notes:

- The native project lives in `src-capacitor/android`.
- `build:android:*` builds inside Docker, so the host machine does not need a local JDK or Android SDK.
- The Docker image uses the official Node Docker image plus OpenJDK 21 and Android command-line tools.
- Docker builds default to `linux/amd64` for better Android SDK compatibility. Override with `ANDROID_DOCKER_PLATFORM` if you need a different target.
- The helper scripts keep Gradle caches inside the repo via `.gradle-android/`, so builds do not depend on `~/.gradle`.
- Linux container dependencies are isolated in Docker volumes instead of using your host `node_modules`.
- If `ANDROID_KEYSTORE_PATH` is absolute, the Docker wrapper mounts that keystore file into the container automatically.
- Release signing is picked up from these environment variables when present:
  - `ANDROID_KEYSTORE_PATH` relative to `src-capacitor/android` or absolute
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`
  - optional `ANDROID_VERSION_CODE`
  - optional `ANDROID_VERSION_NAME`
- Generated Android artifacts are copied into `dist/capacitor/android/`.
- If you ever want the old host-native path, use:
  - `npm run build:android:local:apk:debug`
  - `npm run build:android:local:release`
  - `npm run build:android:local:aab:release`

## Project Structure

```text
src/
  components/        Shared chat, profile, dialog, relay, and settings UI
  composables/       Reusable UI and layout behavior
  constants/         Default relay and app constants
  pages/             Auth, chats, contacts, and settings routes
  router/            Route definitions and lazy page loaders
  services/          IndexedDB and runtime-facing services
  stores/            Pinia stores and the modular Nostr runtime
  testing/           Browser e2e bridge helpers
  types/             App-level TypeScript types
  utils/             Small logic helpers used across stores and UI
src-electron/        Electron main/preload entrypoints and assets
e2e/                 Playwright specs
tests/unit/          Vitest specs
scripts/             Dev and test helper scripts
```

## Architecture Notes

- `src/stores/nostrStore.ts` is the main composition root for auth, relay, startup, message-ingest, and group runtimes.
- `src/stores/nostr/*.ts` contains the focused runtime modules used by the root store.
- `src/stores/chatStore.ts` and `src/stores/messageStore.ts` are the main UI-facing state layers.
- `src/services/chatDataService.ts` is the IndexedDB boundary for chats and messages.
- `src/testing/e2eBridge.ts` exposes deterministic browser helpers used by the Playwright suite.

## Codex Helpers

This repo includes project-specific guidance for coding agents:

- [AGENTS.md](./AGENTS.md) for always-on repo guidance
- [SKILLS.md](./SKILLS.md) for task routing and architecture notes
- `skills/` for repo-local Codex skills:
  - `nostr-runtime`
  - `chat-surface`
  - `validation`
