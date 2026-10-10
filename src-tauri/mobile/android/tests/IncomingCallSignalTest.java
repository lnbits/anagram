package com.nostr.anagram;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public final class IncomingCallSignalTest {
    private static final long NOW = 1700000000000L;
    private JSONObject invite() throws Exception {
        return new JSONObject().put("protocol", "anagram/iroh-call/1")
            .put("callId", "12345678-1234-4123-8123-123456789abc")
            .put("action", "invite").put("mode", "audio").put("mediaVersion", 2)
            .put("expiresAt", "2023-11-14T22:14:20.000Z")
            .put("mimeType", "audio/webm;codecs=opus")
            .put("address", new JSONObject().put("id", "a".repeat(64)).put("relayUrl", "https://relay.example/"));
    }
    private IncomingCallSignal parse(JSONObject value) { return IncomingCallSignal.parse(value.toString(), NOW / 1000, NOW); }
    @Test public void acceptsCurrentInviteAndRepliesWithoutMediaAddress() throws Exception {
        IncomingCallSignal value = parse(invite());
        assertNotNull(value);
        JSONObject response = value.response("ringing", null);
        assertFalse(response.has("address")); assertFalse(response.has("mimeType"));
        assertNotNull(parse(response));
        assertNotNull(parse(value.response("end", "declined")));
    }
    @Test public void rejectsExpiredFutureOrInvalidSignals() throws Exception {
        assertNull(IncomingCallSignal.parse(invite().toString(), NOW / 1000, NOW + 60001));
        assertNull(IncomingCallSignal.parse(invite().toString(), NOW / 1000 + 11, NOW));
        assertNull(parse(invite().put("expiresAt", "2023-11-14T22:15:20.000Z")));
        assertNull(parse(invite().put("protocol", "anagram/iroh-room/1")));
        assertNull(parse(invite().put("callId", "wrong")));
        assertNull(parse(invite().put("mode", "video")));
        assertNull(parse(invite().put("mediaVersion", 1)));
        assertNull(parse(invite().put("screenSupported", "true")));
        assertNull(parse(invite().put("action", "end").put("reason", "other")));
        JSONObject value = invite(); value.getJSONObject("address").put("relayUrl", "http://relay.example");
        assertNull(parse(value));
        value.getJSONObject("address").put("relayUrl", "https://user:password@relay.example");
        assertNull(parse(value));
    }
}
