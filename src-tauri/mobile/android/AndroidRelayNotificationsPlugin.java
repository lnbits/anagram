package com.nostr.anagram;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import android.app.Activity;
import android.webkit.WebView;
import app.tauri.plugin.JSObject;
import app.tauri.PermissionState;
import app.tauri.plugin.Plugin;
import app.tauri.plugin.Invoke;
import app.tauri.annotation.Command;
import app.tauri.annotation.TauriPlugin;
import app.tauri.annotation.Permission;
import app.tauri.annotation.PermissionCallback;
import java.net.URI;
import java.net.URISyntaxException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

@TauriPlugin(
    permissions = @Permission(
        strings = { Manifest.permission.POST_NOTIFICATIONS },
        alias = AndroidRelayNotificationsPlugin.NOTIFICATION_PERMISSION
    )
)
public final class AndroidRelayNotificationsPlugin extends Plugin {

    private final Activity activity;
    private JSObject pendingAction;
    // Key validation and SQLite batches must not block Android's WebView/UI thread.
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32)
    );
    private void background(Invoke call, Runnable operation) {
        try {
            worker.execute(() -> {
                try { operation.run(); }
                catch (RuntimeException ignored) { call.reject("Notification operation failed."); }
            });
        } catch (RejectedExecutionException ignored) { call.reject("Notification service is busy. Retry."); }
    }
    public AndroidRelayNotificationsPlugin(Activity activity) {
        super(activity);
        this.activity = activity;
    }
    private Context getContext() { return activity; }
    private Activity getActivity() { return activity; }

    static final String NOTIFICATION_PERMISSION = "receive";
    private static final String ACTION_EVENT = "notificationActionPerformed";
    private static final String PENDING_EVENTS_AVAILABLE_EVENT = "pendingEventsAvailable";
    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-fA-F]{64}$");
    private final Map<String, String> validatedRecipientKeys = new LinkedHashMap<>();
    private boolean hasSavedRecipientKeySnapshot;
    @Nullable
    private BroadcastReceiver pendingEventsReceiver;

    @Command
    public void checkPermissions(Invoke call) {
        resolvePermission(call);
    }

    @Command
    public void requestPermissions(Invoke call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolvePermission(call);
            return;
        }
        if (getPermissionState(NOTIFICATION_PERMISSION) == PermissionState.GRANTED) {
            resolvePermission(call);
            return;
        }
        requestPermissionForAlias(NOTIFICATION_PERMISSION, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(Invoke call) {
        resolvePermission(call);
    }

    @Command
    public void configure(Invoke call) {
        background(call, () -> configureInBackground(call));
    }

    private void configureInBackground(Invoke call) {
        if (!"granted".equals(notificationPermissionState())) {
            call.reject("Allow Android notifications before enabling the listener.");
            return;
        }
        boolean wasEnabled = RelayNotificationPreferences.isEnabled(getContext());
        List<String> previousRelays = RelayNotificationPreferences.getRelays(getContext());
        Set<String> previousRecipientPubkeys = RelayNotificationPreferences.getRecipientPubkeys(
            getContext()
        );
        String previousOwnerPubkey = RelayNotificationPreferences.getOwnerPubkey(getContext());
        List<String> relays = normalizeRelays(call.getArgs().optJSONArray("relays"));
        List<String> recipientPubkeys = normalizePubkeys(call.getArgs().optJSONArray("recipientPubkeys"));
        String ownerPubkey = normalizePubkey(call.getArgs().optString("ownerPubkey"));
        if (relays.isEmpty()) {
            call.reject("At least one readable ws:// or wss:// relay is required.");
            return;
        }
        if (ownerPubkey == null || recipientPubkeys.isEmpty() || !recipientPubkeys.contains(ownerPubkey)) {
            call.reject("At least one recipient public key is required.");
            return;
        }

        boolean startOnBoot = Boolean.TRUE.equals(call.getArgs().optBoolean("startOnBoot", true));
        boolean showConversationDetails = Boolean.TRUE.equals(
            call.getArgs().optBoolean("showConversationDetails", false)
        );
        boolean didChangeConversationDetails =
            RelayNotificationPreferences.shouldShowConversationDetails(getContext()) !=
            showConversationDetails;
        List<NotificationConversation> conversations = normalizeConversations(
            call.getArgs().optJSONArray("conversations")
        );
        Map<String, String> recipientKeys = normalizeRecipientKeys(
            call.getArgs().optJSONArray("recipientKeys"),
            recipientPubkeys,
            validatedRecipientKeys
        );
        boolean didChangeRecipientKeys =
            !hasSavedRecipientKeySnapshot || !recipientKeys.equals(validatedRecipientKeys);
        if (didChangeRecipientKeys) {
            try {
                NotificationSecureStore.saveRecipientKeys(getContext(), recipientKeys);
            } catch (GeneralSecurityException exception) {
                call.reject("Failed to protect notification decryption keys.");
                return;
            }
        }
        if (!previousOwnerPubkey.isEmpty() && !previousOwnerPubkey.equals(ownerPubkey)) {
            RelayNotificationEventInbox.clear(getContext());
            CallNotifications.clear(getContext());
        }
        validatedRecipientKeys.clear();
        validatedRecipientKeys.putAll(recipientKeys);
        hasSavedRecipientKeySnapshot = true;
        RelayNotificationPreferences.saveWatchPlan(
            getContext(),
            relays,
            ownerPubkey,
            recipientPubkeys,
            conversations,
            showConversationDetails
        );
        RelayNotificationPreferences.setStartOnBoot(getContext(), startOnBoot);
        RelayNotificationPreferences.setEnabled(getContext(), true);
        if (didChangeConversationDetails) {
            RelayNotificationService.clearMessageNotifications(getContext());
        }
        CallNotifications.refresh(getContext());
        NotificationAvatarCache.refreshAsync(getContext(), conversations);
        boolean shouldReconnect =
            !wasEnabled ||
            !RelayNotificationService.hasSameConnectionPlan(
                previousRelays,
                previousRecipientPubkeys,
                previousOwnerPubkey,
                relays,
                new LinkedHashSet<>(recipientPubkeys),
                ownerPubkey
            );
        try {
            RelayNotificationService.startOrRefresh(getContext(), shouldReconnect);
        } catch (RuntimeException exception) {
            RelayNotificationService.requestStop(getContext(), true);
            validatedRecipientKeys.clear();
            hasSavedRecipientKeySnapshot = false;
            call.reject("Could not start notifications. Open the app and retry.");
            return;
        }
        call.resolve(createState());
    }

    @Command
    public void stop(Invoke call) {
        background(call, () -> stopInBackground(call));
    }

    private void stopInBackground(Invoke call) {
        RelayNotificationService.requestStop(getContext(), true);
        hasSavedRecipientKeySnapshot = false;
        validatedRecipientKeys.clear();
        call.resolve(createState());
    }

    @Command
    public void setStartOnBoot(Invoke call) {
        Boolean startOnBoot = call.getArgs().optBoolean("enabled");
        if (!call.getArgs().has("enabled")) {
            call.reject("The enabled option is required.");
            return;
        }
        RelayNotificationPreferences.setStartOnBoot(getContext(), startOnBoot);
        call.resolve(createState());
    }

    @Command
    public void getState(Invoke call) {
        call.resolve(createState());
    }

    @Command
    public void getPendingEvents(Invoke call) {
        background(call, () -> getPendingEventsInBackground(call));
    }

    private void getPendingEventsInBackground(Invoke call) {
        String ownerPubkey = normalizePubkey(call.getArgs().optString("ownerPubkey"));
        JSObject result = new JSObject();
        JSONArray events = new JSONArray();
        result.put("events", events);
        if (
            ownerPubkey == null ||
            !ownerPubkey.equals(RelayNotificationPreferences.getOwnerPubkey(getContext()))
        ) {
            call.resolve(result);
            return;
        }

        Integer requestedLimit = call.getArgs().optInt(
            "limit",
            RelayNotificationEventInbox.MAX_BATCH_SIZE
        );
        List<RelayNotificationEventInbox.PendingEvent> pendingEvents =
            RelayNotificationEventInbox.list(
                getContext(),
                ownerPubkey,
                requestedLimit == null
                    ? RelayNotificationEventInbox.MAX_BATCH_SIZE
                    : requestedLimit,
                System.currentTimeMillis()
            );
        for (RelayNotificationEventInbox.PendingEvent pendingEvent : pendingEvents) {
            JSObject value = new JSObject();
            value.put("id", pendingEvent.eventId);
            value.put("recipientPubkey", pendingEvent.recipientPubkey);
            value.put("relayUrl", pendingEvent.relayUrl);
            value.put("receivedAtMillis", pendingEvent.receivedAtMillis);
            value.put("event", pendingEvent.event);
            events.put(value);
        }
        call.resolve(result);
    }

    @Command
    public void acknowledgePendingEvents(Invoke call) {
        background(call, () -> acknowledgePendingEventsInBackground(call));
    }

    private void acknowledgePendingEventsInBackground(Invoke call) {
        String ownerPubkey = normalizePubkey(call.getArgs().optString("ownerPubkey"));
        if (
            ownerPubkey == null ||
            !ownerPubkey.equals(RelayNotificationPreferences.getOwnerPubkey(getContext()))
        ) {
            call.resolve();
            return;
        }

        RelayNotificationEventInbox.acknowledge(
            getContext(),
            ownerPubkey,
            normalizePubkeys(call.getArgs().optJSONArray("eventIds"))
        );
        call.resolve();
    }

    @Command
    public void clearDeliveredNotifications(Invoke call) {
        String chatPubkey = normalizePubkey(call.getArgs().optString("chatPubkey"));
        if (chatPubkey == null) {
            RelayNotificationService.clearMessageNotifications(getContext());
        } else {
            RelayNotificationService.clearMessageNotification(getContext(), chatPubkey);
        }
        call.resolve();
    }

    @Override
    public void load(WebView webView) {
        super.load(webView);
        RelayNotificationPreferences.setAppForeground(activity, true);
        registerPendingEventsReceiver();
        dispatchNotificationIntent(getActivity().getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        dispatchNotificationIntent(intent);
    }

    @Override
    public void onDestroy() {
        CallNotifications.releaseForegroundCall();
        worker.shutdown();
        if (pendingEventsReceiver != null) {
            getContext().unregisterReceiver(pendingEventsReceiver);
            pendingEventsReceiver = null;
        }
        super.onDestroy();
    }

    @Override
    public void onResume() {
        RelayNotificationPreferences.setAppForeground(activity, true);
        RelayNotificationService.clearGenericMessageNotification(activity);
        trigger(PENDING_EVENTS_AVAILABLE_EVENT, new JSObject());
    }
    @Override
    public void onPause() {
        RelayNotificationPreferences.setAppForeground(activity, false);
    }
    private static JSObject toJSObject(JSONObject source) {
        JSObject result = new JSObject();
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) { String key = keys.next(); result.put(key, source.opt(key)); }
        return result;
    }

    @Command
    public void getCallNotificationState(Invoke call) {
        background(call, () -> call.resolve(toJSObject(CallNotifications.closed(getContext(), call.getArgs().optString("ownerPubkey")))));
    }

    @Command
    public void claimCallAnswer(Invoke call) {
        background(call, () -> {
            JSONObject action = CallNotifications.action(getContext(), call.getArgs().optString("token"), true);
            JSObject result = new JSObject(); result.put("valid", action != null); call.resolve(result);
        });
    }

    @Command
    public void syncCallState(Invoke call) {
        background(call, () -> {
            JSONObject a = call.getArgs();
            CallNotifications.sync(getContext(), a.optString("ownerPubkey"), a.optString("peer"), a.optString("callId"), a.optString("phase"), a.optBoolean("roomBusy"));
            call.resolve();
        });
    }

    @Command
    public void takeNotificationAction(Invoke invoke) {
        JSObject action = pendingAction;
        pendingAction = null;
        invoke.resolve(action);
    }

    private void registerPendingEventsReceiver() {
        if (pendingEventsReceiver != null) {
            return;
        }

        pendingEventsReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                trigger(PENDING_EVENTS_AVAILABLE_EVENT, new JSObject());
            }
        };
        ContextCompat.registerReceiver(
            getContext(),
            pendingEventsReceiver,
            new IntentFilter(RelayNotificationService.ACTION_PENDING_EVENTS_AVAILABLE),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    private void dispatchNotificationIntent(@Nullable Intent intent) {
        if (intent == null) {
            return;
        }

        String token = intent.getStringExtra(CallNotifications.EXTRA_TOKEN);
        if (token != null) {
            boolean answer = intent.getBooleanExtra(CallNotifications.EXTRA_ANSWER, false);
            intent.removeExtra(CallNotifications.EXTRA_TOKEN);
            intent.removeExtra(CallNotifications.EXTRA_ANSWER);
            JSONObject action = CallNotifications.action(getContext(), token, false);
            if (action != null) {
                JSObject event = toJSObject(action);
                event.put("answer", answer);
                event.put("chatPubkey", action.optString("peer"));
                pendingAction = event;
                trigger(ACTION_EVENT, new JSObject());
            }
            return;
        }

        String notificationOwner = normalizePubkey(intent.getStringExtra(RelayNotificationService.EXTRA_OWNER_PUBKEY));
        if (notificationOwner == null || !notificationOwner.equals(RelayNotificationPreferences.getOwnerPubkey(getContext()))) return;
        String chatPubkey = normalizePubkey(
            intent.getStringExtra(RelayNotificationService.EXTRA_CHAT_PUBKEY)
        );
        boolean openChats = intent.getBooleanExtra(
            RelayNotificationService.EXTRA_OPEN_CHATS_LIST,
            false
        );
        if (chatPubkey == null && !openChats) {
            return;
        }

        intent.removeExtra(RelayNotificationService.EXTRA_CHAT_PUBKEY);
        intent.removeExtra(RelayNotificationService.EXTRA_OPEN_CHATS_LIST);
        JSObject event = new JSObject();
        if (chatPubkey != null) {
            RelayNotificationService.clearMessageNotification(getContext(), chatPubkey);
            event.put("chatPubkey", chatPubkey);
        }
        event.put("openChats", openChats);
        event.put("ownerPubkey", notificationOwner);
        pendingAction = event;
        trigger(ACTION_EVENT, new JSObject());
    }

    private void resolvePermission(Invoke call) {
        JSObject result = new JSObject();
        result.put("receive", notificationPermissionState());
        call.resolve(result);
    }

    private String notificationPermissionState() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            return PermissionState.DENIED.toString();
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return PermissionState.GRANTED.toString();
        }
        return getPermissionState(NOTIFICATION_PERMISSION).toString();
    }

    private JSObject createState() {
        JSObject state = new JSObject();
        state.put("enabled", RelayNotificationPreferences.isEnabled(getContext()));
        state.put("running", RelayNotificationService.isRunning());
        state.put("startOnBoot", RelayNotificationPreferences.shouldStartOnBoot(getContext()));
        state.put(
            "showConversationDetails",
            RelayNotificationPreferences.shouldShowConversationDetails(getContext())
        );
        state.put("permission", notificationPermissionState());
        return state;
    }

    private static List<String> normalizeRelays(@Nullable JSONArray values) {
        Set<String> normalized = new LinkedHashSet<>();
        if (values == null) {
            return new ArrayList<>();
        }
        for (int index = 0; index < values.length(); index += 1) {
            String relay = values.optString(index, "").trim();
            try {
                URI uri = new URI(relay);
                String scheme = uri.getScheme();
                if (
                    scheme != null &&
                    (scheme.equalsIgnoreCase("ws") || scheme.equalsIgnoreCase("wss")) &&
                    uri.getHost() != null
                ) {
                    normalized.add(uri.toString());
                }
            } catch (URISyntaxException ignored) {}
        }
        return new ArrayList<>(normalized);
    }

    private static List<String> normalizePubkeys(@Nullable JSONArray values) {
        Set<String> normalized = new LinkedHashSet<>();
        if (values == null) {
            return new ArrayList<>();
        }
        for (int index = 0; index < values.length(); index += 1) {
            String pubkey = normalizePubkey(values.optString(index, ""));
            if (pubkey != null) {
                normalized.add(pubkey);
            }
        }
        return new ArrayList<>(normalized);
    }

    private static List<NotificationConversation> normalizeConversations(
        @Nullable JSONArray values
    ) {
        Map<String, NotificationConversation> normalized = new LinkedHashMap<>();
        if (values == null) {
            return new ArrayList<>();
        }
        for (int index = 0; index < values.length(); index += 1) {
            NotificationConversation conversation = NotificationConversation.fromJson(
                values.optJSONObject(index)
            );
            if (conversation == null) {
                continue;
            }
            String key = conversation.chatPubkey + ":" + String.valueOf(conversation.recipientPubkey);
            normalized.put(key, conversation);
        }
        return new ArrayList<>(normalized.values());
    }

    private static Map<String, String> normalizeRecipientKeys(
        @Nullable JSONArray values,
        List<String> recipientPubkeys,
        Map<String, String> previouslyValidatedKeys
    ) {
        Map<String, String> normalized = new LinkedHashMap<>();
        if (values == null) {
            return normalized;
        }
        Set<String> recipients = new LinkedHashSet<>(recipientPubkeys);
        for (int index = 0; index < values.length(); index += 1) {
            JSONObject value = values.optJSONObject(index);
            if (value == null) {
                continue;
            }
            String recipientPubkey = normalizePubkey(value.optString("recipientPubkey", ""));
            String privateKey = normalizePubkey(value.optString("privateKey", ""));
            if (recipientPubkey == null || privateKey == null || !recipients.contains(recipientPubkey)) {
                continue;
            }
            if (privateKey.equals(previouslyValidatedKeys.get(recipientPubkey))) {
                normalized.put(recipientPubkey, privateKey);
                continue;
            }
            try {
                if (recipientPubkey.equals(Nip44Decryptor.derivePublicKeyHex(privateKey))) {
                    normalized.put(recipientPubkey, privateKey);
                }
            } catch (GeneralSecurityException ignored) {}
        }
        return normalized;
    }

    @Nullable
    private static String normalizePubkey(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return HEX_64.matcher(normalized).matches() ? normalized : null;
    }
}
