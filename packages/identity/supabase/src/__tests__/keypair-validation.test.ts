/**
 * deserializeEd25519Keypair validation tests
 *
 * Tests that the function properly validates keypair data and rejects
 * invalid or corrupted keypairs.
 *
 * File: packages/identity/supabase/src/keypair.ts
 */

import { describe, expect, it } from "vitest";
import { Ed25519Keypair } from "@peerbit/crypto";
import {
    deserializeEd25519Keypair,
    serializeEd25519Keypair,
} from "../keypair.js";

describe("deserializeEd25519Keypair validation", () => {
    describe("rejects invalid keypairs", () => {
        it("rejects randomly generated 64-byte data", async () => {
            const randomBytes = new Uint8Array(64);
            for (let i = 0; i < 64; i++) {
                randomBytes[i] = Math.floor(Math.random() * 256);
            }
            const randomBase64 = Buffer.from(randomBytes).toString("base64");

            await expect(
                deserializeEd25519Keypair(randomBase64)
            ).rejects.toThrow("Invalid keypair encoding");
        });

        it("rejects keypair with mismatched components", async () => {
            const keypair1 = await Ed25519Keypair.create();
            const keypair2 = await Ed25519Keypair.create();

            const bytes1 = keypair1.privateKeyPublicKey;
            const bytes2 = keypair2.privateKeyPublicKey;

            // Create keypair with private key from keypair1 and public key from keypair2
            const mixedBytes = new Uint8Array(64);
            mixedBytes.set(bytes1.slice(0, 32));  // private key from keypair1
            mixedBytes.set(bytes2.slice(32, 64), 32);  // public key from keypair2

            const mixedBase64 = Buffer.from(mixedBytes).toString("base64");

            await expect(
                deserializeEd25519Keypair(mixedBase64)
            ).rejects.toThrow("Invalid keypair encoding");
        });

        it("rejects corrupted key data", async () => {
            const keypair = await Ed25519Keypair.create();
            const serialized = serializeEd25519Keypair(keypair);

            // Corrupt the data while keeping valid Base64 and 64-byte length
            const bytes = Buffer.from(serialized, "base64");
            const corruptedBytes = new Uint8Array(bytes);
            for (let i = 0; i < 64; i++) {
                corruptedBytes[i] = (corruptedBytes[i] + 1) % 256;
            }
            const corrupted = Buffer.from(corruptedBytes).toString("base64");

            await expect(
                deserializeEd25519Keypair(corrupted)
            ).rejects.toThrow("Invalid keypair encoding");
        });
    });

    describe("accepts valid keypairs", () => {
        it("serializes and deserializes correctly", async () => {
            const original = await Ed25519Keypair.create();
            const serialized = serializeEd25519Keypair(original);
            const restored = await deserializeEd25519Keypair(serialized);

            expect(restored.equals(original)).toBe(true);
        });

        it("produces consistent signatures after round-trip", async () => {
            const original = await Ed25519Keypair.create();
            const serialized = serializeEd25519Keypair(original);
            const restored = await deserializeEd25519Keypair(serialized);

            const message = new Uint8Array([1, 2, 3, 4, 5]);
            const signature1 = await original.sign(message);
            const signature2 = await restored.sign(message);

            expect(signature1.signature).toEqual(signature2.signature);
        });

        it("maintains peer identity across operations", async () => {
            const original = await Ed25519Keypair.create();
            const serialized = serializeEd25519Keypair(original);
            const restored = await deserializeEd25519Keypair(serialized);

            expect(original.toPeerId().toString()).toBe(
                restored.toPeerId().toString()
            );
        });
    });
});
