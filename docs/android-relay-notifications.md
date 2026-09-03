# Android relay notifications

Android notifications are delivered without Google Play Services, Firebase Cloud Messaging, or an Anagram notification server.

## Runtime model

When the user opts in, the Android app starts a foreground service with a persistent `Listening for new messages` notification. Before it starts, the user chooses individual readable relays from the user's NIP-65 relays, app relays, and relays advertised by joined groups. The service opens WebSocket connections only to that saved selection and subscribes to NIP-59 gift wraps (`kind:1059`) addressed to:

- the logged-in user's public key; and
- the current public epoch key for each group chat.

The selection is stored per account and is not expanded automatically when new user, app, or group relays are discovered. Duplicate URLs are shown once with all applicable source labels. When no selection exists, the UI initially suggests up to three user relays, or one app relay when no user relay is available; group relays remain opt-in. Relays that disappear from every source stay visible as unavailable selections but are excluded from the foreground-service watch plan.

The watch plan is refreshed when the logged-in identity, readable relay candidates, saved selection, or current group epoch changes. Old group epoch keys are not retained for live notifications. Normal relay use while the app is open is unaffected by the notification-only selection.

NIP-59 gift wraps intentionally use randomized timestamps up to two days in the past. Each relay subscription therefore includes that full lookback window. Stored events received before a relay's initial `EOSE` are validated and deduplicated without notifying; events received after catch-up, and unseen events recovered on later reconnects, can produce alerts.

For conversation-aware alerts, the app supplies the local identity key and current group epoch keys to Android's encrypted notification key store. The service uses those keys only to validate notification eligibility and resolve the conversation. It never persists decrypted seals, rumors, or plaintext message content.

Every validated gift wrap is also written, still encrypted, to an app-private native inbox. The inbox is capped at 500 events and 16 MiB, and individual events larger than 256 KiB are not retained. Events remain until the web app acknowledges successful ingestion or duplicate detection. Unacknowledged events expire after seven days, and disabling notifications, logging out, or replacing the configured account clears the inbox.

## Notifications

Gift wraps are checked for their event shape, canonical event ID, BIP-340 Schnorr signature, kind, timestamp, and a matching `p` tag. Duplicate event IDs seen on several relays produce one alert. When conversation details are enabled and the required local key is available, the service decrypts an event in memory to apply the same accepted-chat policy and choose its notification target.

Alerts contain only:

- title: `Anagram`;
- body: `New message`, or a generic accumulated count.

Tapping an alert opens the matching chat. On app startup, resume, notification action, or a native inbox update, the Capacitor bridge transfers pending encrypted gift wraps to the normal private-message ingestion runtime. Successfully persisted and duplicate events are acknowledged and removed from the native inbox; events that cannot yet be decrypted remain available for retry. Normal relay synchronization continues concurrently and deduplicates any event received through both paths.

## User controls

- Notifications are off by default and require Android notification permission.
- At least one currently available notification relay must be selected before notifications can be enabled.
- Changing the notification relay selection while the listener is enabled immediately refreshes its WebSocket connections.
- Selecting more than five relays shows a battery and data use warning but is not blocked.
- `Start after device restart` is enabled by default and can be disabled separately.
- The foreground-service notification has a `Stop` action. Stopping disables the native preference, and the settings toggle synchronizes to off when the app resumes.
- Logging out stops the service and clears delivered message alerts.

## Android declarations

The app declares `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`, and `FOREGROUND_SERVICE_SPECIAL_USE`. The foreground service is declared as `specialUse`, with its Nostr WebSocket listener purpose documented in the manifest.

The implementation uses the app's custom Capacitor bridge plus OkHttp WebSockets. There are no Google notification dependencies or credentials.

## Debug logging

Debug Android builds emit native listener diagnostics under the `NostrChatRelay` log tag:

```sh
adb logcat -c
adb logcat -v threadtime NostrChatRelay:D '*:S'
```

The trace reports service lifecycle, watch-plan counts, relay connection state, EOSE, gift-wrap validation decisions, foreground suppression, and notification posting. It uses short identifiers for relay URLs and event IDs and never logs message content, private keys, complete public keys, signatures, or encrypted payloads. These diagnostics are omitted from release builds.
