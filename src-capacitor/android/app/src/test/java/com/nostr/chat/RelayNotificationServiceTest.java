package com.nostr.chat;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public final class RelayNotificationServiceTest {

    private static final long NOW = 2_000_000L;
    private static final long TWO_DAYS = 2L * 24L * 60L * 60L;
    private static final long TOLERANCE = 300L;

    @Test
    public void boundsPendingEventRetentionAndBridgeBatches() {
        long sevenDaysMillis = 7L * 24L * 60L * 60L * 1_000L;

        assertEquals(sevenDaysMillis, RelayNotificationEventInbox.RETENTION_MILLIS);
        assertEquals(NOW * 1_000L - sevenDaysMillis, RelayNotificationEventInbox.expiryCutoffMillis(NOW * 1_000L));
        assertEquals(
            RelayNotificationEventInbox.MAX_BATCH_SIZE,
            RelayNotificationEventInbox.normalizeBatchLimit(0)
        );
        assertEquals(
            RelayNotificationEventInbox.MAX_BATCH_SIZE,
            RelayNotificationEventInbox.normalizeBatchLimit(500)
        );
        assertEquals(10, RelayNotificationEventInbox.normalizeBatchLimit(10));
    }

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
    public void suppressesInitialHistoryButAllowsLiveMessagesDuringCatchUp() {
        long listenerStartedAt = NOW - 60L;

        assertFalse(
            RelayNotificationService.shouldNotifyEvent(
                false,
                false,
                NOW - 600L,
                listenerStartedAt,
                NOW
            )
        );
        assertTrue(
            RelayNotificationService.shouldNotifyEvent(
                false,
                false,
                NOW - 30L,
                listenerStartedAt,
                NOW
            )
        );
        assertFalse(
            RelayNotificationService.shouldNotifyEvent(
                false,
                false,
                NOW + TOLERANCE + 1L,
                listenerStartedAt,
                NOW
            )
        );
        assertTrue(
            RelayNotificationService.shouldNotifyEvent(
                false,
                true,
                0L,
                listenerStartedAt,
                NOW
            )
        );
        assertTrue(
            RelayNotificationService.shouldNotifyEvent(
                true,
                false,
                0L,
                listenerStartedAt,
                NOW
            )
        );
    }

    @Test
    public void directNotificationsRequireAnEligibleEnabledConversation() {
        String unknownSender = "11".repeat(32);
        String unverifiedSender = "22".repeat(32);
        String mutedSender = "33".repeat(32);
        String contactSender = "44".repeat(32);
        Map<String, NotificationConversation> conversations = new HashMap<>();
        conversations.put(
            unverifiedSender,
            new NotificationConversation(
                unverifiedSender,
                null,
                "Unverified",
                "",
                "UN",
                false,
                true
            )
        );
        conversations.put(
            mutedSender,
            new NotificationConversation(
                mutedSender,
                null,
                "Muted",
                "",
                "MU",
                true,
                false
            )
        );
        NotificationConversation contact = new NotificationConversation(
            contactSender,
            null,
            "Contact",
            "",
            "CO",
            true,
            true
        );
        conversations.put(contactSender, contact);

        assertNull(
            RelayNotificationService.resolveEligibleDirectConversation(
                conversations,
                unknownSender
            )
        );
        assertNull(
            RelayNotificationService.resolveEligibleDirectConversation(
                conversations,
                unverifiedSender
            )
        );
        assertNull(
            RelayNotificationService.resolveEligibleDirectConversation(
                conversations,
                mutedSender
            )
        );
        assertSame(
            contact,
            RelayNotificationService.resolveEligibleDirectConversation(
                conversations,
                contactSender
            )
        );
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
            "Connecting to message relays…",
            RelayNotificationService.serviceStatusText(0, 3, true, false)
        );
        assertEquals(
            "No message relay connection · retrying",
            RelayNotificationService.serviceStatusText(0, 3, true, true)
        );
        assertEquals(
            "2 of 3 message relays connected",
            RelayNotificationService.serviceStatusText(2, 3, true, false)
        );
        assertEquals(
            "2 of 3 message relays connected",
            RelayNotificationService.serviceStatusText(2, 3, true, true)
        );
        assertEquals(
            "3 of 3 message relays connected",
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

    @Test
    public void reconnectsOnlyWhenTheRelaySubscriptionPlanChanges() {
        List<String> relays = List.of("wss://one.example/", "wss://two.example/");
        Set<String> recipients = Set.of("11".repeat(32), "22".repeat(32));
        String owner = "11".repeat(32);

        assertTrue(
            RelayNotificationService.hasSameConnectionPlan(
                relays,
                recipients,
                owner,
                List.of("wss://two.example/", "wss://one.example/"),
                Set.of("22".repeat(32), "11".repeat(32)),
                owner
            )
        );
        assertFalse(
            RelayNotificationService.hasSameConnectionPlan(
                relays,
                recipients,
                owner,
                List.of("wss://three.example/"),
                recipients,
                owner
            )
        );
        assertFalse(
            RelayNotificationService.hasSameConnectionPlan(
                relays,
                recipients,
                owner,
                relays,
                Set.of("11".repeat(32)),
                owner
            )
        );
        assertFalse(
            RelayNotificationService.hasSameConnectionPlan(
                relays,
                recipients,
                owner,
                relays,
                recipients,
                "33".repeat(32)
            )
        );
    }
}
