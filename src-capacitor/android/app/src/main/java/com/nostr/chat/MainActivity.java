package com.nostr.chat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AndroidRelayNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
        RelayNotificationPreferences.setAppForeground(this, true);
    }

    @Override
    public void onResume() {
        super.onResume();
        RelayNotificationPreferences.setAppForeground(this, true);
        RelayNotificationService.clearGenericMessageNotification(this);
    }

    @Override
    public void onPause() {
        RelayNotificationPreferences.setAppForeground(this, false);
        super.onPause();
    }
}
