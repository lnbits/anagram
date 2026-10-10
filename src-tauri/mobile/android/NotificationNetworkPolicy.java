package com.nostr.anagram;

import java.net.InetAddress;

final class NotificationNetworkPolicy {
    private NotificationNetworkPolicy() {}
    static boolean isPublicAddress(InetAddress address) {
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() ||
            address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        byte[] bytes = address.getAddress();
        int first = bytes[0] & 255;
        if (bytes.length == 16) {
            // Only global unicast; exclude translation, transition and documentation ranges.
            return (first & 0xe0) == 0x20 && !(
                first == 0x20 && (bytes[1] & 255) == 0x02 ||
                first == 0x20 && (bytes[1] & 255) == 0x01 &&
                ((bytes[2] & 255) == 0 || (bytes[2] & 255) == 0x0d && (bytes[3] & 255) == 0xb8)
            );
        }
        int second = bytes[1] & 255;
        return first != 0 && first != 10 && first != 127 && first < 224 &&
            !(first == 100 && second >= 64 && second <= 127) &&
            !(first == 169 && second == 254) &&
            !(first == 172 && second >= 16 && second <= 31) &&
            !(first == 192 && (second == 0 || second == 168)) &&
            !(first == 198 && (second == 18 || second == 19 || second == 51)) &&
            !(first == 203 && second == 0 && (bytes[2] & 255) == 113);
    }
}
