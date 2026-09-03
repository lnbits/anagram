package com.nostr.chat;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

final class RelayNotificationEventInbox extends SQLiteOpenHelper {

    private static final String DATABASE_NAME = "relay_notification_event_inbox.db";
    private static final int DATABASE_VERSION = 1;
    private static final String TABLE_EVENTS = "pending_events";
    private static final String COLUMN_OWNER_PUBKEY = "owner_pubkey";
    private static final String COLUMN_EVENT_ID = "event_id";
    private static final String COLUMN_RECIPIENT_PUBKEY = "recipient_pubkey";
    private static final String COLUMN_RELAY_URL = "relay_url";
    private static final String COLUMN_RECEIVED_AT_MS = "received_at_ms";
    private static final String COLUMN_EVENT_JSON = "event_json";

    static final long RETENTION_MILLIS = 7L * 24L * 60L * 60L * 1_000L;
    static final int MAX_PENDING_EVENTS = 500;
    static final int MAX_BATCH_SIZE = 50;
    private static final int MAX_EVENT_JSON_BYTES = 256 * 1_024;
    private static final int MAX_BATCH_JSON_BYTES = 1_024 * 1_024;
    private static final long MAX_STORED_EVENT_JSON_BYTES = 16L * 1_024L * 1_024L;

    private RelayNotificationEventInbox(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase database) {
        database.execSQL(
            "CREATE TABLE " + TABLE_EVENTS + " (" +
            COLUMN_OWNER_PUBKEY + " TEXT NOT NULL, " +
            COLUMN_EVENT_ID + " TEXT NOT NULL, " +
            COLUMN_RECIPIENT_PUBKEY + " TEXT NOT NULL, " +
            COLUMN_RELAY_URL + " TEXT NOT NULL, " +
            COLUMN_RECEIVED_AT_MS + " INTEGER NOT NULL, " +
            COLUMN_EVENT_JSON + " TEXT NOT NULL, " +
            "PRIMARY KEY (" + COLUMN_OWNER_PUBKEY + ", " + COLUMN_EVENT_ID + ")" +
            ")"
        );
        database.execSQL(
            "CREATE INDEX pending_events_owner_received_at ON " + TABLE_EVENTS + " (" +
            COLUMN_OWNER_PUBKEY + ", " + COLUMN_RECEIVED_AT_MS + ")"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        database.execSQL("DROP TABLE IF EXISTS " + TABLE_EVENTS);
        onCreate(database);
    }

    static synchronized boolean enqueue(
        Context context,
        String ownerPubkey,
        String recipientPubkey,
        String relayUrl,
        JSONObject event,
        long receivedAtMillis
    ) {
        String serializedEvent = event.toString();
        if (
            ownerPubkey.isEmpty() ||
            recipientPubkey.isEmpty() ||
            relayUrl.isEmpty() ||
            serializedEvent.getBytes(StandardCharsets.UTF_8).length > MAX_EVENT_JSON_BYTES
        ) {
            return false;
        }

        RelayNotificationEventInbox inbox = new RelayNotificationEventInbox(context);
        try {
            SQLiteDatabase database = inbox.getWritableDatabase();
            purgeExpired(database, receivedAtMillis);

            ContentValues values = new ContentValues();
            values.put(COLUMN_OWNER_PUBKEY, ownerPubkey);
            values.put(COLUMN_EVENT_ID, event.optString("id", ""));
            values.put(COLUMN_RECIPIENT_PUBKEY, recipientPubkey);
            values.put(COLUMN_RELAY_URL, relayUrl);
            values.put(COLUMN_RECEIVED_AT_MS, Math.max(0L, receivedAtMillis));
            values.put(COLUMN_EVENT_JSON, serializedEvent);
            long rowId = database.insertWithOnConflict(
                TABLE_EVENTS,
                null,
                values,
                SQLiteDatabase.CONFLICT_IGNORE
            );
            trimToLimits(database);
            return rowId != -1L;
        } finally {
            inbox.close();
        }
    }

    static synchronized List<PendingEvent> list(
        Context context,
        String ownerPubkey,
        int requestedLimit,
        long nowMillis
    ) {
        List<PendingEvent> result = new ArrayList<>();
        if (ownerPubkey.isEmpty()) {
            return result;
        }

        RelayNotificationEventInbox inbox = new RelayNotificationEventInbox(context);
        try {
            SQLiteDatabase database = inbox.getWritableDatabase();
            purgeExpired(database, nowMillis);
            try (
                Cursor cursor = database.query(
                    TABLE_EVENTS,
                    new String[] {
                        COLUMN_EVENT_ID,
                        COLUMN_RECIPIENT_PUBKEY,
                        COLUMN_RELAY_URL,
                        COLUMN_RECEIVED_AT_MS,
                        COLUMN_EVENT_JSON,
                    },
                    COLUMN_OWNER_PUBKEY + " = ?",
                    new String[] { ownerPubkey },
                    null,
                    null,
                    pendingEventSortOrder(),
                    String.valueOf(normalizeBatchLimit(requestedLimit))
                )
            ) {
                int batchJsonBytes = 0;
                while (cursor.moveToNext()) {
                    try {
                        String serializedEvent = cursor.getString(4);
                        int eventJsonBytes = serializedEvent
                            .getBytes(StandardCharsets.UTF_8)
                            .length;
                        if (!result.isEmpty() && batchJsonBytes + eventJsonBytes > MAX_BATCH_JSON_BYTES) {
                            break;
                        }
                        result.add(
                            new PendingEvent(
                                cursor.getString(0),
                                cursor.getString(1),
                                cursor.getString(2),
                                cursor.getLong(3),
                                new JSONObject(serializedEvent)
                            )
                        );
                        batchJsonBytes += eventJsonBytes;
                    } catch (JSONException ignored) {}
                }
            }
            return result;
        } finally {
            inbox.close();
        }
    }

    static synchronized void acknowledge(
        Context context,
        String ownerPubkey,
        List<String> eventIds
    ) {
        if (ownerPubkey.isEmpty() || eventIds.isEmpty()) {
            return;
        }

        int count = Math.min(eventIds.size(), MAX_BATCH_SIZE);
        StringBuilder placeholders = new StringBuilder();
        String[] arguments = new String[count + 1];
        arguments[0] = ownerPubkey;
        for (int index = 0; index < count; index += 1) {
            if (index > 0) {
                placeholders.append(',');
            }
            placeholders.append('?');
            arguments[index + 1] = eventIds.get(index);
        }

        RelayNotificationEventInbox inbox = new RelayNotificationEventInbox(context);
        try {
            inbox
                .getWritableDatabase()
                .delete(
                    TABLE_EVENTS,
                    COLUMN_OWNER_PUBKEY + " = ? AND " + COLUMN_EVENT_ID +
                    " IN (" + placeholders + ")",
                    arguments
                );
        } finally {
            inbox.close();
        }
    }

    static synchronized void clear(Context context) {
        RelayNotificationEventInbox inbox = new RelayNotificationEventInbox(context);
        try {
            inbox.getWritableDatabase().delete(TABLE_EVENTS, null, null);
        } finally {
            inbox.close();
        }
    }

    static int normalizeBatchLimit(int requestedLimit) {
        if (requestedLimit <= 0) {
            return MAX_BATCH_SIZE;
        }
        return Math.min(requestedLimit, MAX_BATCH_SIZE);
    }

    static long expiryCutoffMillis(long nowMillis) {
        return Math.max(0L, nowMillis - RETENTION_MILLIS);
    }

    static String pendingEventSortOrder() {
        return COLUMN_RECEIVED_AT_MS + " DESC, " + COLUMN_EVENT_ID + " DESC";
    }

    private static void purgeExpired(SQLiteDatabase database, long nowMillis) {
        database.delete(
            TABLE_EVENTS,
            COLUMN_RECEIVED_AT_MS + " < ?",
            new String[] { String.valueOf(expiryCutoffMillis(nowMillis)) }
        );
    }

    private static void trimToLimits(SQLiteDatabase database) {
        database.execSQL(
            "DELETE FROM " + TABLE_EVENTS + " WHERE rowid NOT IN (" +
            "SELECT rowid FROM " + TABLE_EVENTS + " ORDER BY " +
            COLUMN_RECEIVED_AT_MS + " DESC, rowid DESC LIMIT " + MAX_PENDING_EVENTS +
            ")"
        );

        while (storedEventJsonBytes(database) > MAX_STORED_EVENT_JSON_BYTES) {
            database.execSQL(
                "DELETE FROM " + TABLE_EVENTS + " WHERE rowid = (" +
                "SELECT rowid FROM " + TABLE_EVENTS + " ORDER BY " +
                COLUMN_RECEIVED_AT_MS + " ASC, rowid ASC LIMIT 1)"
            );
        }
    }

    private static long storedEventJsonBytes(SQLiteDatabase database) {
        try (
            Cursor cursor = database.rawQuery(
                "SELECT COALESCE(SUM(LENGTH(" + COLUMN_EVENT_JSON + ")), 0) FROM " + TABLE_EVENTS,
                null
            )
        ) {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        }
    }

    static final class PendingEvent {

        final String eventId;
        final String recipientPubkey;
        final String relayUrl;
        final long receivedAtMillis;
        final JSONObject event;

        private PendingEvent(
            String eventId,
            String recipientPubkey,
            String relayUrl,
            long receivedAtMillis,
            JSONObject event
        ) {
            this.eventId = eventId;
            this.recipientPubkey = recipientPubkey;
            this.relayUrl = relayUrl;
            this.receivedAtMillis = receivedAtMillis;
            this.event = event;
        }
    }
}
