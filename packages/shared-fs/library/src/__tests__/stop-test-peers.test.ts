import { expect, it } from "vitest";
import { stopTestPeers } from "./stop-test-peers.js";

it("stops every peer once and drains the registry before settlement", async () => {
    const calls: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const peers = [
        { stop: () => (calls.push("first"), pending) },
        { stop: () => calls.push("second") },
    ];
    const stopping = stopTestPeers(peers);
    expect(peers).toEqual([]);
    expect(calls).toEqual(["first", "second"]);
    await stopTestPeers(peers);
    finish();
    await stopping;
    expect(calls).toEqual(["first", "second"]);
});

it("retains synchronous and undefined failures while attempting later stops", async () => {
    const original = new Error("ORIGINAL_STOP_STACK");
    const calls: number[] = [];
    const peers = [
        {
            stop: () => {
                calls.push(1);
                throw original;
            },
        },
        { stop: () => (calls.push(2), Promise.reject(undefined)) },
        { stop: () => calls.push(3) },
    ];
    let failure: unknown;
    try {
        await stopTestPeers(peers);
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
        throw new Error("Expected cleanup failure");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(original);
    expect(failure.errors[0].stack).toBe(original.stack);
    expect(failure.errors[1]).toBeUndefined();
    expect(calls).toEqual([1, 2, 3]);
    expect(peers).toEqual([]);
    await stopTestPeers(peers);
    expect(calls).toEqual([1, 2, 3]);
});
