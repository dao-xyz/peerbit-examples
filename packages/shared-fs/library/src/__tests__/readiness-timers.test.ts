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

/**
 * Design test 72 (M2 PR-3, plan 4.4): bootstrap discovery reads peers
 * through the readiness transport (src/readiness/reachability.ts, whose A'
 * reads stay there until U-37), so src/index.ts reads no route table, no
 * pubsub neighbour map and no `stream:outbound` event of its own, except
 * the snapshot segment providers (P5, kept by O13) and, until PR-6, the GC
 * peer gate (P6).
 */
describe("private pubsub reads in src/index.ts", () => {
    it("72: none besides the segment providers and the GC peer gate", async () => {
        const lines = (
            await readFile(
                fileURLToPath(new URL("../index.ts", import.meta.url)),
                "utf8"
            )
        ).split("\n");
        const reads = lines.flatMap((line, i) =>
            /\.peers\b|\broutes\b|getBestRouteHint|stream:outbound/.test(line)
                ? [i]
                : []
        );
        /** The method whose body holds line `i` (0-based). */
        const methodOf = (i: number) => {
            for (let at = i; at >= 0; at--) {
                const name = lines[at].match(
                    /^ {4}(?:private |protected |public )?(?:async )?(\w+)[<(]/
                )?.[1];
                if (name) return name;
            }
            return undefined;
        };
        expect(
            reads.map((i) => ({
                method: methodOf(i),
                read: lines[i].trim(),
            }))
        ).toEqual([
            {
                method: "fetchAndInstallOverlay",
                read: "...(((this.node.services.pubsub as any)?.peers?.keys?.() ??",
            },
            {
                method: "gcSchedulerTickInner",
                read: "...(((this.node.services.pubsub as any)?.peers?.keys?.() ??",
            },
        ]);
    });
});
