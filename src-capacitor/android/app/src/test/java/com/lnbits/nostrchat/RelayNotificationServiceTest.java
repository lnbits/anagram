package com.lnbits.nostrchat;

import static org.junit.Assert.assertFalse;
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
}
