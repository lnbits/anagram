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
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

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
        if (relays.isEmpty()) {
            call.reject("At least one readable ws:// or wss:// relay is required.");
            return;
        }
        if (recipientPubkeys.isEmpty()) {
            call.reject("At least one recipient public key is required.");
            return;
        }

        boolean startOnBoot = Boolean.TRUE.equals(call.getBoolean("startOnBoot", true));
        RelayNotificationPreferences.saveWatchPlan(getContext(), relays, recipientPubkeys);
        RelayNotificationPreferences.setStartOnBoot(getContext(), startOnBoot);
        RelayNotificationPreferences.setEnabled(getContext(), true);
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
        RelayNotificationService.clearMessageNotification(getContext());
        call.resolve();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String recipientPubkey = normalizePubkey(
            intent.getStringExtra(RelayNotificationService.EXTRA_RECIPIENT_PUBKEY)
        );
        if (recipientPubkey == null) {
            return;
        }

        intent.removeExtra(RelayNotificationService.EXTRA_RECIPIENT_PUBKEY);
        RelayNotificationService.clearMessageNotification(getContext());
        JSObject event = new JSObject();
        event.put("recipientPubkey", recipientPubkey);
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

    @Nullable
    private static String normalizePubkey(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return HEX_64.matcher(normalized).matches() ? normalized : null;
    }
}
