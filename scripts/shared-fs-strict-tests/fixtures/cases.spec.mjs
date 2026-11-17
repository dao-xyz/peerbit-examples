import { writeSync } from "node:fs";
import { stopTestPeers } from "../../../packages/shared-fs/library/src/__tests__/stop-test-peers.ts";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    onTestFinished,
    test,
} from "vitest";

describe("strict CI fixture", () => {
    test("clean pass", () => expect(1 + 1).toBe(2));

    test("unused retry budget", { retry: 2 }, () => expect(true).toBe(true));

    test.fails("expected failure", () => {
        throw new Error("EXPECTED_FAILURE_IS_NOT_FLAKINESS");
    });

    test.fails("expected failure with actual retries", { retry: 1 }, () => {
        throw new Error("EXPECTED_FAILURE_RETRIED_BY_VITEST");
    });

    test("ordinary failure", () => {
        throw new Error("ORDINARY_FAILURE_STACK");
    });

    test("deep failure stack", () => {
        const descend = (depth) => {
            if (depth === 0) throw new Error("DEEP_FAILURE_STACK");
            descend(depth - 1);
        };
        descend(30);
    });

    let attempts = 0;
    test("retry eventually passes", { retry: 1 }, () => {
        if (attempts++ === 0) throw new Error("ORIGINAL_FIRST_FAILURE_STACK");
        writeSync(2, "SECOND_ATTEMPT_STARTED\n");
        expect(attempts).toBe(2);
    });

    let nestedAttempts = 0;
    test("nested receipt eventually succeeds", { retry: 1 }, () => {
        if (nestedAttempts++ === 0) {
            const cause = Object.assign(
                new Error("ORIGINAL_RECEIPT_CAUSE_STACK"),
                {
                    localCommitSucceeded: true,
                    retrySafe: false,
                    nativeCommitApplied: true,
                }
            );
            throw new Error("ORIGINAL_RECEIPT_WRAPPER_STACK", { cause });
        }
        writeSync(2, "NESTED_SECOND_ATTEMPT_STARTED\n");
    });

    describe("body and peer cleanup", () => {
        let attempts = 0;
        afterEach(async () => {
            if (attempts !== 1) return;
            await stopTestPeers([
                {
                    stop: () => {
                        throw new Error("ORIGINAL_PEER_STOP_STACK");
                    },
                },
                { stop: () => Promise.reject(undefined) },
                { stop: () => writeSync(2, "FINAL_PEER_STOP_ATTEMPTED\n") },
            ]);
        });
        test("retry after body and cleanup failure", { retry: 1 }, () => {
            if (attempts++ === 0) throw new Error("ORIGINAL_BODY_STACK");
            writeSync(2, "CLEANUP_SECOND_ATTEMPT_STARTED\n");
        });
    });

    let skippedAttempts = 0;
    test("retry then skips", { retry: 1 }, (context) => {
        if (skippedAttempts++ === 0) throw new Error("BEFORE_RETRY_SKIP");
        context.skip();
    });

    test("exhausted retries", { retry: 2 }, () => {
        throw new Error("EVERY_ATTEMPT_FAILED");
    });

    let oversizedAttempts = 0;
    test("bounded first failure", { retry: 1 }, () => {
        if (oversizedAttempts++ > 0) return;
        throw Array.from({ length: 6 }, (_, index) => {
            const error = new Error(`OVERSIZED_${index}`);
            error.stack = `${error.message}\n${"x".repeat(20_000)}`;
            return error;
        });
    });

    describe("before hook", () => {
        let attempts = 0;
        beforeEach(() => {
            if (attempts++ === 0) throw new Error("ORIGINAL_BEFORE_HOOK_STACK");
        });
        test("retry passes after before hook fails", { retry: 1 }, () => {
            expect(attempts).toBe(2);
        });
    });

    describe("suite setup", () => {
        beforeAll(() => {
            throw new Error("ORIGINAL_BEFORE_ALL_STACK");
        });
        test("unreachable test after suite setup failure", () => {
            throw new Error("MUST_NOT_RUN");
        });
    });

    describe("after hook", () => {
        let attempts = 0;
        afterEach(() => {
            if (attempts++ === 0) throw new Error("ORIGINAL_AFTER_HOOK_STACK");
        });
        test("retry passes after after hook fails", { retry: 1 }, () => {
            expect(true).toBe(true);
        });
    });

    describe("hang report", () => {
        test("hangs past the hang report", { timeout: 3_000 }, async () => {
            // Stands in for the library's readiness registry: ten live
            // runtimes, the last three owned, throwing and oversized.
            const owned = {
                debug: () => ({ armedTimers: 0, coordinator: { sessions: 1 } }),
            };
            const throwing = {
                debug: () => {
                    throw new Error("DEBUG_UNAVAILABLE");
                },
            };
            const oversized = { debug: () => ({ rows: "x".repeat(10_000) }) };
            const runtimes = [
                ...Array.from({ length: 7 }, () => ({ debug: () => ({}) })),
                owned,
                throwing,
                oversized,
            ];
            globalThis.__SFS_READINESS_SHADOW__ = {
                runtimes: new Map(
                    runtimes.map((runtime, index) => [
                        `nonce-${index}`,
                        new WeakRef(runtime),
                    ])
                ),
                live: new WeakMap([
                    [owned, { file: "owner.test.ts", test: "opened it" }],
                ]),
                // Keeps the weakly referenced runtimes alive.
                held: runtimes,
            };
            onTestFinished(() => {
                delete globalThis.__SFS_READINESS_SHADOW__;
            });
            // 50 ms for the event loop delay monitor to take a sample, then
            // a synchronous call holding the JS thread for 300 ms (on the
            // clock the report uses; the report is due at 200 ms), then an
            // await that never settles.
            await new Promise((resolve) => setTimeout(resolve, 50));
            const blockedUntil = performance.now() + 300;
            while (performance.now() < blockedUntil);
            await new Promise(() => {});
        });
    });

    describe("hang in an after hook", () => {
        afterEach(() => new Promise(() => {}), 2_000);
        test("passes, then its afterEach hangs", () => {
            expect(true).toBe(true);
        });
    });

    describe("hang report disarmed", () => {
        // Keeps the worker running past the threshold after the attempt
        // ended: a report still armed would fire here.
        afterAll(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
        test("passes before a slow afterAll", () => expect(true).toBe(true));
    });

    describe("hang report beside a timeout", () => {
        // Run with the report due 10 ms before this timeout: the probe
        // still runs when the attempt fails.
        test("times out while its probe runs", { timeout: 600 }, async () => {
            await new Promise(() => {});
        });
    });
});
