import { describe, expect, it } from "vitest";
import { Ed25519Keypair } from "@peerbit/crypto";
import {
    deserializeEd25519Keypair,
    serializeEd25519Keypair,
} from "../keypair.js";

describe("identity-supabase keypair codec", () => {
    it("roundtrips an Ed25519 keypair", async () => {
        const keypair = await Ed25519Keypair.create();
        const encoded = serializeEd25519Keypair(keypair);
        const decoded = deserializeEd25519Keypair(encoded);
        expect(decoded.equals(keypair)).to.equal(true);
    });
});
