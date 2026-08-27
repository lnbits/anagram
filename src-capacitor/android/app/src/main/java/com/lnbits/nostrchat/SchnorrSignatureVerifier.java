package com.lnbits.nostrchat;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

final class SchnorrSignatureVerifier {

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

    private SchnorrSignatureVerifier() {}

    static boolean verify(String messageHex, String publicKeyHex, String signatureHex) {
        try {
            byte[] message = hexToBytes(messageHex, 32);
            byte[] publicKey = hexToBytes(publicKeyHex, 32);
            byte[] signature = hexToBytes(signatureHex, 64);
            if (message == null || publicKey == null || signature == null) {
                return false;
            }

            BigInteger publicKeyX = unsigned(publicKey);
            BigInteger r = unsigned(Arrays.copyOfRange(signature, 0, 32));
            BigInteger s = unsigned(Arrays.copyOfRange(signature, 32, 64));
            if (
                publicKeyX.compareTo(FIELD_PRIME) >= 0 ||
                r.compareTo(FIELD_PRIME) >= 0 ||
                s.compareTo(CURVE_ORDER) >= 0
            ) {
                return false;
            }

            Point publicKeyPoint = liftX(publicKeyX);
            if (publicKeyPoint == null) {
                return false;
            }

            byte[] challengeInput = new byte[96];
            System.arraycopy(signature, 0, challengeInput, 0, 32);
            System.arraycopy(publicKey, 0, challengeInput, 32, 32);
            System.arraycopy(message, 0, challengeInput, 64, 32);
            BigInteger challenge = unsigned(taggedHash("BIP0340/challenge", challengeInput)).mod(CURVE_ORDER);

            Point rPoint = add(
                multiply(GENERATOR, s),
                multiply(publicKeyPoint, CURVE_ORDER.subtract(challenge))
            );
            return rPoint != null && !rPoint.y.testBit(0) && rPoint.x.equals(r);
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private static Point liftX(BigInteger x) {
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

    private static byte[] taggedHash(String tag, byte[] value) {
        byte[] tagHash = sha256(tag.getBytes(StandardCharsets.UTF_8));
        byte[] input = new byte[tagHash.length * 2 + value.length];
        System.arraycopy(tagHash, 0, input, 0, tagHash.length);
        System.arraycopy(tagHash, 0, input, tagHash.length, tagHash.length);
        System.arraycopy(value, 0, input, tagHash.length * 2, value.length);
        return sha256(input);
    }

    private static byte[] sha256(byte[] value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static BigInteger unsigned(byte[] value) {
        return new BigInteger(1, value);
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

    private static final class Point {

        private final BigInteger x;
        private final BigInteger y;

        private Point(BigInteger x, BigInteger y) {
            this.x = x;
            this.y = y;
        }
    }
}
