package com.lnbits.nostrchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.Nullable;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;
import org.json.JSONObject;

/** Stores notification-only recipient keys encrypted by a non-exportable Android Keystore key. */
final class NotificationSecureStore {

    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "nostr_chat_notification_recipient_keys";
    private static final String PREFERENCES_NAME = "nostr_chat_notification_secrets";
    private static final String KEY_ENCRYPTED_KEYS = "recipient_keys";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_LENGTH_BYTES = 12;

    private NotificationSecureStore() {}

    static synchronized void saveRecipientKeys(Context context, Map<String, String> recipientKeys)
        throws GeneralSecurityException {
        if (recipientKeys.isEmpty()) {
            clear(context);
            return;
        }

        JSONObject serialized = new JSONObject();
        try {
            for (Map.Entry<String, String> entry : recipientKeys.entrySet()) {
                serialized.put(entry.getKey(), entry.getValue());
            }
        } catch (JSONException exception) {
            throw new GeneralSecurityException("Failed to serialize notification keys.", exception);
        }

        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey());
        byte[] encrypted = cipher.doFinal(
            serialized.toString().getBytes(StandardCharsets.UTF_8)
        );
        byte[] iv = cipher.getIV();
        byte[] stored = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, stored, 0, iv.length);
        System.arraycopy(encrypted, 0, stored, iv.length, encrypted.length);
        preferences(context)
            .edit()
            .putString(KEY_ENCRYPTED_KEYS, Base64.encodeToString(stored, Base64.NO_WRAP))
            .apply();
    }

    static synchronized Map<String, String> loadRecipientKeys(Context context) {
        String encoded = preferences(context).getString(KEY_ENCRYPTED_KEYS, "");
        if (encoded == null || encoded.isEmpty()) {
            return new LinkedHashMap<>();
        }

        try {
            byte[] stored = Base64.decode(encoded, Base64.NO_WRAP);
            if (stored.length <= IV_LENGTH_BYTES) {
                throw new GeneralSecurityException("Invalid encrypted notification key data.");
            }
            byte[] iv = new byte[IV_LENGTH_BYTES];
            byte[] encrypted = new byte[stored.length - IV_LENGTH_BYTES];
            System.arraycopy(stored, 0, iv, 0, iv.length);
            System.arraycopy(stored, iv.length, encrypted, 0, encrypted.length);

            KeyStore keyStore = loadKeyStore();
            KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keyStore.getEntry(
                KEY_ALIAS,
                null
            );
            if (entry == null) {
                clear(context);
                return new LinkedHashMap<>();
            }

            Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
            cipher.init(
                Cipher.DECRYPT_MODE,
                entry.getSecretKey(),
                new GCMParameterSpec(128, iv)
            );
            String plaintext = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
            JSONObject values = new JSONObject(plaintext);
            Map<String, String> result = new LinkedHashMap<>();
            Iterator<String> keys = values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String recipientPubkey = NotificationConversation.normalizePubkey(key);
                String privateKey = normalizePrivateKey(values.optString(key, ""));
                if (recipientPubkey != null && privateKey != null) {
                    result.put(recipientPubkey, privateKey);
                }
            }
            return result;
        } catch (Exception exception) {
            clear(context);
            return new LinkedHashMap<>();
        }
    }

    static synchronized void clear(Context context) {
        preferences(context).edit().remove(KEY_ENCRYPTED_KEYS).apply();
        try {
            KeyStore keyStore = loadKeyStore();
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS);
            }
        } catch (GeneralSecurityException ignored) {}
    }

    @Nullable
    private static String normalizePrivateKey(String value) {
        String normalized = value.trim().toLowerCase(java.util.Locale.ROOT);
        if (!normalized.matches("^[0-9a-f]{64}$")) {
            return null;
        }
        try {
            Nip44Decryptor.derivePublicKeyHex(normalized);
            return normalized;
        } catch (GeneralSecurityException exception) {
            return null;
        }
    }

    private static SecretKey getOrCreateSecretKey() throws GeneralSecurityException {
        KeyStore keyStore = loadKeyStore();
        KeyStore.SecretKeyEntry existing = (KeyStore.SecretKeyEntry) keyStore.getEntry(
            KEY_ALIAS,
            null
        );
        if (existing != null) {
            return existing.getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEY_STORE
        );
        generator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        );
        return generator.generateKey();
    }

    private static KeyStore loadKeyStore() throws GeneralSecurityException {
        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            return keyStore;
        } catch (java.io.IOException exception) {
            throw new GeneralSecurityException("Failed to load Android Keystore.", exception);
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }
}
