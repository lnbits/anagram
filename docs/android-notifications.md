# Android notifications

In the APK, enable **Settings → Notifications → Android notifications**, allow the Android permission and select relays. The foreground listener keeps a persistent status notification and supports optional restart after reboot. Android battery restrictions and force-stop can prevent background delivery.

This ports the `iroh_call` relay listener to Tauri: verified NIP-59 envelopes, conversation mute/block rules, private-group epoch subscriptions, notification taps and bounded recovery into the normal message-ingestion path. It does not subscribe to public rooms.

Local identity/epoch keys used for detailed notifications stay encrypted with Android Keystore. Logout stops the listener and clears its keys and pending envelopes. External signers without local decryption keys receive generic notifications. Avatar requests require public HTTPS destinations, reject redirects/private addresses and have download limits.

Incoming call cards temporarily replace the listener’s quiet foreground-service notification. Android 12+ requires this service association for `CallStyle`; posting a separate call card is rejected. Answer, decline, cancellation and expiry restore the quiet notification, and relay status updates preserve an active ringing card. Caller details remain hidden unless explicitly enabled.

Native sources live in `src-tauri/mobile/android`; `scripts/prepare-android.mjs` copies them and their manifest declarations into the generated Android project. The release workflow runs crypto/policy tests and Android 15 device tests for call cards, action tokens, privacy, expiry, and encrypted invitation/ringing/decline delivery through a local relay. These device tests use a debug harness after the release APK startup check. Physical-device lock-screen behaviour, battery restrictions and reboot recovery still need device validation.
