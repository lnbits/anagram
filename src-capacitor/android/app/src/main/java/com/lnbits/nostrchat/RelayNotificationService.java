package com.lnbits.nostrchat;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class RelayNotificationService extends Service {

    private static final String LOG_TAG = "NostrChatRelay";
    static final String ACTION_START_OR_REFRESH = "com.lnbits.nostrchat.notifications.START_OR_REFRESH";
    static final String ACTION_STOP = "com.lnbits.nostrchat.notifications.STOP";
    static final String EXTRA_RECIPIENT_PUBKEY = "nostr_chat_recipient_pubkey";

    private static final String SERVICE_CHANNEL_ID = "nostr_chat_background_listener";
    private static final String MESSAGE_CHANNEL_ID = "nostr_chat_messages";
    private static final int SERVICE_NOTIFICATION_ID = 4101;
    private static final int MESSAGE_NOTIFICATION_ID = 4102;
    private static final long GIFT_WRAP_RANDOMIZATION_WINDOW_SECONDS = 2L * 24L * 60L * 60L;
    private static final long EVENT_TIMESTAMP_TOLERANCE_SECONDS = 300L;
    private static final long MAX_RECONNECT_DELAY_MILLIS = 30_000L;
    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-fA-F]{64}$");
    private static final Pattern HEX_128 = Pattern.compile("^[0-9a-fA-F]{128}$");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, WebSocket> sockets = new HashMap<>();
    private final Map<String, Integer> reconnectAttempts = new HashMap<>();
    private List<String> configuredRelays = new ArrayList<>();
    private Set<String> recipientPubkeys = new HashSet<>();
    private OkHttpClient httpClient;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean isStopping;

    @Override
    public void onCreate() {
        super.onCreate();
        logDebug("service-created");
        if (!isProcessInForeground()) {
            RelayNotificationPreferences.setAppForeground(this, false);
        }
        createNotificationChannels();
        httpClient = new OkHttpClient.Builder()
            .pingInterval(30L, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            logDebug("service-stop-requested source=intent");
            stopListener(true);
            return START_NOT_STICKY;
        }

        if (!RelayNotificationPreferences.isEnabled(this)) {
            logDebug("service-start-skipped reason=disabled");
            stopListener(false);
            return START_NOT_STICKY;
        }

        logDebug("service-start startId=" + startId + " flags=" + flags);
        startAsForegroundService();
        reloadWatchPlan();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        logDebug("service-destroyed sockets=" + sockets.size());
        isStopping = true;
        handler.removeCallbacksAndMessages(null);
        closeAllSockets();
        unregisterNetworkCallback();
        if (httpClient != null) {
            httpClient.dispatcher().executorService().shutdown();
            httpClient.connectionPool().evictAll();
        }
        super.onDestroy();
    }

    static void startOrRefresh(Context context) {
        Intent intent = new Intent(context, RelayNotificationService.class);
        intent.setAction(ACTION_START_OR_REFRESH);
        ContextCompat.startForegroundService(context, intent);
    }

    static void requestStop(Context context, boolean disablePreference) {
        if (disablePreference) {
            RelayNotificationPreferences.setEnabled(context, false);
        }
        clearMessageNotification(context);
        context.stopService(new Intent(context, RelayNotificationService.class));
    }

    static void clearMessageNotification(Context context) {
        RelayNotificationPreferences.resetUnreadNotificationCount(context);
        NotificationManagerCompat.from(context).cancel(MESSAGE_NOTIFICATION_ID);
    }

    private void startAsForegroundService() {
        Notification notification = createServiceNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
            logDebug("foreground-notification-posted id=" + SERVICE_NOTIFICATION_ID);
            return;
        }
        startForeground(SERVICE_NOTIFICATION_ID, notification);
        logDebug("foreground-notification-posted id=" + SERVICE_NOTIFICATION_ID);
    }

    private void stopListener(boolean disablePreference) {
        logDebug("listener-stop disablePreference=" + disablePreference);
        isStopping = true;
        if (disablePreference) {
            RelayNotificationPreferences.setEnabled(this, false);
        }
        clearMessageNotification(this);
        closeAllSockets();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void reloadWatchPlan() {
        configuredRelays = RelayNotificationPreferences.getRelays(this);
        recipientPubkeys = RelayNotificationPreferences.getRecipientPubkeys(this);
        logDebug(
            "watch-plan-loaded relays=" + configuredRelays.size() +
            " recipients=" + recipientPubkeys.size()
        );
        if (configuredRelays.isEmpty() || recipientPubkeys.isEmpty()) {
            logWarning("watch-plan-rejected reason=empty");
            stopListener(true);
            return;
        }

        isStopping = false;
        closeAllSockets();
        reconnectAttempts.clear();
        for (String relayUrl : configuredRelays) {
            connectRelay(relayUrl);
        }
    }

    private void connectRelay(String relayUrl) {
        if (isStopping || !RelayNotificationPreferences.isEnabled(this) || !configuredRelays.contains(relayUrl)) {
            return;
        }
        if (sockets.containsKey(relayUrl)) {
            return;
        }

        logDebug("relay-connect-start relay=" + relayLogId(relayUrl));
        Request request = new Request.Builder().url(relayUrl).build();
        RelayWebSocketListener listener = new RelayWebSocketListener(relayUrl);
        WebSocket socket = httpClient.newWebSocket(request, listener);
        sockets.put(relayUrl, socket);
    }

    private void scheduleReconnect(String relayUrl, WebSocket failedSocket) {
        handler.post(() -> {
            if (sockets.get(relayUrl) != failedSocket) {
                return;
            }
            sockets.remove(relayUrl);
            if (isStopping || !configuredRelays.contains(relayUrl)) {
                return;
            }
            int attempts = reconnectAttempts.getOrDefault(relayUrl, 0) + 1;
            reconnectAttempts.put(relayUrl, attempts);
            long delay = Math.min(MAX_RECONNECT_DELAY_MILLIS, 1_000L << Math.min(attempts - 1, 5));
            logWarning(
                "relay-reconnect-scheduled relay=" + relayLogId(relayUrl) +
                " attempt=" + attempts +
                " delayMs=" + delay
            );
            handler.postDelayed(() -> connectRelay(relayUrl), delay);
        });
    }

    private void closeAllSockets() {
        if (!sockets.isEmpty()) {
            logDebug("relay-close-all count=" + sockets.size());
        }
        for (WebSocket socket : sockets.values()) {
            socket.close(1000, "Notification listener refresh");
        }
        sockets.clear();
    }

    private String createSubscription(String relayUrl) throws JSONException {
        String subscriptionId = "notifications-" + shortHash(relayUrl);
        long since = subscriptionSince(System.currentTimeMillis() / 1000L);

        JSONObject filter = new JSONObject();
        filter.put("kinds", new JSONArray().put(1059));
        filter.put("#p", new JSONArray(recipientPubkeys));
        filter.put("since", since);

        logDebug(
            "relay-subscription-built relay=" + relayLogId(relayUrl) +
            " recipients=" + recipientPubkeys.size() +
            " since=" + since
        );

        return new JSONArray().put("REQ").put(subscriptionId).put(filter).toString();
    }

    static long subscriptionSince(long nowSeconds) {
        return Math.max(
            0L,
            nowSeconds - GIFT_WRAP_RANDOMIZATION_WINDOW_SECONDS - EVENT_TIMESTAMP_TOLERANCE_SECONDS
        );
    }

    static boolean isPlausibleGiftWrapTimestamp(long createdAt, long nowSeconds) {
        return (
            createdAt >= subscriptionSince(nowSeconds) &&
            createdAt <= nowSeconds + EVENT_TIMESTAMP_TOLERANCE_SECONDS
        );
    }

    static boolean shouldNotifyEvent(boolean relayInitializedAtConnect, boolean relayCaughtUp) {
        return relayInitializedAtConnect || relayCaughtUp;
    }

    private void handleRelayMessage(RelayWebSocketListener source, String message) {
        try {
            JSONArray envelope = new JSONArray(message);
            String messageType = envelope.optString(0);
            if (
                "EOSE".equals(messageType) &&
                envelope.length() >= 2 &&
                source.subscriptionId.equals(envelope.optString(1))
            ) {
                source.markCaughtUp();
                logDebug("relay-eose relay=" + relayLogId(source.relayUrl));
                return;
            }
            if (envelope.length() < 3 || !"EVENT".equals(messageType)) {
                return;
            }

            JSONObject event = envelope.optJSONObject(2);
            if (event == null || event.optInt("kind", -1) != 1059) {
                return;
            }

            String eventId = event.optString("id", "").toLowerCase(Locale.ROOT);
            String eventPubkey = event.optString("pubkey", "");
            String signature = event.optString("sig", "");
            long createdAt = event.optLong("created_at", 0L);
            long now = System.currentTimeMillis() / 1000L;
            String eventLabel = eventLogId(eventId);
            logDebug(
                "gift-wrap-received relay=" + relayLogId(source.relayUrl) +
                " event=" + eventLabel
            );
            if (!HEX_64.matcher(eventId).matches()) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=event-id-format");
                return;
            }
            if (!HEX_64.matcher(eventPubkey).matches()) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=pubkey-format");
                return;
            }
            if (!HEX_128.matcher(signature).matches()) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=signature-format");
                return;
            }
            if (!isPlausibleGiftWrapTimestamp(createdAt, now)) {
                logDebug(
                    "gift-wrap-rejected event=" + eventLabel +
                    " reason=timestamp deltaSeconds=" + (createdAt - now)
                );
                return;
            }
            if (!eventId.equals(computeEventId(event))) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=event-id-mismatch");
                return;
            }
            if (!SchnorrSignatureVerifier.verify(eventId, eventPubkey, signature)) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=signature-invalid");
                return;
            }

            String recipientPubkey = findWatchedRecipient(event.optJSONArray("tags"));
            if (recipientPubkey == null) {
                logDebug("gift-wrap-rejected event=" + eventLabel + " reason=recipient-not-watched");
                return;
            }
            if (!RelayNotificationPreferences.markEventSeen(this, eventId)) {
                logDebug("gift-wrap-ignored event=" + eventLabel + " reason=duplicate");
                return;
            }

            if (!source.shouldNotifyEvent()) {
                logDebug("gift-wrap-accepted event=" + eventLabel + " action=catch-up-only");
                return;
            }
            if (RelayNotificationPreferences.isAppForeground(this)) {
                logDebug("gift-wrap-accepted event=" + eventLabel + " action=foreground-suppressed");
                return;
            }

            logDebug("gift-wrap-accepted event=" + eventLabel + " action=notify");
            showMessageNotification(recipientPubkey);
        } catch (JSONException exception) {
            logWarning(
                "relay-message-rejected relay=" + relayLogId(source.relayUrl) +
                " reason=json-error " + exceptionSummary(exception)
            );
        }
    }

    @Nullable
    private String findWatchedRecipient(@Nullable JSONArray tags) {
        if (tags == null) {
            return null;
        }

        for (int index = 0; index < tags.length(); index += 1) {
            JSONArray tag = tags.optJSONArray(index);
            if (tag == null || tag.length() < 2 || !"p".equals(tag.optString(0))) {
                continue;
            }
            String candidate = tag.optString(1, "").toLowerCase(Locale.ROOT);
            if (HEX_64.matcher(candidate).matches() && recipientPubkeys.contains(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private String computeEventId(JSONObject event) throws JSONException {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null || !event.has("content")) {
            return "";
        }
        JSONArray serializedEvent = new JSONArray()
            .put(0)
            .put(event.optString("pubkey", ""))
            .put(event.optLong("created_at", 0L))
            .put(event.optInt("kind", -1))
            .put(tags)
            .put(event.optString("content", ""));
        return computeCanonicalEventId(serializedEvent.toString());
    }

    static String computeCanonicalEventId(String serializedEvent) {
        // Android's org.json escapes '/', while NIP-01 canonical JSON (JSON.stringify) does not.
        return sha256(serializedEvent.replace("\\/", "/"));
    }

    private void showMessageNotification(String recipientPubkey) {
        int unreadCount = RelayNotificationPreferences.incrementUnreadNotificationCount(this);
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_VIEW);
        openIntent.putExtra(EXTRA_RECIPIENT_PUBKEY, recipientPubkey);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String message = unreadCount == 1 ? "New message" : unreadCount + " new messages";
        Notification notification = new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.nostr_chat_notification)
            .setContentTitle("Nostr Chat")
            .setContentText(message)
            .setNumber(unreadCount)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(pendingIntent)
            .build();

        try {
            NotificationManagerCompat.from(this).notify(MESSAGE_NOTIFICATION_ID, notification);
            logDebug(
                "message-notification-posted id=" + MESSAGE_NOTIFICATION_ID +
                " unreadCount=" + unreadCount
            );
        } catch (SecurityException exception) {
            logWarning("message-notification-failed " + exceptionSummary(exception));
        }
    }

    private Notification createServiceNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent stopIntent = new Intent(this, StopRelayNotificationReceiver.class);
        PendingIntent stopPendingIntent = PendingIntent.getBroadcast(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.nostr_chat_notification)
            .setContentTitle("Nostr Chat notifications")
            .setContentText("Listening for new messages")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(openPendingIntent)
            .addAction(0, "Stop", stopPendingIntent)
            .build();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);

        NotificationChannel serviceChannel = new NotificationChannel(
            SERVICE_CHANNEL_ID,
            "Background message listener",
            NotificationManager.IMPORTANCE_LOW
        );
        serviceChannel.setDescription("Keeps the private Nostr relay listener running");
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel messageChannel = new NotificationChannel(
            MESSAGE_CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        messageChannel.setDescription("Generic alerts for incoming Nostr Chat messages");
        manager.createNotificationChannel(messageChannel);
    }

    private void registerNetworkCallback() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                logDebug("network-available action=refresh-listener");
                handler.postDelayed(() -> {
                    if (!isStopping && RelayNotificationPreferences.isEnabled(RelayNotificationService.this)) {
                        reloadWatchPlan();
                    }
                }, 500L);
            }
        };
        connectivityManager.registerDefaultNetworkCallback(networkCallback);
    }

    private void unregisterNetworkCallback() {
        if (connectivityManager == null || networkCallback == null) {
            return;
        }
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        } catch (IllegalArgumentException ignored) {}
        networkCallback = null;
    }

    private boolean isProcessInForeground() {
        ActivityManager.RunningAppProcessInfo processInfo = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(processInfo);
        return processInfo.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    private static String shortHash(String value) {
        String hash = sha256(value);
        return hash.length() >= 12 ? hash.substring(0, 12) : Integer.toHexString(value.hashCode());
    }

    private static String relayLogId(String relayUrl) {
        return shortHash(relayUrl);
    }

    private static String eventLogId(String eventId) {
        if (eventId == null || eventId.isEmpty()) {
            return "missing";
        }
        return eventId.length() <= 12 ? eventId : eventId.substring(0, 12);
    }

    private static String exceptionSummary(Throwable throwable) {
        String type = throwable.getClass().getSimpleName();
        String message = throwable.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return type;
        }
        String normalized = message.replace('\n', ' ').replace('\r', ' ').trim();
        if (normalized.length() > 160) {
            normalized = normalized.substring(0, 160);
        }
        return type + ": " + normalized;
    }

    private void logDebug(String message) {
        if (isDebuggable()) {
            Log.d(LOG_TAG, message);
        }
    }

    private void logWarning(String message) {
        if (isDebuggable()) {
            Log.w(LOG_TAG, message);
        }
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(hash.length * 2);
            for (byte item : hash) {
                result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException exception) {
            return "";
        }
    }

    private final class RelayWebSocketListener extends WebSocketListener {

        private final String relayUrl;
        private final String subscriptionId;
        private final boolean initializedAtConnect;
        private boolean caughtUp;

        private RelayWebSocketListener(String relayUrl) {
            this.relayUrl = relayUrl;
            this.subscriptionId = "notifications-" + shortHash(relayUrl);
            this.initializedAtConnect = RelayNotificationPreferences.isRelayInitialized(
                RelayNotificationService.this,
                relayUrl
            );
        }

        private void markCaughtUp() {
            caughtUp = true;
            RelayNotificationPreferences.markRelayInitialized(
                RelayNotificationService.this,
                relayUrl
            );
        }

        private boolean shouldNotifyEvent() {
            return RelayNotificationService.shouldNotifyEvent(initializedAtConnect, caughtUp);
        }

        @Override
        public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            handler.post(() -> reconnectAttempts.remove(relayUrl));
            logDebug(
                "relay-open relay=" + relayLogId(relayUrl) +
                " responseCode=" + response.code()
            );
            try {
                boolean queued = webSocket.send(createSubscription(relayUrl));
                logDebug(
                    "relay-subscription-sent relay=" + relayLogId(relayUrl) +
                    " queued=" + queued
                );
            } catch (JSONException exception) {
                logWarning(
                    "relay-subscription-failed relay=" + relayLogId(relayUrl) +
                    " " + exceptionSummary(exception)
                );
                webSocket.close(1002, "Invalid notification subscription");
            }
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            handleRelayMessage(this, text);
        }

        @Override
        public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            logWarning(
                "relay-closed relay=" + relayLogId(relayUrl) +
                " code=" + code +
                " reason=" + sanitizeLogValue(reason)
            );
            scheduleReconnect(relayUrl, webSocket);
        }

        @Override
        public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable throwable, @Nullable Response response) {
            logWarning(
                "relay-failed relay=" + relayLogId(relayUrl) +
                " responseCode=" + (response == null ? "none" : response.code()) +
                " " + exceptionSummary(throwable)
            );
            scheduleReconnect(relayUrl, webSocket);
        }
    }

    private static String sanitizeLogValue(String value) {
        String normalized = value.replace('\n', ' ').replace('\r', ' ').trim();
        return normalized.length() <= 160 ? normalized : normalized.substring(0, 160);
    }
}
