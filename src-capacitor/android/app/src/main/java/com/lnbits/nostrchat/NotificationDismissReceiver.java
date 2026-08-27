package com.lnbits.nostrchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class NotificationDismissReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String countKey = intent.getStringExtra(
            RelayNotificationService.EXTRA_NOTIFICATION_COUNT_KEY
        );
        if (countKey != null && !countKey.trim().isEmpty()) {
            RelayNotificationPreferences.resetUnreadNotificationCount(context, countKey.trim());
        }
    }
}
