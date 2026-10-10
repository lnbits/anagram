package com.nostr.anagram;

/** Uses rust-nostr for NIP-44 encryption and BIP-340 signing, never custom signing code. */
final class CallSignalNative {
    static { System.loadLibrary("anagram_lib"); }
    private CallSignalNative() {}
    static native String reply(String privateKey, String peer, String signal);
}
