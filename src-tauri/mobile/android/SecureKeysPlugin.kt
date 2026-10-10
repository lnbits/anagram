package com.nostr.anagram

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class PrivateKeyArgs { lateinit var value: String }

// Only called by Rust after checking the main webview's origin. The AES key
// stays in Android Keystore; preferences contain only authenticated ciphertext.
@TauriPlugin
class SecureKeysPlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "com.nostr.anagram.private-key"
    private val preferences get() = activity.getSharedPreferences("secure-keys", Context.MODE_PRIVATE)
    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun key(create: Boolean): SecretKey {
        (keystore().getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "Missing encryption key" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    @Command
    fun read(invoke: Invoke) {
        try {
            val saved = preferences.getString("ciphertext", null)
            val value = if (saved == null) null else {
                val bytes = Base64.decode(saved, Base64.NO_WRAP)
                require(bytes.size > 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            }
            invoke.resolve(JSObject().put("value", value ?: org.json.JSONObject.NULL))
        } catch (_: Exception) { invoke.reject("Secure storage operation failed") }
    }
    @Command
    fun write(invoke: Invoke) {
        try {
            val value = invoke.parseArgs(PrivateKeyArgs::class.java).value
            require(value.matches(Regex("[0-9a-fA-F]{64}")))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(true))
            val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            check(preferences.edit().putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("Secure storage operation failed") }
    }
    @Command
    fun remove(invoke: Invoke) {
        try {
            check(preferences.edit().remove("ciphertext").commit())
            keystore().deleteEntry(alias)
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("Secure storage operation failed") }
    }
}
