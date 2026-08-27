# Android relay notifications

Android notifications are delivered without Google Play Services, Firebase Cloud Messaging, or a Nostr Chat notification server.

## Runtime model

When the user opts in, the Android app starts a foreground service with a persistent `Listening for new messages` notification. The service opens WebSocket connections directly to the user's readable Nostr relays and subscribes to NIP-59 gift wraps (`kind:1059`) addressed to:

- the logged-in user's public key; and
- the current public epoch key for each group chat.

The watch plan is refreshed when the logged-in identity, readable relay list, or current group epoch changes. Old group epoch keys are not retained for live notifications.

The service persists only relay URLs, public recipient keys, subscription cursors, seen event IDs, and an unread count. It does not receive or store account private keys, group epoch private keys, plaintext messages, sender names, or chat names.

## Notifications

Gift wraps are checked for their event shape, canonical event ID, BIP-340 Schnorr signature, kind, timestamp, and a matching `p` tag. Duplicate event IDs seen on several relays produce one alert. The service intentionally does not decrypt gift wraps.

Alerts contain only:

- title: `Nostr Chat`;
- body: `New message`, or a generic accumulated count.

Tapping an alert opens the chats screen and routes to a matching group when the watched recipient is a current group epoch key. The app performs all message fetching and decryption through its normal Nostr runtime.

## User controls

- Notifications are off by default and require Android notification permission.
- `Start after device restart` is enabled by default and can be disabled separately.
- The foreground-service notification has a `Stop` action. Stopping disables the native preference, and the settings toggle synchronizes to off when the app resumes.
- Logging out stops the service and clears delivered message alerts.

## Android declarations

The app declares `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`, and `FOREGROUND_SERVICE_SPECIAL_USE`. The foreground service is declared as `specialUse`, with its Nostr WebSocket listener purpose documented in the manifest.

The implementation uses the app's custom Capacitor bridge plus OkHttp WebSockets. There are no Google notification dependencies or credentials.
