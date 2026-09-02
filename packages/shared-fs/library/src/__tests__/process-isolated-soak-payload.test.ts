import { describe, expect, it } from "vitest";
import {
    createProcessSoakGeneratedContent,
    processSoakContentHash,
    processSoakPayloadSeed,
} from "./process-isolated-soak.bench.payload.js";

describe("process-isolated soak payloads", () => {
    it("creates deterministic byte-exact hashed ASCII", () => {
        const first = createProcessSoakGeneratedContent(
            "fixture;",
            "fixture",
            4096
        );

        expect(
            createProcessSoakGeneratedContent("fixture;", "fixture", 4096)
        ).toEqual(first);
        expect(Buffer.byteLength(first.content)).toBe(
            Buffer.byteLength(first.expectation.prefix) +
                first.expectation.bytes
        );
        expect(processSoakContentHash(first.content)).toBe(
            first.expectation.sha256
        );
        expect(
            new Set(first.content.slice(first.expectation.prefix.length)).size
        ).toBeGreaterThan(80);
    });

    it("keeps every supported writer/round payload stream distinct", () => {
        const seeds = new Set<number>();
        const hashes = new Set<string>();
        const add = (key: string) => {
            seeds.add(processSoakPayloadSeed(key));
            hashes.add(
                createProcessSoakGeneratedContent("", key, 512).expectation
                    .sha256
            );
        };
        for (let round = 0; round < 200; round++) {
            for (let writer = 0; writer < 3; writer++) {
                add(`hot:${round}:${writer}`);
                add(`history:${round}:${writer}`);
            }
        }
        for (let writer = 0; writer < 3; writer++) {
            add(`editor:${writer}`);
            add(`conflict:${writer}`);
        }
        add("post-restart");
        const expected = 200 * 3 * 2 + 3 * 2 + 1;
        expect(seeds.size).toBe(expected);
        expect(hashes.size).toBe(expected);
    });
});
