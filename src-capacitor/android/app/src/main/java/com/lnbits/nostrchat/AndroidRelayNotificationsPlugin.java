package com.lnbits.nostrchat;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
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
import org.json.JSONObject;

@CapacitorPlugin(
    name = "AndroidRelayNotifications",
    permissions = @Permission(
        strings = { Manifest.permission.POST_NOTIFICATIONS },
        alias = AndroidRelayNotificationsPlugin.NOTIFICATION_PERMISSION
    )
)
public final class AndroidRelayNotificationsPlugin extends Plugin {

    static final String NOTIFICATION_PERMISSION = "receive";
    private static final String ACTION_EVENT = "notificationActionPerformed";
    private static final Pattern HEX_64 = Pattern.compile("^[0-9a-fA-F]{64}$");

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        resolvePermission(call);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
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
    private void permissionsCallback(PluginCall call) {
        resolvePermission(call);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        List<String> relays = normalizeRelays(call.getArray("relays"));
        List<String> recipientPubkeys = normalizePubkeys(call.getArray("recipientPubkeys"));
        String ownerPubkey = normalizePubkey(call.getString("ownerPubkey"));
        if (relays.isEmpty()) {
            call.reject("At least one readable ws:// or wss:// relay is required.");
            return;
        }
        if (ownerPubkey == null || recipientPubkeys.isEmpty() || !recipientPubkeys.contains(ownerPubkey)) {
            call.reject("At least one recipient public key is required.");
            return;
        }

        boolean startOnBoot = Boolean.TRUE.equals(call.getBoolean("startOnBoot", true));
        boolean showConversationDetails = Boolean.TRUE.equals(
            call.getBoolean("showConversationDetails", true)
        );
        boolean didChangeConversationDetails =
            RelayNotificationPreferences.shouldShowConversationDetails(getContext()) !=
            showConversationDetails;
        List<NotificationConversation> conversations = normalizeConversations(
            call.getArray("conversations")
        );
        Map<String, String> recipientKeys = showConversationDetails
            ? normalizeRecipientKeys(call.getArray("recipientKeys"), recipientPubkeys)
            : new LinkedHashMap<>();
        try {
            NotificationSecureStore.saveRecipientKeys(getContext(), recipientKeys);
        } catch (GeneralSecurityException exception) {
            call.reject("Failed to protect notification decryption keys.", exception);
            return;
        }
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
        NotificationAvatarCache.refreshAsync(getContext(), conversations);
        RelayNotificationService.startOrRefresh(getContext());
        call.resolve(createState());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RelayNotificationService.requestStop(getContext(), true);
        call.resolve(createState());
    }

    @PluginMethod
    public void setStartOnBoot(PluginCall call) {
        Boolean startOnBoot = call.getBoolean("enabled");
        if (startOnBoot == null) {
            call.reject("The enabled option is required.");
            return;
        }
        RelayNotificationPreferences.setStartOnBoot(getContext(), startOnBoot);
        call.resolve(createState());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(createState());
    }

    @PluginMethod
    public void clearDeliveredNotifications(PluginCall call) {
        String chatPubkey = normalizePubkey(call.getString("chatPubkey"));
        if (chatPubkey == null) {
            RelayNotificationService.clearMessageNotifications(getContext());
        } else {
            RelayNotificationService.clearMessageNotification(getContext(), chatPubkey);
        }
        call.resolve();
    }

    @Override
    public void load() {
        super.load();
        dispatchNotificationIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        dispatchNotificationIntent(intent);
    }

    private void dispatchNotificationIntent(@Nullable Intent intent) {
        if (intent == null) {
            return;
        }

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
        notifyListeners(ACTION_EVENT, event, true);
    }

    private void resolvePermission(PluginCall call) {
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
        state.put("startOnBoot", RelayNotificationPreferences.shouldStartOnBoot(getContext()));
        state.put(
            "showConversationDetails",
            RelayNotificationPreferences.shouldShowConversationDetails(getContext())
        );
        state.put("permission", notificationPermissionState());
        return state;
    }

    private static List<String> normalizeRelays(@Nullable JSArray values) {
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

    private static List<String> normalizePubkeys(@Nullable JSArray values) {
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
        @Nullable JSArray values
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
        @Nullable JSArray values,
        List<String> recipientPubkeys
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
