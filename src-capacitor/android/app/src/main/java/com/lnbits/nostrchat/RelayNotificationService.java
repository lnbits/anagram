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
import android.net.NetworkCapabilities;
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
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
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
    static final String EXTRA_CHAT_PUBKEY = "nostr_chat_chat_pubkey";
    static final String EXTRA_OPEN_CHATS_LIST = "nostr_chat_open_chats_list";
    static final String EXTRA_NOTIFICATION_COUNT_KEY = "nostr_chat_notification_count_key";

    private static final String SERVICE_CHANNEL_ID = "nostr_chat_background_listener";
    private static final String MESSAGE_CHANNEL_ID = "nostr_chat_messages";
    private static final int SERVICE_NOTIFICATION_ID = 4101;
    private static final int GENERIC_MESSAGE_NOTIFICATION_ID = 4102;
    private static final String GENERIC_NOTIFICATION_COUNT_KEY = "generic";
    private static final String MESSAGE_NOTIFICATION_GROUP = "nostr_chat_conversations";
    private static final long GIFT_WRAP_RANDOMIZATION_WINDOW_SECONDS = 2L * 24L * 60L * 60L;
    private static final long EVENT_TIMESTAMP_TOLERANCE_SECONDS = 300L;
    private static final long MAX_RECONNECT_DELAY_MILLIS = 30_000L;
    private static final long SERVICE_NOTIFICATION_UPDATE_DELAY_MILLIS = 250L;
    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-fA-F]{64}$");
    private static final Pattern HEX_128 = Pattern.compile("^[0-9a-fA-F]{128}$");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable serviceNotificationUpdateTask = this::postServiceNotificationUpdate;
    private final Map<String, WebSocket> sockets = new HashMap<>();
    private final Map<String, Integer> reconnectAttempts = new HashMap<>();
    private final Map<String, Runnable> reconnectTasks = new HashMap<>();
    private final Set<String> openRelays = new HashSet<>();
    private final Map<String, NotificationConversation> directConversations = new HashMap<>();
    private final Map<String, NotificationConversation> groupConversations = new HashMap<>();
    private List<String> configuredRelays = new ArrayList<>();
    private Set<String> recipientPubkeys = new HashSet<>();
    private Map<String, String> recipientPrivateKeys = new LinkedHashMap<>();
    private String ownerPubkey = "";
    private boolean showConversationDetails = true;
    private OkHttpClient httpClient;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean isStopping;
    private boolean hasNetworkConnection;
    private boolean hasPostedForegroundNotification;

    @Override
    public void onCreate() {
        super.onCreate();
        logDebug("service-created");
        if (!isProcessInForeground()) {
            RelayNotificationPreferences.setAppForeground(this, false);
        }
        createNotificationChannels();
        hasNetworkConnection = hasUsableNetwork();
        httpClient = new OkHttpClient.Builder()
            .pingInterval(30L, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
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
        hasPostedForegroundNotification = false;
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
        clearMessageNotifications(context);
        if (disablePreference) {
            NotificationSecureStore.clear(context);
            NotificationAvatarCache.clear(context);
            RelayNotificationPreferences.clearNotificationContext(context);
        }
        context.stopService(new Intent(context, RelayNotificationService.class));
    }

    static void clearMessageNotification(Context context, String chatPubkey) {
        String normalizedChatPubkey = NotificationConversation.normalizePubkey(chatPubkey);
        if (normalizedChatPubkey == null) {
            return;
        }
        RelayNotificationPreferences.resetUnreadNotificationCount(context, normalizedChatPubkey);
        NotificationManagerCompat.from(context).cancel(notificationIdForChat(normalizedChatPubkey));
    }

    static void clearGenericMessageNotification(Context context) {
        RelayNotificationPreferences.resetUnreadNotificationCount(
            context,
            GENERIC_NOTIFICATION_COUNT_KEY
        );
        NotificationManagerCompat.from(context).cancel(GENERIC_MESSAGE_NOTIFICATION_ID);
    }

    static void clearMessageNotifications(Context context) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (String key : RelayNotificationPreferences.getUnreadConversationKeys(context)) {
            if (GENERIC_NOTIFICATION_COUNT_KEY.equals(key)) {
                manager.cancel(GENERIC_MESSAGE_NOTIFICATION_ID);
                continue;
            }
            String chatPubkey = NotificationConversation.normalizePubkey(key);
            if (chatPubkey != null) {
                manager.cancel(notificationIdForChat(chatPubkey));
            }
        }
        RelayNotificationPreferences.resetUnreadNotificationCounts(context);
    }

    private void startAsForegroundService() {
        Notification notification = createServiceNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
            hasPostedForegroundNotification = true;
            logDebug("foreground-notification-posted id=" + SERVICE_NOTIFICATION_ID);
            return;
        }
        startForeground(SERVICE_NOTIFICATION_ID, notification);
        hasPostedForegroundNotification = true;
        logDebug("foreground-notification-posted id=" + SERVICE_NOTIFICATION_ID);
    }

    private void stopListener(boolean disablePreference) {
        logDebug("listener-stop disablePreference=" + disablePreference);
        isStopping = true;
        if (disablePreference) {
            RelayNotificationPreferences.setEnabled(this, false);
        }
        clearMessageNotifications(this);
        if (disablePreference) {
            NotificationSecureStore.clear(this);
            NotificationAvatarCache.clear(this);
            RelayNotificationPreferences.clearNotificationContext(this);
        }
        closeAllSockets();
        stopForeground(STOP_FOREGROUND_REMOVE);
        hasPostedForegroundNotification = false;
        stopSelf();
    }

    private void reloadWatchPlan() {
        configuredRelays = RelayNotificationPreferences.getRelays(this);
        recipientPubkeys = RelayNotificationPreferences.getRecipientPubkeys(this);
        ownerPubkey = RelayNotificationPreferences.getOwnerPubkey(this);
        showConversationDetails = RelayNotificationPreferences.shouldShowConversationDetails(this);
        recipientPrivateKeys = showConversationDetails
            ? NotificationSecureStore.loadRecipientKeys(this)
            : new LinkedHashMap<>();
        directConversations.clear();
        groupConversations.clear();
        List<NotificationConversation> conversations = RelayNotificationPreferences.getConversations(
            this
        );
        for (NotificationConversation conversation : conversations) {
            if (conversation.recipientPubkey == null) {
                directConversations.put(conversation.chatPubkey, conversation);
            } else {
                groupConversations.put(conversation.recipientPubkey, conversation);
            }
        }
        logDebug(
            "watch-plan-loaded relays=" + configuredRelays.size() +
            " recipients=" + recipientPubkeys.size() +
            " conversations=" + conversations.size() +
            " decryptableRecipients=" + recipientPrivateKeys.size()
        );
        if (configuredRelays.isEmpty() || recipientPubkeys.isEmpty() || ownerPubkey.isEmpty()) {
            logWarning("watch-plan-rejected reason=empty");
            stopListener(true);
            return;
        }

        isStopping = false;
        closeAllSockets();
        reconnectAttempts.clear();
        updateServiceNotification();
        if (!hasNetworkConnection) {
            return;
        }
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

        cancelReconnectTask(relayUrl);
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
            openRelays.remove(relayUrl);
            if (
                isStopping ||
                !configuredRelays.contains(relayUrl) ||
                reconnectTasks.containsKey(relayUrl)
            ) {
                updateServiceNotification();
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
            Runnable reconnectTask = () -> {
                reconnectTasks.remove(relayUrl);
                if (hasNetworkConnection) {
                    connectRelay(relayUrl);
                }
                updateServiceNotification();
            };
            reconnectTasks.put(relayUrl, reconnectTask);
            handler.postDelayed(reconnectTask, delay);
            updateServiceNotification();
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
        openRelays.clear();
        for (Runnable reconnectTask : reconnectTasks.values()) {
            handler.removeCallbacks(reconnectTask);
        }
        reconnectTasks.clear();
    }

    private void cancelReconnectTask(String relayUrl) {
        Runnable reconnectTask = reconnectTasks.remove(relayUrl);
        if (reconnectTask != null) {
            handler.removeCallbacks(reconnectTask);
        }
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

            NotificationTarget target = resolveNotificationTarget(event, recipientPubkey);
            if (target == null) {
                logDebug("gift-wrap-accepted event=" + eventLabel + " action=notification-suppressed");
                return;
            }
            logDebug(
                "gift-wrap-accepted event=" + eventLabel +
                " action=notify mode=" + (target.conversation == null ? "generic" : "conversation")
            );
            showMessageNotification(target);
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

    @Nullable
    private NotificationTarget resolveNotificationTarget(JSONObject wrappedEvent, String recipientPubkey) {
        if (!showConversationDetails) {
            return NotificationTarget.generic();
        }

        String recipientPrivateKey = recipientPrivateKeys.get(recipientPubkey);
        if (recipientPrivateKey == null) {
            return NotificationTarget.generic();
        }

        try {
            String sealPlaintext = Nip44Decryptor.decrypt(
                wrappedEvent.optString("content", ""),
                recipientPrivateKey,
                wrappedEvent.optString("pubkey", "")
            );
            JSONObject seal = new JSONObject(sealPlaintext);
            if (!isValidSignedEvent(seal, 13)) {
                return null;
            }

            String senderPubkey = seal.optString("pubkey", "").toLowerCase(Locale.ROOT);
            String rumorPlaintext = Nip44Decryptor.decrypt(
                seal.optString("content", ""),
                recipientPrivateKey,
                senderPubkey
            );
            JSONObject rumor = new JSONObject(rumorPlaintext);
            if (
                rumor.optInt("kind", -1) != 14 ||
                !senderPubkey.equals(rumor.optString("pubkey", "").toLowerCase(Locale.ROOT)) ||
                !isValidRumor(rumor) ||
                senderPubkey.equals(ownerPubkey) ||
                !hasRecipientTag(rumor.optJSONArray("tags"), recipientPubkey) ||
                rumor.optString("content", "").trim().isEmpty()
            ) {
                return null;
            }

            NotificationConversation groupConversation = groupConversations.get(recipientPubkey);
            if (groupConversation != null) {
                return groupConversation.notificationsEnabled
                    ? NotificationTarget.conversation(groupConversation)
                    : null;
            }
            if (!recipientPubkey.equals(ownerPubkey)) {
                return null;
            }

            NotificationConversation directConversation = directConversations.get(senderPubkey);
            if (directConversation != null) {
                return directConversation.notificationsEnabled
                    ? NotificationTarget.conversation(directConversation)
                    : null;
            }
            String fallbackName = senderPubkey.substring(0, 8) + "…" + senderPubkey.substring(60);
            return NotificationTarget.conversation(
                new NotificationConversation(
                    senderPubkey,
                    null,
                    fallbackName,
                    "",
                    fallbackName.substring(0, 2),
                    true
                )
            );
        } catch (GeneralSecurityException | JSONException exception) {
            logDebug("gift-wrap-details-rejected reason=" + exceptionSummary(exception));
            return null;
        }
    }

    private boolean isValidSignedEvent(JSONObject event, int expectedKind) throws JSONException {
        String eventId = event.optString("id", "").toLowerCase(Locale.ROOT);
        String pubkey = event.optString("pubkey", "").toLowerCase(Locale.ROOT);
        String signature = event.optString("sig", "").toLowerCase(Locale.ROOT);
        return (
            event.optInt("kind", -1) == expectedKind &&
            HEX_64.matcher(eventId).matches() &&
            HEX_64.matcher(pubkey).matches() &&
            HEX_128.matcher(signature).matches() &&
            eventId.equals(computeEventId(event)) &&
            SchnorrSignatureVerifier.verify(eventId, pubkey, signature)
        );
    }

    private boolean isValidRumor(JSONObject event) throws JSONException {
        String eventId = event.optString("id", "").toLowerCase(Locale.ROOT);
        String pubkey = event.optString("pubkey", "").toLowerCase(Locale.ROOT);
        return (
            HEX_64.matcher(eventId).matches() &&
            HEX_64.matcher(pubkey).matches() &&
            eventId.equals(computeEventId(event))
        );
    }

    private boolean hasRecipientTag(@Nullable JSONArray tags, String recipientPubkey) {
        if (tags == null) {
            return false;
        }
        for (int index = 0; index < tags.length(); index += 1) {
            JSONArray tag = tags.optJSONArray(index);
            if (
                tag != null &&
                tag.length() >= 2 &&
                "p".equals(tag.optString(0)) &&
                recipientPubkey.equals(tag.optString(1, "").toLowerCase(Locale.ROOT))
            ) {
                return true;
            }
        }
        return false;
    }

    private void showMessageNotification(NotificationTarget target) {
        NotificationConversation conversation = target.conversation;
        String countKey = conversation == null
            ? GENERIC_NOTIFICATION_COUNT_KEY
            : conversation.chatPubkey;
        int unreadCount = RelayNotificationPreferences.incrementUnreadNotificationCount(
            this,
            countKey
        );
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_VIEW);
        if (conversation == null) {
            openIntent.putExtra(EXTRA_OPEN_CHATS_LIST, true);
        } else {
            openIntent.putExtra(EXTRA_CHAT_PUBKEY, conversation.chatPubkey);
        }
        openIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int notificationId = conversation == null
            ? GENERIC_MESSAGE_NOTIFICATION_ID
            : notificationIdForChat(conversation.chatPubkey);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            notificationId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent dismissIntent = new Intent(this, NotificationDismissReceiver.class);
        dismissIntent.putExtra(EXTRA_NOTIFICATION_COUNT_KEY, countKey);
        PendingIntent dismissPendingIntent = PendingIntent.getBroadcast(
            this,
            notificationId,
            dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String message = unreadCount == 1 ? "1 new message" : unreadCount + " new messages";
        String title = conversation == null ? "Nostr Chat" : conversation.name;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.nostr_chat_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setNumber(unreadCount)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(pendingIntent)
            .setDeleteIntent(dismissPendingIntent)
            .setGroup(MESSAGE_NOTIFICATION_GROUP)
            .setPublicVersion(createRedactedMessageNotification(unreadCount, pendingIntent));
        if (conversation != null) {
            builder.setLargeIcon(NotificationAvatarCache.load(this, conversation));
        }
        Notification notification = builder.build();

        try {
            NotificationManagerCompat.from(this).notify(notificationId, notification);
            logDebug(
                "message-notification-posted id=" + notificationId +
                " unreadCount=" + unreadCount
            );
        } catch (SecurityException exception) {
            logWarning("message-notification-failed " + exceptionSummary(exception));
        }
    }

    private Notification createRedactedMessageNotification(
        int unreadCount,
        PendingIntent pendingIntent
    ) {
        String message = unreadCount == 1 ? "1 new message" : unreadCount + " new messages";
        return new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.nostr_chat_notification)
            .setContentTitle("Nostr Chat")
            .setContentText(message)
            .setNumber(unreadCount)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pendingIntent)
            .build();
    }

    private Notification createServiceNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_VIEW);
        openIntent.putExtra(EXTRA_OPEN_CHATS_LIST, true);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.nostr_chat_notification)
            .setContentTitle("Standing by for messages")
            .setContentText(
                serviceStatusText(
                    openRelays.size(),
                    configuredRelays.size(),
                    hasNetworkConnection,
                    !reconnectTasks.isEmpty() || !reconnectAttempts.isEmpty()
                )
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(openPendingIntent)
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
        serviceChannel.setDescription("Keeps direct Nostr relay connections ready for messages");
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel messageChannel = new NotificationChannel(
            MESSAGE_CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        messageChannel.setDescription("Incoming Nostr Chat message counts");
        manager.createNotificationChannel(messageChannel);
    }

    static String serviceStatusText(
        int connectedRelays,
        int totalRelays,
        boolean networkAvailable,
        boolean retrying
    ) {
        int connected = Math.max(0, connectedRelays);
        int total = Math.max(0, totalRelays);
        if (!networkAvailable) {
            return "Offline · waiting for network";
        }
        if (connected == 0) {
            return retrying
                ? "No relay connection · retrying"
                : "Connecting to relays…";
        }
        String connectedStatus = connected + " of " + total + " relays on";
        return connected < total || retrying
            ? connectedStatus + " · reconnecting"
            : connectedStatus;
    }

    private void updateServiceNotification() {
        if (!hasPostedForegroundNotification || isStopping) {
            return;
        }
        handler.removeCallbacks(serviceNotificationUpdateTask);
        handler.postDelayed(
            serviceNotificationUpdateTask,
            SERVICE_NOTIFICATION_UPDATE_DELAY_MILLIS
        );
    }

    private void postServiceNotificationUpdate() {
        if (!hasPostedForegroundNotification || isStopping) {
            return;
        }
        try {
            NotificationManagerCompat.from(this).notify(
                SERVICE_NOTIFICATION_ID,
                createServiceNotification()
            );
        } catch (SecurityException exception) {
            logWarning("foreground-notification-update-failed " + exceptionSummary(exception));
        }
    }

    private void registerNetworkCallback() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                logDebug("network-available action=connect-relays");
                handler.postDelayed(() -> syncNetworkState(true), 500L);
            }

            @Override
            public void onLost(@NonNull Network network) {
                logDebug("network-lost action=wait");
                handler.postDelayed(() -> syncNetworkState(hasUsableNetwork()), 250L);
            }
        };
        connectivityManager.registerDefaultNetworkCallback(networkCallback);
    }

    private void syncNetworkState(boolean isAvailable) {
        hasNetworkConnection = isAvailable;
        if (isStopping || !RelayNotificationPreferences.isEnabled(this)) {
            updateServiceNotification();
            return;
        }
        if (!hasNetworkConnection) {
            closeAllSockets();
            updateServiceNotification();
            return;
        }
        for (String relayUrl : configuredRelays) {
            connectRelay(relayUrl);
        }
        updateServiceNotification();
    }

    private boolean hasUsableNetwork() {
        ConnectivityManager manager = connectivityManager != null
            ? connectivityManager
            : (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) {
            return true;
        }
        Network activeNetwork = manager.getActiveNetwork();
        if (activeNetwork == null) {
            return false;
        }
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(activeNetwork);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
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

    static int notificationIdForChat(String chatPubkey) {
        byte[] hash;
        try {
            hash = MessageDigest.getInstance("SHA-256").digest(
                chatPubkey.getBytes(StandardCharsets.UTF_8)
            );
        } catch (NoSuchAlgorithmException exception) {
            return 100_000 + Math.floorMod(chatPubkey.hashCode(), 900_000);
        }
        int value =
            ((hash[0] & 0x7f) << 24) |
            ((hash[1] & 0xff) << 16) |
            ((hash[2] & 0xff) << 8) |
            (hash[3] & 0xff);
        return 100_000 + Math.floorMod(value, 2_000_000_000);
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
            handler.post(() -> {
                if (sockets.get(relayUrl) != webSocket) {
                    webSocket.close(1000, "Stale notification connection");
                    return;
                }
                reconnectAttempts.remove(relayUrl);
                cancelReconnectTask(relayUrl);
                openRelays.add(relayUrl);
                updateServiceNotification();
            });
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

    private static final class NotificationTarget {

        @Nullable
        private final NotificationConversation conversation;

        private NotificationTarget(@Nullable NotificationConversation conversation) {
            this.conversation = conversation;
        }

        private static NotificationTarget generic() {
            return new NotificationTarget(null);
        }

        private static NotificationTarget conversation(NotificationConversation conversation) {
            return new NotificationTarget(conversation);
        }
    }
}
