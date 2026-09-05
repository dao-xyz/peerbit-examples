import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileChunk, openSharedFs, type SharedFsHandle } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 90_000 : 30_000);
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

/**
 * The memoized trust-verdict cache must never change WHO can write — only
 * how often the trust-graph BFS runs. Revocation-shaped changes (any
 * trust-graph change) flush it; negative verdicts expire quickly so a
 * writer whose trust relation is still replicating is retried.
 */
describe("shared fs trust-verdict cache", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            peers.splice(0).map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* benign close races */
                }
            })
        );
    });

    it("rejects an untrusted writer with a warm cache, accepts after authorization", async () => {
        const owner = await Peerbit.create();
        const stranger = await Peerbit.create();
        peers.push(owner, stranger);
        await owner.dial(stranger);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        await ownerFs.writeFile("/owned.txt", "by owner");
        const strangerFs = await openSharedFs({
            peerbit: stranger,
            address: ownerFs.address,
            machineLabel: "stranger",
        });
        // Two consecutive attempts: the second hits the negative-verdict
        // cache path and must be rejected identically.
        await expect(
            strangerFs.writeFile("/intruder.txt", "nope")
        ).rejects.toThrow();
        await expect(
            strangerFs.writeFile("/intruder.txt", "still nope")
        ).rejects.toThrow();

        await ownerFs.authorizeWriter(stranger.identity.publicKey);
        // The trust relation replicates to the stranger's replica, whose
        // change listener flushes the verdict cache; the write then lands.
        await waitUntil(async () => {
            await strangerFs.writeFile("/granted.txt", "now trusted");
        });
        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/granted.txt"))).toBe(
                "now trusted"
            );
        });
    });

    it("flushes every memoized verdict on any trust-graph change", async () => {
        const owner = await Peerbit.create();
        const other = await Peerbit.create();
        peers.push(owner, other);
        const ownerFs = await openSharedFs({
            peerbit: owner,
            machineLabel: "owner",
            rootKey: owner.identity.publicKey,
        });
        await ownerFs.writeFile("/warm.txt", "warms the cache");
        const program: any = ownerFs.program;
        expect(program.trustVerdicts.size).toBeGreaterThan(0);

        await ownerFs.authorizeWriter(other.identity.publicKey);
        await waitUntil(() => {
            expect(program.trustVerdicts.size).toBe(0);
        });
        // And the cache re-warms on the next validated write.
        await ownerFs.writeFile("/rewarm.txt", "again");
        expect(program.trustVerdicts.size).toBeGreaterThan(0);
    });

    describe("deterministic admission invalidation", () => {
        let owner: Peerbit;
        let fs: SharedFsHandle;
        let program: any;
        let operation: any;

        beforeEach(async () => {
            owner = await Peerbit.create();
            peers.push(owner);
            fs = await openSharedFs({
                peerbit: owner,
                machineLabel: "trust-epoch",
                rootKey: owner.identity.publicKey,
                gc: false,
                bootstrap: false,
            });
            program = fs.program;
            program.trustVerdicts.clear();
            operation = {
                type: "put",
                value: new FileChunk({ bytes: new Uint8Array([1, 2, 3]) }),
                entry: {
                    getPublicKeys: async () => [owner.identity.publicKey],
                },
            };
        });

        afterEach(() => vi.restoreAllMocks());

        const changeTrustGraph = () => {
            // Exercise the installed listener, not a direct cache clear.
            // The mocked BFS supplies the before/after graph verdicts.
            program.trustGraph.trustGraph.events.dispatchEvent(
                new CustomEvent("change", {
                    detail: { added: [], removed: [] },
                })
            );
        };

        const parkVerdict = (fresh: boolean) => {
            const entered = deferred<void>();
            const stale = deferred<boolean>();
            const check = vi
                .spyOn(program.trustGraph, "isTrusted")
                .mockImplementationOnce(async () => {
                    entered.resolve();
                    return stale.promise;
                })
                .mockResolvedValue(fresh);
            const admission = program.canPerformEntry(operation);
            return { entered, stale, check, admission };
        };

        it.each([true, false])(
            "rejects an invalidated %s verdict without refilling after a graph change",
            async (previous) => {
                const parked = parkVerdict(!previous);
                try {
                    await parked.entered.promise;
                    program.trustVerdicts.set("event-witness", {
                        ok: true,
                        at: 0,
                    });
                    changeTrustGraph();
                    expect(program.trustVerdicts.size).toBe(0);
                    parked.stale.resolve(previous);
                    expect(await parked.admission).toBe(false);
                    expect(program.trustVerdicts.size).toBe(0);
                    expect(parked.check).toHaveBeenCalledTimes(1);

                    // A fresh admission sees the new state, then reuses its
                    // stable cache verdict without another BFS.
                    expect(await program.canPerformEntry(operation)).toBe(
                        !previous
                    );
                    expect(await program.canPerformEntry(operation)).toBe(
                        !previous
                    );
                    expect(parked.check).toHaveBeenCalledTimes(2);
                } finally {
                    parked.stale.resolve(previous);
                    await parked.admission;
                }
            }
        );

        it.each(["close", "close-reopen lifecycle seam"] as const)(
            "rejects an old positive verdict across %s without a late cache fill",
            async (transition) => {
                const parked = parkVerdict(false);
                try {
                    await parked.entered.promise;
                    await program.close();
                    if (transition === "close-reopen lifecycle seam") {
                        // Exercise the real open request/generation wrapper
                        // with its storage transition replaced by a fresh
                        // cache lifetime and a live invalidation listener.
                        // This is not network reopen proof.
                        vi.spyOn(
                            program,
                            "openLifecycleTransition"
                        ).mockImplementation(async () => {
                            program.openGeneration++;
                            program.trustVerdicts = new Map();
                            program.trustVerdictEpoch++;
                            program.trustChangeListener = () => {
                                program.trustVerdictEpoch++;
                                program.trustVerdicts.clear();
                            };
                            program.trustGraph.trustGraph.events.addEventListener(
                                "change",
                                program.trustChangeListener
                            );
                        });
                        await program.open({ gc: false, bootstrap: false });
                        expect(program.lifecycleRequestedState).toBe("open");
                    }
                    expect(program.trustVerdicts.size).toBe(0);
                    const callsBeforeRelease = parked.check.mock.calls.length;
                    parked.stale.resolve(true);
                    expect(await parked.admission).toBe(false);
                    expect(program.trustVerdicts.size).toBe(0);
                    expect(parked.check).toHaveBeenCalledTimes(
                        callsBeforeRelease
                    );
                    if (transition === "close-reopen lifecycle seam") {
                        expect(await program.canPerformEntry(operation)).toBe(
                            false
                        );
                        expect(parked.check).toHaveBeenCalledTimes(
                            callsBeforeRelease + 1
                        );
                    } else {
                        expect(await program.canPerformEntry(operation)).toBe(
                            false
                        );
                        expect(parked.check).toHaveBeenCalledTimes(
                            callsBeforeRelease
                        );
                    }
                } finally {
                    parked.stale.resolve(true);
                    await parked.admission;
                    if (transition === "close-reopen lifecycle seam") {
                        program.detachTrustChangeListener();
                    }
                }
            }
        );

        it.each([false, true])(
            "drains an owned critical-tail trust check across close (graph changed: %s)",
            async (changed) => {
                await fs.writeFile("/draining.txt", "before");
                program.trustVerdicts.clear();
                const entered = deferred<void>();
                const release = deferred<boolean>();
                const check = vi
                    .spyOn(program.trustGraph, "isTrusted")
                    .mockImplementationOnce(async () => {
                        entered.resolve();
                        return release.promise;
                    })
                    .mockResolvedValue(true);
                // Observe either outcome immediately: a rejected append is
                // expected only in the graph-change case, never from close.
                const writing = fs.writeFile("/draining.txt", "after").then(
                    (value) => ({ value, error: undefined }),
                    (error: unknown) => ({ value: undefined, error })
                );
                let closing: Promise<boolean> | undefined;
                try {
                    await entered.promise;
                    expect(
                        program.foregroundMutationTasks.size
                    ).toBeGreaterThan(0);
                    closing = program.close();
                    expect(program.lifecycleRequestedState).toBe("closing");
                    if (changed) {
                        program.trustVerdicts.set("event-witness", {
                            ok: true,
                            at: 0,
                        });
                        check.mockResolvedValue(false);
                        changeTrustGraph();
                        expect(program.trustVerdicts.size).toBe(0);
                    }
                    release.resolve(true);
                    const result = await writing;
                    if (changed) {
                        expect(result.error).toMatchObject({
                            message: "Not allowed to append",
                        });
                        expect(program.trustVerdicts.size).toBe(0);
                    } else {
                        expect(result.error).toBeUndefined();
                        expect(result.value).toBeDefined();
                    }
                    await closing;
                    expect(program.foregroundMutationTasks.size).toBe(0);
                    expect(program.trustChangeListener).toBeUndefined();
                } finally {
                    release.resolve(true);
                    await writing;
                    await closing;
                }
            }
        );

        it("rejects fresh callbacks after trust retirement while child storage still closes", async () => {
            const check = vi
                .spyOn(program.trustGraph, "isTrusted")
                .mockResolvedValue(true);
            expect(await program.canPerformEntry(operation)).toBe(true);
            expect(check).toHaveBeenCalledTimes(1);
            const openGeneration = program.openGeneration;
            const entered = deferred<void>();
            const release = deferred<void>();
            const originalClose = program.entries.close.bind(program.entries);
            vi.spyOn(program.entries, "close").mockImplementation(
                async (from: unknown) => {
                    entered.resolve();
                    await release.promise;
                    return originalClose(from);
                }
            );
            const closing = program.close();
            try {
                await entered.promise;
                expect(program.lifecycleRequestedState).toBe("closing");
                expect(program.openGeneration).toBeGreaterThan(openGeneration);
                expect(program.trustChangeListener).toBeUndefined();

                // Both warm-cache and fresh-BFS paths must remain closed.
                // A new callback cannot claim the retired generation that
                // close advanced immediately before awaiting child storage.
                const warmed = await program.canPerformEntry(operation);
                program.trustVerdicts.clear();
                const cold = await program.canPerformEntry(operation);
                expect({
                    warmed,
                    cold,
                    checks: check.mock.calls.length,
                    cacheSize: program.trustVerdicts.size,
                }).toEqual({
                    warmed: false,
                    cold: false,
                    checks: 1,
                    cacheSize: 0,
                });
            } finally {
                release.resolve();
                await closing;
            }
        });

        it("invalidates a warmed verdict while the current open is still gated", async () => {
            const check = vi
                .spyOn(program.trustGraph, "isTrusted")
                .mockResolvedValue(true);
            expect(await program.canPerformEntry(operation)).toBe(true);
            program.writeReadinessLifecycleBlocked = true;
            try {
                changeTrustGraph();
                expect(program.trustVerdicts.size).toBe(0);
            } finally {
                program.writeReadinessLifecycleBlocked = false;
            }
            check.mockResolvedValue(false);
            expect(await program.canPerformEntry(operation)).toBe(false);
            expect(check).toHaveBeenCalledTimes(2);
        });

        it("fences graph changes while entry signers are still loading", async () => {
            const entered = deferred<void>();
            const release = deferred<void>();
            const check = vi
                .spyOn(program.trustGraph, "isTrusted")
                .mockResolvedValue(true);
            operation.entry.getPublicKeys = async () => {
                entered.resolve();
                await release.promise;
                return [owner.identity.publicKey];
            };
            const admission = program.canPerformEntry(operation);
            try {
                await entered.promise;
                changeTrustGraph();
                release.resolve();
                expect(await admission).toBe(false);
                expect(program.trustVerdicts.size).toBe(0);
                expect(check).not.toHaveBeenCalled();
            } finally {
                release.resolve();
                await admission;
            }
        });
    });
});
