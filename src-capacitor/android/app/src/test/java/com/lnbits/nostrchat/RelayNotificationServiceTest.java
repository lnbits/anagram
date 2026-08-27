package com.lnbits.nostrchat;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RelayNotificationServiceTest {

    private static final long NOW = 2_000_000L;
    private static final long TWO_DAYS = 2L * 24L * 60L * 60L;
    private static final long TOLERANCE = 300L;

    @Test
    public void subscriptionIncludesNip59TimestampRandomizationWindow() {
        long since = RelayNotificationService.subscriptionSince(NOW);

        assertTrue(since <= NOW - TWO_DAYS);
        assertTrue(RelayNotificationService.isPlausibleGiftWrapTimestamp(NOW - TWO_DAYS, NOW));
        assertFalse(
            RelayNotificationService.isPlausibleGiftWrapTimestamp(
                NOW - TWO_DAYS - TOLERANCE - 1L,
                NOW
            )
        );
        assertTrue(RelayNotificationService.isPlausibleGiftWrapTimestamp(NOW + TOLERANCE, NOW));
        assertFalse(
            RelayNotificationService.isPlausibleGiftWrapTimestamp(NOW + TOLERANCE + 1L, NOW)
        );
    }

    @Test
    public void suppressesInitialHistoryUntilRelayEndOfStoredEvents() {
        assertFalse(RelayNotificationService.shouldNotifyEvent(false, false));
        assertTrue(RelayNotificationService.shouldNotifyEvent(false, true));
        assertTrue(RelayNotificationService.shouldNotifyEvent(true, false));
    }

    @Test
    public void computesNip01EventIdWhenAndroidJsonEscapesForwardSlashes() {
        String androidSerializedEvent =
            "[0,\"1111111111111111111111111111111111111111111111111111111111111111\"," +
            "123,1059,[[\"p\",\"2222222222222222222222222222222222222222222222222222222222222222\"]]," +
            "\"cipher\\/text\"]";

        assertEquals(
            "40fde1dd31e744088374d3f980c470905816dc54a6a85ac5040265a1fab6e95f",
            RelayNotificationService.computeCanonicalEventId(androidSerializedEvent)
        );
    }

    @Test
    public void formatsForegroundRelayConnectivityStates() {
        assertEquals(
            "Offline · waiting for network",
            RelayNotificationService.serviceStatusText(0, 3, false, false)
        );
        assertEquals(
            "Connecting to relays…",
            RelayNotificationService.serviceStatusText(0, 3, true, false)
        );
        assertEquals(
            "No relay connection · retrying",
            RelayNotificationService.serviceStatusText(0, 3, true, true)
        );
        assertEquals(
            "2 of 3 relays connected",
            RelayNotificationService.serviceStatusText(2, 3, true, false)
        );
        assertEquals(
            "2 of 3 relays connected",
            RelayNotificationService.serviceStatusText(2, 3, true, true)
        );
        assertEquals(
            "3 of 3 relays connected",
            RelayNotificationService.serviceStatusText(3, 3, true, false)
        );
    }

    @Test
    public void assignsStableDistinctConversationNotificationIds() {
        int first = RelayNotificationService.notificationIdForChat("11".repeat(32));
        int second = RelayNotificationService.notificationIdForChat("22".repeat(32));

        assertEquals(first, RelayNotificationService.notificationIdForChat("11".repeat(32)));
        assertFalse(first == second);
    }
}
