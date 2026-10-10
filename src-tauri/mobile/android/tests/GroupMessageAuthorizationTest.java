package com.nostr.anagram;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;
import org.junit.Test;

public final class GroupMessageAuthorizationTest {
    // Public deterministic test keys; ticket signed independently by nostr-tools.
    private static final String GROUP = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    private static final String MEMBER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    private static final String KEY = "0000000000000000000000000000000000000000000000000000000000000003";
    private static final String PROOF = "991b143c7c10d30bb7c63d23be3416d8de460e58f155d19d3de6565314bd49c47ce387dc6c243611d761b9d6ab2f6f42df45b1d86492c46c74a92f560c3580c4";

    @Test public void acceptsCanonicalMemberTicket() {
        assertTrue(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, KEY, MEMBER, 1700000000L, PROOF));
    }
    @Test public void rejectsCopiedOrAlteredTickets() {
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, KEY, GROUP, 1700000000L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(MEMBER, 3L, KEY, MEMBER, 1700000000L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 4L, KEY, MEMBER, 1700000000L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, GROUP, MEMBER, 1700000000L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, KEY, MEMBER, 1700000001L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, KEY, MEMBER, 1700000000L, ""));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, -1L, KEY, MEMBER, 1700000000L, PROOF));
        assertFalse(RelayNotificationService.verifyGroupMembershipProof(GROUP, 3L, KEY, MEMBER, 9007199254740992L, PROOF));
    }
}
