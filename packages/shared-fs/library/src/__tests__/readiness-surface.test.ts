import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair, type PublicSignKey } from "@peerbit/crypto";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFileSystem,
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type BootstrapStatus,
    type BootstrapTelemetryEvent,
    type ReadinessStatus,
    type SharedFsHandle,
} from "../index.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { OpenV1 } from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The readiness surface of M1 PR-4 (plan 7.4, SPEC-PR4 section 2), in
 * process: `write:ready` once per open for every source (a creator and a
 * warm reopen at the end of open, a reconciled and an operator flip at the
 * flip), never under allowPartialWrites or on an observer;
 * `readiness:progress` and awaitWriteReady's `onProgress` while a join
 * waits, each the status of its moment, and nothing after the flip;
 * `writeReadiness.requestTimeoutMs` reaching the join's attempts, and its
 * validation; `msSinceLastArrival` gone from bootstrapStatus(); and the
 * telemetry PR-4 adds (`write-ready` counts, `readiness-peer`,
 * `write-ready-timeout`, `writers-unheard`). Waits are on events, never on
 * a poll.
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();

/** A promise and its resolve. */
const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
};

type Telemetry<T extends BootstrapTelemetryEvent["type"]> = Extract<
    BootstrapTelemetryEvent,
    { type: T }
>;

const eventsOf = <T extends BootstrapTelemetryEvent["type"]>(
    telemetry: BootstrapTelemetryEvent[],
    type: T
) => telemetry.filter((event): event is Telemetry<T> => event.type === type);

/**
 * Makes `donor`'s responder drop every OPEN it receives (a hung peer that
 * still holds the store and stays reachable), recording when each arrived
 * (as readiness-escape.test.ts's `dropOpens`).
 */
const dropOpens = (donor: SharedFsHandle) => {
    const responder = runtimeOf(donor)!.responder!;
    const onMessage = responder.onMessage;
    const times: number[] = [];
    responder.onMessage = (message, from) => {
        if (message instanceof OpenV1) {
            times.push(performance.now());
            return;
        }
        onMessage.call(responder, message, from);
    };
    return {
        times,
        restore: () => {
            responder.onMessage = onMessage;
        },
    };
};

/**
 * Resolves once `check()` holds, re-checking on each `type` event of
 * `target` (an event-driven wait; the listener is attached before the
 * first check, so no event is missed).
 */
const untilEvent = async (
    target: EventTarget,
    type: string,
    check: () => Promise<boolean> | boolean
) => {
    for (;;) {
        const next = new Promise((resolve) =>
            target.addEventListener(type, resolve, { once: true })
        );
        if (await check()) return;
        await next;
    }
};

describe("write readiness surface (PR-4)", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    /** Undone first in afterEach: patched prototypes and responders. */
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

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(directory ? { directory } : {});
        peers.push(peer);
        return peer;
    };

    const newDirectory = async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-surface-"));
        roots.push(root);
        return join(root, "peer");
    };

    /** A creator with one file, in memory. */
    const createDonor = async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "surface-donor",
            gc: false,
        });
        await fs.writeFile("/donor.txt", "from the donor");
        return { peer, fs };
    };

    /**
     * Listens to every SharedFileSystem opened on `peer` from now on,
     * before its open runs (a flip can land before openSharedFs returns):
     * each `write:ready`, and each `readiness:progress` with the status
     * read inside the dispatch.
     */
    const listenOn = (peer: Peerbit) => {
        const prototype = SharedFileSystem.prototype as any;
        const open = prototype.open;
        const programs = new Set<unknown>();
        const seen = {
            ready: [] as BootstrapStatus[],
            progress: [] as Array<{
                detail: ReadinessStatus;
                status: ReadinessStatus | undefined;
            }>,
        };
        prototype.open = function (this: any, ...args: unknown[]) {
            if (this.node === peer && !programs.has(this)) {
                programs.add(this);
                this.events.addEventListener("write:ready", (event: any) =>
                    seen.ready.push(event.detail)
                );
                this.events.addEventListener(
                    "readiness:progress",
                    (event: any) =>
                        seen.progress.push({
                            detail: event.detail,
                            status: this.bootstrapStatus().readiness,
                        })
                );
            }
            return open.apply(this, args);
        };
        restores.push(() => (prototype.open = open));
        return seen;
    };

    /** A fresh full address-open of `donor`'s filesystem, dialed to it. */
    const joinDonor = async (
        donor: { peer: Peerbit; fs: SharedFsHandle },
        options: {
            peer?: Peerbit;
            label?: string;
            telemetry?: BootstrapTelemetryEvent[];
            onTelemetry?: (event: BootstrapTelemetryEvent) => void;
            requestTimeoutMs?: number;
            replicate?: false;
            allowPartialWrites?: boolean;
        } = {}
    ) => {
        const peer = options.peer ?? (await createPeer());
        await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.fs.address,
            machineLabel: options.label ?? "surface-joiner",
            bootstrap: false,
            gc: false,
            ...(options.replicate === false ? { replicate: false } : {}),
            ...(options.allowPartialWrites ? { allowPartialWrites: true } : {}),
            ...(options.requestTimeoutMs !== undefined
                ? {
                      writeReadiness: {
                          requestTimeoutMs: options.requestTimeoutMs,
                      },
                  }
                : {}),
            ...(options.telemetry || options.onTelemetry
                ? {
                      telemetry: {
                          bootstrap: (event: BootstrapTelemetryEvent) => {
                              options.telemetry?.push(event);
                              options.onTelemetry?.(event);
                          },
                      },
                  }
                : {}),
        });
        return { peer, fs };
    };

    it("a creator and a warm reopen dispatch write:ready once each, as the open's last step, with no readiness:progress; write-ready telemetry counts nothing", async () => {
        const peer = await createPeer(await newDirectory());
        const program = new SharedFileSystem();
        const events = program.events as EventTarget;
        let opened = false;
        const ready: Array<{ status: BootstrapStatus; opened: boolean }> = [];
        const progress: unknown[] = [];
        events.addEventListener("write:ready", (event) =>
            ready.push({
                status: (event as CustomEvent<BootstrapStatus>).detail,
                opened,
            })
        );
        events.addEventListener("readiness:progress", (event) =>
            progress.push((event as CustomEvent).detail)
        );
        const telemetry: BootstrapTelemetryEvent[] = [];
        const args = {
            machineLabel: "surface-creator",
            bootstrap: false,
            gc: false,
            bootstrapTelemetry: (event: BootstrapTelemetryEvent) =>
                telemetry.push(event),
        };
        await peer.open(program, { args: args as any });
        opened = true;
        // Dispatched inside the open, before peer.open returned.
        expect(ready).toEqual([
            {
                status: expect.objectContaining({
                    writeReady: true,
                    writeReadinessSource: "creator",
                    partialWriteOverride: false,
                }),
                opened: false,
            },
        ]);
        expect(eventsOf(telemetry, "write-ready")).toEqual([
            {
                type: "write-ready",
                atMs: expect.any(Number),
                durationMs: expect.any(Number),
                source: "creator",
                warm: false,
                contained: 0,
                excluded: 0,
                gaps: 0,
            },
        ]);
        await program.writeFile("/creator.txt", "written");
        expect(ready).toHaveLength(1);

        // A same-instance warm reopen (open mode: an access-controlled
        // same-instance reopen fails upstream, U-66).
        await program.close();
        opened = false;
        telemetry.length = 0;
        await peer.open(program, {
            existing: "reuse",
            args: {
                ...args,
                machineLabel: "surface-warm",
                addressOpen: true,
            } as any,
        });
        opened = true;
        expect(ready).toHaveLength(2);
        expect(ready[1]).toEqual({
            status: expect.objectContaining({
                writeReady: true,
                writeReadinessSource: "creator",
            }),
            opened: false,
        });
        expect((program as any).readinessProvenance().source).toBe("warm");
        expect(program.bootstrapStatus().readiness).toBeUndefined();
        expect(eventsOf(telemetry, "write-ready")).toEqual([
            expect.objectContaining({
                source: "creator",
                warm: true,
                contained: 0,
                excluded: 0,
                gaps: 0,
            }),
        ]);
        expect(eventsOf(telemetry, "readiness-peer")).toEqual([]);
        expect(progress).toEqual([]);
        expect("msSinceLastArrival" in program.bootstrapStatus()).toBe(false);
    });

    it("a fresh joiner: readiness:progress while it joins, each the status of its moment, then one write:ready (reconciled) and nothing after; an observer and allowPartialWrites get no write:ready", async () => {
        const donor = await createDonor();
        const donorHash = hashOf(donor.peer);
        const peer = await createPeer();
        const seen = listenOn(peer);
        const telemetry: BootstrapTelemetryEvent[] = [];
        const joiner = await joinDonor(donor, { peer, telemetry });
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });

        expect(seen.ready).toEqual([
            expect.objectContaining({
                writeReady: true,
                writeReadinessSource: "reconciled",
            }),
        ]);
        // Each event carries bootstrapStatus().readiness at its dispatch,
        // and consecutive ones differ; none says ready.
        expect(seen.progress.length).toBeGreaterThan(0);
        for (const { detail, status } of seen.progress) {
            expect(detail).toEqual(status);
            expect(detail.state).not.toBe("ready");
        }
        for (let i = 1; i < seen.progress.length; i++) {
            expect(seen.progress[i].detail).not.toEqual(
                seen.progress[i - 1].detail
            );
        }

        // Telemetry: the donor's readiness-peer events start asked and end
        // contained and qualified, all before write-ready, whose counts are
        // the proof's; atMs never goes back.
        const donorChanges = eventsOf(telemetry, "readiness-peer").filter(
            ({ peer }) => peer === donorHash
        );
        expect(donorChanges[0]).toMatchObject({
            state: "asking",
            reason: "asked",
        });
        expect(donorChanges.at(-1)).toMatchObject({
            state: "contained",
            reason: "qualified",
        });
        const types = telemetry.map(({ type }) => type);
        expect(types.lastIndexOf("readiness-peer")).toBeLessThan(
            types.indexOf("write-ready")
        );
        expect(eventsOf(telemetry, "write-ready")).toEqual([
            expect.objectContaining({
                source: "reconciled",
                warm: false,
                contained: 1,
                excluded: 0,
                gaps: 0,
            }),
        ]);
        for (let i = 1; i < telemetry.length; i++) {
            expect(telemetry[i].atMs).toBeGreaterThanOrEqual(
                telemetry[i - 1].atMs
            );
        }
        // Open mode: no writers-unheard.
        expect(eventsOf(telemetry, "writers-unheard")).toEqual([]);

        // After the flip: a donor write reaches the joiner, and two more
        // peers subscribe to the readiness topic; no readiness event.
        const progressAtReady = seen.progress.length;
        const changesAtReady = telemetry.length;
        const entries = programOf(joiner.fs).entries;
        const written = new Promise((resolve) =>
            entries.events.addEventListener("change", resolve, {
                once: true,
            })
        );
        await donor.fs.writeFile("/after.txt", "after the flip");
        await written;

        const topic = programOf(joiner.fs).readiness.topic;
        const others = [
            {
                peer: await createPeer(),
                label: "surface-observer",
                replicate: false as const,
            },
            {
                peer: await createPeer(),
                label: "surface-partial",
                allowPartialWrites: true,
            },
        ];
        const expected = others.map(({ peer }) => hashOf(peer));
        const subscribers = new Set<string>();
        const bothSubscribed = deferred();
        const pubsub = peer.services.pubsub as unknown as EventTarget;
        const onSubscribe = (event: any) => {
            const from: PublicSignKey | undefined = event.detail?.from;
            if (!from || !event.detail.topics?.includes(topic)) return;
            subscribers.add(from.hashcode());
            if (expected.every((hash) => subscribers.has(hash))) {
                bothSubscribed.resolve();
            }
        };
        pubsub.addEventListener("subscribe", onSubscribe);
        restores.push(() =>
            pubsub.removeEventListener("subscribe", onSubscribe)
        );
        for (const { peer: other, ...options } of others) {
            await other.dial(peer);
            const otherSeen = listenOn(other);
            const opened = await joinDonor(donor, { peer: other, ...options });
            // Neither has a write-readiness source: no write:ready, and
            // assumeComplete() is refused.
            await expect(opened.fs.assumeComplete()).rejects.toMatchObject({
                code: "EINVAL",
            });
            expect(otherSeen.ready).toEqual([]);
            expect(otherSeen.progress).toEqual([]);
            expect("msSinceLastArrival" in opened.fs.bootstrapStatus()).toBe(
                false
            );
        }
        await bothSubscribed.promise;

        expect(seen.progress).toHaveLength(progressAtReady);
        expect(seen.ready).toHaveLength(1);
        expect(telemetry.slice(changesAtReady)).toEqual([]);
        for (const fs of [donor.fs, joiner.fs]) {
            const status = fs.bootstrapStatus();
            expect("msSinceLastArrival" in status).toBe(false);
            // @ts-expect-error removed from BootstrapStatus in PR-4
            expect(status.msSinceLastArrival).toBeUndefined();
        }
    });

    it("a silent donor with requestTimeoutMs 200: three OPENs, then reachable-silent; onProgress at once and on each change; timeouts reported; assumeComplete ends the join as operator", async () => {
        const donor = await createDonor();
        const donorHash = hashOf(donor.peer);
        const drops = dropOpens(donor.fs);
        restores.push(drops.restore);
        const peer = await createPeer();
        const seen = listenOn(peer);
        const telemetry: BootstrapTelemetryEvent[] = [];
        const silent = deferred<number>();
        const joiner = await joinDonor(donor, {
            peer,
            telemetry,
            requestTimeoutMs: 200,
            onTelemetry: (event) => {
                if (
                    event.type === "readiness-peer" &&
                    event.peer === donorHash &&
                    event.state === "silent"
                ) {
                    silent.resolve(performance.now());
                }
            },
        });
        expect(programOf(joiner.fs).readinessRequestTimeoutMs).toBe(200);

        const calls: ReadinessStatus[] = [];
        const waiting = joiner.fs.awaitWriteReady({
            onProgress: (readiness) => calls.push(readiness),
        });
        // The first call is synchronous: before awaitWriteReady returned.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(joiner.fs.bootstrapStatus().readiness);

        // OPENs at 0, 200 and 600 ms; silent once the third has waited
        // 800 ms (1,400 ms after the first, less its delivery). The upper
        // bounds fail if the option never reached the sessions: the
        // defaults send the second OPEN 5 s after the first and report
        // silent after 35 s.
        const silentAt = await silent.promise;
        expect(drops.times).toHaveLength(3);
        expect(silentAt - drops.times[0]).toBeGreaterThanOrEqual(1_350);
        expect(drops.times[1] - drops.times[0]).toBeLessThan(2_500);
        expect(silentAt - drops.times[0]).toBeLessThan(5_000);
        expect(eventsOf(telemetry, "readiness-peer").at(-1)).toEqual({
            type: "readiness-peer",
            atMs: expect.any(Number),
            peer: donorHash,
            state: "silent",
            reason: "reachable-silent",
        });
        expect(calls.at(-1)).toMatchObject({
            state: "waiting-silent",
            silent: [{ peer: donorHash, reachable: true }],
        });
        // Every call after the first was a readiness:progress event.
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.slice(1)).toEqual(
            seen.progress
                .slice(seen.progress.length - (calls.length - 1))
                .map(({ detail }) => detail)
        );

        // A timed wait rejects on its timeout after its last call; the
        // timeout is reported with what it waited for.
        const order: string[] = [];
        const timedOut = await joiner.fs
            .awaitWriteReady({
                timeout: 500,
                onProgress: () => order.push("progress"),
            })
            .then(
                () => {
                    throw new Error("awaitWriteReady resolved");
                },
                (error: unknown) => {
                    order.push("rejected");
                    return error;
                }
            );
        expect(timedOut).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
        expect(
            (timedOut as SharedFsWriteReadyTimeoutError).readiness?.state
        ).toBe("waiting-silent");
        expect(order).toEqual(["progress", "rejected"]);
        expect(eventsOf(telemetry, "write-ready-timeout")).toEqual([
            {
                type: "write-ready-timeout",
                atMs: expect.any(Number),
                timeoutMs: 500,
                state: "waiting-silent",
                required: 1,
                silent: 1,
                reachable: 1,
                busy: 0,
            },
        ]);

        // A throwing onProgress never ends a wait early.
        const started = performance.now();
        const thrown = await joiner.fs
            .awaitWriteReady({
                timeout: 300,
                onProgress: () => {
                    throw new Error("the caller's bug");
                },
            })
            .catch((error: unknown) => error);
        expect(thrown).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
        expect(performance.now() - started).toBeGreaterThanOrEqual(290);
        expect(eventsOf(telemetry, "write-ready-timeout")).toHaveLength(2);

        // The operator escape: one write:ready (operator), the waiter
        // resolves, and no progress follows.
        const callsBefore = calls.length;
        const progressBefore = seen.progress.length;
        await joiner.fs.assumeComplete();
        await waiting;
        expect(seen.ready).toEqual([
            expect.objectContaining({
                writeReady: true,
                writeReadinessSource: "operator",
            }),
        ]);
        expect(calls).toHaveLength(callsBefore);
        expect(seen.progress).toHaveLength(progressBefore);
        expect(eventsOf(telemetry, "write-ready")).toEqual([
            {
                type: "write-ready",
                atMs: expect.any(Number),
                durationMs: expect.any(Number),
                source: "operator",
                warm: false,
                contained: 0,
                excluded: 0,
                gaps: 0,
            },
        ]);
        // Another joiner, without a telemetry callback: its timeout just
        // rejects (the donor is still silent).
        const plain = await joinDonor(donor, { label: "surface-plain" });
        await expect(
            plain.fs.awaitWriteReady({ timeout: 200 })
        ).rejects.toBeInstanceOf(SharedFsWriteReadyTimeoutError);
        // A new peer after the flip reports nothing on the ready joiner.
        expect(seen.progress).toHaveLength(progressBefore);
        expect(seen.ready).toHaveLength(1);

        // Already writable: resolved at once, onProgress never called.
        const after: unknown[] = [];
        await joiner.fs.awaitWriteReady({
            onProgress: (readiness) => after.push(readiness),
        });
        expect(after).toEqual([]);
    });

    it("writeReadiness.requestTimeoutMs outside 100 to 25000 is EINVAL before anything opens; the bounds open", async () => {
        const peer = await createPeer();
        // The handler exists once a program opened.
        const programs = () => peer.handler?.items.size ?? 0;
        const before = programs();
        const message =
            "writeReadiness.requestTimeoutMs must be a number of milliseconds from 100 to 25000";
        // Above 25000 a sync-wait window can outlast the responder's 30 s
        // session idle, so every session of a stalled sync would expire.
        for (const requestTimeoutMs of [
            0,
            99,
            25_001,
            30_000,
            600_000,
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            "5000",
        ]) {
            await expect(
                openSharedFs({
                    peerbit: peer,
                    machineLabel: "surface-invalid",
                    writeReadiness: {
                        requestTimeoutMs: requestTimeoutMs as number,
                    },
                }),
                String(requestTimeoutMs)
            ).rejects.toMatchObject({ code: "EINVAL", message });
            expect(programs()).toBe(before);
        }
        // A program opened directly is checked as it opens (beforeOpen).
        await expect(
            peer.open(new SharedFileSystem(), {
                args: { writeReadiness: { requestTimeoutMs: 50 } },
            })
        ).rejects.toMatchObject({ code: "EINVAL", message });
        expect(programs()).toBe(before);

        for (const requestTimeoutMs of [100, 25_000]) {
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: `surface-bound-${requestTimeoutMs}`,
                writeReadiness: { requestTimeoutMs },
                gc: false,
            });
            expect(fs.bootstrapStatus().writeReady).toBe(true);
            expect(programOf(fs).readinessRequestTimeoutMs).toBe(
                requestTimeoutMs
            );
        }

        // open() itself, past beforeOpen: refused before a lifecycle
        // request begins.
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "surface-reopen",
            gc: false,
        });
        const program = programOf(fs);
        expect(program.readinessRequestTimeoutMs).toBe(5_000);
        await program.close();
        const generation = program.lifecycleRequestGeneration;
        await expect(
            program.open({ writeReadiness: { requestTimeoutMs: 25_001 } })
        ).rejects.toMatchObject({ code: "EINVAL", message });
        expect(program.lifecycleRequestGeneration).toBe(generation);
    });

    it("awaitWriteReady's timeout is at most 2147483647 ms: above Node's timer limit it is EINVAL at once, not a timeout after 1 ms", async () => {
        const donor = await createDonor();
        restores.push(dropOpens(donor.fs).restore);
        const telemetry: BootstrapTelemetryEvent[] = [];
        const joiner = await joinDonor(donor, {
            label: "surface-timeout-limit",
            telemetry,
        });
        const message =
            "awaitWriteReady timeout must be a positive number of milliseconds no greater than 2147483647";
        // Node runs a longer setTimeout after 1 ms, so the wait would end at
        // once with a timeout the caller did not ask for (and the CLI's
        // --assume-complete would act on it).
        for (const timeout of [
            2_147_483_648,
            2 ** 32,
            Number.MAX_SAFE_INTEGER,
            0,
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        ]) {
            const outcome = await Promise.resolve()
                .then(() => joiner.fs.awaitWriteReady({ timeout }))
                .then(
                    () => "resolved",
                    (error: unknown) => error
                );
            expect(outcome, String(timeout)).toMatchObject({
                code: "EINVAL",
                message,
            });
        }
        expect(eventsOf(telemetry, "write-ready-timeout")).toEqual([]);
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);

        // The limit itself is a wait like any other: only its abort ends it.
        const abort = new AbortController();
        const waiting = joiner.fs.awaitWriteReady({
            timeout: 2_147_483_647,
            signal: abort.signal,
        });
        const reason = new Error("stop waiting");
        abort.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        expect(eventsOf(telemetry, "write-ready-timeout")).toEqual([]);
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
    });

    it("writers-unheard: after a reconciled flip in an access-controlled store, the trusted writers with no row attributed to them here", async () => {
        const ownerPeer = await createPeer();
        const owner = await openSharedFs({
            peerbit: ownerPeer,
            machineLabel: "surface-owner",
            rootKey: ownerPeer.identity.publicKey,
            gc: false,
        });
        await owner.writeFile("/owner.txt", "from the owner");
        // W: authorized, never writes.
        const unheard = (await Ed25519Keypair.create()).publicKey;
        await owner.authorizeWriter(unheard);
        // X: authorized, writes once its own graph trusts it.
        const writerPeer = await createPeer();
        await writerPeer.dial(ownerPeer);
        const writer = await openSharedFs({
            peerbit: writerPeer,
            address: owner.address,
            machineLabel: "surface-writer",
            allowPartialWrites: true,
            bootstrap: false,
            gc: false,
        });
        await owner.authorizeWriter(writerPeer.identity.publicKey);
        await untilEvent(
            programOf(writer).trustGraph.trustGraph.events,
            "change",
            () => writer.isTrustedWriter(writerPeer.identity.publicKey)
        );
        await writer.writeFile("/writer.txt", "from the writer");

        // J: authorized before it joins, so its own key is among its
        // trusted writers and the event must leave it out.
        const joinerPeer = await createPeer();
        await owner.authorizeWriter(joinerPeer.identity.publicKey);
        await joinerPeer.dial(writerPeer);
        const reported = deferred<Telemetry<"writers-unheard">>();
        const joiner = await joinDonor(
            { peer: ownerPeer, fs: owner },
            {
                peer: joinerPeer,
                label: "surface-acl-joiner",
                onTelemetry: (event) => {
                    if (event.type === "writers-unheard") {
                        reported.resolve(event);
                    }
                },
            }
        );
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(joiner.fs.bootstrapStatus().writeReadinessSource).toBe(
            "reconciled"
        );
        const event = await reported.promise;
        const all = await joiner.fs.trustedWriters();
        expect(
            all.some((key) => key.equals(joinerPeer.identity.publicKey))
        ).toBe(true);
        const trusted = all.filter(
            (key) => !key.equals(joinerPeer.identity.publicKey)
        );
        // The root O, W and X besides J; O and X wrote. Counting J's own
        // key would report count 2 and trusted 4 (J wrote nothing).
        expect(trusted.map((key) => key.hashcode()).sort()).toEqual(
            [
                ownerPeer.identity.publicKey,
                unheard,
                writerPeer.identity.publicKey,
            ]
                .map((key) => key.hashcode())
                .sort()
        );
        expect(event).toEqual({
            type: "writers-unheard",
            atMs: expect.any(Number),
            count: 1,
            trusted: 3,
        });
    });

    it("writers-unheard checks at most 1024 trusted keys besides this peer's own and says when it cut the list", async () => {
        const own = (await Ed25519Keypair.create()).publicKey;
        const others = await Promise.all(
            Array.from(
                { length: 1025 },
                async () => (await Ed25519Keypair.create()).publicKey
            )
        );
        /** reportWritersUnheard on a host whose index holds no row. */
        const report = async (keys: PublicSignKey[]) => {
            const events: BootstrapTelemetryEvent[] = [];
            const read: string[] = [];
            let task: Promise<unknown> | undefined;
            const host = Object.assign(
                Object.create(SharedFileSystem.prototype),
                {
                    trustGraph: {},
                    bootstrapTelemetry: () => {},
                    node: { identity: { publicKey: own } },
                    maintenanceContextIfActive: () => ({}),
                    maintenanceContextActive: () => true,
                    trustedWriters: async () => keys,
                    readLocalIndex: async (query: any[]) => {
                        read.push(query[0].value);
                        return false;
                    },
                    emitBootstrapTelemetry: (event: BootstrapTelemetryEvent) =>
                        events.push(event),
                    bootstrapTelemetryElapsed: () => 0,
                    bootstrapTelemetryNow: () => 0,
                    trackMaintenanceTask: (promise: Promise<unknown>) =>
                        (task = promise),
                }
            );
            (SharedFileSystem.prototype as any).reportWritersUnheard.call(host);
            await task;
            return { events, read };
        };

        const small = await report([own, ...others.slice(0, 3)]);
        expect(small.events).toEqual([
            { type: "writers-unheard", atMs: 0, count: 3, trusted: 3 },
        ]);
        expect(small.read).toHaveLength(3);

        const big = await report([...others, own]);
        expect(big.events).toEqual([
            {
                type: "writers-unheard",
                atMs: 0,
                count: 1024,
                trusted: 1025,
                truncated: true,
            },
        ]);
        expect(big.read).toHaveLength(1024);
    });
});
