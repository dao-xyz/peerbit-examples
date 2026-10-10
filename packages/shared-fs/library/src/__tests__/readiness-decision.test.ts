import type { PublicSignKey } from "@peerbit/crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SharedFileSystem,
    SharedFsHandle,
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type BootstrapTelemetryEvent,
} from "../index.js";
import type { Coordinator } from "../readiness/coordinator.js";
import { hlcProvedOf, validateProof, type Proof } from "../readiness/proof.js";
import { Responder } from "../readiness/responder.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import { documentsIndexPort } from "../readiness/tap.js";
import { OpenV1, type ReadinessMessage } from "../readiness/wire.js";
import { holdFlips } from "./readiness-flip-hold.js";
import { watchTimers } from "./readiness-timer-watch.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The decision of PR-3 commit 4 on in-process Peerbit peers and real
 * filesystems (SPEC4 1.2, 9.4(6); M1 plan 7.3 item 4, 10.5): the
 * coordinator's predicate (design 4.8) decides, and nothing but a design
 * 4.9 trigger asks it again.
 *
 * - M8: the bootstrap decision settling and a phase change are triggers, so
 *   a joiner whose peers are accounted for turns ready by that event alone.
 *   Held by test hooks: the joiner's `startBootstrap`, and the quiescence
 *   checker's callback, captured as `guard-override.test.ts` captures it
 *   (production checks every five minutes).
 * - M9: a failed sidecar write leaves J gated with nothing armed, and the
 *   next trigger retries (`replaceBootstrapState` fails for J's node).
 * - The proof the decision persists, its `hlcProved`, the
 *   `readiness-session` telemetry, and `hlcProved` reaching the next fresh
 *   join's OPEN through an observer open's gate reset (G2-21).
 * - Plan 10.5: a joiner gated with nothing in flight arms no timer, and a
 *   donor appearing makes it ready by that event; a donor's responder
 *   keeps no idle timer once its sessions closed.
 *
 * Timers are watched through the global setTimeout and setInterval and
 * classified by the frame that armed them (`readiness-timer-watch.ts`).
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const readinessOf = (fs: SharedFsHandle) => fs.bootstrapStatus().readiness;
const decisionsOf = (fs: SharedFsHandle) =>
    runtimeOf(fs).debug().coordinator!.decisions;

const coordinatorOf = (fs: SharedFsHandle): Coordinator => {
    const coordinator = runtimeOf(fs)?.coordinator;
    if (!coordinator) throw new Error("no coordinator runs for this open");
    return coordinator;
};

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `awaitWriteReady` with `timeout`, which must time out. */
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

/** The namespace rows of `fs`'s index (id to head). */
const namespaceRows = async (fs: SharedFsHandle) => {
    const port = documentsIndexPort(programOf(fs).entries, NAMESPACE_V1);
    const rows = new Map<string, string>();
    for await (const page of port.scan()) {
        for (const row of page) rows.set(row.key as string, row.head);
    }
    return rows;
};

/** The sidecar file of the one filesystem `directory` holds. */
const sidecarPath = async (directory: string) => {
    const state = joinPath(directory, "shared-fs-bootstrap");
    const [name] = await readdir(state);
    return joinPath(state, name);
};
const readSidecar = async (directory: string) =>
    JSON.parse(await readFile(await sidecarPath(directory), "utf8"));

/** The proof a sidecar holds, checked for shape. */
const proofIn = (sidecar: any): Proof => {
    const checked = validateProof(sidecar.proof);
    if (!checked.ok) throw new Error(`malformed proof: ${checked.reason}`);
    return checked.proof;
};

describe("readiness decision (PR-3 commit 4, in-process)", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    /** Undone first in afterEach: held gates, patched prototypes, spies. */
    const restores: Array<() => void> = [];

    afterEach(async () => {
        for (const restore of restores.splice(0).reverse()) {
            try {
                restore();
            } catch {
                // Best effort; the peers stop next either way.
            }
        }
        await stopTestPeers(peers);
        for (const root of roots.splice(0)) {
            await rm(root, { recursive: true, force: true });
        }
    });

    type Node = { peer: Peerbit; fs: SharedFsHandle };

    const newDirectory = async () => {
        const root = await mkdtemp(joinPath(tmpdir(), "shared-fs-decision-"));
        roots.push(root);
        return joinPath(root, "peer");
    };

    const createPeer = async (directory?: string, connectionGater?: object) => {
        const peer = await Peerbit.create({
            ...(directory ? { directory } : {}),
            ...(connectionGater ? { libp2p: { connectionGater } } : {}),
        } as any);
        peers.push(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        const index = peers.indexOf(peer);
        if (index >= 0) peers.splice(index, 1);
        await peer.stop();
    };

    /** A creator with `count` files, in memory unless `peer` is given. */
    const createDonor = async (count = 5, peer?: Peerbit): Promise<Node> => {
        peer ??= await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "decision-donor",
            gc: false,
        });
        for (let i = 0; i < count; i++) {
            await fs.writeFile(`/donor-${i}.txt`, `donor ${i}`);
        }
        return { peer, fs };
    };

    /** A fresh full address-open of `donor`'s filesystem on `peer`. */
    const joinOf = async (
        donor: Node,
        peer: Peerbit,
        options: Record<string, unknown> = {}
    ): Promise<Node> => {
        await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.fs.address,
            machineLabel: "decision-joiner",
            bootstrap: false,
            gc: false,
            ...options,
        });
        return { peer, fs };
    };

    /**
     * Runs `capture` inside the `write:ready` dispatch of the first flip of
     * a filesystem opened on `peer` from now on, given that filesystem.
     * Installed before the open: a flip can land before `openSharedFs`
     * returns.
     */
    const atReadyOn = <T>(
        peer: Peerbit,
        capture: (fs: SharedFsHandle) => T
    ): Promise<T> => {
        const prototype = SharedFileSystem.prototype as any;
        const commitWriteReady = prototype.commitWriteReady;
        let installed = true;
        const uninstall = () => {
            if (!installed) return;
            installed = false;
            prototype.commitWriteReady = commitWriteReady;
        };
        restores.push(uninstall);
        return new Promise((resolve, reject) => {
            prototype.commitWriteReady = function (
                this: any,
                ...args: unknown[]
            ) {
                if (this.node === peer) {
                    uninstall();
                    this.events.addEventListener(
                        "write:ready",
                        () => {
                            try {
                                resolve(capture(new SharedFsHandle(this)));
                            } catch (error) {
                                reject(error);
                            }
                        },
                        { once: true }
                    );
                }
                return commitWriteReady.apply(this, args);
            };
        });
    };

    /**
     * Records, for each call of `name` on `program` (an instance property
     * wrapping the prototype's), whether the coordinator had an evaluation
     * pending before and after it: a trigger schedules one.
     */
    const watchTrigger = (fs: SharedFsHandle, name: string) => {
        const program = programOf(fs);
        const coordinator = coordinatorOf(fs);
        const original = program[name];
        const calls: Array<{
            args: unknown[];
            before: boolean;
            after: boolean;
        }> = [];
        program[name] = function (this: any, ...args: unknown[]) {
            const before = coordinator.debug().evaluationPending;
            const out = original.apply(this, args);
            calls.push({
                args,
                before,
                after: coordinator.debug().evaluationPending,
            });
            return out;
        };
        restores.push(() => delete program[name]);
        return calls;
    };

    /** Holds every OPEN `donor`'s responder receives until `release`. */
    const holdOpens = (donor: SharedFsHandle) => {
        const responder = runtimeOf(donor).responder!;
        const onMessage = responder.onMessage;
        const held: Array<[ReadinessMessage, PublicSignKey | undefined]> = [];
        let holding = true;
        responder.onMessage = (message, from) => {
            if (holding && message instanceof OpenV1) {
                held.push([message, from]);
                return;
            }
            onMessage.call(responder, message, from);
        };
        const release = () => {
            if (!holding) return;
            holding = false;
            responder.onMessage = onMessage;
            for (const [message, from] of held.splice(0)) {
                onMessage.call(responder, message, from);
            }
        };
        restores.push(release);
        return {
            get held() {
                return held.length;
            },
            release,
        };
    };

    describe("M8: the bootstrap decision and the phase are triggers", () => {
        it("a joiner whose peers are accounted for while its bootstrap decision is still open turns ready when the decision settles", async () => {
            const donor = await createDonor();
            const peer = await createPeer();
            // J's bootstrap waits for the test, then ends without an
            // overlay: only the decision settling changes, the phase stays
            // `off`.
            const prototype = SharedFileSystem.prototype as any;
            const startBootstrap = prototype.startBootstrap;
            let releaseBootstrap!: () => void;
            const gate = new Promise<void>((resolve) => {
                releaseBootstrap = resolve;
            });
            let held = 0;
            prototype.startBootstrap = async function (
                this: any,
                ...args: unknown[]
            ) {
                if (this.node !== peer) return startBootstrap.apply(this, args);
                held++;
                await gate;
            };
            restores.push(() => {
                releaseBootstrap();
                prototype.startBootstrap = startBootstrap;
            });
            const joiner = await joinOf(donor, peer, { bootstrap: "auto" });
            const donorHash = hashOf(donor.peer);
            await waitUntil(() =>
                expect(readinessOf(joiner.fs)).toMatchObject({
                    state: "waiting-phase",
                    satisfied: false,
                    required: [],
                    contained: [{ peer: donorHash, qualified: true }],
                })
            );
            expect(held).toBe(1);
            const program = programOf(joiner.fs);
            expect(program.writeReadinessDecisionSettled).toBe(false);
            expect(joiner.fs.bootstrapStatus().phase).toBe("off");
            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.readiness).toMatchObject({
                state: "waiting-phase",
                satisfied: false,
            });
            expect(decisionsOf(joiner.fs)).toEqual({
                started: 0,
                failed: 0,
                inFlight: false,
            });
            expect(runtimeOf(joiner.fs).debug().armedTimers).toBe(0);

            const settled = watchTrigger(
                joiner.fs,
                "settleWriteReadinessDecision"
            );
            releaseBootstrap();
            await joiner.fs.awaitWriteReady({ timeout: 30_000 });
            // The settle scheduled the evaluation that decided, once.
            expect(settled).toHaveLength(1);
            expect(settled[0].after).toBe(true);
            expect(decisionsOf(joiner.fs)).toMatchObject({
                started: 1,
                failed: 0,
            });
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
                phase: "off",
            });
            expect(readinessOf(joiner.fs)!.state).toBe("ready");
        });

        it("a joiner in the unverified posture turns ready by the quiescence transition to converged alone", async () => {
            const donor = await createDonor();
            const busy = holdOpens(donor.fs);
            const peer = await createPeer();
            const joiner = await joinOf(donor, peer);
            const program = programOf(joiner.fs);
            // Enter the unverified posture (a resumed bootstrap that could
            // not verify) and capture the quiescence checker's callback.
            const realSetInterval = globalThis.setInterval;
            let check: (() => void) | undefined;
            let handle: ReturnType<typeof setInterval> | undefined;
            const spy = vi
                .spyOn(globalThis, "setInterval")
                .mockImplementation(((callback: () => void) => {
                    check = callback;
                    handle = realSetInterval(() => {}, 2 ** 30);
                    return handle;
                }) as typeof setInterval);
            try {
                program.enterUnverified(
                    program.openGeneration,
                    "test: unverified posture"
                );
            } finally {
                spy.mockRestore();
            }
            restores.push(() => clearInterval(handle));
            expect(check).toBeDefined();
            expect(joiner.fs.bootstrapStatus().phase).toBe("unverified");

            busy.release();
            const donorHash = hashOf(donor.peer);
            await waitUntil(() =>
                expect(readinessOf(joiner.fs)).toMatchObject({
                    state: "waiting-phase",
                    satisfied: false,
                    required: [],
                    contained: [{ peer: donorHash, qualified: true }],
                })
            );
            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.readiness).toMatchObject({ state: "waiting-phase" });
            expect(decisionsOf(joiner.fs)).toMatchObject({
                started: 0,
                inFlight: false,
            });
            expect(runtimeOf(joiner.fs).debug().armedTimers).toBe(0);

            // The two quiescence checks, five minutes apart in production.
            const phases = watchTrigger(joiner.fs, "setBootstrapPhase");
            program.lastArrivalMs = 0;
            check!();
            expect(joiner.fs.bootstrapStatus().phase).toBe("unverified");
            expect(phases).toEqual([]);
            check!();
            expect(phases).toEqual([
                {
                    args: ["converged"],
                    before: expect.any(Boolean),
                    after: true,
                },
            ]);
            await joiner.fs.awaitWriteReady({ timeout: 30_000 });
            expect(decisionsOf(joiner.fs)).toMatchObject({
                started: 1,
                failed: 0,
            });
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
                phase: "converged",
            });
        });
    });

    it("M9: a failed proof write leaves J gated with nothing armed; the next trigger retries and persists the proof", async () => {
        const donor = await createDonor();
        const directory = await newDirectory();
        const peer = await createPeer(directory);
        // J's sidecar refuses every reconciled write until the test lets
        // it through.
        const prototype = SharedFileSystem.prototype as any;
        const replace = prototype.replaceBootstrapState;
        let failing = true;
        let refused = 0;
        prototype.replaceBootstrapState = async function (
            this: any,
            path: string,
            contents: string
        ) {
            const next = JSON.parse(contents);
            if (
                this.node === peer &&
                failing &&
                next.writeReady === true &&
                next.writeReadySource === "reconciled"
            ) {
                refused++;
                throw new Error("test: the disk refused the proof");
            }
            return replace.call(this, path, contents);
        };
        restores.push(() => (prototype.replaceBootstrapState = replace));
        const warn = vi.spyOn(console, "warn");
        restores.push(() => warn.mockRestore());

        const flip = atReadyOn(peer, (fs) => coordinatorOf(fs).proof());
        const joiner = await joinOf(donor, peer);
        await waitUntil(() =>
            expect(decisionsOf(joiner.fs).failed).toBeGreaterThanOrEqual(1)
        );
        expect(refused).toBeGreaterThanOrEqual(1);
        // Gated, Guard D disarmed, the predicate holding: the proof is
        // what waits (G4-6).
        expect(joiner.fs.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: false,
        });
        expect(readinessOf(joiner.fs)).toMatchObject({
            state: "reconciling",
            satisfied: true,
            required: [],
        });
        expect(decisionsOf(joiner.fs)).toMatchObject({
            inFlight: false,
            lastError: expect.stringContaining(
                "test: the disk refused the proof"
            ),
        });
        expect(
            await readSidecar(directory).then(({ writeReady, proof }) => ({
                writeReady,
                proof,
            }))
        ).toEqual({ writeReady: false, proof: undefined });

        // Sync done, so the window sees J idle.
        const donorRows = await namespaceRows(donor.fs);
        await waitUntil(async () =>
            expect((await namespaceRows(joiner.fs)).size).toBe(donorRows.size)
        );
        const before = decisionsOf(joiner.fs);
        const evaluationsBefore = coordinatorOf(joiner.fs).debug().evaluations;
        // Every decision so far was asked by an event and failed.
        expect(before.failed).toBe(before.started);
        const timers = watchTimers();
        restores.push(timers.stop);
        await sleep(1_500);
        timers.stop();
        const after = decisionsOf(joiner.fs);
        const evaluationsAfter = coordinatorOf(joiner.fs).debug().evaluations;
        console.info(
            `readiness-decision M9: decisions ${JSON.stringify(before)} then ${JSON.stringify(after)}, evaluations ${evaluationsBefore} then ${evaluationsAfter}, over 1.5 s; timers armed through the globals ${timers.total}`
        );
        // J is idle and gated: nothing armed by this package, and no retry,
        // no decision and no evaluation at all in the window. A retry comes
        // only from a design 4.9 trigger, never from a timer, a sleep or a
        // dependency's delay, whatever armed it (M9).
        expect(timers.own).toEqual([]);
        expect(timers.readiness).toEqual([]);
        expect(after.started).toBe(before.started);
        expect(after.failed).toBe(before.failed);
        expect(evaluationsAfter).toBe(evaluationsBefore);
        expect(runtimeOf(joiner.fs).debug().armedTimers).toBe(0);
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
        // One warning per open, however many retries failed.
        const warnings = warn.mock.calls.filter(([message]) =>
            String(message).startsWith(
                "shared-fs: write readiness could not persist its proof"
            )
        );
        expect(warnings).toEqual([
            [
                "shared-fs: write readiness could not persist its proof; the next readiness event retries:",
                expect.stringContaining("test: the disk refused the proof"),
            ],
        ]);

        // A design 4.9 trigger: a peer connects (one that runs no
        // filesystem at all).
        failing = false;
        const startedBefore = decisionsOf(joiner.fs).started;
        const other = await createPeer();
        await peer.dial(other);
        await joiner.fs.awaitWriteReady({ timeout: 30_000 });
        const atFlip = await flip;
        expect(decisionsOf(joiner.fs).started).toBeGreaterThan(startedBefore);
        expect(decisionsOf(joiner.fs).failed).toBe(after.failed);
        expect(joiner.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "reconciled",
            guardArmed: true,
        });
        const sidecar = await readSidecar(directory);
        expect(sidecar).toMatchObject({
            writeReady: true,
            writeReadySource: "reconciled",
        });
        const proof = proofIn(sidecar);
        expect(proof).toEqual(atFlip);
        expect(sidecar.hlcProved).toBe(String(hlcProvedOf(proof)));
        expect(
            warn.mock.calls.filter(([message]) =>
                String(message).startsWith(
                    "shared-fs: write readiness could not persist its proof"
                )
            )
        ).toHaveLength(1);
    });

    it("the slot reads the predicate again: a decision parked while a peer turns Required flips nothing; that peer's answer then decides (design 2.2(2))", async () => {
        const donor = await createDonor();
        const donorHash = hashOf(donor.peer);
        // J's decisions park once it contains D.
        const peer = await createPeer();
        const joinerHash = hashOf(peer);
        const flips = holdFlips(peer);
        restores.push(flips.restore);
        const joiner = await joinOf(donor, peer);
        await waitUntil(() => {
            expect(flips.parked()).toBe(1);
            expect(readinessOf(joiner.fs)).toMatchObject({
                satisfied: true,
                required: [],
                contained: [{ peer: donorHash, qualified: true }],
            });
        });
        expect(decisionsOf(joiner.fs)).toMatchObject({
            started: 1,
            inFlight: true,
        });

        // R: a replica whose responder holds J's OPENs, so once J sees it, R
        // is Required and stays so. Its responder does not exist before R's
        // open, which can answer before openSharedFs returns: hold by
        // prototype, for every responder but D's and J's.
        const known = new Set<Responder | undefined>([
            runtimeOf(donor.fs).responder,
            runtimeOf(joiner.fs).responder,
        ]);
        const held: Array<{
            responder: Responder;
            message: ReadinessMessage;
            from: PublicSignKey | undefined;
        }> = [];
        const onMessage = Responder.prototype.onMessage;
        let holding = true;
        Responder.prototype.onMessage = function (
            this: Responder,
            message: ReadinessMessage,
            from: PublicSignKey | undefined
        ) {
            if (
                holding &&
                !known.has(this) &&
                message instanceof OpenV1 &&
                from?.hashcode() === joinerHash
            ) {
                held.push({ responder: this, message, from });
                return;
            }
            return onMessage.call(this, message, from);
        };
        const releaseOpens = () => {
            if (!holding) return;
            holding = false;
            Responder.prototype.onMessage = onMessage;
            for (const { responder, message, from } of held.splice(0)) {
                onMessage.call(responder, message, from);
            }
        };
        restores.push(releaseOpens);
        const replicaPeer = await createPeer();
        const replicaHash = hashOf(replicaPeer);
        await replicaPeer.dial(donor.peer);
        await replicaPeer.dial(peer);
        await openSharedFs({
            peerbit: replicaPeer,
            address: donor.fs.address,
            machineLabel: "decision-replica",
            bootstrap: false,
            gc: false,
        });
        await waitUntil(() => {
            expect(held.length).toBeGreaterThan(0);
            expect(readinessOf(joiner.fs)).toMatchObject({
                satisfied: false,
                required: [replicaHash],
            });
        });
        expect(flips.parked()).toBe(1);
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);

        // The decision taken while only D was visible now runs: its slot
        // reads the predicate again, finds R Required and flips nothing.
        flips.release();
        await waitUntil(() =>
            expect(decisionsOf(joiner.fs).inFlight).toBe(false)
        );
        expect(decisionsOf(joiner.fs)).toMatchObject({
            started: 1,
            failed: 0,
        });
        expect(joiner.fs.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: false,
        });
        expect(readinessOf(joiner.fs)).toMatchObject({
            satisfied: false,
            required: [replicaHash],
        });

        // R answers: J contains it and turns ready, with a proof of both.
        const flip = atReadyOn(peer, (fs) => coordinatorOf(fs).proof());
        releaseOpens();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(joiner.fs.bootstrapStatus().writeReadinessSource).toBe(
            "reconciled"
        );
        const atFlip = await flip;
        expect(
            atFlip.contained
                .filter((record) => record.scope === "namespace-v1")
                .map((record) => record.peer)
                .sort()
        ).toEqual([donorHash, replicaHash].sort());
    });

    describe("the persisted proof and telemetry", () => {
        it("persists the decision's proof and its hlcProved, emits readiness-session before write-ready, and a reopen after an observer open sends that hlcProved in its OPEN (G2-21)", async () => {
            const donor = await createDonor(12);
            const donorHash = hashOf(donor.peer);
            const rows = await namespaceRows(donor.fs);
            const directory = await newDirectory();
            const peer = await createPeer(directory);
            const telemetry: BootstrapTelemetryEvent[] = [];
            const flip = atReadyOn(peer, (fs) => ({
                proof: coordinatorOf(fs).proof(),
                result: coordinatorOf(fs)
                    .record(donorHash)!
                    .results.get(SCOPE_NAMESPACE_V1)!,
            }));
            const joiner = await joinOf(donor, peer, {
                telemetry: { bootstrap: (event: any) => telemetry.push(event) },
            });
            await joiner.fs.awaitWriteReady({ timeout: 30_000 });
            const atFlip = await flip;

            // The sidecar holds the proof the flip held, and its hint.
            const sidecar = await readSidecar(directory);
            expect(Object.keys(sidecar).sort()).toEqual([
                "hlcProved",
                "proof",
                "writeReady",
                "writeReadySource",
            ]);
            expect(sidecar).toMatchObject({
                writeReady: true,
                writeReadySource: "reconciled",
            });
            const proof = proofIn(sidecar);
            expect(proof).toEqual(atFlip.proof);
            expect(proof.contained).toEqual([
                expect.objectContaining({
                    peer: donorHash,
                    scope: "namespace-v1",
                    source: "creator",
                    qualified: true,
                    count: rows.size,
                }),
            ]);
            // Open mode: no trust results (G4-2).
            expect(proof.contained[0]).not.toHaveProperty("identity");
            expect(proof.contained[0]).not.toHaveProperty("untrusted");
            const hlcProved = hlcProvedOf(proof);
            expect(hlcProved).toBeGreaterThan(0n);
            expect(hlcProved).toBe(atFlip.result.hlc);
            expect(sidecar.hlcProved).toBe(String(hlcProved));

            // Telemetry: the whole sequence of a plain join, with one
            // readiness-session per contained scope before write-ready and
            // no synchronizer milestone.
            const types = telemetry.map(({ type }) => type);
            expect(types).toEqual([
                "open:start",
                "documents-open:start",
                "documents-open:end",
                "readiness-session",
                "write-ready",
            ]);
            const sessions = telemetry.filter(
                (event) => event.type === "readiness-session"
            ) as Array<
                Extract<BootstrapTelemetryEvent, { type: "readiness-session" }>
            >;
            expect(sessions).toHaveLength(1);
            expect(types.indexOf("readiness-session")).toBeLessThan(
                types.indexOf("write-ready")
            );
            const result = atFlip.result;
            expect(sessions[0]).toEqual({
                type: "readiness-session",
                atMs: expect.any(Number),
                peer: donorHash,
                scope: "namespace-v1",
                mode: result.mode,
                count: rows.size,
                gapEst: result.gapEst,
                cells: result.cells,
                missingAtStart: result.missingAtStart,
                pulled: result.pulled,
                explained: result.explained,
                explainedBy: result.explainedBy,
                recoveries: result.recoveries,
                roundTrips: result.roundTrips,
                durationMs: result.ms,
                qualified: true,
                source: "creator",
            });
            expect(sessions[0].roundTrips).toBeGreaterThanOrEqual(1);
            expect(sessions[0].durationMs).toBeGreaterThanOrEqual(0);
            expect(
                telemetry.find(({ type }) => type === "write-ready")
            ).toMatchObject({ source: "reconciled" });
            await stopPeer(peer);

            // An observer open withdraws the proof and keeps the hint.
            const observerPeer = await createPeer(directory);
            await openSharedFs({
                peerbit: observerPeer,
                address: donor.fs.address,
                machineLabel: "decision-observer",
                replicate: false,
                bootstrap: false,
                gc: false,
            });
            await stopPeer(observerPeer);
            expect(await readSidecar(directory)).toEqual({
                writeReady: false,
                hlcProved: String(hlcProved),
            });

            // The next full open is a fresh join whose OPEN carries it.
            const opens: bigint[] = [];
            const responder = runtimeOf(donor.fs).responder!;
            const onMessage = responder.onMessage;
            responder.onMessage = (message, from) => {
                if (
                    message instanceof OpenV1 &&
                    from?.hashcode() === hashOf(peer)
                ) {
                    opens.push(message.hlcProved);
                }
                onMessage.call(responder, message, from);
            };
            restores.push(() => (responder.onMessage = onMessage));
            const reopenedPeer = await createPeer(directory);
            expect(hashOf(reopenedPeer)).toBe(hashOf(peer));
            const reopened = await joinOf(donor, reopenedPeer);
            await reopened.fs.awaitWriteReady({ timeout: 30_000 });
            expect(opens.length).toBeGreaterThan(0);
            expect(opens.every((value) => value === hlcProved)).toBe(true);
            expect(reopened.fs.bootstrapStatus().writeReadinessSource).toBe(
                "reconciled"
            );
        });
    });

    it("10.5: a joiner gated with no peer arms no readiness timer; a donor appearing makes it ready by that event, and the donor's responder keeps no idle timer after", async () => {
        // A filesystem whose creator left, held by a ready replica R; the
        // creator's directory reopens without a proof. Its peer refuses
        // connections with R until the test lets R appear (the reopened
        // identity is the creator's, which R and the persisted peer store
        // would otherwise reconnect).
        const directory = await newDirectory();
        const creatorPeer = await createPeer(directory);
        const creator = await createDonor(5, creatorPeer);
        const address = creator.fs.address;
        const replicaPeer = await createPeer();
        const replica = await joinOf(creator, replicaPeer, {
            machineLabel: "decision-replica",
        });
        await replica.fs.awaitWriteReady({ timeout: 30_000 });
        expect(replica.fs.bootstrapStatus().writeReadinessSource).toBe(
            "reconciled"
        );
        await stopPeer(creatorPeer);
        await writeFile(
            await sidecarPath(directory),
            JSON.stringify({ writeReady: false })
        );

        const refused = new Set([replicaPeer.peerId.toString()]);
        const deny = (peerId: unknown) => refused.has(String(peerId));
        const peer = await createPeer(directory, {
            denyDialPeer: deny,
            denyOutboundConnection: deny,
            denyInboundEncryptedConnection: deny,
            denyOutboundEncryptedConnection: deny,
            denyInboundUpgradedConnection: deny,
            denyOutboundUpgradedConnection: deny,
        });
        const joiner: Node = {
            peer,
            fs: await openSharedFs({
                peerbit: peer,
                address,
                machineLabel: "decision-orphan",
                bootstrap: false,
                gc: false,
                snapshot: { disabled: true },
            }),
        };
        await waitUntil(() =>
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "no-peer",
                satisfied: false,
                required: [],
                contained: [],
            })
        );
        const runtime = runtimeOf(joiner.fs);
        const settledDebug = runtime.debug();
        expect(settledDebug.armedTimers).toBe(0);
        expect(settledDebug.coordinator).toMatchObject({
            sessions: 0,
            evaluationPending: false,
            decisions: { started: 0, failed: 0, inFlight: false },
        });
        const idle = watchTimers();
        restores.push(idle.stop);
        await sleep(1_500);
        idle.stop();
        console.info(
            `readiness-decision 10.5: over 1.5 s idle, ${idle.total} timers armed through the globals, ${idle.own.length} by shared-fs, ${idle.readiness.length} by readiness`
        );
        expect(idle.readiness).toEqual([]);
        expect(idle.own).toEqual([]);
        expect(runtime.debug().armedTimers).toBe(0);
        expect(runtime.debug().coordinator!.evaluations).toBe(
            settledDebug.coordinator!.evaluations
        );
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);

        // The donor appears: a transport event, then a session (whose
        // bounded timers the same watch sees), then the decision.
        const joining = watchTimers();
        restores.push(joining.stop);
        const flip = atReadyOn(peer, () => joining.stop());
        refused.clear();
        await peer.dial(replicaPeer);
        await joiner.fs.awaitWriteReady({ timeout: 30_000 });
        await flip;
        expect(joining.readiness.length).toBeGreaterThan(0);
        expect(readinessOf(joiner.fs)).toMatchObject({
            state: "ready",
            contained: [
                {
                    peer: hashOf(replicaPeer),
                    qualified: true,
                    source: "reconciled",
                },
            ],
        });
        expect(joiner.fs.bootstrapStatus().writeReadinessSource).toBe(
            "reconciled"
        );
        // The donor's responder ends its sessions with J and keeps nothing
        // armed.
        await waitUntil(() =>
            expect(runtimeOf(replica.fs).debug().responder).toMatchObject({
                sessions: 0,
                armedTimers: 0,
            })
        );
        expect(runtimeOf(joiner.fs).debug().armedTimers).toBe(0);
    });
});
