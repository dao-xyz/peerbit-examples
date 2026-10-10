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
import { hlcProvedOf, validateProof } from "../readiness/proof.js";
import type { Timers } from "../readiness/responder.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NOTICE_REASON,
    OpenV1,
    StateNoticeV1,
    type ReadinessMessage,
} from "../readiness/wire.js";
import { holdFlips } from "./readiness-flip-hold.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The operator escape and the readiness status of PR-3 commit 2 (M1 plan
 * 7.3 item 2, skeptic S1; design section 7 and test 47). Since PR-3 commit
 * 4 the coordinator's predicate (design 4.8) decides when a fresh full
 * address-open turns ready, with no timer of its own, so a joiner whose
 * only peers are absent, gated or silent stays gated: these tests pin the
 * escape (`assumeComplete`), the reason (`bootstrapStatus().readiness`) and
 * the timeout that carries it, and the coordinator's lifecycle inside the
 * filesystem (close, same-instance reopen and drop while a session or the
 * decision's sidecar write is in flight). PR-3 commit 3 adds the
 * trusted-identity clause of an access-controlled store (G3-8) and its
 * escape.
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
 * Watches the readiness timers of one open from now on: the Timers of its
 * runtime's responder, its coordinator and every session in flight (the
 * only readiness timers there are: write readiness arms none of its own
 * since PR-3 commit 4). Counts the arms after `mark()` and knows which
 * handles are still armed. Handles a session armed before the watch began
 * show in its own `debug().armedTimers`. The wrappers stay on the old
 * instances after a reopen and keep counting.
 */
const watchReadinessTimers = (runtime: ReadinessRuntime) => {
    const armed = new Set<unknown>();
    const counts = { armsSinceMark: 0 };
    let marked = false;
    const wrap = (timers: Timers): Timers => ({
        set: (fn, ms) => {
            const handle = timers.set(() => {
                armed.delete(handle);
                fn();
            }, ms);
            armed.add(handle);
            if (marked) counts.armsSinceMark++;
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
    return {
        counts,
        sessions,
        /** Arms after this call are counted in `armsSinceMark`. */
        mark: () => {
            marked = true;
        },
        /** The runtime's handles still armed. */
        armed: () => armed.size,
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
    const holds: Array<ReturnType<typeof holdFlips>> = [];

    afterEach(async () => {
        await stopTestPeers(peers);
        // After the peers stopped: a decision still parked then finds its
        // open ended and flips nothing.
        for (const hold of holds.splice(0)) hold.restore();
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

    /**
     * A fresh full joiner of `donor`'s filesystem, dialed to it. With
     * `holdFlips` its write-ready decisions park until `hold.release()`
     * (readiness-flip-hold.ts), installed before the open.
     */
    const joinDonor = async (
        donor: { peer: Peerbit; fs: SharedFsHandle },
        options: { holdFlips?: boolean } = {}
    ) => {
        const peer = await createPeer();
        await peer.dial(donor.peer);
        let hold: ReturnType<typeof holdFlips> | undefined;
        if (options.holdFlips) {
            hold = holdFlips(peer);
            holds.push(hold);
        }
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.fs.address,
            machineLabel: "escape-joiner",
            bootstrap: false,
            gc: false,
        });
        return { peer, fs, hold };
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
            // waits (M1 plan 10.5), and no decision asked.
            expect(runtime.debug().armedTimers).toBe(0);
            expect(runtime.coordinator!.debug().sessions).toBe(0);
            expect(runtime.coordinator!.debug().decisions).toEqual({
                started: 0,
                failed: 0,
                inFlight: false,
            });

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
            // The coordinator is the only gate: the bootstrap decision
            // settled and the phase is off, so the predicate is false only
            // because the donor is Required and still being asked, and no
            // decision was ever asked of the host.
            const coordinator = runtimeOf(joiner.fs)!.coordinator!;
            expect(program.writeReadinessDecisionSettled).toBe(true);
            expect(joiner.fs.bootstrapStatus().phase).toBe("off");
            expect(coordinator.record(hashOf(donor.peer))?.state).toBe(
                "asking"
            );
            expect(runtimeOf(joiner.fs)!.satisfied()).toBe(false);
            expect(coordinator.debug().decisions).toMatchObject({
                started: 0,
                inFlight: false,
            });
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
        });
        await reader.awaitWriteReady({ timeout: 60_000 });
        await waitUntil(async () =>
            expect(
                new TextDecoder().decode(await reader.readFile("/owner.txt"))
            ).toBe("from the owner")
        );
        // J reads the file from the reader once the owner stopped, so the
        // reader must hold its chunk. Readiness proves the namespace, not
        // chunk bytes (design 2.3), and a remote read does not store the
        // chunk: wait for the reader's own copy.
        await waitUntil(async () => {
            const versionId = (await reader.stat("/owner.txt"))!.versionId!;
            const version: any = await reader.program.entries.index.get(
                versionId,
                { local: true, remote: false }
            );
            expect(version.chunkIds.length).toBeGreaterThan(0);
            for (const chunkId of version.chunkIds) {
                expect(
                    await reader.program.entries.index.get(chunkId, {
                        local: true,
                        remote: false,
                    })
                ).toBeDefined();
            }
        });
        await stopPeer(ownerPeer);

        const joinerPeer = await createPeer();
        await joinerPeer.dial(readerPeer);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: owner.address,
            machineLabel: "escape-acl-joiner",
            bootstrap: false,
            gc: false,
        });
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
                writeReadinessSource: "reconciled",
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

        it("reports reconciling while the decision is persisting, and waiting-phase, not satisfied, while the phase is unsettled", async () => {
            const donor = await createDonor();
            // The joiner's decision parks (holdFlips): the predicate holds
            // and the flip has not happened, as while its proof is written.
            const joiner = await joinDonor(donor, { holdFlips: true });
            const hold = joiner.hold!;
            await waitUntil(() => expect(hold.parked()).toBe(1));
            const program = programOf(joiner.fs);
            const runtime = runtimeOf(joiner.fs)!;
            const readiness = joiner.fs.bootstrapStatus().readiness!;
            expect(readiness).toMatchObject({
                state: "reconciling",
                satisfied: true,
                required: [],
            });
            expect(describeReadiness(readiness)).toBe(
                "reconciling: every required peer is accounted for; the write-readiness proof is being persisted"
            );
            expect(runtime.satisfied()).toBe(true);
            expect(runtime.coordinator!.debug().decisions).toEqual({
                started: 1,
                failed: 0,
                inFlight: true,
            });
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
            // The phase clause is the predicate's (design 4.8, G4-5): with
            // the phase unsettled the status names it and `satisfied` is
            // false (read synchronously).
            program.bootstrapPhase = "overlay-active";
            const overlay = joiner.fs.bootstrapStatus().readiness;
            const overlaySatisfied = runtime.satisfied();
            program.bootstrapPhase = "off";
            expect(overlay).toMatchObject({
                state: "waiting-phase",
                satisfied: false,
            });
            expect(overlaySatisfied).toBe(false);
            program.writeReadinessDecisionSettled = false;
            const deciding = joiner.fs.bootstrapStatus().readiness;
            const decidingSatisfied = runtime.satisfied();
            program.writeReadinessDecisionSettled = true;
            expect(deciding).toMatchObject({
                state: "waiting-phase",
                satisfied: false,
            });
            expect(decidingSatisfied).toBe(false);
            // Nothing armed while the decision is held, and nothing asked
            // twice.
            expect(runtime.debug().armedTimers).toBe(0);
            expect(hold.parked()).toBe(1);

            // The held decision alone flips it: no other event is needed.
            hold.release();
            await joiner.fs.awaitWriteReady({ timeout: 10_000 });
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
            });
            // The waiters resolve inside the decision; it ends just after.
            await waitUntil(() =>
                expect(runtime.coordinator!.debug().decisions).toEqual({
                    started: 1,
                    failed: 0,
                    inFlight: false,
                })
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
            // Write readiness has no timer of its own (PR-3 commit 4): the
            // session's attempt is the only one armed.
            expect("writeReadinessTimer" in program).toBe(false);
            expect(runtime.debug().armedTimers).toBeGreaterThan(0);
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
            // The drop ends the wait and leaves nothing armed that could
            // fire in whichever file this worker runs next.
            expect(await waiting).toMatchObject({ code: "ECLOSED" });
            expect(runtime.debug().armedTimers).toBe(0);
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
            // Hold J's {writeReady: true} write (the decision's, with its
            // proof) inside the real I/O, where the decision already queued
            // it on the sidecar chain (markWriteReady reads the predicate
            // and the proof, and queues, in one synchronous step).
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
                });
                const program = programOf(fs);
                const events: unknown[] = [];
                program.events.addEventListener("write:ready", (event: any) =>
                    events.push(event.detail)
                );
                await held;
                expect(program.writesReady).toBe(false);
                expect(program.guardArmed).toBe(false);
                expect(await sidecar()).toEqual({ writeReady: false });
                // The held write is the decision's: the source, the proof
                // of the records the predicate read and its hlcProved.
                const decided = JSON.parse(written.at(-1)!);
                expect(decided).toEqual({
                    writeReady: true,
                    writeReadySource: "reconciled",
                    proof: expect.objectContaining({
                        v: 1,
                        scopes: ["namespace-v1"],
                        contained: [
                            expect.objectContaining({
                                peer: hashOf(donor.peer),
                                scope: "namespace-v1",
                                source: "creator",
                                qualified: true,
                            }),
                        ],
                        excluded: [],
                        gaps: [],
                    }),
                    hlcProved: expect.stringMatching(/^[1-9][0-9]*$/),
                });
                const validation = validateProof(decided.proof);
                expect(validation.ok).toBe(true);
                expect(decided.hlcProved).toBe(
                    hlcProvedOf((validation as any).proof).toString()
                );

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
                // and not on disk: the drop withdrew the source, the proof
                // and its hlcProved before it returned (SPEC4 G4-8), so the
                // sidecar is exactly the gate again.
                expect(program.writesReady).toBe(false);
                expect(program.writeReadinessSource).toBeUndefined();
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
            });
            expect(programOf(reopened).readinessWarmOpen).toBe(false);
            expect(reopened.bootstrapStatus().writeReady).toBe(false);
            expect(runtimeOf(reopened)!.coordinator).toBeDefined();
            await reopened.awaitWriteReady({ timeout: 60_000 });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
            });
            expect(
                new TextDecoder().decode(await reopened.readFile("/donor.txt"))
            ).toBe("from the donor");
        });

        /** The sidecar of the one filesystem `directory` holds. */
        const sidecarIn = async (directory: string) => {
            const stateDirectory = join(directory, "shared-fs-bootstrap");
            const [name] = await readdir(stateDirectory);
            return JSON.parse(
                await readFile(join(stateDirectory, name), "utf8")
            );
        };

        it("withdraws a ready joiner's proof on drop: a reopen in the same directory joins afresh instead of vouching for the dropped store", async () => {
            const donor = await createDonor();
            const root = await mkdtemp(join(tmpdir(), "shared-fs-escape-"));
            roots.push(root);
            const directory = join(root, "joiner");
            const peer = await createPeer(directory);
            await peer.dial(donor.peer);
            const fs = await openSharedFs({
                peerbit: peer,
                address: donor.fs.address,
                machineLabel: "escape-joiner",
                bootstrap: false,
                gc: false,
            });
            await fs.awaitWriteReady({ timeout: 60_000 });
            expect(await sidecarIn(directory)).toMatchObject({
                writeReady: true,
                writeReadySource: "reconciled",
                proof: expect.objectContaining({ v: 1 }),
                hlcProved: expect.stringMatching(/^[1-9][0-9]*$/),
            });

            expect(await programOf(fs).drop()).toBe(true);
            // The store is gone, so the proof and its hint are false: drop()
            // leaves exactly the gate (SPEC4 G4-8).
            expect(await sidecarIn(directory)).toEqual({ writeReady: false });

            // The donor, visible and honest, still holds /donor.txt: a reopen
            // there is no warm replica over the empty store, which would
            // admit a clashing write at once and vouch for nothing as a
            // donor. It joins afresh, to ready.
            const reopened = await openSharedFs({
                peerbit: peer,
                address: donor.fs.address,
                machineLabel: "escape-joiner-after-drop",
                bootstrap: false,
                gc: false,
            });
            expect(programOf(reopened).readinessWarmOpen).toBe(false);
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: false,
                guardArmed: false,
            });
            await expect(
                reopened.writeFile("/donor.txt", "too early")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);
            expect(runtimeOf(reopened)!.coordinator).toBeDefined();
            await reopened.awaitWriteReady({ timeout: 60_000 });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
            });
            expect(
                new TextDecoder().decode(await reopened.readFile("/donor.txt"))
            ).toBe("from the donor");
            expect(await reopened.namingConflicts()).toEqual([]);
        });

        it("withdraws a creator's sidecar on drop: a reopen by address in the same directory joins afresh from a replica holding its rows", async () => {
            const root = await mkdtemp(join(tmpdir(), "shared-fs-escape-"));
            roots.push(root);
            const directory = join(root, "creator");
            const creatorPeer = await createPeer(directory);
            const creator = await openSharedFs({
                peerbit: creatorPeer,
                machineLabel: "escape-creator",
                gc: false,
            });
            for (let i = 0; i < 3; i++) {
                await creator.writeFile(`/c${i}.txt`, `creator ${i}`);
            }
            expect(await sidecarIn(directory)).toEqual({
                writeReady: true,
                writeReadySource: "creator",
            });
            // A ready joiner holds every row the creator wrote.
            const joinerPeer = await createPeer();
            await joinerPeer.dial(creatorPeer);
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: creator.address,
                machineLabel: "escape-joiner",
                bootstrap: false,
                gc: false,
                remoteChunkFetch: false,
            });
            await joiner.awaitWriteReady({ timeout: 60_000 });
            // Bytes included, read locally (readiness proves rows, not
            // chunks, design 2.3): after the drop the joiner is their only
            // holder.
            await waitUntil(async () => {
                for (let i = 0; i < 3; i++) {
                    expect(
                        new TextDecoder().decode(
                            await joiner.readFile(`/c${i}.txt`)
                        )
                    ).toBe(`creator ${i}`);
                }
            });

            const address = creator.address!;
            expect(await programOf(creator).drop()).toBe(true);
            expect(await sidecarIn(directory)).toEqual({ writeReady: false });

            const reopened = await openSharedFs({
                peerbit: creatorPeer,
                address,
                machineLabel: "escape-creator-after-drop",
                bootstrap: false,
                gc: false,
            });
            expect(programOf(reopened).readinessWarmOpen).toBe(false);
            expect(reopened.bootstrapStatus().writeReady).toBe(false);
            await expect(
                reopened.writeFile("/c0.txt", "too early")
            ).rejects.toBeInstanceOf(SharedFsWritePendingError);
            await reopened.awaitWriteReady({ timeout: 60_000 });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
            });
            expect(
                new TextDecoder().decode(await reopened.readFile("/c0.txt"))
            ).toBe("creator 0");
            expect(await reopened.namingConflicts()).toEqual([]);
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
                const timers = watchReadinessTimers(runtime);
                try {
                    // Write readiness has no timer of its own (PR-3 commit
                    // 4): no tracker field, and the sessions' attempts are
                    // the only readiness timers armed.
                    expect("writeReadinessTimer" in program).toBe(false);
                    expect(timers.sessions.length).toBeGreaterThan(0);
                    expect(
                        timers.sessions.some(
                            (session) => session.debug().armedTimers > 0
                        )
                    ).toBe(true);
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
                    // reconciles with it to ready. The ended open arms
                    // nothing.
                    hung.restore();
                    const other = await joinDonor(donor);
                    await other.fs.awaitWriteReady({ timeout: 60_000 });
                    expect(timers.armed()).toBe(0);
                    expect(timers.counts.armsSinceMark).toBe(0);

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
                        });
                        expect(reopened.program).not.toBe(program);
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
                    // Its own decision flipped it, and none failed (the
                    // waiters resolve inside the decision; it ends just
                    // after).
                    await waitUntil(() =>
                        expect(
                            next.coordinator!.debug().decisions
                        ).toMatchObject({ failed: 0, inFlight: false })
                    );
                    expect(
                        next.coordinator!.debug().decisions.started
                    ).toBeGreaterThanOrEqual(1);
                    // The old generation still armed nothing.
                    expect(timers.armed()).toBe(0);
                    expect(timers.counts.armsSinceMark).toBe(0);
                    for (const session of timers.sessions) {
                        expect(session.debug().armedTimers).toBe(0);
                    }
                } finally {
                    hung.restore();
                }
            }
        );
    });
});
