package com.nostr.anagram;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.util.LinkedHashSet;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Short-lived call control only. Media and answering remain in the foreground app. */
final class CallNotifications {
    static final String EXTRA_TOKEN = "anagram.call.token";
    static final String EXTRA_ANSWER = "anagram.call.answer";
    private static final String CHANNEL = "anagram-incoming-calls";
    private static final int NOTIFICATION_ID = 7104;
    private static final ThreadPoolExecutor sender = new ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    // A notification receiver has a short Android deadline. Never queue its
    // decline behind slow relay acknowledgements for unrelated ringing signals.
    private static final ThreadPoolExecutor declines = new ThreadPoolExecutor(
        0, 2, 30L, TimeUnit.SECONDS, new java.util.concurrent.SynchronousQueue<>());
    private static String busyOwner = "", busyCall = "";
    private static boolean busy;
    private static long busyUntil;
    private static final android.os.Handler expiryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private static Runnable expiryTask;

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("anagram-call-notifications", Context.MODE_PRIVATE);
    }
    private static JSONObject read(Context c, String key) {
        try { return new JSONObject(prefs(c).getString(key, "{}")); }
        catch (Exception ignored) { return new JSONObject(); }
    }
    private static void put(JSONObject value, String key, Object item) {
        try { value.put(key, item); } catch (Exception ignored) { }
    }
    private static boolean eligible(Context c, String owner, String peer) {
        if (!RelayNotificationPreferences.isEnabled(c) ||
            !owner.equals(RelayNotificationPreferences.getOwnerPubkey(c))) return false;
        for (NotificationConversation conversation : RelayNotificationPreferences.getConversations(c)) {
            if (conversation.recipientPubkey == null && peer.equals(conversation.chatPubkey))
                return conversation.policyEligible && conversation.notificationsEnabled;
        }
        return false;
    }
    static synchronized boolean isClosed(Context c, String owner, String peer, String id) {
        return read(c, "closed").optLong(owner + ":" + peer + ":" + id) > System.currentTimeMillis();
    }
    private static void rememberClosed(Context c, String owner, String peer, String id) {
        JSONObject old = read(c, "closed"), next = new JSONObject();
        long now = System.currentTimeMillis();
        java.util.Iterator<String> keys = old.keys();
        while (keys.hasNext() && next.length() < 127) {
            String key = keys.next();
            if (old.optLong(key) > now) put(next, key, old.optLong(key));
        }
        put(next, owner + ":" + peer + ":" + id, now + 120_000);
        prefs(c).edit().putString("closed", next.toString()).commit();
    }
    static synchronized JSONObject closed(Context c, String owner) {
        JSONObject result = new JSONObject();
        JSONArray entries = new JSONArray();
        if (owner.equals(RelayNotificationPreferences.getOwnerPubkey(c))) {
            JSONObject values = read(c, "closed");
            java.util.Iterator<String> keys = values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key.startsWith(owner + ":") && values.optLong(key) > System.currentTimeMillis()) {
                    String[] parts = key.split(":");
                    if (parts.length == 3) {
                        JSONObject item = new JSONObject();
                        put(item, "peer", parts[1]); put(item, "callId", parts[2]); entries.put(item);
                    }
                }
            }
        }
        put(result, "closed", entries);
        return result;
    }
    static synchronized void clear(Context c) {
        prefs(c).edit().clear().commit();
        if (expiryTask != null) expiryHandler.removeCallbacks(expiryTask);
        busy = false; busyOwner = ""; busyCall = "";
        dismiss(c);
    }
    private static void dismiss(Context c) {
        NotificationManagerCompat.from(c).cancel(NOTIFICATION_ID);
    }
    static synchronized void finish(Context c, String owner, String peer, String id) {
        rememberClosed(c, owner, peer, id);
        JSONObject current = read(c, "pending");
        if (owner.equals(current.optString("ownerPubkey")) && peer.equals(current.optString("peer")) && id.equals(current.optString("callId"))) {
            prefs(c).edit().remove("pending").commit(); dismiss(c);
            if (expiryTask != null) expiryHandler.removeCallbacks(expiryTask);
        }
        wake(c);
    }
    static void wake(Context c) {
        c.sendBroadcast(new Intent(RelayNotificationService.ACTION_PENDING_EVENTS_AVAILABLE).setPackage(c.getPackageName()));
    }
    static synchronized void releaseForegroundCall() { busy = false; busyCall = ""; busyOwner = ""; }
    private static boolean busyNow(String owner) {
        return busy && owner.equals(busyOwner) && System.currentTimeMillis() < busyUntil;
    }
    static synchronized void sync(Context c, String owner, String peer, String id, String phase, boolean roomBusy) {
        if (!owner.equals(RelayNotificationPreferences.getOwnerPubkey(c))) return;
        busyOwner = owner; busyCall = id;
        busy = roomBusy || (!id.isEmpty() && !"ended".equals(phase));
        busyUntil = "incoming".equals(phase) ? System.currentTimeMillis() + 60_000 : Long.MAX_VALUE;
        if (!id.isEmpty() && !"incoming".equals(phase)) finish(c, owner, peer, id);
    }
    static synchronized JSONObject action(Context c, String token, boolean claim) {
        JSONObject current = read(c, "pending");
        String owner = current.optString("ownerPubkey"), peer = current.optString("peer"), id = current.optString("callId");
        if (token == null || token.isEmpty() || !token.equals(current.optString("token")) ||
            current.optBoolean("claimed") || current.optLong("expiresAt") <= System.currentTimeMillis() ||
            !eligible(c, owner, peer) || isClosed(c, owner, peer, id) ||
            (busyNow(owner) && !id.equals(busyCall))) return null;
        if (claim) {
            put(current, "claimed", true);
            prefs(c).edit().putString("pending", current.toString()).commit();
            dismiss(c);
        }
        return current;
    }
    static synchronized void refresh(Context c) {
        JSONObject pending = read(c, "pending");
        if (pending.length() == 0) return;
        if (!eligible(c, pending.optString("ownerPubkey"), pending.optString("peer")) || pending.optLong("expiresAt") <= System.currentTimeMillis()) {
            finish(c, pending.optString("ownerPubkey"), pending.optString("peer"), pending.optString("callId"));
        } else if (!pending.optBoolean("claimed")) show(c, pending);
    }
    static synchronized void receive(Context c, String owner, String peer, IncomingCallSignal signal, JSONObject event, String relay) {
        if (!eligible(c, owner, peer)) return;
        if ("end".equals(signal.action)) {
            if (owner.equals(busyOwner) && signal.id.equals(busyCall)) busy = false;
            finish(c, owner, peer, signal.id); return;
        }
        if (!"invite".equals(signal.action) || isClosed(c, owner, peer, signal.id)) return;
        // The foreground runtime owns its ringing/acceptance handshake.
        if (RelayNotificationPreferences.isAppForeground(c)) return;
        JSONObject previous = read(c, "pending");
        if (signal.id.equals(previous.optString("callId")) && peer.equals(previous.optString("peer"))) return;
        if ((busyNow(owner) && !signal.id.equals(busyCall)) || previous.optLong("expiresAt") > System.currentTimeMillis()) {
            rememberClosed(c, owner, peer, signal.id);
            reply(c, owner, peer, signal, "end", "busy", relay);
            return;
        }
        JSONObject pending = new JSONObject();
        put(pending, "ownerPubkey", owner); put(pending, "peer", peer); put(pending, "callId", signal.id);
        put(pending, "expiresAt", signal.expiresAt); put(pending, "token", UUID.randomUUID().toString());
        put(pending, "event", event); put(pending, "relayUrl", relay);
        // Persist only the encrypted invitation, not the Iroh address or decrypted content.
        prefs(c).edit().putString("pending", pending.toString()).commit();
        show(c, pending);
        reply(c, owner, peer, signal, "ringing", null, relay);
    }
    static synchronized void decline(Context c, String token, Runnable done) {
        JSONObject current = action(c, token, false);
        if (current == null) { done.run(); return; }
        String owner = current.optString("ownerPubkey"), peer = current.optString("peer");
        if (owner.equals(busyOwner) && current.optString("callId").equals(busyCall)) busy = false;
        finish(c, owner, peer, current.optString("callId"));
        // Decrypt the stored signed envelope again; no secret or signal is supplied by the intent.
        Runnable response = () -> {
            try {
                String key = NotificationSecureStore.loadRecipientKeys(c).get(owner);
                if (key == null || !eligible(c, owner, peer)) return;
                JSONObject event = current.getJSONObject("event");
                JSONObject seal = new JSONObject(Nip44Decryptor.decrypt(event.getString("content"), key, event.getString("pubkey")));
                JSONObject rumor = new JSONObject(Nip44Decryptor.decrypt(seal.getString("content"), key, peer));
                IncomingCallSignal signal = IncomingCallSignal.parse(rumor.getString("content"), rumor.getLong("created_at"), System.currentTimeMillis());
                if (signal != null) publish(c, owner, peer, key, signal.response("end", "declined").toString(), current.optString("relayUrl"));
            } catch (Exception ignored) { }
            finally { done.run(); }
        };
        try { declines.execute(response); }
        catch (java.util.concurrent.RejectedExecutionException ignored) { done.run(); }
    }
    private static void reply(Context c, String owner, String peer, IncomingCallSignal signal, String action, String reason, String relay) {
        submit(() -> {
            try {
                if (!eligible(c, owner, peer) || signal.expiresAt <= System.currentTimeMillis()) return;
                String key = NotificationSecureStore.loadRecipientKeys(c).get(owner);
                if (key != null) publish(c, owner, peer, key, signal.response(action, reason).toString(), relay);
            } catch (Exception ignored) { }
        }, () -> {});
    }
    private static void submit(Runnable work, Runnable rejected) {
        try { sender.execute(work); } catch (java.util.concurrent.RejectedExecutionException ignored) { rejected.run(); }
    }
    private static void publish(Context c, String owner, String peer, String key, String signal, String source) {
        String event = CallSignalNative.reply(key, peer, signal);
        if (event == null || !eligible(c, owner, peer)) return;
        LinkedHashSet<String> relays = new LinkedHashSet<>();
        for (NotificationConversation conversation : RelayNotificationPreferences.getConversations(c))
            if (peer.equals(conversation.chatPubkey)) relays.addAll(conversation.replyRelays);
        if (!source.isEmpty()) relays.add(source);
        relays.addAll(RelayNotificationPreferences.getRelays(c));
        CallSignalPublisher.publish(event, relays, RelayNotificationPreferences.getRelays(c), () -> eligible(c, owner, peer));
    }
    private static PendingIntent open(Context c, JSONObject pending, boolean answer) {
        String token = pending.optString("token");
        Intent intent = new Intent(c, MainActivity.class)
            .setData(Uri.parse("anagram-call://" + token + (answer ? "/answer" : "/open")))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_TOKEN, token).putExtra(EXTRA_ANSWER, answer);
        return PendingIntent.getActivity(c, answer ? 1 : 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private static void show(Context c, JSONObject pending) {
        if (expiryTask != null) expiryHandler.removeCallbacks(expiryTask);
        Context app = c.getApplicationContext();
        String token = pending.optString("token");
        expiryTask = () -> {
            synchronized (CallNotifications.class) {
                JSONObject current = read(app, "pending");
                if (token.equals(current.optString("token")) && current.optLong("expiresAt") <= System.currentTimeMillis())
                    finish(app, current.optString("ownerPubkey"), current.optString("peer"), current.optString("callId"));
            }
        };
        expiryHandler.postDelayed(expiryTask, Math.max(1, pending.optLong("expiresAt") - System.currentTimeMillis()));
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            channel.setSound(android.provider.Settings.System.DEFAULT_RINGTONE_URI,
                new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
            c.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        String title = "Incoming Anagram call";
        if (RelayNotificationPreferences.shouldShowConversationDetails(c)) {
            for (NotificationConversation conversation : RelayNotificationPreferences.getConversations(c))
                if (pending.optString("peer").equals(conversation.chatPubkey)) title = conversation.name;
        }
        Intent decline = new Intent(c, CallNotificationReceiver.class)
            .setData(Uri.parse("anagram-call://" + pending.optString("token") + "/decline"))
            .putExtra(EXTRA_TOKEN, pending.optString("token"));
        PendingIntent declineIntent = PendingIntent.getBroadcast(c, 0, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answerIntent = open(c, pending, true);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.nostr_chat_notification).setContentTitle(title).setContentText("Incoming call")
            .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(true).setOnlyAlertOnce(true)
            .setTimeoutAfter(Math.max(1, pending.optLong("expiresAt") - System.currentTimeMillis()))
            .setContentIntent(open(c, pending, false))
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(new Person.Builder().setName(title).setImportant(true).build(), declineIntent, answerIntent))
            .setPublicVersion(new NotificationCompat.Builder(c, CHANNEL).setSmallIcon(R.drawable.nostr_chat_notification)
                .setContentTitle("Incoming Anagram call").setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_CALL).setContentIntent(open(c, pending, false))
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(new Person.Builder().setName("Incoming Anagram call").build(), declineIntent, answerIntent)).build());
        try { NotificationManagerCompat.from(c).notify(NOTIFICATION_ID, builder.build()); }
        catch (SecurityException ignored) { }
    }
}
