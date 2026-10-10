package com.nostr.anagram;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.util.Collections;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class CallNotificationsDeviceTest {
    private static String repeat(String s, int count) { return new String(new char[count]).replace("\0", s); }
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final String owner = repeat("a", 64), peer = repeat("b", 64);
    private final String id = "12345678-1234-4123-8123-123456789abc";
    private void plan(String account, boolean allowed, boolean details) {
        RelayNotificationPreferences.saveWatchPlan(context, Collections.singletonList("ws://127.0.0.1:7019/"), account, Collections.singletonList(account),
            Collections.singletonList(new NotificationConversation(peer, null, "Private caller name", "", "PC", allowed, allowed)), details);
        RelayNotificationPreferences.setEnabled(context, true);
        RelayNotificationPreferences.setAppForeground(context, false);
    }
    @Before public void before() throws Exception {
        CallNotifications.clear(context); plan(owner, true, false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> RelayNotificationService.startOrRefresh(context, true));
        waitForListener();
    }
    @After public void after() throws Exception {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> RelayNotificationService.requestStop(context, true));
        long deadline = System.currentTimeMillis() + 3000;
        while (context.getSystemService(NotificationManager.class).getActiveNotifications().length != 0 && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    }
    private android.service.notification.StatusBarNotification[] calls() {
        return java.util.Arrays.stream(context.getSystemService(NotificationManager.class).getActiveNotifications())
            .filter(n -> Notification.CATEGORY_CALL.equals(n.getNotification().category))
            .toArray(android.service.notification.StatusBarNotification[]::new);
    }
    private void waitForListener() throws Exception {
        // Android can defer the first quiet foreground-service notification.
        long deadline = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < deadline) {
            for (android.service.notification.StatusBarNotification n : context.getSystemService(NotificationManager.class).getActiveNotifications())
                if (!Notification.CATEGORY_CALL.equals(n.getNotification().category) && (n.getNotification().flags & Notification.FLAG_FOREGROUND_SERVICE) != 0) return;
            Thread.sleep(20);
        }
        fail("Quiet foreground listener notification was not restored");
    }
    private IncomingCallSignal signal(String action) throws Exception {
        JSONObject value = new JSONObject().put("protocol", "anagram/iroh-call/1").put("callId", id)
            .put("action", action).put("mode", "audio").put("reason", "cancelled")
            .put("expiresAt", java.time.Instant.ofEpochMilli(System.currentTimeMillis() / 1000 * 1000 + 60000).toString().replace("Z", ".000Z"))
            .put("mimeType", "audio/webm;codecs=opus").put("address", new JSONObject().put("id", repeat("a", 64)).put("relayUrl", "https://relay.example/"));
        IncomingCallSignal signal = IncomingCallSignal.parse(value.toString(), System.currentTimeMillis()/1000, System.currentTimeMillis());
        assertNotNull(signal); return signal;
    }
    private JSONObject pending() throws Exception {
        return new JSONObject(context.getSharedPreferences("anagram-call-notifications", Context.MODE_PRIVATE).getString("pending", "{}"));
    }
    private void waitForNotifications(int count) throws Exception {
        long deadline = System.currentTimeMillis() + 3000;
        while (calls().length != count && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertEquals(count, calls().length);
        if (count == 0) waitForListener();
    }
    private void invite() throws Exception { CallNotifications.receive(context, owner, peer, signal("invite"), new JSONObject().put("content", "ciphertext"), ""); }
    @Test public void notificationIsPrivateAndHasAnswerDeclineActions() throws Exception {
        invite();
        waitForNotifications(1);
        android.service.notification.StatusBarNotification[] shown = calls();
        assertEquals(1, shown.length);
        Notification notification = shown[0].getNotification();
        assertEquals("Incoming Anagram call", notification.extras.getString(Notification.EXTRA_TITLE));
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility);
        assertTrue("Call card must belong to the foreground service", (notification.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0);
        assertNotNull(notification.publicVersion);
        assertEquals("Incoming Anagram call", notification.publicVersion.extras.getString(Notification.EXTRA_TITLE));
        assertEquals(2, notification.publicVersion.actions.length);
        assertEquals(2, notification.actions.length);
        assertNotNull(notification.contentIntent);
        assertFalse(pending().toString().contains("relay.example"));
        plan(owner, true, true); CallNotifications.refresh(context);
        long deadline = System.currentTimeMillis() + 3000;
        while (!"Private caller name".equals(calls()[0].getNotification().extras.getString(Notification.EXTRA_TITLE)) && System.currentTimeMillis() < deadline) Thread.sleep(20);
        shown = calls();
        assertEquals("Private caller name", shown[0].getNotification().extras.getString(Notification.EXTRA_TITLE));
    }
    @Test public void answerTokenIsSingleUseAndUnforgeable() throws Exception {
        invite(); String token = pending().getString("token");
        assertNull(CallNotifications.action(context, "forged", true));
        assertNotNull(CallNotifications.action(context, token, true));
        assertNull(CallNotifications.action(context, token, true));
        waitForNotifications(0);
    }
    @Test public void cancelPreventsDelayedInvitationAndOldAction() throws Exception {
        invite(); String token = pending().getString("token");
        CallNotifications.receive(context, owner, peer, signal("end"), new JSONObject(), "");
        assertNull(CallNotifications.action(context, token, true));
        invite(); assertEquals(0, pending().length());
        waitForNotifications(0);
        assertTrue(CallNotifications.isClosed(context, owner, peer, id));
    }
    @Test public void blockedAccountSwitchAndExpiryInvalidateAnswer() throws Exception {
        invite(); String token = pending().getString("token");
        plan(owner, false, false); assertNull(CallNotifications.action(context, token, true));
        plan(repeat("c", 64), true, false); assertNull(CallNotifications.action(context, token, true));
        plan(owner, true, false);
        JSONObject value = pending().put("expiresAt", System.currentTimeMillis() - 1);
        context.getSharedPreferences("anagram-call-notifications", Context.MODE_PRIVATE).edit().putString("pending", value.toString()).commit();
        assertNull(CallNotifications.action(context, token, true));
    }
    @Test public void duplicateAndForegroundHandoffDoNotDeclineTheSameCall() throws Exception {
        CallNotifications.sync(context, owner, peer, id, "incoming", false);
        invite(); String token = pending().getString("token");
        invite(); assertEquals(token, pending().getString("token"));
        assertFalse(CallNotifications.isClosed(context, owner, peer, id));
    }
    @Test public void expirationClearsTheCardAndRejectsItsAction() throws Exception {
        invite(); JSONObject current = pending(); String token = current.getString("token");
        current.put("expiresAt", System.currentTimeMillis() + 100);
        context.getSharedPreferences("anagram-call-notifications", Context.MODE_PRIVATE).edit().putString("pending", current.toString()).commit();
        CallNotifications.refresh(context);
        long deadline = System.currentTimeMillis() + 3000;
        while (pending().length() != 0 && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertEquals(0, pending().length()); assertNull(CallNotifications.action(context, token, true));
        waitForNotifications(0);
    }
    @Test public void declineActionWorksWithoutAnActivity() throws Exception {
        invite(); waitForNotifications(1);
        Notification notification = calls()[0].getNotification();
        notification.actions[0].actionIntent.send();
        long deadline = System.currentTimeMillis() + 3000;
        while (!CallNotifications.isClosed(context, owner, peer, id) && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertTrue(CallNotifications.isClosed(context, owner, peer, id));
        waitForNotifications(0);
    }
    @Test public void serviceRefreshKeepsRingingAndCancellationRestoresListener() throws Exception {
        invite(); waitForNotifications(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> RelayNotificationService.startOrRefresh(context, true));
        Thread.sleep(600); // Includes the debounced relay-status notification update.
        waitForNotifications(1);
        assertTrue((calls()[0].getNotification().flags & Notification.FLAG_FOREGROUND_SERVICE) != 0);
        CallNotifications.finish(context, owner, peer, id);
        waitForNotifications(0);
    }
    @Test public void backgroundListenerReceivesAndDeclinesThroughRelay() throws Exception {
        org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("realRelay")));
        String receiver = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        String caller = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        RelayNotificationPreferences.saveWatchPlan(context, Collections.singletonList("ws://10.0.2.2:7018/"), receiver, Collections.singletonList(receiver),
            Collections.singletonList(new NotificationConversation(caller, null, "Caller", "", "C", true, true)), false);
        NotificationSecureStore.saveRecipientKeys(context, Collections.singletonMap(receiver, repeat("0", 63) + "2"));
        RelayNotificationPreferences.setEnabled(context, true);
        RelayNotificationPreferences.setAppForeground(context, false);
        try {
            RelayNotificationService.startOrRefresh(context, true);
            long deadline = System.currentTimeMillis() + 15000;
            while (pending().length() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(50);
            assertEquals(caller, pending().optString("peer"));
            assertEquals(receiver, pending().optString("ownerPubkey"));
            // Find the call among the listener's foreground-service notifications.
            Notification call = null;
            while (call == null && System.currentTimeMillis() < deadline) {
                for (android.service.notification.StatusBarNotification shown : context.getSystemService(NotificationManager.class).getActiveNotifications())
                    if (Notification.CATEGORY_CALL.equals(shown.getNotification().category)) call = shown.getNotification();
                if (call == null) Thread.sleep(20);
            }
            assertNotNull(call);
            Notification message = null;
            while (message == null && System.currentTimeMillis() < deadline) {
                for (android.service.notification.StatusBarNotification shown : context.getSystemService(NotificationManager.class).getActiveNotifications())
                    if (Notification.CATEGORY_MESSAGE.equals(shown.getNotification().category)) message = shown.getNotification();
                if (message == null) Thread.sleep(20);
            }
            assertNotNull("Encrypted direct message must also produce a notification", message);
            assertEquals("Anagram", message.extras.getString(Notification.EXTRA_TITLE));
            assertFalse(message.extras.toString().contains("Private notification regression message"));
            call.actions[0].actionIntent.send();
            boolean delivered = false;
            while (System.currentTimeMillis() < deadline) {
                java.net.HttpURLConnection connection = (java.net.HttpURLConnection) new java.net.URL("http://10.0.2.2:7018/status").openConnection();
                connection.setConnectTimeout(1000); connection.setReadTimeout(1000);
                try (java.io.InputStream response = connection.getInputStream()) { delivered = response.read() == '1'; }
                finally { connection.disconnect(); }
                if (delivered) break;
                Thread.sleep(50);
            }
            assertTrue("Caller must receive both encrypted ringing and declined signals", delivered);
            boolean messageAfterCall = false;
            while (System.currentTimeMillis() < deadline) {
                for (android.service.notification.StatusBarNotification shown : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                    Notification notification = shown.getNotification();
                    if (Notification.CATEGORY_MESSAGE.equals(notification.category) && notification.number == 2) {
                        assertEquals("Anagram", notification.extras.getString(Notification.EXTRA_TITLE));
                        assertFalse(notification.extras.toString().contains("Private message after declining the call"));
                        messageAfterCall = true;
                    }
                }
                if (messageAfterCall) break;
                Thread.sleep(20);
            }
            assertTrue("Ordinary message notifications must keep working after declining a call", messageAfterCall);
            waitForNotifications(0);
        } finally { RelayNotificationService.requestStop(context, true); }
    }
    @Test public void jniCanCreateGiftWrapWithoutOpeningAnActivity() throws Exception {
        String key = repeat("0", 63) + "1";
        String recipient = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        String event = CallSignalNative.reply(key, recipient, signal("invite").response("ringing", null).toString());
        assertNotNull(event);
        JSONObject wrapped = new JSONObject(event);
        assertEquals(1059, wrapped.getInt("kind"));
        assertTrue(SchnorrSignatureVerifier.verify(wrapped.getString("id"), wrapped.getString("pubkey"), wrapped.getString("sig")));
        String recipientKey = repeat("0", 63) + "2";
        JSONObject seal = new JSONObject(Nip44Decryptor.decrypt(wrapped.getString("content"), recipientKey, wrapped.getString("pubkey")));
        assertTrue(SchnorrSignatureVerifier.verify(seal.getString("id"), seal.getString("pubkey"), seal.getString("sig")));
        JSONObject rumor = new JSONObject(Nip44Decryptor.decrypt(seal.getString("content"), recipientKey, seal.getString("pubkey")));
        assertEquals(21117, rumor.getInt("kind"));
        assertEquals("ringing", new JSONObject(rumor.getString("content")).getString("action"));
    }
}
