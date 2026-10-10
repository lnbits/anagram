package com.nostr.anagram;

import androidx.annotation.Nullable;
import java.util.Locale;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONArray;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

final class NotificationConversation {

    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final int MAX_NAME_LENGTH = 120;
    private static final int MAX_AVATAR_TEXT_LENGTH = 4;

    final java.util.List<String> replyRelays = new java.util.ArrayList<>();
    final String chatPubkey;
    @Nullable
    final String recipientPubkey;
    long epochNumber = -1L;
    final Set<String> knownEpochPubkeys = new HashSet<>();
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
        result.put("epochNumber", epochNumber);
        result.put("knownEpochPubkeys", new JSONArray(knownEpochPubkeys));
        result.put("replyRelays", new JSONArray(replyRelays));
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
        NotificationConversation conversation = new NotificationConversation(
            chatPubkey,
            normalizePubkey(value.optString("recipientPubkey", "")),
            value.optString("name", ""),
            value.optString("avatarUrl", ""),
            value.optString("avatarText", ""),
            value.optBoolean("policyEligible", false),
            value.optBoolean("notificationsEnabled", false)
        );
        JSONArray routes = value.optJSONArray("replyRelays");
        if (routes != null) for (int i = 0; i < Math.min(routes.length(), 8); i++) {
            String route = routes.optString(i, "");
            try {
                java.net.URI uri = java.net.URI.create(route);
                if ("wss".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && uri.getUserInfo() == null)
                    conversation.replyRelays.add(route);
            } catch (IllegalArgumentException ignored) { }
        }
        conversation.epochNumber = value.optLong("epochNumber", -1L);
        JSONArray epochs = value.optJSONArray("knownEpochPubkeys");
        if (epochs != null) for (int i = 0; i < epochs.length(); i++) {
            String pubkey = normalizePubkey(epochs.optString(i, ""));
            if (pubkey != null) conversation.knownEpochPubkeys.add(pubkey);
        }
        return conversation;
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
