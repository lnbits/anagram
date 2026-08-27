package com.lnbits.nostrchat;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SchnorrSignatureVerifierTest {

    private static final String MESSAGE =
        "0000000000000000000000000000000000000000000000000000000000000000";
    private static final String PUBLIC_KEY =
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
    private static final String SIGNATURE =
        "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca8215" +
        "25f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0";

    @Test
    public void acceptsValidBip340Signature() {
        assertTrue(SchnorrSignatureVerifier.verify(MESSAGE, PUBLIC_KEY, SIGNATURE));
    }

    @Test
    public void rejectsModifiedMessageAndSignature() {
        assertFalse(SchnorrSignatureVerifier.verify("01" + MESSAGE.substring(2), PUBLIC_KEY, SIGNATURE));
        assertFalse(
            SchnorrSignatureVerifier.verify(
                MESSAGE,
                PUBLIC_KEY,
                SIGNATURE.substring(0, SIGNATURE.length() - 1) + "1"
            )
        );
    }
}
