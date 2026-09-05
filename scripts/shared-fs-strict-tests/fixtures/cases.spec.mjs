import { writeSync } from "node:fs";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
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

    let attempts = 0;
    test("retry eventually passes", { retry: 1 }, () => {
        if (attempts++ === 0) throw new Error("ORIGINAL_FIRST_FAILURE_STACK");
        writeSync(2, "SECOND_ATTEMPT_STARTED\n");
        expect(attempts).toBe(2);
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
});
