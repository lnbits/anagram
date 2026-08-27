package com.lnbits.nostrchat;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class RelayNotificationPreferences {

    private static final String PREFERENCES_NAME = "nostr_chat_relay_notifications";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_START_ON_BOOT = "start_on_boot";
    private static final String KEY_RELAYS = "relays";
    private static final String KEY_OWNER_PUBKEY = "owner_pubkey";
    private static final String KEY_RECIPIENT_PUBKEYS = "recipient_pubkeys";
    private static final String KEY_CONVERSATIONS = "conversations";
    private static final String KEY_SHOW_CONVERSATION_DETAILS = "show_conversation_details";
    private static final String KEY_INITIALIZED_RELAYS = "initialized_relays";
    private static final String KEY_SEEN_EVENT_IDS = "seen_event_ids";
    private static final String KEY_UNREAD_NOTIFICATION_COUNTS = "unread_notification_counts";
    private static final String KEY_APP_FOREGROUND = "app_foreground";
    private static final int MAX_SEEN_EVENT_IDS = 8192;

    private RelayNotificationPreferences() {}

    static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(KEY_ENABLED, false);
    }

    static void setEnabled(Context context, boolean enabled) {
        SharedPreferences prefs = preferences(context);
        SharedPreferences.Editor editor = prefs.edit().putBoolean(KEY_ENABLED, enabled);
        if (enabled && !prefs.getBoolean(KEY_ENABLED, false)) {
            editor
                .putString(KEY_INITIALIZED_RELAYS, "[]")
                .putString(KEY_SEEN_EVENT_IDS, "[]")
                .putString(KEY_UNREAD_NOTIFICATION_COUNTS, "{}");
        }
        editor.apply();
    }

    static boolean shouldStartOnBoot(Context context) {
        return preferences(context).getBoolean(KEY_START_ON_BOOT, true);
    }

    static void setStartOnBoot(Context context, boolean startOnBoot) {
        preferences(context).edit().putBoolean(KEY_START_ON_BOOT, startOnBoot).apply();
    }

    static void saveWatchPlan(
        Context context,
        List<String> relays,
        String ownerPubkey,
        List<String> recipientPubkeys,
        List<NotificationConversation> conversations,
        boolean showConversationDetails
    ) {
        preferences(context)
            .edit()
            .putString(KEY_RELAYS, toJson(relays))
            .putString(KEY_OWNER_PUBKEY, ownerPubkey)
            .putString(KEY_RECIPIENT_PUBKEYS, toJson(recipientPubkeys))
            .putString(KEY_CONVERSATIONS, conversationsToJson(conversations))
            .putBoolean(KEY_SHOW_CONVERSATION_DETAILS, showConversationDetails)
            .apply();
    }

    static List<String> getRelays(Context context) {
        return fromJson(preferences(context).getString(KEY_RELAYS, "[]"));
    }

    static Set<String> getRecipientPubkeys(Context context) {
        return new LinkedHashSet<>(fromJson(preferences(context).getString(KEY_RECIPIENT_PUBKEYS, "[]")));
    }

    static String getOwnerPubkey(Context context) {
        String ownerPubkey = NotificationConversation.normalizePubkey(
            preferences(context).getString(KEY_OWNER_PUBKEY, "")
        );
        return ownerPubkey == null ? "" : ownerPubkey;
    }

    static List<NotificationConversation> getConversations(Context context) {
        List<NotificationConversation> result = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(
                preferences(context).getString(KEY_CONVERSATIONS, "[]")
            );
            for (int index = 0; index < values.length(); index += 1) {
                NotificationConversation conversation = NotificationConversation.fromJson(
                    values.optJSONObject(index)
                );
                if (conversation != null) {
                    result.add(conversation);
                }
            }
        } catch (JSONException ignored) {}
        return result;
    }

    static boolean shouldShowConversationDetails(Context context) {
        return preferences(context).getBoolean(KEY_SHOW_CONVERSATION_DETAILS, true);
    }

    static boolean isRelayInitialized(Context context, String relayUrl) {
        return new LinkedHashSet<>(
            fromJson(preferences(context).getString(KEY_INITIALIZED_RELAYS, "[]"))
        ).contains(relayUrl);
    }

    static synchronized void markRelayInitialized(Context context, String relayUrl) {
        SharedPreferences prefs = preferences(context);
        LinkedHashSet<String> initializedRelays = new LinkedHashSet<>(
            fromJson(prefs.getString(KEY_INITIALIZED_RELAYS, "[]"))
        );
        if (initializedRelays.add(relayUrl)) {
            prefs
                .edit()
                .putString(KEY_INITIALIZED_RELAYS, toJson(new ArrayList<>(initializedRelays)))
                .apply();
        }
    }

    static synchronized boolean markEventSeen(Context context, String eventId) {
        SharedPreferences prefs = preferences(context);
        LinkedHashSet<String> seenIds = new LinkedHashSet<>(
            fromJson(prefs.getString(KEY_SEEN_EVENT_IDS, "[]"))
        );
        if (!seenIds.add(eventId.toLowerCase(Locale.ROOT))) {
            return false;
        }

        while (seenIds.size() > MAX_SEEN_EVENT_IDS) {
            String oldestId = seenIds.iterator().next();
            seenIds.remove(oldestId);
        }
        prefs.edit().putString(KEY_SEEN_EVENT_IDS, toJson(new ArrayList<>(seenIds))).apply();
        return true;
    }

    static synchronized int incrementUnreadNotificationCount(Context context, String chatPubkey) {
        SharedPreferences prefs = preferences(context);
        Map<String, Integer> counts = unreadCountsFromJson(
            prefs.getString(KEY_UNREAD_NOTIFICATION_COUNTS, "{}")
        );
        int nextCount = Math.max(0, counts.getOrDefault(chatPubkey, 0)) + 1;
        counts.put(chatPubkey, nextCount);
        prefs.edit().putString(KEY_UNREAD_NOTIFICATION_COUNTS, unreadCountsToJson(counts)).apply();
        return nextCount;
    }

    static synchronized Set<String> getUnreadConversationKeys(Context context) {
        return new LinkedHashSet<>(
            unreadCountsFromJson(
                preferences(context).getString(KEY_UNREAD_NOTIFICATION_COUNTS, "{}")
            ).keySet()
        );
    }

    static synchronized void resetUnreadNotificationCount(Context context, String chatPubkey) {
        SharedPreferences prefs = preferences(context);
        Map<String, Integer> counts = unreadCountsFromJson(
            prefs.getString(KEY_UNREAD_NOTIFICATION_COUNTS, "{}")
        );
        counts.remove(chatPubkey);
        prefs.edit().putString(KEY_UNREAD_NOTIFICATION_COUNTS, unreadCountsToJson(counts)).apply();
    }

    static void resetUnreadNotificationCounts(Context context) {
        preferences(context).edit().putString(KEY_UNREAD_NOTIFICATION_COUNTS, "{}").apply();
    }

    static boolean isAppForeground(Context context) {
        return preferences(context).getBoolean(KEY_APP_FOREGROUND, false);
    }

    static void setAppForeground(Context context, boolean isForeground) {
        preferences(context).edit().putBoolean(KEY_APP_FOREGROUND, isForeground).apply();
    }

    static void clearNotificationContext(Context context) {
        preferences(context)
            .edit()
            .remove(KEY_OWNER_PUBKEY)
            .remove(KEY_RECIPIENT_PUBKEYS)
            .remove(KEY_CONVERSATIONS)
            .remove(KEY_RELAYS)
            .remove(KEY_INITIALIZED_RELAYS)
            .remove(KEY_SEEN_EVENT_IDS)
            .remove(KEY_UNREAD_NOTIFICATION_COUNTS)
            .apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static String toJson(List<String> values) {
        return new JSONArray(values).toString();
    }

    private static String conversationsToJson(List<NotificationConversation> conversations) {
        JSONArray result = new JSONArray();
        for (NotificationConversation conversation : conversations) {
            try {
                result.put(conversation.toJson());
            } catch (JSONException ignored) {}
        }
        return result.toString();
    }

    private static List<String> fromJson(String serialized) {
        List<String> result = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(serialized == null ? "[]" : serialized);
            for (int index = 0; index < values.length(); index += 1) {
                String value = values.optString(index, "").trim();
                if (!value.isEmpty()) {
                    result.add(value);
                }
            }
        } catch (JSONException ignored) {}
        return result;
    }

    private static Map<String, Integer> unreadCountsFromJson(String serialized) {
        Map<String, Integer> result = new LinkedHashMap<>();
        try {
            JSONObject values = new JSONObject(serialized == null ? "{}" : serialized);
            Iterator<String> keys = values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!key.trim().isEmpty()) {
                    int count = Math.max(0, values.optInt(key, 0));
                    if (count > 0) {
                        result.put(key, count);
                    }
                }
            }
        } catch (JSONException ignored) {}
        return result;
    }

    private static String unreadCountsToJson(Map<String, Integer> values) {
        JSONObject result = new JSONObject();
        for (Map.Entry<String, Integer> entry : values.entrySet()) {
            try {
                result.put(entry.getKey(), Math.max(0, entry.getValue()));
            } catch (JSONException ignored) {}
        }
        return result.toString();
    }

}
