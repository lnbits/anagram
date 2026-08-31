package com.nostr.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootCompletedReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (
            Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) &&
            RelayNotificationPreferences.isEnabled(context) &&
            RelayNotificationPreferences.shouldStartOnBoot(context)
        ) {
            RelayNotificationService.startOrRefresh(context);
        }
    }
}
