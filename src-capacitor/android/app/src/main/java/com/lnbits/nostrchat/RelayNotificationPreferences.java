package com.lnbits.nostrchat;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;

final class RelayNotificationPreferences {

    private static final String PREFERENCES_NAME = "nostr_chat_relay_notifications";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_START_ON_BOOT = "start_on_boot";
    private static final String KEY_RELAYS = "relays";
    private static final String KEY_RECIPIENT_PUBKEYS = "recipient_pubkeys";
    private static final String KEY_LISTENING_SINCE = "listening_since";
    private static final String KEY_LAST_EVENT_CREATED_AT = "last_event_created_at";
    private static final String KEY_SEEN_EVENT_IDS = "seen_event_ids";
    private static final String KEY_UNREAD_NOTIFICATION_COUNT = "unread_notification_count";
    private static final String KEY_APP_FOREGROUND = "app_foreground";
    private static final int MAX_SEEN_EVENT_IDS = 512;

    private RelayNotificationPreferences() {}

    static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(KEY_ENABLED, false);
    }

    static void setEnabled(Context context, boolean enabled) {
        SharedPreferences prefs = preferences(context);
        SharedPreferences.Editor editor = prefs.edit().putBoolean(KEY_ENABLED, enabled);
        if (enabled && !prefs.getBoolean(KEY_ENABLED, false)) {
            editor
                .putLong(KEY_LISTENING_SINCE, nowSeconds())
                .putLong(KEY_LAST_EVENT_CREATED_AT, 0L)
                .putString(KEY_SEEN_EVENT_IDS, "[]")
                .putInt(KEY_UNREAD_NOTIFICATION_COUNT, 0);
        }
        editor.apply();
    }

    static boolean shouldStartOnBoot(Context context) {
        return preferences(context).getBoolean(KEY_START_ON_BOOT, true);
    }

    static void setStartOnBoot(Context context, boolean startOnBoot) {
        preferences(context).edit().putBoolean(KEY_START_ON_BOOT, startOnBoot).apply();
    }

    static void saveWatchPlan(Context context, List<String> relays, List<String> recipientPubkeys) {
        preferences(context)
            .edit()
            .putString(KEY_RELAYS, toJson(relays))
            .putString(KEY_RECIPIENT_PUBKEYS, toJson(recipientPubkeys))
            .apply();
    }

    static List<String> getRelays(Context context) {
        return fromJson(preferences(context).getString(KEY_RELAYS, "[]"));
    }

    static Set<String> getRecipientPubkeys(Context context) {
        return new LinkedHashSet<>(fromJson(preferences(context).getString(KEY_RECIPIENT_PUBKEYS, "[]")));
    }

    static long getListeningSince(Context context) {
        return preferences(context).getLong(KEY_LISTENING_SINCE, nowSeconds());
    }

    static long getLastEventCreatedAt(Context context) {
        return preferences(context).getLong(KEY_LAST_EVENT_CREATED_AT, 0L);
    }

    static void updateLastEventCreatedAt(Context context, long createdAt) {
        SharedPreferences prefs = preferences(context);
        if (createdAt > prefs.getLong(KEY_LAST_EVENT_CREATED_AT, 0L)) {
            prefs.edit().putLong(KEY_LAST_EVENT_CREATED_AT, createdAt).apply();
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

    static int incrementUnreadNotificationCount(Context context) {
        SharedPreferences prefs = preferences(context);
        int nextCount = Math.max(0, prefs.getInt(KEY_UNREAD_NOTIFICATION_COUNT, 0)) + 1;
        prefs.edit().putInt(KEY_UNREAD_NOTIFICATION_COUNT, nextCount).apply();
        return nextCount;
    }

    static void resetUnreadNotificationCount(Context context) {
        preferences(context).edit().putInt(KEY_UNREAD_NOTIFICATION_COUNT, 0).apply();
    }

    static boolean isAppForeground(Context context) {
        return preferences(context).getBoolean(KEY_APP_FOREGROUND, false);
    }

    static void setAppForeground(Context context, boolean isForeground) {
        preferences(context).edit().putBoolean(KEY_APP_FOREGROUND, isForeground).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static String toJson(List<String> values) {
        return new JSONArray(values).toString();
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

    private static long nowSeconds() {
        return System.currentTimeMillis() / 1000L;
    }
}
