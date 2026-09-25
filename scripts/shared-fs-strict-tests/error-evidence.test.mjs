import assert from "node:assert/strict";
import test from "node:test";
import { firstFailureEvidence } from "./error-evidence.mjs";

test("keeps top-level fields and whitelisted nested commit evidence", () => {
    const cause = Object.assign(new Error("RECEIPT_CAUSE"), {
        localCommitSucceeded: true,
        retrySafe: false,
        nativeCommitApplied: true,
        payload: "DO_NOT_COPY",
    });
    const wrapper = new Error("ORIGINAL_WRAPPER", { cause });
    const result = firstFailureEvidence([wrapper]);
    assert.equal(result.errors[0].name, wrapper.name);
    assert.equal(result.errors[0].message, wrapper.message);
    assert.equal(result.errors[0].stack, wrapper.stack);
    assert.deepEqual(result.errors[0].cause, {
        name: cause.name,
        message: cause.message,
        stack: cause.stack,
        localCommitSucceeded: true,
        retrySafe: false,
        nativeCommitApplied: true,
    });
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_COPY/);
    assert.equal(result.errorEvidence.captureErrors, 0);
});

test("keeps AggregateError children, serialized records, and undefined causes", () => {
    const child = { name: "Error", message: "STOP_CAUSE", stack: "STOP_STACK" };
    const result = firstFailureEvidence([
        new AggregateError([child, undefined, null], "cleanup", {
            cause: undefined,
        }),
    ]).errors[0];
    assert.deepEqual(result.errors[0], child);
    assert.deepEqual(result.cause, {
        name: "",
        message: "undefined",
        stack: "",
        valueType: "undefined",
    });
    assert.equal(result.errors[1].valueType, "undefined");
    assert.equal(result.errors[2].valueType, "null");
    assert.equal(result.omittedErrors, 0);
});

test("does not call coercion hooks or inspect arbitrary payload properties", () => {
    let calls = 0;
    const hostile = {
        toString() {
            calls++;
            throw new Error("must not stringify");
        },
    };
    const error = {
        name: hostile,
        message: "ORIGINAL_MESSAGE",
        stack: "ORIGINAL_STACK",
        localCommitSucceeded: "true",
        retrySafe: 0,
        get payload() {
            throw new Error("must not inspect payload");
        },
    };
    const [result] = firstFailureEvidence([error]).errors;
    assert.equal(calls, 0);
    assert.equal(result.name, "[non-primitive diagnostic field]");
    assert.equal(result.message, "ORIGINAL_MESSAGE");
    assert.equal(result.stack, "ORIGINAL_STACK");
    assert.equal("localCommitSucceeded" in result, false);
    assert.equal("retrySafe" in result, false);
});

test("hostile getters and proxies cannot replace readable original fields", () => {
    const error = {
        message: "ORIGINAL_MESSAGE",
        get stack() {
            throw undefined;
        },
        get cause() {
            throw new Error("getter failure");
        },
        get errors() {
            throw new Error("getter failure");
        },
    };
    const result = firstFailureEvidence([error]);
    assert.equal(result.errors[0].message, "ORIGINAL_MESSAGE");
    assert.equal(result.errors[0].stack, "[unreadable diagnostic field]");
    assert.equal(result.errors[0].cause.truncated, "unreadable");
    assert.equal(result.errorEvidence.captureErrors, 3);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.doesNotThrow(() => JSON.stringify(firstFailureEvidence([proxy])));
});

test("cycles and depth limits are explicit and detached", () => {
    const cycle = new Error("cycle");
    cycle.cause = cycle;
    const result = firstFailureEvidence([cycle]);
    assert.equal(result.errors[0].cause.truncated, "cycle");
    const chain = new Error("root");
    let current = chain;
    for (let i = 0; i < 10; i++) current = current.cause = new Error(`n${i}`);
    const snapshot = firstFailureEvidence([chain]);
    assert.match(JSON.stringify(snapshot), /"truncated":"depth"/);
    snapshot.errors[0].cause.message = "changed snapshot";
    assert.equal(chain.cause.message, "n0");
    assert.equal(firstFailureEvidence([chain]).errors[0].cause.message, "n0");
});

test("caps top-level and aggregate counts and retains the original text limits", () => {
    const error = {
        name: "n".repeat(20_000),
        message: "m".repeat(20_000),
        stack: "s".repeat(20_000),
        errors: Array(100_000).fill(new Error("child")),
    };
    const result = firstFailureEvidence(Array(6).fill(error));
    assert.equal(result.errors.length, 4);
    assert.equal(result.omittedErrors, 2);
    for (const root of result.errors) {
        assert.equal(root.errors.length, 4);
        assert.equal(root.omittedErrors, 99_996);
        for (const key of ["name", "message", "stack"]) {
            assert.equal(
                root[key].slice(0, 16_384),
                error[key].slice(0, 16_384)
            );
            assert.equal(
                root[key].slice(16_384),
                "\n[shared-fs diagnostic truncated]"
            );
        }
    }
});

test("bounds nested node and text expansion across all top-level errors", () => {
    const large = {
        name: "n".repeat(50_000),
        message: "m".repeat(50_000),
        stack: "s".repeat(50_000),
    };
    const branch = {
        message: "branch",
        cause: large,
        errors: Array(4).fill(large),
    };
    const root = {
        message: "root",
        cause: branch,
        errors: Array(4).fill(branch),
    };
    const result = firstFailureEvidence(Array(4).fill(root));
    assert.ok(result.errorEvidence.truncatedNodes > 0);
    assert.ok(result.errorEvidence.truncatedFields > 0);
    assert.match(JSON.stringify(result), /"truncated":"node-budget"/);
    assert.ok(JSON.stringify(result).length < 50_000);
});

test("aggregate item access failures do not prevent later evidence", () => {
    const children = [new Error("first"), new Error("second")];
    Object.defineProperty(children, "0", {
        get() {
            throw new Error("unreadable item");
        },
    });
    const result = firstFailureEvidence([
        { message: "ORIGINAL", errors: children },
    ]);
    assert.equal(result.errors[0].message, "ORIGINAL");
    assert.equal(result.errors[0].errors[0].truncated, "unreadable");
    assert.equal(result.errors[0].errors[1].message, "second");
    assert.equal(result.errorEvidence.captureErrors, 1);
});

test("invalid required array lengths are counted at the root and in aggregates", () => {
    for (const length of ["bad", -1, 1.5, Infinity, NaN, undefined]) {
        const malformed = new Proxy([], {
            get(target, key, receiver) {
                if (key === "length") return length;
                return Reflect.get(target, key, receiver);
            },
        });
        const root = firstFailureEvidence(malformed);
        assert.deepEqual(root.errors, []);
        assert.equal(root.omittedErrors, 0);
        assert.equal(root.errorEvidence.captureErrors, 1);

        const aggregate = firstFailureEvidence([
            {
                name: "AggregateError",
                message: "ORIGINAL_AGGREGATE_MESSAGE",
                stack: "ORIGINAL_AGGREGATE_STACK",
                errors: malformed,
            },
        ]);
        assert.equal(aggregate.errors[0].message, "ORIGINAL_AGGREGATE_MESSAGE");
        assert.equal(aggregate.errors[0].stack, "ORIGINAL_AGGREGATE_STACK");
        assert.equal(aggregate.errorEvidence.captureErrors, 1);
    }
});

test("throwing array-length getters are captured once without hiding top-level fields", () => {
    const malformed = new Proxy([], {
        get(target, key, receiver) {
            if (key === "length") throw undefined;
            return Reflect.get(target, key, receiver);
        },
    });
    assert.equal(
        firstFailureEvidence(malformed).errorEvidence.captureErrors,
        1
    );
    const aggregate = firstFailureEvidence([
        { message: "ORIGINAL", stack: "ORIGINAL_STACK", errors: malformed },
    ]);
    assert.equal(aggregate.errors[0].message, "ORIGINAL");
    assert.equal(aggregate.errors[0].stack, "ORIGINAL_STACK");
    assert.equal(aggregate.errorEvidence.captureErrors, 1);
});
