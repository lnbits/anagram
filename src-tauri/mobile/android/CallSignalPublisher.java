package com.nostr.anagram;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;

/** Fan out to bounded relay routes; one acknowledgement is enough. Never delays the UI. */
final class CallSignalPublisher {
    private static final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
        .dns(host -> {
            List<InetAddress> addresses = okhttp3.Dns.SYSTEM.lookup(host);
            for (InetAddress address : addresses)
                if (!NotificationNetworkPolicy.isPublicAddress(address)) throw new java.net.UnknownHostException("Not a public relay");
            return addresses;
        }).build();
    private static final OkHttpClient selectedRelayClient = client.newBuilder().dns(okhttp3.Dns.SYSTEM).build();
    static void publish(String event, Set<String> relays, java.util.List<String> selectedRelays, java.util.function.BooleanSupplier eligible) {
        CountDownLatch acknowledged = new CountDownLatch(1);
        List<WebSocket> sockets = new ArrayList<>();
        for (String relay : relays) {
            if (sockets.size() >= 8) break;
            try {
                java.net.URI uri = java.net.URI.create(relay);
                if (!("wss".equalsIgnoreCase(uri.getScheme()) || "ws".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null) continue;
                sockets.add((selectedRelays.contains(relay) ? selectedRelayClient : client).newWebSocket(new Request.Builder().url(relay).build(), new WebSocketListener() {
                    @Override public void onOpen(WebSocket socket, Response response) { if (eligible.getAsBoolean()) socket.send("[\"EVENT\"," + event + "]"); else socket.cancel(); }
                    @Override public void onMessage(WebSocket socket, String value) {
                        try { JSONArray message = new JSONArray(value);
                            if ("OK".equals(message.optString(0)) && message.optBoolean(2)) acknowledged.countDown();
                        } catch (Exception ignored) { }
                    }
                }));
            } catch (IllegalArgumentException ignored) { }
        }
        try { acknowledged.await(4, TimeUnit.SECONDS); }
        catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        finally { for (WebSocket socket : sockets) socket.cancel(); }
    }
}
