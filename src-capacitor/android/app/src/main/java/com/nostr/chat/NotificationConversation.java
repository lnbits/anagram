package com.nostr.chat;

import androidx.annotation.Nullable;
import java.util.Locale;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

final class NotificationConversation {

    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final int MAX_NAME_LENGTH = 120;
    private static final int MAX_AVATAR_TEXT_LENGTH = 4;

    final String chatPubkey;
    @Nullable
    final String recipientPubkey;
    final String name;
    final String avatarUrl;
    final String avatarText;
    final boolean policyEligible;
    final boolean notificationsEnabled;

    NotificationConversation(
        String chatPubkey,
        @Nullable String recipientPubkey,
        String name,
        String avatarUrl,
        String avatarText,
        boolean policyEligible,
        boolean notificationsEnabled
    ) {
        this.chatPubkey = chatPubkey;
        this.recipientPubkey = recipientPubkey;
        this.name = normalizeText(name, MAX_NAME_LENGTH, "Nostr contact");
        this.avatarUrl = normalizeText(avatarUrl, 2048, "");
        this.avatarText = normalizeText(avatarText, MAX_AVATAR_TEXT_LENGTH, "NC");
        this.policyEligible = policyEligible;
        this.notificationsEnabled = notificationsEnabled;
    }

    JSONObject toJson() throws JSONException {
        JSONObject result = new JSONObject();
        result.put("chatPubkey", chatPubkey);
        if (recipientPubkey != null) {
            result.put("recipientPubkey", recipientPubkey);
        }
        result.put("name", name);
        result.put("avatarUrl", avatarUrl);
        result.put("avatarText", avatarText);
        result.put("policyEligible", policyEligible);
        result.put("notificationsEnabled", notificationsEnabled);
        return result;
    }

    @Nullable
    static NotificationConversation fromJson(@Nullable JSONObject value) {
        if (value == null) {
            return null;
        }
        String chatPubkey = normalizePubkey(value.optString("chatPubkey", ""));
        if (chatPubkey == null) {
            return null;
        }
        return new NotificationConversation(
            chatPubkey,
            normalizePubkey(value.optString("recipientPubkey", "")),
            value.optString("name", ""),
            value.optString("avatarUrl", ""),
            value.optString("avatarText", ""),
            value.optBoolean("policyEligible", false),
            value.optBoolean("notificationsEnabled", false)
        );
    }

    @Nullable
    static String normalizePubkey(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return HEX_64.matcher(normalized).matches() ? normalized : null;
    }

    private static String normalizeText(
        @Nullable String value,
        int maxLength,
        String fallback
    ) {
        String normalized = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (normalized.isEmpty()) {
            return fallback;
        }
        return normalized.length() <= maxLength ? normalized : normalized.substring(0, maxLength);
    }
}
