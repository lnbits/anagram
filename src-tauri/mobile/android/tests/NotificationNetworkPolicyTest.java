package com.nostr.anagram;
import org.junit.Test;
import java.net.InetAddress;
import static org.junit.Assert.*;
public class NotificationNetworkPolicyTest {
    @Test public void rejectsNonPublicConnectionsIncludingMappedAndTranslatedAddresses() throws Exception {
        for (String ip : new String[]{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::"})
            assertFalse(ip, NotificationNetworkPolicy.isPublicAddress(InetAddress.getByName(ip)));
        assertTrue(NotificationNetworkPolicy.isPublicAddress(InetAddress.getByName("1.1.1.1")));
        assertTrue(NotificationNetworkPolicy.isPublicAddress(InetAddress.getByName("2606:4700:4700::1111")));
    }
}
