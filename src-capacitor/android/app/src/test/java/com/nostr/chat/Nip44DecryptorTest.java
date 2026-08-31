package com.nostr.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.security.GeneralSecurityException;
import java.util.Locale;
import org.junit.Test;

public final class Nip44DecryptorTest {

    @Test
    public void matchesOfficialConversationKeyVector() throws Exception {
        assertEquals(
            "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1",
            bytesToHex(
                Nip44Decryptor.conversationKey(
                    "315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268",
                    "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133"
                )
            )
        );
    }

    @Test
    public void decryptsOfficialAsciiAndUnicodeVectors() throws Exception {
        assertEquals(
            "a",
            Nip44Decryptor.decrypt(
                "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb",
                "0000000000000000000000000000000000000000000000000000000000000001",
                "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
            )
        );
        assertEquals(
            "🍕🫃",
            Nip44Decryptor.decrypt(
                "AvAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAPSKSK6is9ngkX2+cSq85Th16oRTISAOfhStnixqZziKMDvB0QQzgFZdjLTPicCJaV8nDITO+QfaQ61+KbWQIOO2Yj",
                "0000000000000000000000000000000000000000000000000000000000000002",
                "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            )
        );
    }

    @Test
    public void rejectsInvalidMac() {
        assertThrows(
            GeneralSecurityException.class,
            () ->
                Nip44Decryptor.decrypt(
                    "Agn/l3ULCEAS4V7LhGFM6IGA17jsDUaFCKhrbXDANholyySBfeh+EN8wNB9gaLlg4j6wdBYh+3oK+mnxWu3NKRbSvQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "0000000000000000000000000000000000000000000000000000000000000001",
                    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
                )
        );
    }

    @Test
    public void derivesBip340PublicKey() throws Exception {
        assertEquals(
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            Nip44Decryptor.derivePublicKeyHex(
                "0000000000000000000000000000000000000000000000000000000000000001"
            )
        );
    }

    private static String bytesToHex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) {
            result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return result.toString();
    }
}
