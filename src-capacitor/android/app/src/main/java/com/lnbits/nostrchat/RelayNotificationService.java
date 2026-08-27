package com.lnbits.nostrchat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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

    static final String ACTION_START_OR_REFRESH = "com.lnbits.nostrchat.notifications.START_OR_REFRESH";
    static final String ACTION_STOP = "com.lnbits.nostrchat.notifications.STOP";
    static final String EXTRA_RECIPIENT_PUBKEY = "nostr_chat_recipient_pubkey";

    private static final String SERVICE_CHANNEL_ID = "nostr_chat_background_listener";
    private static final String MESSAGE_CHANNEL_ID = "nostr_chat_messages";
    private static final int SERVICE_NOTIFICATION_ID = 4101;
    private static final int MESSAGE_NOTIFICATION_ID = 4102;
    private static final long SUBSCRIPTION_OVERLAP_SECONDS = 60L;
    private static final long MAX_FUTURE_EVENT_SECONDS = 300L;
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
            stopListener(true);
            return START_NOT_STICKY;
        }

        if (!RelayNotificationPreferences.isEnabled(this)) {
            stopListener(false);
            return START_NOT_STICKY;
        }

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
            return;
        }
        startForeground(SERVICE_NOTIFICATION_ID, notification);
    }

    private void stopListener(boolean disablePreference) {
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
        if (configuredRelays.isEmpty() || recipientPubkeys.isEmpty()) {
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
            handler.postDelayed(() -> connectRelay(relayUrl), delay);
        });
    }

    private void closeAllSockets() {
        for (WebSocket socket : sockets.values()) {
            socket.close(1000, "Notification listener refresh");
        }
        sockets.clear();
    }

    private String createSubscription(String relayUrl) throws JSONException {
        String subscriptionId = "notifications-" + shortHash(relayUrl);
        long listeningSince = RelayNotificationPreferences.getListeningSince(this);
        long lastEventCreatedAt = RelayNotificationPreferences.getLastEventCreatedAt(this);
        long since = Math.max(listeningSince, Math.max(0L, lastEventCreatedAt - SUBSCRIPTION_OVERLAP_SECONDS));

        JSONObject filter = new JSONObject();
        filter.put("kinds", new JSONArray().put(1059));
        filter.put("#p", new JSONArray(recipientPubkeys));
        filter.put("since", since);

        return new JSONArray().put("REQ").put(subscriptionId).put(filter).toString();
    }

    private void handleRelayMessage(String message) {
        try {
            JSONArray envelope = new JSONArray(message);
            if (envelope.length() < 3 || !"EVENT".equals(envelope.optString(0))) {
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
            if (
                !HEX_64.matcher(eventId).matches() ||
                !HEX_64.matcher(eventPubkey).matches() ||
                !HEX_128.matcher(signature).matches() ||
                createdAt < RelayNotificationPreferences.getListeningSince(this) ||
                createdAt > now + MAX_FUTURE_EVENT_SECONDS ||
                !eventId.equals(computeEventId(event)) ||
                !SchnorrSignatureVerifier.verify(eventId, eventPubkey, signature)
            ) {
                return;
            }

            String recipientPubkey = findWatchedRecipient(event.optJSONArray("tags"));
            if (recipientPubkey == null || !RelayNotificationPreferences.markEventSeen(this, eventId)) {
                return;
            }

            RelayNotificationPreferences.updateLastEventCreatedAt(this, createdAt);
            if (!RelayNotificationPreferences.isAppForeground(this)) {
                showMessageNotification(recipientPubkey);
            }
        } catch (JSONException ignored) {}
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
        return sha256(serializedEvent.toString());
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
        } catch (SecurityException ignored) {}
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

        private RelayWebSocketListener(String relayUrl) {
            this.relayUrl = relayUrl;
        }

        @Override
        public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            handler.post(() -> reconnectAttempts.remove(relayUrl));
            try {
                webSocket.send(createSubscription(relayUrl));
            } catch (JSONException exception) {
                webSocket.close(1002, "Invalid notification subscription");
            }
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            handleRelayMessage(text);
        }

        @Override
        public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            scheduleReconnect(relayUrl, webSocket);
        }

        @Override
        public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable throwable, @Nullable Response response) {
            scheduleReconnect(relayUrl, webSocket);
        }
    }
}
