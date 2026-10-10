import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFileSystem,
    SharedFsWritePendingError,
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import { describeReadiness } from "../readiness/coordinator.js";
import type { Timers } from "../readiness/responder.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NOTICE_REASON,
    OpenV1,
    StateNoticeV1,
    type ReadinessMessage,
} from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The operator escape and the readiness status of PR-3 commit 2 (M1 plan
 * 7.3 item 2, skeptic S1; design section 7 and test 47). In prerequisite
 * mode today's tracker still decides when a fresh full address-open turns
 * ready and additionally requires the coordinator's containment, so a
 * joiner whose only peers are absent, gated or silent stays gated: these
 * tests pin the escape (`assumeComplete`), the reason (`bootstrapStatus()
 * .readiness`) and the timeout that carries it, and the coordinator's
 * lifecycle inside the filesystem (close, same-instance reopen and drop
 * while a session is in flight). PR-3 commit 3 adds the trusted-identity
 * clause of an access-controlled store (G3-8) and its escape.
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 60_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
};

const timeoutOf = async (fs: SharedFsHandle, timeout: number) => {
    const error = await fs.awaitWriteReady({ timeout }).then(
        () => {
            throw new Error("awaitWriteReady resolved");
        },
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
    return error as SharedFsWriteReadyTimeoutError;
};

/**
 * Makes `donor`'s responder drop every OPEN it receives (a hung or
 * overloaded peer that still holds the store and stays reachable). Returns
 * the drop count and the restore.
 */
const dropOpens = (donor: SharedFsHandle) => {
    const responder = runtimeOf(donor)!.responder!;
    const onMessage = responder.onMessage;
    const state = { dropped: 0 };
    responder.onMessage = (message, from) => {
        if (message instanceof OpenV1) {
            state.dropped++;
            return;
        }
        onMessage.call(responder, message, from);
    };
    return {
        state,
        restore: () => {
            responder.onMessage = onMessage;
        },
    };
};

/**
 * Watches the readiness timers of one open from now on: the write-readiness
 * tracker's (the program's `writeReadinessTimer`) and the runtime's (the
 * Timers of its responder, its coordinator and every session in flight).
 * Counts the arms after `mark()` and knows which handles are still armed.
 * Handles a session armed before the watch began show in its own
 * `debug().armedTimers`. `unwatchTracker()` hands the program's field back
 * (a same-instance reopen arms its own tracker there); the runtime's
 * wrappers stay on the old instances and keep counting.
 */
const watchReadinessTimers = (program: any, runtime: ReadinessRuntime) => {
    const armed = new Set<unknown>();
    const cleared = new WeakSet<object>();
    const counts = { trackerArms: 0, armsSinceMark: 0 };
    let marked = false;
    const arm = () => {
        if (marked) counts.armsSinceMark++;
    };
    const wrap = (timers: Timers): Timers => ({
        set: (fn, ms) => {
            const handle = timers.set(() => {
                armed.delete(handle);
                fn();
            }, ms);
            armed.add(handle);
            arm();
            return handle;
        },
        clear: (handle) => {
            armed.delete(handle);
            timers.clear(handle);
        },
    });
    const responder = runtime.responder as any;
    if (responder) responder.timers = wrap(responder.timers);
    const coordinator = runtime.coordinator as any;
    coordinator.timers = wrap(coordinator.timers);
    const sessions = [...coordinator.owners.keys()];
    for (const session of sessions) session.timers = wrap(session.timers);

    // The tracker arms with the global setTimeout and clears with the
    // global clearTimeout: its field records each arm, a clear wrapper
    // whether the last one was cleared.
    let tracker = program.writeReadinessTimer;
    Object.defineProperty(program, "writeReadinessTimer", {
        configurable: true,
        enumerable: true,
        get: () => tracker,
        set: (value) => {
            if (value !== undefined) {
                counts.trackerArms++;
                arm();
            }
            tracker = value;
        },
    });
    const clearTimeoutOf = globalThis.clearTimeout;
    globalThis.clearTimeout = ((handle?: any) => {
        if (handle && typeof handle === "object") cleared.add(handle);
        return clearTimeoutOf(handle);
    }) as typeof clearTimeout;
    let lastTracker: unknown;
    let watching = true;
    return {
        counts,
        sessions,
        /** Arms after this call are counted in `armsSinceMark`. */
        mark: () => {
            lastTracker = tracker;
            marked = true;
        },
        /** The runtime's handles still armed. */
        armed: () => armed.size,
        /** The tracker's handle at `mark()` was cleared (or none was armed). */
        trackerCleared: () =>
            lastTracker === undefined || cleared.has(lastTracker as object),
        unwatchTracker: () => {
            if (!watching) return;
            watching = false;
            globalThis.clearTimeout = clearTimeoutOf;
            Object.defineProperty(program, "writeReadinessTimer", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: tracker,
            });
        },
    };
};

/** Records every readiness message a filesystem's runtime receives. */
const recordMessages = (fs: SharedFsHandle) => {
    const runtime = runtimeOf(fs)!;
    const onMessage = runtime.onMessage;
    const seen: Array<{ message: ReadinessMessage; from?: string }> = [];
    runtime.onMessage = (message, from, bytes) => {
        seen.push({ message, from: from?.hashcode() });
        onMessage.call(runtime, message, from, bytes);
    };
    return seen;
};

describe("write readiness escape and status", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
        for (const root of roots.splice(0)) {
            await rm(root, { recursive: true, force: true });
        }
    });

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(directory ? { directory } : {});
        peers.push(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        const index = peers.indexOf(peer);
        if (index >= 0) peers.splice(index, 1);
        await peer.stop();
    };

    /** A creator with one file, in memory. */
    const createDonor = async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "escape-donor",
            gc: false,
        });
        await fs.writeFile("/donor.txt", "from the donor");
        return { peer, fs };
    };

    /** A fresh full joiner of `donor`'s filesystem, dialed to it. */
    const joinDonor = async (
        donor: { peer: Peerbit; fs: SharedFsHandle },
        options: { writeReadinessSettleMs?: number } = {}
    ) => {
        const peer = await createPeer();
        await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.fs.address,
            machineLabel: "escape-joiner",
            bootstrap: false,
            gc: false,
            writeReadinessSettleMs: options.writeReadinessSettleMs ?? 100,
        } as any);
        return { peer, fs };
    };

    /**
     * A directory holding a filesystem whose creator stopped, with its
     * readiness proof withdrawn (as an observer open withdraws it): the next
     * full open there is a fresh join that sees no peer.
     */
    const orphanedDirectory = async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-escape-"));
        roots.push(root);
        const directory = join(root, "peer");
        const creatorPeer = await createPeer(directory);
        const creator = await openSharedFs({
            peerbit: creatorPeer,
            machineLabel: "orphan-creator",
            gc: false,
        });
        await creator.writeFile("/kept.txt", "before the creator left");
        const address = creator.address!;
        await stopPeer(creatorPeer);
        const stateDirectory = join(directory, "shared-fs-bootstrap");
        const [stateName] = await readdir(stateDirectory);
        const statePath = join(stateDirectory, stateName);
        await writeFile(statePath, JSON.stringify({ writeReady: false }));
        return { directory, address, statePath };
    };

    describe("assumeComplete (design test 47)", () => {
        it("makes a fresh joiner with no peer writable as operator; a reopen is warm", async () => {
            const { directory, address, statePath } = await orphanedDirectory();
            const telemetry: BootstrapTelemetryEvent[] = [];
            const peer = await createPeer(directory);
            const fs = await openSharedFs({
                peerbit: peer,
                address,
                machineLabel: "orphan-joiner",
                bootstrap: false,
                gc: false,
                telemetry: { bootstrap: (event) => telemetry.push(event) },
            });
            const runtime = runtimeOf(fs)!;
            expect(fs.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            await waitUntil(() =>
                expect(fs.bootstrapStatus().readiness).toMatchObject({
                    state: "no-peer",
                    satisfied: false,
                    required: [],
                    contained: [],
                })
            );
            // Gated with nothing in flight: no timer armed, however long it
            // waits (M1 plan 10.5; the tracker's own poll is commit 4's).
            expect(runtime.debug().armedTimers).toBe(0);
            expect(runtime.coordinator!.debug().sessions).toBe(0);

            const error = await timeoutOf(fs, 500);
            expect(error.code).toBe("ETIMEDOUT");
            expect(error.readiness).toMatchObject({ state: "no-peer" });
            expect(error.message).toMatch(
                /^timed out awaiting shared filesystem write readiness: .*no-peer/
            );
            expect(runtime.debug().armedTimers).toBe(0);
            await expect(
                fs.writeFile("/early.txt", "no")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);

            const events: any[] = [];
            programOf(fs).events.addEventListener("write:ready", (event: any) =>
                events.push(event.detail)
            );
            const waiting = fs.awaitWriteReady();
            await fs.assumeComplete();
            await waiting;

            const status = fs.bootstrapStatus();
            expect(status).toMatchObject({
                writeReady: true,
                writeReadinessSource: "operator",
                guardArmed: true,
            });
            expect(status.readiness).toMatchObject({ state: "ready" });
            expect(programOf(fs).viewProven).toBe(true);
            expect(programOf(fs).readinessProvenance()).toMatchObject({
                writeReady: true,
                source: "operator",
                fullReplica: true,
            });
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                writeReady: true,
                writeReadinessSource: "operator",
            });
            expect(
                telemetry.filter((event) => event.type === "write-ready")
            ).toMatchObject([{ type: "write-ready", source: "operator" }]);
            expect(runtime.coordinator!.phase).toBe("finished");
            expect(runtime.debug().armedTimers).toBe(0);
            const persisted = JSON.parse(await readFile(statePath, "utf8"));
            expect(persisted).toMatchObject({
                writeReady: true,
                writeReadySource: "operator",
            });
            expect(persisted).not.toHaveProperty("bootstrap");

            // Writable now, and a second call is a no-op.
            await fs.writeFile("/after.txt", "operator");
            await fs.assumeComplete();
            expect(fs.bootstrapStatus().writeReadinessSource).toBe("operator");

            await stopPeer(peer);
            const reopenedPeer = await createPeer(directory);
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "orphan-warm",
                bootstrap: false,
                gc: false,
            });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "operator",
                guardArmed: true,
            });
            // A warm reopen runs no join.
            expect(reopened.bootstrapStatus().readiness).toBeUndefined();
            expect(runtimeOf(reopened)!.coordinator).toBeUndefined();
            expect(programOf(reopened).readinessProvenance()).toMatchObject({
                writeReady: true,
                source: "warm",
            });
            await reopened.writeFile("/warm.txt", "at once");
        });

        it("is refused on an observer, a partial replica and allowPartialWrites; a no-op on a creator", async () => {
            const donor = await createDonor();
            const opened: SharedFsHandle[] = [];
            for (const options of [
                { machineLabel: "observer", replicate: false as const },
                { machineLabel: "partial", replicate: { factor: 0.5 } },
                { machineLabel: "override", allowPartialWrites: true },
            ]) {
                const peer = await createPeer();
                await peer.dial(donor.peer);
                const fs = await openSharedFs({
                    peerbit: peer,
                    address: donor.fs.address,
                    bootstrap: false,
                    gc: false,
                    ...options,
                });
                opened.push(fs);
                await expect(fs.assumeComplete()).rejects.toMatchObject({
                    code: "EINVAL",
                });
                // None of them runs a join.
                expect(fs.bootstrapStatus().readiness).toBeUndefined();
                expect(runtimeOf(fs)!.coordinator).toBeUndefined();
            }
            const [observer, partial, override] = opened;
            expect(observer.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            expect(partial.bootstrapStatus().writeReady).toBe(false);
            expect(override.bootstrapStatus()).toMatchObject({
                writeReady: true,
                partialWriteOverride: true,
                guardArmed: false,
            });
            expect(override.bootstrapStatus().writeReadinessSource).toBe(
                undefined
            );
            // Refused before anything changed.
            expect(programOf(override).viewProven).toBe(false);

            await donor.fs.assumeComplete();
            expect(donor.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "creator",
            });
            expect(donor.fs.bootstrapStatus().readiness).toBeUndefined();
            expect(programOf(donor.fs).readinessProvenance().source).toBe(
                "creator"
            );
        });

        it("refuses with EAGAIN while the bootstrap phase is unsettled and ECLOSED after close", async () => {
            const { directory, address } = await orphanedDirectory();
            const peer = await createPeer(directory);
            const fs = await openSharedFs({
                peerbit: peer,
                address,
                machineLabel: "orphan-phase",
                bootstrap: false,
                gc: false,
            });
            const program = programOf(fs);
            // A snapshot overlay settles by itself; an unverified posture is
            // M2's. Either way the operator waits.
            for (const phase of ["fetching", "overlay-active", "unverified"]) {
                program.bootstrapPhase = phase;
                const refused = fs.assumeComplete();
                await expect(refused).rejects.toBeInstanceOf(
                    SharedFsWritePendingError
                );
                await expect(refused).rejects.toMatchObject({ code: "EAGAIN" });
                program.bootstrapPhase = "off";
            }
            expect(fs.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            const runtime = runtimeOf(fs)!;
            await program.close();
            expect(runtime.disposed).toBe(true);
            expect(runtime.coordinator!.phase).toBe("disposed");
            expect(fs.bootstrapStatus().readiness).toBeUndefined();
            await expect(fs.assumeComplete()).rejects.toMatchObject({
                code: "ECLOSED",
            });
        });

        it("releases a joiner whose donor never answers; the timeout names that donor", async () => {
            const donor = await createDonor();
            const hung = dropOpens(donor.fs);
            const joiner = await joinDonor(donor);
            const program = programOf(joiner.fs);
            await waitUntil(() =>
                expect(hung.state.dropped).toBeGreaterThan(0)
            );

            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.code).toBe("ETIMEDOUT");
            const readiness = error.readiness!;
            expect(readiness.state).toBe("reconciling");
            expect(readiness.satisfied).toBe(false);
            expect(readiness.required).toContain(hashOf(donor.peer));
            expect(readiness.inFlight.map((peer) => peer.peer)).toContain(
                hashOf(donor.peer)
            );
            expect(error.message).toContain(
                "timed out awaiting shared filesystem write readiness: "
            );
            // Today's tracker alone would have released this joiner: remote
            // evidence, a settled decision and a live replicator. The
            // coordinator is what gates it (prerequisite mode, S23).
            expect(program.writeReadinessRemoteEvidence).toBe(true);
            expect(program.writeReadinessDecisionSettled).toBe(true);
            expect(await program.hasConnectedRemoteReplicator()).toBe(true);
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);

            await joiner.fs.assumeComplete();
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "operator",
                guardArmed: true,
            });
            const runtime = runtimeOf(joiner.fs)!;
            expect(runtime.coordinator!.phase).toBe("finished");
            // The final records stay readable.
            expect(joiner.fs.bootstrapStatus().readiness).toMatchObject({
                state: "ready",
            });
            expect(runtime.debug().armedTimers).toBe(0);
            await joiner.fs.writeFile(
                "/joiner.txt",
                "released by the operator"
            );
            hung.restore();
        });
    });

    it("releases an access-controlled joiner whose only donor is a ready full replica J's graph does not trust (G3-8)", async () => {
        const ownerPeer = await createPeer();
        const owner = await openSharedFs({
            peerbit: ownerPeer,
            machineLabel: "escape-owner",
            rootKey: ownerPeer.identity.publicKey,
            gc: false,
        });
        await owner.writeFile("/owner.txt", "from the owner");
        // A reader that replicates in full and is never authorized.
        const readerPeer = await createPeer();
        await readerPeer.dial(ownerPeer);
        const reader = await openSharedFs({
            peerbit: readerPeer,
            address: owner.address,
            machineLabel: "escape-reader",
            bootstrap: false,
            gc: false,
            writeReadinessSettleMs: 100,
        } as any);
        await reader.awaitWriteReady({ timeout: 60_000 });
        await waitUntil(async () =>
            expect(
                new TextDecoder().decode(await reader.readFile("/owner.txt"))
            ).toBe("from the owner")
        );
        await stopPeer(ownerPeer);

        const joinerPeer = await createPeer();
        await joinerPeer.dial(readerPeer);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: owner.address,
            machineLabel: "escape-acl-joiner",
            bootstrap: false,
            gc: false,
            writeReadinessSettleMs: 100,
        } as any);
        const readerHash = hashOf(readerPeer);
        // The reader is contained on both scopes and qualifies by its
        // header, but J's trust graph does not hold its identity.
        await waitUntil(() => {
            const readiness = joiner.bootstrapStatus().readiness!;
            expect(readiness.state).toBe("no-qualified-donor");
            expect(readiness.contained).toEqual([
                expect.objectContaining({
                    peer: readerHash,
                    qualified: false,
                    identity: "untrusted",
                    scopes: ["namespace-v1", "trust-v1"],
                }),
            ]);
        }, 60_000);
        const record = runtimeOf(joiner)!.coordinator!.record(readerHash)!;
        expect(record.qualified).toBe(true);
        const error = await timeoutOf(joiner, 1_500);
        expect(error.readiness?.state).toBe("no-qualified-donor");
        expect(describeReadiness(error.readiness!)).toContain(
            `${readerHash} (reconciled, untrusted identity)`
        );
        expect(joiner.bootstrapStatus().writeReady).toBe(false);
        expect(runtimeOf(joiner)!.debug().armedTimers).toBe(0);

        // The escape: the operator assumes completeness.
        await joiner.assumeComplete();
        expect(joiner.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "operator",
        });
        expect(
            new TextDecoder().decode(await joiner.readFile("/owner.txt"))
        ).toBe("from the owner");
    });

    describe("status", () => {
        it("names the qualified donor once ready; the joiner then reports reconciled and sends READY", async () => {
            const donor = await createDonor();
            const seen = recordMessages(donor.fs);
            const registry = globalThis.__SFS_READINESS_SHADOW__!;
            const checksBefore = registry.counts.sessionChecks;
            const joiner = await joinDonor(donor);
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });

            const status = joiner.fs.bootstrapStatus();
            expect(status).toMatchObject({
                writeReady: true,
                writeReadinessSource: "remote-settled",
                guardArmed: true,
            });
            expect(status.readiness).toMatchObject({ state: "ready" });
            expect(status.readiness!.contained).toEqual([
                expect.objectContaining({
                    peer: hashOf(donor.peer),
                    qualified: true,
                    source: "creator",
                }),
            ]);
            // G2-1: a joiner made ready with the coordinator's containment
            // qualifies as a donor itself.
            expect(programOf(joiner.fs).readinessProvenance()).toMatchObject({
                writeReady: true,
                source: "reconciled",
                fullReplica: true,
            });
            expect(runtimeOf(joiner.fs)!.coordinator!.phase).toBe("finished");
            // G2-24: the donor J had a session with gets a READY notice.
            await waitUntil(() =>
                expect(
                    seen.some(
                        ({ message, from }) =>
                            message instanceof StateNoticeV1 &&
                            message.reason === NOTICE_REASON.READY &&
                            from === hashOf(joiner.peer)
                    )
                ).toBe(true)
            );
            // The per-session K2 check ran on both sides (C1 G18); a
            // difference would fail this test from the setup's afterEach.
            await waitUntil(() =>
                expect(registry.counts.sessionChecks).toBeGreaterThanOrEqual(
                    checksBefore + 2
                )
            );
        });

        it("reports reconciling while the tracker still waits, and waiting-phase while the phase is unsettled", async () => {
            const donor = await createDonor();
            // A quiet window the test outlives: the coordinator is satisfied
            // long before today's tracker would decide.
            const joiner = await joinDonor(donor, {
                writeReadinessSettleMs: 600_000,
            });
            await waitUntil(() =>
                expect(joiner.fs.bootstrapStatus().readiness).toMatchObject({
                    state: "reconciling",
                    satisfied: true,
                    required: [],
                })
            );
            const program = programOf(joiner.fs);
            expect(runtimeOf(joiner.fs)!.satisfied()).toBe(true);
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
            // The phase is the tracker's clause in commit 2; the status
            // names it once nothing else blocks (read synchronously).
            program.bootstrapPhase = "overlay-active";
            const overlay = joiner.fs.bootstrapStatus().readiness;
            program.bootstrapPhase = "off";
            expect(overlay).toMatchObject({
                state: "waiting-phase",
                satisfied: true,
            });
            program.writeReadinessDecisionSettled = false;
            const deciding = joiner.fs.bootstrapStatus().readiness;
            program.writeReadinessDecisionSettled = true;
            expect(deciding).toMatchObject({ state: "waiting-phase" });
            // Only an idle coordinator: nothing armed while it waits.
            expect(runtimeOf(joiner.fs)!.coordinator!.debug().armedTimers).toBe(
                0
            );
        });

        it("is undefined for a creator and after close", async () => {
            const donor = await createDonor();
            expect(donor.fs.bootstrapStatus().readiness).toBeUndefined();
            const joiner = await joinDonor(donor);
            await waitUntil(() =>
                expect(joiner.fs.bootstrapStatus().readiness).toBeDefined()
            );
            await programOf(joiner.fs).close();
            expect(joiner.fs.bootstrapStatus().readiness).toBeUndefined();
        });
    });

    describe("lifecycle", () => {
        it("disposes the coordinator on close mid-session and runs a new one after a same-instance reopen", async () => {
            const donor = await createDonor();
            const hung = dropOpens(donor.fs);
            const joiner = await joinDonor(donor);
            const program = programOf(joiner.fs);
            const runtime = runtimeOf(joiner.fs)!;
            const coordinator = runtime.coordinator!;
            await waitUntil(() => {
                expect(hung.state.dropped).toBeGreaterThan(0);
                expect(coordinator.debug().sessions).toBeGreaterThan(0);
            });
            // A session in flight holds its attempt timer.
            expect(runtime.debug().armedTimers).toBeGreaterThan(0);

            await program.close();
            expect(coordinator.phase).toBe("disposed");
            expect(coordinator.debug()).toMatchObject({
                armedTimers: 0,
                sessions: 0,
            });
            expect(runtime.disposed).toBe(true);
            const received = runtime.messagesReceived;

            hung.restore();
            const reopened = await joiner.peer.open(program, {
                existing: "reuse",
                args: {
                    machineLabel: "escape-joiner-reopen",
                    addressOpen: true,
                    bootstrap: false,
                    gc: false,
                    writeReadinessSettleMs: 100,
                },
            });
            expect(reopened).toBe(program);
            const next = runtimeOf(joiner.fs)!;
            expect(next).not.toBe(runtime);
            expect(next.coordinator).toBeDefined();
            expect(next.coordinator).not.toBe(coordinator);
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            expect(joiner.fs.bootstrapStatus().readiness!.contained).toEqual([
                expect.objectContaining({
                    peer: hashOf(donor.peer),
                    qualified: true,
                }),
            ]);
            // The old generation acted on nothing after its close.
            expect(coordinator.phase).toBe("disposed");
            expect(runtime.messagesReceived).toBe(received);
        });

        it("disposes the coordinator on drop mid-session", async () => {
            const donor = await createDonor();
            const hung = dropOpens(donor.fs);
            const joiner = await joinDonor(donor);
            const runtime = runtimeOf(joiner.fs)!;
            const coordinator = runtime.coordinator!;
            await waitUntil(() =>
                expect(coordinator.debug().sessions).toBeGreaterThan(0)
            );
            const program = programOf(joiner.fs);
            expect(program.writeReadinessTimer).toBeDefined();
            const waiting = joiner.fs.awaitWriteReady({ timeout: 10_000 }).then(
                () => undefined,
                (error: unknown) => error
            );
            expect(await program.drop()).toBe(true);
            expect(coordinator.phase).toBe("disposed");
            expect(coordinator.debug().armedTimers).toBe(0);
            expect(runtime.disposed).toBe(true);
            expect(runtimeOf(joiner.fs)).toBeUndefined();
            expect(runtime.satisfied()).toBe(false);
            // The drop ends the wait and the tracker. Its poll would
            // otherwise outlive the drop (the predicate stays false) and
            // arm timers in whichever file this worker runs next.
            expect(await waiting).toMatchObject({ code: "ECLOSED" });
            expect(program.writeReadinessTimer).toBeUndefined();
            hung.restore();
        });

        it("drops a write-ready flip whose sidecar write is in flight: nothing flips, the proof is withdrawn and a reopen there joins afresh", async () => {
            const donor = await createDonor();
            const root = await mkdtemp(join(tmpdir(), "shared-fs-escape-"));
            roots.push(root);
            const directory = join(root, "joiner");
            const peer = await createPeer(directory);
            await peer.dial(donor.peer);
            const sidecar = async () => {
                const stateDirectory = join(directory, "shared-fs-bootstrap");
                const [name] = await readdir(stateDirectory);
                return JSON.parse(
                    await readFile(join(stateDirectory, name), "utf8")
                );
            };
            // Hold J's {writeReady: true} write inside the real I/O, where
            // the flip's decision already queued it on the sidecar chain
            // (markWriteReady decides and queues in one synchronous step).
            const prototype = SharedFileSystem.prototype as any;
            const replace = prototype.replaceBootstrapState;
            const self = hashOf(peer);
            const written: string[] = [];
            let hit!: () => void;
            const held = new Promise<void>((resolve) => (hit = resolve));
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            prototype.replaceBootstrapState = async function (
                this: any,
                path: string,
                contents: string
            ) {
                if (this.node?.identity?.publicKey?.hashcode() === self) {
                    written.push(contents);
                    if (JSON.parse(contents).writeReady === true) {
                        hit();
                        await gate;
                    }
                }
                return replace.call(this, path, contents);
            };
            try {
                const fs = await openSharedFs({
                    peerbit: peer,
                    address: donor.fs.address,
                    machineLabel: "escape-joiner",
                    bootstrap: false,
                    gc: false,
                    writeReadinessSettleMs: 100,
                } as any);
                const program = programOf(fs);
                const events: unknown[] = [];
                program.events.addEventListener("write:ready", (event: any) =>
                    events.push(event.detail)
                );
                await held;
                expect(program.writesReady).toBe(false);
                expect(program.guardArmed).toBe(false);
                expect(await sidecar()).toEqual({ writeReady: false });

                // drop() begins (its synchronous half runs at the call)
                // before the held write lands.
                const dropping = program.drop();
                release();
                expect(await dropping).toBe(true);
                const writesAtDrop = written.length;
                // Whatever the flip still had to do is done by now.
                await program.writeReadinessTransitionChain;
                let pending: Promise<unknown>;
                do {
                    pending = program.stateWriteChain;
                    await pending;
                } while (pending !== program.stateWriteChain);

                // The flip never happened: not in memory, not as an event,
                // and not in the proof, which the drop withdrew before it
                // returned.
                expect(program.writesReady).toBe(false);
                expect(program.writeReadinessSource).not.toBe("remote-settled");
                expect(program.guardArmed).toBe(false);
                expect(events).toEqual([]);
                expect(await sidecar()).toEqual({ writeReady: false });
                expect(written.length).toBe(writesAtDrop);
                expect(
                    written.map((contents) => JSON.parse(contents).writeReady)
                ).toEqual([false, true, false]);
            } finally {
                prototype.replaceBootstrapState = replace;
                release();
            }

            // A reopen of the address in the same directory is no warm
            // donor over the dropped store: it joins afresh, to ready.
            const reopened = await openSharedFs({
                peerbit: peer,
                address: donor.fs.address,
                machineLabel: "escape-joiner-after-drop",
                bootstrap: false,
                gc: false,
                writeReadinessSettleMs: 100,
            } as any);
            expect(programOf(reopened).readinessWarmOpen).toBe(false);
            expect(reopened.bootstrapStatus().writeReady).toBe(false);
            expect(runtimeOf(reopened)!.coordinator).toBeDefined();
            await reopened.awaitWriteReady({ timeout: 60_000 });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "remote-settled",
            });
            expect(
                new TextDecoder().decode(await reopened.readFile("/donor.txt"))
            ).toBe("from the donor");
        });

        it.each(["close", "drop"] as const)(
            "leaves no readiness timer armed after a %s mid-session, then or later; a reopen joins afresh",
            async (end) => {
                const donor = await createDonor();
                const hung = dropOpens(donor.fs);
                const joiner = await joinDonor(donor);
                const program = programOf(joiner.fs);
                const runtime = runtimeOf(joiner.fs)!;
                const coordinator = runtime.coordinator!;
                await waitUntil(() => {
                    expect(hung.state.dropped).toBeGreaterThan(0);
                    expect(coordinator.debug().sessions).toBeGreaterThan(0);
                });
                const timers = watchReadinessTimers(program, runtime);
                try {
                    // The gated tracker polls (every 100 ms here): wait for
                    // an arm the watch saw, so its handle is the one known.
                    await waitUntil(() =>
                        expect(timers.counts.trackerArms).toBeGreaterThan(0)
                    );
                    expect(timers.sessions.length).toBeGreaterThan(0);
                    const waiting = joiner.fs
                        .awaitWriteReady({ timeout: 10_000 })
                        .then(
                            () => undefined,
                            (error: unknown) => error
                        );

                    timers.mark();
                    expect(
                        await (end === "close"
                            ? program.close()
                            : program.drop())
                    ).toBe(true);
                    // Then: nothing the open armed is still armed, and the
                    // wait ends.
                    expect(program.writeReadinessTimer).toBeUndefined();
                    expect(timers.trackerCleared()).toBe(true);
                    expect(coordinator.phase).toBe("disposed");
                    expect(coordinator.debug().sessions).toBe(0);
                    expect(runtime.disposed).toBe(true);
                    expect(runtime.debug().armedTimers).toBe(0);
                    for (const session of timers.sessions) {
                        expect(session.debug().armedTimers).toBe(0);
                    }
                    expect(timers.armed()).toBe(0);
                    expect(timers.counts.armsSinceMark).toBe(0);
                    expect(await waiting).toMatchObject({ code: "ECLOSED" });

                    // Later: the donor answers again and a second joiner
                    // reconciles with it to ready, over seconds of the old
                    // tracker's period. The ended open arms nothing.
                    hung.restore();
                    const other = await joinDonor(donor);
                    await other.fs.awaitWriteReady({ timeout: 60_000 });
                    expect(program.writeReadinessTimer).toBeUndefined();
                    expect(timers.armed()).toBe(0);
                    expect(timers.counts.armsSinceMark).toBe(0);
                    timers.unwatchTracker();

                    // A reopen runs a join of its own to ready: the same
                    // instance after a close, a new one after a drop (the
                    // dropped instance stays ended).
                    let reopened: SharedFsHandle;
                    if (end === "close") {
                        expect(
                            await joiner.peer.open(program, {
                                existing: "reuse",
                                args: {
                                    machineLabel: "escape-joiner-reopen",
                                    addressOpen: true,
                                    bootstrap: false,
                                    gc: false,
                                    writeReadinessSettleMs: 100,
                                },
                            })
                        ).toBe(program);
                        reopened = joiner.fs;
                    } else {
                        reopened = await openSharedFs({
                            peerbit: joiner.peer,
                            address: donor.fs.address,
                            machineLabel: "escape-joiner-after-drop",
                            bootstrap: false,
                            gc: false,
                            writeReadinessSettleMs: 100,
                        } as any);
                        expect(reopened.program).not.toBe(program);
                        expect(program.writeReadinessTimer).toBeUndefined();
                    }
                    const next = runtimeOf(reopened)!;
                    expect(next).not.toBe(runtime);
                    expect(next.coordinator).toBeDefined();
                    await reopened.awaitWriteReady({ timeout: 60_000 });
                    // The second joiner, ready itself, may be contained too.
                    expect(
                        reopened.bootstrapStatus().readiness!.contained
                    ).toContainEqual(
                        expect.objectContaining({
                            peer: hashOf(donor.peer),
                            qualified: true,
                        })
                    );
                    expect(next.coordinator!.phase).toBe("finished");
                    expect(next.coordinator!.debug().armedTimers).toBe(0);
                    expect(
                        programOf(reopened).writeReadinessTimer
                    ).toBeUndefined();
                    // The old generation still armed nothing.
                    expect(timers.armed()).toBe(0);
                    expect(timers.counts.armsSinceMark).toBe(0);
                    for (const session of timers.sessions) {
                        expect(session.debug().armedTimers).toBe(0);
                    }
                } finally {
                    timers.unwatchTracker();
                    hung.restore();
                }
            }
        );
    });
});
