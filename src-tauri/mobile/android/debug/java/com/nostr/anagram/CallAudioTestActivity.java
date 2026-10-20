package com.nostr.anagram;

// A foreground permission owner for service instrumentation. The runner closes
// activities between tests, which would shut down Tauri's process and the runner
// together. This host is packaged only in debug builds, never release APKs.
public final class CallAudioTestActivity extends android.app.Activity {}
