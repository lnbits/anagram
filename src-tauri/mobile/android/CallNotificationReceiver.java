package com.nostr.anagram;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Explicit, non-exported receiver; immutable notification actions carry a random one-use token. */
public final class CallNotificationReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        PendingResult result = goAsync();
        CallNotifications.decline(context.getApplicationContext(), intent.getStringExtra(CallNotifications.EXTRA_TOKEN), result::finish);
    }
}
