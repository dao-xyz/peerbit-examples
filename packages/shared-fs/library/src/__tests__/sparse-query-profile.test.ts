import { AsyncLocalStorage } from "node:async_hooks";
import { StringMatch } from "@peerbit/document";
import { describe, expect, it, vi } from "vitest";
import { SparseQueryProfile } from "./sparse-query-profile.js";

type Entries = Parameters<SparseQueryProfile["wrap"]>[0];
type Options = NonNullable<Parameters<Entries["index"]["iterate"]>[1]>;
type Remote = Exclude<NonNullable<Options["remote"]>, boolean>;
type Callback = NonNullable<Remote["onResponse"]>;
const source = "configured-public-source-hash";
const request = {
    query: [new StringMatch({ key: "id", value: "private-chunk-id" })],
};
const remoteOptions = (): Options => ({
    local: false,
    resolve: true,
    remote: {
        from: [source],
        replicate: false,
        timeout: 5000,
        throwOnMissing: true,
        retryMissingResponses: false,
    },
});
const fixture = () => {
    const row = { marker: "returned-row" };
    let options: Options | undefined;
    const received: unknown[] = [];
    const iterator = {
        marker: "original-iterator",
        done() {
            return this.marker === "original-iterator";
        },
        next: vi.fn(async function (this: unknown, _amount: number) {
            received.push(this);
            return [row];
        }),
        close: vi.fn(async function (this: unknown) {
            received.push(this);
        }),
        all() {
            return Promise.resolve([this.marker]);
        },
        first() {
            return Promise.resolve(this.marker);
        },
        pending() {
            return this.marker;
        },
        async *[Symbol.asyncIterator]() {
            yield this.marker;
        },
    };
    const index = {
        marker: "original-index",
        identify() {
            return this.marker;
        },
        iterate: vi.fn(function (
            this: unknown,
            _request: unknown,
            supplied?: Options
        ) {
            received.push(this);
            options = supplied;
            return iterator;
        }),
    };
    const entries = {
        index,
        marker: "original-entries",
        identify() {
            return this.marker;
        },
    };
    return {
        row,
        iterator,
        index,
        entries,
        received,
        asEntries: entries as unknown as Entries,
        options: () => options,
    };
};
const remote = (options: Options | undefined) => options?.remote as Remote;
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
};

describe("test-only sparse query phase profile", () => {
    it("releases async context once and never reactivates it after stop", async () => {
        const disable = vi.spyOn(AsyncLocalStorage.prototype, "disable");
        const run = vi.spyOn(AsyncLocalStorage.prototype, "run");
        try {
            const profile = new SparseQueryProfile({ source });
            const value = {};
            expect(await profile.measure("active", async () => value)).toBe(
                value
            );
            expect(run).toHaveBeenCalledTimes(1);
            profile.stop();
            profile.stop();
            expect(disable).toHaveBeenCalledTimes(1);
            const snapshot = profile.snapshot();
            expect(await profile.measure("stopped", async () => value)).toBe(
                value
            );
            const original = new Error("Original failure");
            await expect(
                profile.measure("stopped-error", async () => {
                    throw original;
                })
            ).rejects.toBe(original);
            expect(run).toHaveBeenCalledTimes(1);
            expect(profile.snapshot()).toEqual(snapshot);
        } finally {
            disable.mockRestore();
            run.mockRestore();
        }
    });

    it("forwards options, values, receivers and other iterator methods without mutating the originals", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const wrapped = profile.wrap(fake.asEntries);
        const options = remoteOptions();
        const originalRemote = options.remote;
        const signal = new AbortController().signal;
        options.signal = signal;
        Object.freeze(originalRemote);
        Object.freeze(options);
        const originalIterate = fake.index.iterate;
        const originalNext = fake.iterator.next;
        const iterator = wrapped.index.iterate(request, options);
        expect(fake.index.iterate).toBe(originalIterate);
        expect(fake.iterator.next).toBe(originalNext);
        expect(fake.index.iterate.mock.calls[0][0]).toBe(request);
        expect(fake.options()).toEqual({
            ...options,
            remote: {
                ...(originalRemote as Remote),
                onResponse: expect.any(Function),
            },
        });
        expect(fake.options()?.signal).toBe(signal);
        expect(remote(fake.options()).from).toBe(
            (originalRemote as Remote).from
        );
        expect((originalRemote as Remote).onResponse).toBeUndefined();
        expect(await iterator.next(3)).toEqual([fake.row]);
        await iterator.close();
        expect(fake.iterator.next).toHaveBeenCalledWith(3);
        expect(fake.received).toEqual([
            fake.index,
            fake.iterator,
            fake.iterator,
        ]);
        expect(iterator.done()).toBe(true);
        expect(await iterator.all()).toEqual(["original-iterator"]);
        expect(await iterator.first()).toBe("original-iterator");
        expect(iterator.pending()).toBe("original-iterator");
        const yielded: unknown[] = [];
        for await (const value of iterator) yielded.push(value);
        expect(yielded).toEqual(["original-iterator"]);
        // These two methods belong only to the fake; exercise general forwarding.
        expect((wrapped as unknown as typeof fake.entries).identify()).toBe(
            "original-entries"
        );
        expect((wrapped.index as unknown as typeof fake.index).identify()).toBe(
            "original-index"
        );
        const events = profile.snapshot().events;
        expect(events.map((event) => event.phase)).toEqual([
            "query.create.start",
            "query.create.end",
            "query.next.start",
            "query.next.end",
            "query.close.start",
            "query.close.end",
        ]);
        expect(
            events.find((event) => event.phase === "query.next.end")
        ).toMatchObject({
            queryId: 1,
            requested: 3,
            returned: 1,
            outcome: "fulfilled",
        });
        for (let i = 0; i < events.length; i++) {
            expect(events[i]).toMatchObject({
                source,
                connection: "initial-local",
                applicationGeneration: 0,
            });
            expect(events[i].atMs).toBeGreaterThanOrEqual(
                i ? events[i - 1].atMs : 0
            );
        }
        expect(JSON.stringify(profile.snapshot())).not.toContain(
            "private-chunk-id"
        );
        expect(JSON.stringify(profile.snapshot())).not.toContain(
            "returned-row"
        );
    });

    it.each([false, true, undefined])(
        "preserves remote=%s without enabling a response hook",
        (value) => {
            const fake = fixture();
            const options: Options = { local: true, remote: value };
            new SparseQueryProfile({ source })
                .wrap(fake.asEntries)
                .index.iterate({}, options);
            expect(fake.options()).toBe(options);
        }
    );

    it("records decoded response before the existing callback and next completion without inspecting payload", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const payload = new Proxy(
            {},
            {
                get() {
                    throw new Error("Payload inspected");
                },
            }
        ) as Parameters<Callback>[0];
        // A minimal public-key callback fixture, not a real identity.
        const from = {
            hashcode: () => "actual-public-source-hash",
        } as unknown as Parameters<Callback>[1];
        const receiver = {};
        const callbackResult = Promise.resolve("not awaited by wrapper");
        const callback = vi.fn(function (this: unknown, response, sender) {
            expect(this).toBe(receiver);
            expect(response).toBe(payload);
            expect(sender).toBe(from);
            expect(profile.snapshot().events.at(-1)?.phase).toBe(
                "query.decoded-response"
            );
            return callbackResult;
        });
        const options = remoteOptions();
        remote(options).onResponse = callback;
        fake.iterator.next.mockImplementation(async () => {
            expect(
                remote(fake.options()).onResponse!.call(receiver, payload, from)
            ).toBe(callbackResult);
            return [fake.row];
        });
        await profile.measure("selected", async () => {
            const iterator = profile
                .wrap(fake.asEntries)
                .index.iterate(request, options);
            await iterator.next(1);
            await iterator.close();
        });
        const events = profile.snapshot().events;
        expect(callback).toHaveBeenCalledTimes(1);
        expect(
            events.find((event) => event.phase === "query.decoded-response")
        ).toMatchObject({
            operationId: 1,
            queryId: 1,
            label: "selected",
            from: "actual-public-source-hash",
        });
        expect(
            events.findIndex(
                (event) => event.phase === "query.decoded-response"
            )
        ).toBeLessThan(
            events.findIndex((event) => event.phase === "query.next.end")
        );
        expect(profile.snapshot().observerErrors).toBe(0);
    });

    it("keeps an existing response callback failure visible as the original next rejection", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const reason = new Error("existing callback failed");
        const options = remoteOptions();
        remote(options).onResponse = () => {
            throw reason;
        };
        fake.iterator.next.mockImplementation(async () => {
            remote(fake.options()).onResponse!({} as Parameters<Callback>[0]);
            return [fake.row];
        });
        const iterator = profile
            .wrap(fake.asEntries)
            .index.iterate({}, options);
        await expect(iterator.next(1)).rejects.toBe(reason);
        expect(profile.snapshot().events.at(-1)).toMatchObject({
            phase: "query.next.end",
            outcome: "rejected",
            rejectionType: "object",
        });
        expect(profile.snapshot().observerErrors).toBe(0);
    });

    it("contains observer hash extraction failure but still calls the existing callback", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const callback = vi.fn();
        const options = remoteOptions();
        remote(options).onResponse = callback;
        profile.wrap(fake.asEntries).index.iterate({}, options);
        // Deliberately malformed metadata exercises nonthrowing capture.
        const from = {
            hashcode() {
                throw new Error("observer read failed");
            },
        } as unknown as Parameters<Callback>[1];
        expect(() =>
            remote(fake.options()).onResponse!(
                {} as Parameters<Callback>[0],
                from
            )
        ).not.toThrow();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(profile.snapshot().observerErrors).toBe(1);
        expect(
            profile
                .snapshot()
                .events.some(
                    (event) => event.phase === "query.decoded-response"
                )
        ).toBe(false);
    });

    it("contains returned-row counting failure without replacing the result", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const result = new Proxy([fake.row], {
            get(target, key, receiver) {
                if (key === "length")
                    throw new Error("observer row-count read failed");
                return Reflect.get(target, key, receiver);
            },
        });
        fake.iterator.next.mockResolvedValue(result);
        const iterator = profile
            .wrap(fake.asEntries)
            .index.iterate({}, remoteOptions());
        expect(await iterator.next(1)).toBe(result);
        expect(profile.snapshot().observerErrors).toBe(1);
    });

    it.each(["create", "next", "close", "measure"] as const)(
        "preserves error and undefined rejection identity in %s",
        async (phase) => {
            for (const reason of [new Error("original failure"), undefined]) {
                const fake = fixture();
                const profile = new SparseQueryProfile({ source });
                const wrapped = profile.wrap(fake.asEntries);
                if (phase === "create") {
                    fake.index.iterate.mockImplementation(() => {
                        throw reason;
                    });
                    let caught = false;
                    try {
                        wrapped.index.iterate({}, remoteOptions());
                    } catch (error) {
                        caught = true;
                        expect(error).toBe(reason);
                    }
                    expect(caught).toBe(true);
                } else if (phase === "measure") {
                    await expect(
                        profile.measure("failure", async () => {
                            throw reason;
                        })
                    ).rejects.toBe(reason);
                } else {
                    const iterator = wrapped.index.iterate({}, remoteOptions());
                    if (phase === "next")
                        fake.iterator.next.mockRejectedValue(reason);
                    else fake.iterator.close.mockRejectedValue(reason);
                    await expect(
                        phase === "next" ? iterator.next(1) : iterator.close()
                    ).rejects.toBe(reason);
                }
                expect(profile.snapshot().events.at(-1)).toMatchObject({
                    outcome: "rejected",
                    rejectionType:
                        reason === undefined ? "undefined" : "object",
                });
            }
        }
    );

    it("keeps overlapping measures and their queries attributed independently", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source });
        const wrapped = profile.wrap(fake.asEntries);
        const release = deferred();
        const first = profile.measure("first", async () => {
            await release.promise;
            await wrapped.index.iterate({}, remoteOptions()).next(1);
            return "first-value";
        });
        const secondValue = await profile.measure("second", async () => {
            await wrapped.index.iterate({}, remoteOptions()).next(2);
            return "second-value";
        });
        release.resolve();
        expect(await first).toBe("first-value");
        expect(secondValue).toBe("second-value");
        expect(
            profile
                .snapshot()
                .events.filter((event) => event.phase === "query.next.end")
        ).toMatchObject([
            { label: "second", operationId: 2, queryId: 1, requested: 2 },
            { label: "first", operationId: 1, queryId: 2, requested: 1 },
        ]);
    });

    it("bounds capture and freezes it after stop without changing forwarding", async () => {
        const fake = fixture();
        const profile = new SparseQueryProfile({ source, maxEvents: 2 });
        const iterator = profile
            .wrap(fake.asEntries)
            .index.iterate({}, remoteOptions());
        await iterator.next(1);
        expect(profile.snapshot().events).toHaveLength(2);
        expect(profile.snapshot().dropped).toBe(2);
        profile.stop();
        const before = profile.snapshot();
        await profile.measure("after-stop", async () => {
            await iterator.close();
        });
        expect(profile.snapshot()).toEqual(before);
        expect(fake.iterator.close).toHaveBeenCalledTimes(1);
        before.events[0].phase = "caller mutation";
        expect(profile.snapshot().events[0].phase).toBe("query.create.start");
    });

    it("freezes an in-flight measure at stop and still returns its value", async () => {
        const profile = new SparseQueryProfile({ source });
        const release = deferred();
        const work = profile.measure("parked", async () => {
            await release.promise;
            return 42;
        });
        profile.stop();
        const before = profile.snapshot();
        release.resolve();
        expect(await work).toBe(42);
        expect(profile.snapshot()).toEqual(before);
    });

    it.each([
        {
            matches: {
                kind: "naming",
                parentId: "private-parent",
                name: "private-name",
            },
            kind: "naming-slot",
        },
        {
            matches: { kind: "naming", nodeId: "private-node" },
            kind: "naming-node",
        },
        {
            matches: { kind: "file-version", nodeId: "private-node" },
            kind: "versions-node",
        },
        { matches: { id: "private-id" }, kind: "chunk-id" },
    ])(
        "classifies $kind without retaining identifiers or paths",
        ({ matches, kind }) => {
            const fake = fixture();
            const profile = new SparseQueryProfile({ source });
            profile.wrap(fake.asEntries).index.iterate(
                {
                    query: Object.entries(matches).map(
                        ([key, value]) =>
                            new StringMatch({ key, value: value! })
                    ),
                },
                remoteOptions()
            );
            expect(profile.snapshot().events[0].queryKind).toBe(kind);
            expect(JSON.stringify(profile.snapshot())).not.toContain(
                "private-"
            );
        }
    );

    it.each([-1, 0.5, Infinity, NaN])(
        "rejects an invalid event cap %s",
        (maxEvents) => {
            expect(() => new SparseQueryProfile({ source, maxEvents })).toThrow(
                "nonnegative safe integer"
            );
        }
    );
});
