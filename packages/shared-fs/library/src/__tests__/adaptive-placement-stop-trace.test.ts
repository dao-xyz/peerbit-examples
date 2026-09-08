import { describe, expect, it } from "vitest";
import {
    createPlacementStopTrace,
    observePlacementStopMethods,
    type PlacementStopEvent,
    type StopPhase,
    type StopPoint,
} from "./adaptive-placement-stop-trace.js";

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

describe("adaptive placement stop trace", () => {
    it("emits phase boundaries immediately and preserves synchronous results", () => {
        let clock = 100;
        const emitted: PlacementStopEvent[] = [];
        const trace = createPlacementStopTrace({
            now: () => clock,
            emit: (event) => emitted.push(event),
        });
        trace.point("command.received");
        clock = 102;
        trace.point("command.dequeued");
        const result = {};
        const returned = trace.observe("disk.scan", () => {
            expect(emitted.at(-1)).toEqual({
                label: "disk.scan",
                state: "enter",
                atMs: 2,
            });
            expect(trace.snapshot().pending).toEqual([
                { label: "disk.scan", count: 1 },
            ]);
            clock = 106;
            return result;
        });
        expect(returned).toBe(result);
        trace.point("ipc.reply.begin");
        trace.point("ipc.reply.end");
        expect(trace.snapshot()).toEqual({
            events: [
                { label: "command.received", state: "point", atMs: 0 },
                { label: "command.dequeued", state: "point", atMs: 2 },
                { label: "disk.scan", state: "enter", atMs: 2 },
                { label: "disk.scan", state: "fulfilled", atMs: 6 },
                { label: "ipc.reply.begin", state: "point", atMs: 6 },
                { label: "ipc.reply.end", state: "point", atMs: 6 },
            ],
            omittedEvents: 0,
            pending: [],
            elapsedMs: 6,
        });
        expect(emitted).toEqual(trace.snapshot().events);
    });

    it("returns the original promise and observes fulfillment without await insertion", async () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const task = deferred<object>();
        const value = {};
        expect(trace.observe("peer.stop", () => task.promise)).toBe(
            task.promise
        );
        expect(trace.snapshot().pending).toEqual([
            { label: "peer.stop", count: 1 },
        ]);
        task.resolve(value);
        expect(trace.snapshot().pending).toEqual([
            { label: "peer.stop", count: 1 },
        ]);
        expect(await task.promise).toBe(value);
        expect(trace.snapshot().pending).toEqual([]);
        expect(trace.snapshot().events.map(({ state }) => state)).toEqual([
            "enter",
            "fulfilled",
        ]);
    });

    it("preserves rejected promises and original rejection reasons", async () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const task = deferred<void>();
        const error = new Error("original rejection");
        expect(trace.observe("peer.storage.close", () => task.promise)).toBe(
            task.promise
        );
        task.reject(error);
        await expect(task.promise).rejects.toBe(error);
        expect(trace.snapshot().pending).toEqual([]);
        expect(trace.snapshot().events.map(({ state }) => state)).toEqual([
            "enter",
            "rejected",
        ]);
    });

    it("preserves synchronous throws even if the emitter throws", () => {
        const trace = createPlacementStopTrace({
            emit: () => {
                throw new Error("emitter");
            },
        });
        const error = { original: true };
        let thrown: unknown;
        try {
            trace.observe("peer.handler.stop", () => {
                throw error;
            });
        } catch (caught) {
            thrown = caught;
        }
        expect(thrown).toBe(error);
        expect(() => trace.point("ipc.reply.error")).not.toThrow();
        expect(trace.observe("disk.scan", () => 42)).toBe(42);
        expect(trace.snapshot().pending).toEqual([]);
        expect(trace.snapshot().events[1].state).toBe("rejected");
    });

    it("contains emitter failures on async settlement without changing the promise", async () => {
        const trace = createPlacementStopTrace({
            emit: () => {
                throw new Error("IPC closed");
            },
        });
        const promise = Promise.resolve(42);
        expect(trace.observe("peer.libp2p.stop", () => promise)).toBe(promise);
        expect(await promise).toBe(42);
        expect(trace.snapshot().pending).toEqual([]);
        expect(trace.snapshot().events[1].state).toBe("fulfilled");
    });

    it("tracks overlapping phases and reentrant calls by fixed-label counts", async () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const first = deferred<void>();
        const second = deferred<void>();
        const other = deferred<void>();
        trace.observe("peer.stop", () => first.promise);
        trace.observe("peer.stop", () => second.promise);
        trace.observe("peer.indexer.stop", () => other.promise);
        expect(trace.snapshot().pending).toEqual([
            { label: "peer.stop", count: 2 },
            { label: "peer.indexer.stop", count: 1 },
        ]);
        second.resolve();
        await second.promise;
        expect(trace.snapshot().pending).toEqual([
            { label: "peer.stop", count: 1 },
            { label: "peer.indexer.stop", count: 1 },
        ]);
        first.resolve();
        other.resolve();
        await Promise.all([first.promise, other.promise]);
        expect(trace.snapshot().pending).toEqual([]);
    });

    it("caps retained and emitted events but keeps pending state accurate", async () => {
        const emitted: PlacementStopEvent[] = [];
        const trace = createPlacementStopTrace({
            emit: (event) => emitted.push(event),
        });
        for (let i = 0; i < 70; i++) trace.point("command.received");
        const task = deferred<void>();
        trace.observe("peer.bootstrapRecovery", () => task.promise);
        expect(trace.snapshot()).toMatchObject({
            omittedEvents: 7,
            pending: [{ label: "peer.bootstrapRecovery", count: 1 }],
        });
        task.resolve();
        await task.promise;
        expect(trace.snapshot().events).toHaveLength(64);
        expect(emitted).toHaveLength(64);
        expect(trace.snapshot().omittedEvents).toBe(8);
        expect(trace.snapshot().pending).toEqual([]);
    });

    it("detaches all snapshot and emitter records and ignores unknown labels", async () => {
        const trace = createPlacementStopTrace({
            now: () => 100,
            emit: (event) => {
                event.atMs = -1;
            },
        });
        trace.point("command.received");
        const task = deferred<void>();
        trace.observe("peer.stop", () => task.promise);
        const view = trace.snapshot();
        view.events[0].atMs = -2;
        view.events.length = 0;
        view.pending[0].count = 200;
        view.pending.push({ label: "disk.scan", count: 2 });
        view.omittedEvents = 300;
        trace.point("private payload" as StopPoint);
        const value = {};
        expect(trace.observe("private phase" as StopPhase, () => value)).toBe(
            value
        );
        expect(trace.snapshot()).toEqual({
            events: [
                { label: "command.received", state: "point", atMs: 0 },
                { label: "peer.stop", state: "enter", atMs: 0 },
            ],
            omittedEvents: 0,
            pending: [{ label: "peer.stop", count: 1 }],
            elapsedMs: 0,
        });
        task.resolve();
        await task.promise;
    });

    it("keeps elapsed time finite and monotonic when the diagnostic clock misbehaves", () => {
        const samples = [100, 105, 103, Number.NaN, Infinity, 108];
        const trace = createPlacementStopTrace({
            emit: () => {},
            now: () => {
                const value = samples.shift();
                if (value === undefined) throw new Error("clock");
                return value;
            },
        });
        for (let i = 0; i < 6; i++) trace.point("command.received");
        expect(trace.snapshot().events.map(({ atMs }) => atMs)).toEqual([
            5, 5, 5, 5, 8, 8,
        ]);
        expect(trace.snapshot().elapsedMs).toBe(8);
    });

    it("does not assimilate arbitrary thenables or invoke their then getters", () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const result = {
            get then() {
                throw new Error("must not inspect");
            },
        };
        expect(trace.observe("disk.scan", () => result)).toBe(result);
        expect(trace.snapshot().pending).toEqual([]);
        expect(trace.snapshot().events[1].state).toBe("fulfilled");
    });
});

describe("adaptive placement stop method observation", () => {
    it("preserves receiver, arguments, and cached promise identity", async () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const task = deferred<number>();
        const target = {
            seen: [] as unknown[],
            stop(...args: unknown[]) {
                this.seen.push(...args);
                return task.promise;
            },
        };
        const descriptor = Object.getOwnPropertyDescriptor(target, "stop");
        const restore = observePlacementStopMethods(trace, [
            { target, key: "stop", phase: "peer.stop" },
        ]);
        const argument = {};
        expect(target.stop(argument, 42)).toBe(task.promise);
        expect(target.stop()).toBe(task.promise);
        expect(target.seen).toEqual([argument, 42]);
        expect(trace.snapshot().pending).toEqual([
            { label: "peer.stop", count: 2 },
        ]);
        task.resolve(42);
        expect(await task.promise).toBe(42);
        expect(trace.snapshot().pending).toEqual([]);
        restore();
        restore();
        expect(Object.getOwnPropertyDescriptor(target, "stop")).toEqual(
            descriptor
        );
    });

    it("shadows and restores inherited methods without changing the prototype", () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const error = {};
        class Target {
            stop() {
                throw error;
            }
        }
        const original = Target.prototype.stop;
        const target = new Target();
        const restore = observePlacementStopMethods(trace, [
            { target, key: "stop", phase: "peer.handler.stop" },
        ]);
        expect(Object.hasOwn(target, "stop")).toBe(true);
        expect(Target.prototype.stop).toBe(original);
        let thrown: unknown;
        try {
            target.stop();
        } catch (caught) {
            thrown = caught;
        }
        expect(thrown).toBe(error);
        restore();
        expect(Object.hasOwn(target, "stop")).toBe(false);
        expect(target.stop).toBe(original);
    });

    it("does not overwrite a replacement installed by another owner", () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const target = { stop: () => 1 };
        const restore = observePlacementStopMethods(trace, [
            { target, key: "stop", phase: "peer.stop" },
        ]);
        const replacement = () => 2;
        target.stop = replacement;
        restore();
        expect(target.stop).toBe(replacement);
    });

    it("fails before installation for missing methods or duplicate targets", () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const target = { stop: () => 1 };
        const original = target.stop;
        expect(() =>
            observePlacementStopMethods(trace, [
                { target, key: "stop", phase: "peer.stop" },
                { target, key: "missing", phase: "peer.storage.close" },
            ])
        ).toThrow("Missing stop-trace method: missing");
        expect(target.stop).toBe(original);
        expect(() =>
            observePlacementStopMethods(trace, [
                { target, key: "stop", phase: "peer.stop" },
                { target, key: "stop", phase: "peer.stop" },
            ])
        ).toThrow("Invalid stop-trace method target: stop");
        expect(trace.snapshot().events).toEqual([]);
    });

    it("rolls back earlier installations if a later method cannot be shadowed", () => {
        const trace = createPlacementStopTrace({ emit: () => {} });
        const first = { stop: () => 1 };
        const second = Object.freeze({ stop: () => 2 });
        const descriptor = Object.getOwnPropertyDescriptor(first, "stop");
        expect(() =>
            observePlacementStopMethods(trace, [
                { target: first, key: "stop", phase: "peer.stop" },
                { target: second, key: "stop", phase: "peer.handler.stop" },
            ])
        ).toThrow();
        expect(Object.getOwnPropertyDescriptor(first, "stop")).toEqual(
            descriptor
        );
    });
});
