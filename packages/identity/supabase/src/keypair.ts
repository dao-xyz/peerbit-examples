import {
    Ed25519Keypair,
    Ed25519PrivateKey,
    Ed25519PublicKey,
} from "@peerbit/crypto";
import { decodeBase64, encodeBase64 } from "./base64.js";
import sodium from "libsodium-wrappers";
import { equals } from "uint8arrays";

export const serializeEd25519Keypair = (keypair: Ed25519Keypair): string => {
    const bytes = keypair.privateKeyPublicKey; // 32 (priv) + 32 (pub)
    return encodeBase64(bytes);
};

export const deserializeEd25519Keypair = async (
    value: string
): Promise<Ed25519Keypair> => {
    const bytes = decodeBase64(value.trim());
    if (bytes.length !== 64) {
        throw new Error(
            `Invalid keypair encoding: expected 64 bytes, got ${bytes.length}`
        );
    }

    const privateKeyBytes = bytes.slice(0, 32);
    const publicKeyBytes = bytes.slice(32, 64);

    // Validate that the public key matches the private key
    await sodium.ready;
    const derivedKeypair = sodium.crypto_sign_seed_keypair(privateKeyBytes);
    const derivedPublicKey = derivedKeypair.publicKey;

    if (!equals(derivedPublicKey, publicKeyBytes)) {
        throw new Error(
            "Invalid keypair encoding: public key does not match private key"
        );
    }

    return new Ed25519Keypair({
        publicKey: new Ed25519PublicKey({ publicKey: publicKeyBytes }),
        privateKey: new Ed25519PrivateKey({ privateKey: privateKeyBytes }),
    });
};
