package com.lnbits.nostrchat;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Minimal NIP-44 v2 decryption used by the native notification listener. */
final class Nip44Decryptor {

    private static final BigInteger FIELD_PRIME = new BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F",
        16
    );
    private static final BigInteger CURVE_ORDER = new BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
        16
    );
    private static final Point GENERATOR = new Point(
        new BigInteger("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16),
        new BigInteger("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16)
    );
    private static final BigInteger TWO = BigInteger.valueOf(2L);
    private static final BigInteger THREE = BigInteger.valueOf(3L);
    private static final BigInteger SEVEN = BigInteger.valueOf(7L);
    private static final byte[] CONVERSATION_KEY_SALT = "nip44-v2".getBytes(StandardCharsets.UTF_8);
    private static final int MAX_ENCODED_PAYLOAD_LENGTH = 87_472;
    private static final int MAX_DECODED_PAYLOAD_BYTES = 65_603;

    private Nip44Decryptor() {}

    static String derivePublicKeyHex(String privateKeyHex) throws GeneralSecurityException {
        BigInteger privateKey = parsePrivateKey(privateKeyHex);
        Point publicKey = multiply(GENERATOR, privateKey);
        if (publicKey == null) {
            throw new GeneralSecurityException("Invalid secp256k1 private key.");
        }
        return bytesToHex(toFixedLength(publicKey.x, 32));
    }

    static String decrypt(String payload, String privateKeyHex, String publicKeyHex)
        throws GeneralSecurityException {
        byte[] decoded = decodePayload(payload);
        byte[] nonce = Arrays.copyOfRange(decoded, 1, 33);
        byte[] ciphertext = Arrays.copyOfRange(decoded, 33, decoded.length - 32);
        byte[] expectedMac = Arrays.copyOfRange(decoded, decoded.length - 32, decoded.length);

        byte[] conversationKey = conversationKey(privateKeyHex, publicKeyHex);
        byte[] messageKeys = hkdfExpand(conversationKey, nonce, 76);
        byte[] chachaKey = Arrays.copyOfRange(messageKeys, 0, 32);
        byte[] chachaNonce = Arrays.copyOfRange(messageKeys, 32, 44);
        byte[] hmacKey = Arrays.copyOfRange(messageKeys, 44, 76);
        byte[] authenticatedData = concatenate(nonce, ciphertext);
        byte[] actualMac = hmacSha256(hmacKey, authenticatedData);
        if (!MessageDigest.isEqual(expectedMac, actualMac)) {
            throw new GeneralSecurityException("Invalid NIP-44 MAC.");
        }

        byte[] paddedPlaintext = chacha20(chachaKey, chachaNonce, ciphertext);
        return decodeUtf8Strict(unpad(paddedPlaintext));
    }

    static byte[] conversationKey(String privateKeyHex, String publicKeyHex)
        throws GeneralSecurityException {
        BigInteger privateKey = parsePrivateKey(privateKeyHex);
        byte[] publicKeyBytes = hexToBytes(publicKeyHex, 32);
        if (publicKeyBytes == null) {
            throw new GeneralSecurityException("Invalid secp256k1 public key.");
        }
        Point publicKey = liftX(new BigInteger(1, publicKeyBytes));
        if (publicKey == null) {
            throw new GeneralSecurityException("Invalid secp256k1 public key.");
        }
        Point sharedPoint = multiply(publicKey, privateKey);
        if (sharedPoint == null) {
            throw new GeneralSecurityException("Invalid secp256k1 shared point.");
        }
        return hmacSha256(CONVERSATION_KEY_SALT, toFixedLength(sharedPoint.x, 32));
    }

    private static byte[] decodePayload(String payload) throws GeneralSecurityException {
        if (
            payload == null ||
            payload.length() < 132 ||
            payload.length() > MAX_ENCODED_PAYLOAD_LENGTH ||
            payload.charAt(0) == '#'
        ) {
            throw new GeneralSecurityException("Unsupported or invalid NIP-44 payload.");
        }
        byte[] decoded = decodeBase64(payload);
        if (
            decoded.length < 99 ||
            decoded.length > MAX_DECODED_PAYLOAD_BYTES ||
            (decoded[0] & 0xff) != 2
        ) {
            throw new GeneralSecurityException("Unsupported or invalid NIP-44 payload.");
        }
        return decoded;
    }

    private static byte[] unpad(byte[] padded) throws GeneralSecurityException {
        if (padded.length < 3) {
            throw new GeneralSecurityException("Invalid NIP-44 padding.");
        }

        long plaintextLength = ((padded[0] & 0xffL) << 8) | (padded[1] & 0xffL);

        if (
            plaintextLength < 1L ||
            plaintextLength > 65_535L ||
            2L + calculatedPaddedLength(plaintextLength) != padded.length
        ) {
            throw new GeneralSecurityException("Invalid NIP-44 padding.");
        }
        return Arrays.copyOfRange(padded, 2, 2 + (int) plaintextLength);
    }

    private static long calculatedPaddedLength(long plaintextLength) {
        if (plaintextLength <= 32L) {
            return 32L;
        }
        long nextPower = Long.highestOneBit(plaintextLength - 1L) << 1;
        long chunk = nextPower <= 256L ? 32L : nextPower / 8L;
        return chunk * (((plaintextLength - 1L) / chunk) + 1L);
    }

    private static byte[] hkdfExpand(byte[] key, byte[] info, int length)
        throws GeneralSecurityException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(length);
        byte[] previous = new byte[0];
        int counter = 1;
        while (output.size() < length) {
            previous = hmacSha256(key, concatenate(previous, info, new byte[] { (byte) counter }));
            int remaining = length - output.size();
            output.write(previous, 0, Math.min(previous.length, remaining));
            counter += 1;
        }
        return output.toByteArray();
    }

    private static byte[] hmacSha256(byte[] key, byte[] value) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(value);
    }

    private static byte[] chacha20(byte[] key, byte[] nonce, byte[] input)
        throws GeneralSecurityException {
        if (key.length != 32 || nonce.length != 12) {
            throw new GeneralSecurityException("Invalid ChaCha20 key or nonce.");
        }

        int[] state = new int[16];
        state[0] = 0x61707865;
        state[1] = 0x3320646e;
        state[2] = 0x79622d32;
        state[3] = 0x6b206574;
        for (int index = 0; index < 8; index += 1) {
            state[4 + index] = readLittleEndianInt(key, index * 4);
        }
        state[12] = 0;
        state[13] = readLittleEndianInt(nonce, 0);
        state[14] = readLittleEndianInt(nonce, 4);
        state[15] = readLittleEndianInt(nonce, 8);

        byte[] output = new byte[input.length];
        for (int offset = 0; offset < input.length; offset += 64) {
            int[] working = state.clone();
            for (int round = 0; round < 10; round += 1) {
                quarterRound(working, 0, 4, 8, 12);
                quarterRound(working, 1, 5, 9, 13);
                quarterRound(working, 2, 6, 10, 14);
                quarterRound(working, 3, 7, 11, 15);
                quarterRound(working, 0, 5, 10, 15);
                quarterRound(working, 1, 6, 11, 12);
                quarterRound(working, 2, 7, 8, 13);
                quarterRound(working, 3, 4, 9, 14);
            }

            byte[] block = new byte[64];
            for (int index = 0; index < 16; index += 1) {
                writeLittleEndianInt(block, index * 4, working[index] + state[index]);
            }
            int blockLength = Math.min(64, input.length - offset);
            for (int index = 0; index < blockLength; index += 1) {
                output[offset + index] = (byte) (input[offset + index] ^ block[index]);
            }
            state[12] += 1;
            if (state[12] == 0) {
                throw new GeneralSecurityException("ChaCha20 counter exhausted.");
            }
        }
        return output;
    }

    private static void quarterRound(int[] state, int a, int b, int c, int d) {
        state[a] += state[b];
        state[d] = Integer.rotateLeft(state[d] ^ state[a], 16);
        state[c] += state[d];
        state[b] = Integer.rotateLeft(state[b] ^ state[c], 12);
        state[a] += state[b];
        state[d] = Integer.rotateLeft(state[d] ^ state[a], 8);
        state[c] += state[d];
        state[b] = Integer.rotateLeft(state[b] ^ state[c], 7);
    }

    private static int readLittleEndianInt(byte[] value, int offset) {
        return ByteBuffer.wrap(value, offset, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    private static void writeLittleEndianInt(byte[] target, int offset, int value) {
        ByteBuffer.wrap(target, offset, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(value);
    }

    private static Point liftX(BigInteger x) {
        if (x.signum() < 0 || x.compareTo(FIELD_PRIME) >= 0) {
            return null;
        }
        BigInteger ySquared = x.modPow(THREE, FIELD_PRIME).add(SEVEN).mod(FIELD_PRIME);
        BigInteger y = ySquared.modPow(FIELD_PRIME.add(BigInteger.ONE).shiftRight(2), FIELD_PRIME);
        if (!y.modPow(TWO, FIELD_PRIME).equals(ySquared)) {
            return null;
        }
        if (y.testBit(0)) {
            y = FIELD_PRIME.subtract(y);
        }
        return new Point(x, y);
    }

    private static Point multiply(Point point, BigInteger scalar) {
        Point result = null;
        Point addend = point;
        for (int bit = 0; bit < scalar.bitLength(); bit += 1) {
            if (scalar.testBit(bit)) {
                result = add(result, addend);
            }
            addend = add(addend, addend);
        }
        return result;
    }

    private static Point add(Point first, Point second) {
        if (first == null) {
            return second;
        }
        if (second == null) {
            return first;
        }
        if (first.x.equals(second.x)) {
            if (!first.y.equals(second.y) || first.y.signum() == 0) {
                return null;
            }
            BigInteger slope = THREE
                .multiply(first.x.modPow(TWO, FIELD_PRIME))
                .multiply(TWO.multiply(first.y).modInverse(FIELD_PRIME))
                .mod(FIELD_PRIME);
            return pointFromSlope(first, second, slope);
        }
        BigInteger slope = second.y
            .subtract(first.y)
            .multiply(second.x.subtract(first.x).mod(FIELD_PRIME).modInverse(FIELD_PRIME))
            .mod(FIELD_PRIME);
        return pointFromSlope(first, second, slope);
    }

    private static Point pointFromSlope(Point first, Point second, BigInteger slope) {
        BigInteger x = slope
            .modPow(TWO, FIELD_PRIME)
            .subtract(first.x)
            .subtract(second.x)
            .mod(FIELD_PRIME);
        BigInteger y = slope.multiply(first.x.subtract(x)).subtract(first.y).mod(FIELD_PRIME);
        return new Point(x, y);
    }

    private static BigInteger parsePrivateKey(String privateKeyHex)
        throws GeneralSecurityException {
        byte[] value = hexToBytes(privateKeyHex, 32);
        if (value == null) {
            throw new GeneralSecurityException("Invalid secp256k1 private key.");
        }
        BigInteger privateKey = new BigInteger(1, value);
        if (privateKey.signum() <= 0 || privateKey.compareTo(CURVE_ORDER) >= 0) {
            throw new GeneralSecurityException("Invalid secp256k1 private key.");
        }
        return privateKey;
    }

    private static byte[] toFixedLength(BigInteger value, int length) {
        byte[] raw = value.toByteArray();
        byte[] result = new byte[length];
        int sourceOffset = Math.max(0, raw.length - length);
        int copyLength = Math.min(raw.length, length);
        System.arraycopy(raw, sourceOffset, result, length - copyLength, copyLength);
        return result;
    }

    private static byte[] decodeBase64(String value) throws GeneralSecurityException {
        if (value.length() % 4 != 0) {
            throw new GeneralSecurityException("Invalid base64 payload.");
        }
        int padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        int outputLength = (value.length() / 4) * 3 - padding;
        if (outputLength < 0 || outputLength > MAX_DECODED_PAYLOAD_BYTES) {
            throw new GeneralSecurityException("Invalid base64 payload.");
        }

        byte[] output = new byte[outputLength];
        int outputOffset = 0;
        for (int offset = 0; offset < value.length(); offset += 4) {
            int first = base64Value(value.charAt(offset));
            int second = base64Value(value.charAt(offset + 1));
            int third = value.charAt(offset + 2) == '=' ? -2 : base64Value(value.charAt(offset + 2));
            int fourth = value.charAt(offset + 3) == '=' ? -2 : base64Value(value.charAt(offset + 3));
            boolean isLast = offset + 4 == value.length();
            if (
                first < 0 ||
                second < 0 ||
                third == -1 ||
                fourth == -1 ||
                (!isLast && (third == -2 || fourth == -2)) ||
                (third == -2 && fourth != -2)
            ) {
                throw new GeneralSecurityException("Invalid base64 payload.");
            }
            int packed = (first << 18) | (second << 12);
            if (third >= 0) {
                packed |= third << 6;
            }
            if (fourth >= 0) {
                packed |= fourth;
            }
            if (outputOffset < output.length) {
                output[outputOffset++] = (byte) (packed >>> 16);
            }
            if (outputOffset < output.length) {
                output[outputOffset++] = (byte) (packed >>> 8);
            }
            if (outputOffset < output.length) {
                output[outputOffset++] = (byte) packed;
            }
        }
        return output;
    }

    private static int base64Value(char value) {
        if (value >= 'A' && value <= 'Z') {
            return value - 'A';
        }
        if (value >= 'a' && value <= 'z') {
            return value - 'a' + 26;
        }
        if (value >= '0' && value <= '9') {
            return value - '0' + 52;
        }
        if (value == '+') {
            return 62;
        }
        if (value == '/') {
            return 63;
        }
        return -1;
    }

    private static byte[] concatenate(byte[]... values) {
        int length = 0;
        for (byte[] value : values) {
            length += value.length;
        }
        byte[] result = new byte[length];
        int offset = 0;
        for (byte[] value : values) {
            System.arraycopy(value, 0, result, offset, value.length);
            offset += value.length;
        }
        return result;
    }

    private static String decodeUtf8Strict(byte[] value) throws GeneralSecurityException {
        try {
            CharBuffer decoded = StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(value));
            return decoded.toString();
        } catch (CharacterCodingException exception) {
            throw new GeneralSecurityException("Invalid UTF-8 plaintext.", exception);
        }
    }

    private static byte[] hexToBytes(String value, int expectedLength) {
        if (value == null || value.length() != expectedLength * 2) {
            return null;
        }
        byte[] result = new byte[expectedLength];
        for (int index = 0; index < result.length; index += 1) {
            int high = Character.digit(value.charAt(index * 2), 16);
            int low = Character.digit(value.charAt(index * 2 + 1), 16);
            if (high < 0 || low < 0) {
                return null;
            }
            result[index] = (byte) ((high << 4) | low);
        }
        return result;
    }

    private static String bytesToHex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) {
            result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return result.toString();
    }

    private static final class Point {

        private final BigInteger x;
        private final BigInteger y;

        private Point(BigInteger x, BigInteger y) {
            this.x = x;
            this.y = y;
        }
    }
}
