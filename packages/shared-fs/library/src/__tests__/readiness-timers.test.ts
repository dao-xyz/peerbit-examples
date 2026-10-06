import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No idle timers (M1 plan section 10.5): readiness code arms timers only for
 * work that exists (a session's idle expiry, a pending request), never a
 * periodic one. The code rule: no `setInterval` anywhere in src/readiness/.
 */

const readinessDirectory = fileURLToPath(
    new URL("../readiness/", import.meta.url)
);

describe("readiness timers", () => {
    it("has no setInterval in src/readiness", async () => {
        const files = (
            await readdir(readinessDirectory, { recursive: true })
        ).filter((name) => name.endsWith(".ts"));
        expect(files.length).toBeGreaterThan(10);
        const offenders: string[] = [];
        for (const name of files) {
            const source = await readFile(
                join(readinessDirectory, name),
                "utf8"
            );
            source.split("\n").forEach((line, i) => {
                if (line.includes("setInterval")) {
                    offenders.push(`${name}:${i + 1}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});
