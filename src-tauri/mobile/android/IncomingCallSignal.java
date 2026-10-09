package com.nostr.anagram;

import java.net.URI;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONObject;

/** Mirrors the direct-call signal constraints; no room invitations or media are handled here. */
final class IncomingCallSignal {
    final JSONObject value;
    final String id, mode, action;
    final long expiresAt;
    private IncomingCallSignal(JSONObject value, long expiresAt) {
        this.value = value;
        this.id = value.optString("callId");
        this.mode = value.optString("mode");
        this.action = value.optString("action");
        this.expiresAt = expiresAt;
    }
    static IncomingCallSignal parse(String content, long createdAt, long now) {
        if (content.length() > 4096 || createdAt <= 0 || createdAt > now / 1000 + 10 || now - createdAt * 1000 > 60000) return null;
        try {
            JSONObject v = new JSONObject(content);
            if (!"anagram/iroh-call/1".equals(v.optString("protocol")) ||
                !v.optString("callId").matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") ||
                !v.optString("mode").matches("audio|video") ||
                !v.optString("action").matches("invite|ringing|accept|end")) return null;
            if (v.has("mediaVersion") && !Integer.valueOf(2).equals(v.opt("mediaVersion"))) return null;
            for (String key : new String[]{"videoSupported", "screenSupported", "muteStateSupported"})
                if (v.has(key) && !(v.opt(key) instanceof Boolean)) return null;
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            format.setLenient(false);
            String expiration = v.optString("expiresAt");
            ParsePosition position = new ParsePosition(0);
            Date date = format.parse(expiration, position);
            if (date == null || position.getIndex() != expiration.length()) return null;
            long expiresAt = date.getTime();
            if (expiresAt <= now || expiresAt > createdAt * 1000 + 61000) return null;
            String action = v.optString("action");
            if ("end".equals(action)) {
                if (!v.optString("reason").matches("hangup|declined|busy|timeout|failed|cancelled|unsupported")) return null;
            } else if (!"ringing".equals(action)) {
                JSONObject address = v.optJSONObject("address");
                if (address == null || !address.optString("id").matches("[a-z0-9]{52,64}") || address.optString("relayUrl").length() > 512) return null;
                URI relay = new URI(address.optString("relayUrl"));
                if (!"https".equals(relay.getScheme()) || relay.getHost() == null || relay.getUserInfo() != null || relay.getQuery() != null || relay.getFragment() != null) return null;
                String mime = "audio".equals(v.optString("mode")) ? "audio/webm;codecs=opus" : "video/webm;codecs=vp8,opus";
                if (!mime.equals(v.optString("mimeType"))) return null;
            }
            return new IncomingCallSignal(v, expiresAt);
        } catch (Exception ignored) { return null; }
    }
    JSONObject response(String action, String reason) throws org.json.JSONException {
        JSONObject result = new JSONObject().put("protocol", "anagram/iroh-call/1")
            .put("callId", id).put("mode", mode).put("action", action)
            .put("expiresAt", value.getString("expiresAt"));
        if (value.optInt("mediaVersion") == 2) result.put("mediaVersion", 2);
        if (reason != null) result.put("reason", reason);
        return result;
    }
}
