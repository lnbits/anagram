package com.lnbits.nostrchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class StopRelayNotificationReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        RelayNotificationService.requestStop(context, true);
    }
}
