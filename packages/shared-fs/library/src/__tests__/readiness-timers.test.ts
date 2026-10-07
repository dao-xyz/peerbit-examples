import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No idle timers (M1 plan section 10.5): readiness code arms timers only for
 * work that exists (a session's idle expiry, a pending request), never a
 * periodic one, and never a quiet window that waits for events to stop. The
 * code rules: no `setInterval` anywhere in src/readiness/, and `setTimeout`
 * only where such bounded work is armed.
 */

const readinessDirectory = fileURLToPath(
    new URL("../readiness/", import.meta.url)
);

/** `file:line` of every line of src/readiness that mentions `word`. */
const linesWith = async (word: string, except = new Set<string>()) => {
    const files = (
        await readdir(readinessDirectory, { recursive: true })
    ).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const name of files) {
        if (except.has(name)) continue;
        const source = await readFile(join(readinessDirectory, name), "utf8");
        source.split("\n").forEach((line, i) => {
            if (line.includes(word)) found.push(`${name}:${i + 1}`);
        });
    }
    return found;
};

describe("readiness timers", () => {
    it("has no setInterval in src/readiness", async () => {
        expect(await linesWith("setInterval")).toEqual([]);
    });

    it("arms setTimeout only for bounded work", async () => {
        // responder.ts: a session's 30 s idle expiry (`systemTimers`).
        // shadow.ts: test mode only, a differing row's wait for the event
        // that names it. The count check waits for changes, not for quiet
        // (`ScopeTap.checkCount`).
        expect(
            await linesWith(
                "setTimeout",
                new Set(["responder.ts", "shadow.ts"])
            )
        ).toEqual([]);
    });
});
