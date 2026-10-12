import { StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    SharedFileSystem,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import { BootstrapManifest } from "../model.js";
import { PeerbitTransport } from "../readiness/reachability.js";
import { holdCuts } from "./readiness-cut-hold.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Snapshot-manifest discovery asks the peers that run the filesystem (M2
 * PR-3, design tests 69, 70 and 91): the readiness topic's subscribers and
 * the namespace log's replicators, each while A' reads it reachable, from a
 * readiness transport of discovery's own. It must not ask, or wait on, a
 * peer that does not run the filesystem, and must not give up on a donor
 * whose readiness subscription J has not seen.
 *
 * `bystander` runs Peerbit but not this filesystem, like the public relays
 * that peer.bootstrap() dials. It is a pubsub neighbour of the joiner and
 * never answers a manifest query. Discovery used to ask it as a direct
 * neighbour and, without a usable snapshot, wait out the discovery timeout
 * for it; now it is never asked, and discovery ends on the filesystem
 * peers' answers. The bounds below separate those outcomes from a timeout
 * without being timing-flaky.
 *
 * These tests pin discovery itself, so every joiner holds the bootstrap cut
 * (readiness-cut-hold.ts, M2 PR-2): a readiness proof that comes first
 * would otherwise end discovery before what they measure. The cut has its
 * own tests (readiness-bootstrap-cut.test.ts); mode "require" never cuts
 * (test 67, below).
 */

type DiscoveryEnd = Extract<
    BootstrapTelemetryEvent,
    { type: "manifest-discovery:end" }
>;

/** A readiness transport over `fs`'s node, as discovery builds one. */
const transportOf = (fs: SharedFsHandle) => {
    const program = fs.program as any;
    return new PeerbitTransport(program.node, {
        topic: program.readiness.topic,
        log: program.entries.log,
    });
};

const waitFor = async (
    assertion: () => Promise<void> | void,
    timeoutMs = 30_000
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

const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_BOUND_MS = DISCOVERY_TIMEOUT_MS;
/** A deadline a test cannot pass by waiting. */
const LONG_TIMEOUT_MS = 60_000;

describe("shared fs manifest discovery targets", () => {
    const peers: Peerbit[] = [];
    const cutHolds: Array<ReturnType<typeof holdCuts>> = [];
    const restores: Array<() => void> = [];

    afterEach(async () => {
        await stopTestPeers(peers);
        for (const hold of cutHolds.splice(0)) hold.restore();
        for (const restore of restores.splice(0).reverse()) restore();
    });

    /** A joiner's peer whose bootstrap cut is held (see the file comment). */
    const createJoinerPeer = async () => {
        const peer = await createPeer();
        cutHolds.push(holdCuts(peer));
        return peer;
    };

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();

    const discoveryEnd = (events: BootstrapTelemetryEvent[]) =>
        events.find(
            (event): event is DiscoveryEnd =>
                event.type === "manifest-discovery:end"
        );

    /** A factor-1 creator; with `files`, a published snapshot of them. */
    const createDonor = async (files = 0) => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "discovery-donor",
            replicate: { factor: 1 },
        });
        if (files > 0) {
            await fs.writeBatch(
                Array.from({ length: files }, (_, index) => ({
                    path: `/tree/file-${index}.txt`,
                    content: `content ${index}`,
                }))
            );
            expect((await fs.snapshotWrite()).segments).toBeGreaterThan(0);
        } else {
            await fs.writeFile("/seed.txt", "seed");
        }
        return { peer, fs };
    };

    /**
     * Every peer `peer`'s manifest queries name (`remote.from`), in order.
     * `index` is any opened filesystem's document index: the wrapper sits
     * on its class, for `peer`'s indexes only; restored after the test.
     */
    const recordAsked = (peer: Peerbit, fs: SharedFsHandle) => {
        const asked: string[] = [];
        const prototype = Object.getPrototypeOf(
            (fs.program as any).entries.index
        );
        const iterate = prototype.iterate;
        prototype.iterate = function (this: any, ...args: any[]) {
            const from = args[1]?.remote?.from;
            if (this?.node === peer && Array.isArray(from)) {
                asked.push(...from);
            }
            return iterate.apply(this, args);
        };
        restores.push(() => (prototype.iterate = iterate));
        return asked;
    };

    /** J (`observer`) does not see the readiness subscription of `hidden`. */
    const hideSubscriber = (observer: Peerbit, hidden: Peerbit) => {
        const previous = globalThis.__SFS_READINESS_TRANSPORT_HOOKS__;
        globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
            hideSubscriber: (self, peer) =>
                self === hashOf(observer) && peer === hashOf(hidden),
        };
        restores.push(
            () => (globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = previous)
        );
    };

    const joinBesideBystander = async (
        donor: { peer: Peerbit; fs: SharedFsHandle },
        bootstrap: object = {}
    ) => {
        const bystander = await createPeer();
        const joinerPeer = await createJoinerPeer();
        await joinerPeer.dial(bystander);
        await joinerPeer.dial(donor.peer);
        // The bystander is a direct neighbour, which discovery used to ask.
        expect(
            (joinerPeer.services.pubsub as any).peers.has(hashOf(bystander))
        ).toBe(true);
        const asked = recordAsked(joinerPeer, donor.fs);
        const events: BootstrapTelemetryEvent[] = [];
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.fs.address,
            machineLabel: "discovery-joiner",
            replicate: { factor: 1 },
            bootstrap,
            telemetry: { bootstrap: (event) => events.push(event) },
        } as any);
        return { joiner, events, asked, bystander };
    };

    it(
        "69: never asks a neighbour that does not run the filesystem; the boot2 shape ends discovery on the donor's answer",
        { timeout: 120_000 },
        async () => {
            // The donor holds only its genesis manifest (boot2: both peers
            // bootstrap). With a 60 s deadline, only an end on the donor's
            // answer passes.
            const donor = await createDonor();
            const { joiner, events, asked, bystander } =
                await joinBesideBystander(donor, {
                    discoveryTimeoutMs: LONG_TIMEOUT_MS,
                });
            await joiner.awaitWriteReady({ timeout: 60_000 });

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.aborted).toBeUndefined();
            expect(end!.targets).toBe(1);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(asked).toContain(hashOf(donor.peer));
            expect(asked).not.toContain(hashOf(bystander));
            // The genesis manifest is reported, not hidden behind
            // "0 candidates".
            expect(end!.candidates).toBe(0);
            expect(end!.zeroDocument).toBeGreaterThanOrEqual(1);
            expect(
                events.find((event) => event.type === "fallback")
            ).toMatchObject({
                posture: "plain-join",
                reason: expect.stringContaining("zero-document"),
            });
        }
    );

    it(
        "69: installs the snapshot from the filesystem peer, never asking the neighbour",
        { timeout: 120_000 },
        async () => {
            const donor = await createDonor(20);
            const { joiner, events, asked, bystander } =
                await joinBesideBystander(donor, {
                    discoveryTimeoutMs: LONG_TIMEOUT_MS,
                });
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBe(1);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(end!.trusted).toBeGreaterThan(0);
            expect(asked).not.toContain(hashOf(bystander));
            expect(events.some((event) => event.type === "fallback")).toBe(
                false
            );
        }
    );

    it(
        "70: asks a donor visible only by its replicator row (its readiness Subscribe hidden)",
        { timeout: 120_000 },
        async () => {
            const donor = await createDonor(20);
            const joinerPeer = await createJoinerPeer();
            // Design test 16's hideSubscriber applied to discovery: J never
            // sees the donor's readiness subscription (U-1), so only the
            // namespace log's replicator row names the donor.
            hideSubscriber(joinerPeer, donor.peer);
            await joinerPeer.dial(donor.peer);
            const asked = recordAsked(joinerPeer, donor.fs);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-joiner",
                replicate: { factor: 1 },
                bootstrap: { discoveryTimeoutMs: LONG_TIMEOUT_MS },
                telemetry: { bootstrap: (event) => events.push(event) },
            } as any);
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const transport = transportOf(joiner);
            const visible = await transport.filesystemPeers();
            transport.dispose();
            expect(visible).toEqual({
                subscribers: [],
                replicatorOnly: [hashOf(donor.peer)],
            });
            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBe(1);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(end!.trusted).toBeGreaterThan(0);
            expect(asked).toContain(hashOf(donor.peer));
        }
    );

    it(
        "still finds a donor visible only as a replicator when a readiness subscriber answers with nothing",
        { timeout: 120_000 },
        async () => {
            const donor = await createDonor(20);

            // An observer runs the filesystem but holds no manifest, so it
            // answers a manifest query with nothing.
            const observerPeer = await createPeer();
            await observerPeer.dial(donor.peer);
            const observer = await openSharedFs({
                peerbit: observerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-observer",
                replicate: false,
                bootstrap: { mode: "off" },
            });

            const joinerPeer = await createJoinerPeer();
            // Only the observer subscribes visibly: the donor's Subscribe
            // has not arrived (U-1), so it is a replicator-only row. The
            // observer answers once the donor was asked, and the donor
            // answers 500 ms after the observer's empty answer, so that
            // answer always comes first. The donor's query must not be
            // cancelled for that: a replicator-only row holds the end on
            // "every peer asked has answered" while a readiness subscriber
            // returned no manifest (it never holds the end on a usable
            // manifest, test 91, and is released once every subscriber
            // returned one, test 91's no-snapshot variant).
            hideSubscriber(joinerPeer, donor.peer);
            await joinerPeer.dial(observerPeer);
            await joinerPeer.dial(donor.peer);
            const asked = recordAsked(joinerPeer, donor.fs);
            const joinerHash = hashOf(joinerPeer);
            let observerAnswered!: () => void;
            const observerAnswer = new Promise<void>(
                (resolve) => (observerAnswered = resolve)
            );
            const delay = (
                fs: SharedFsHandle,
                before: () => Promise<void>,
                after: () => void = () => {}
            ) => {
                const index = (fs.program as any).entries.index;
                const processQuery = index.processQuery;
                index.processQuery = async function (
                    this: unknown,
                    ...args: any[]
                ) {
                    if (args[1]?.hashcode?.() !== joinerHash) {
                        return processQuery.apply(this, args);
                    }
                    await before();
                    try {
                        return await processQuery.apply(this, args);
                    } finally {
                        after();
                    }
                };
                restores.push(() => (index.processQuery = processQuery));
            };
            delay(
                observer,
                () =>
                    waitFor(() => expect(asked).toContain(hashOf(donor.peer))),
                () => observerAnswered()
            );
            delay(donor.fs, async () => {
                await observerAnswer;
                await new Promise((resolve) => setTimeout(resolve, 500));
            });
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-joiner",
                replicate: { factor: 1 },
                telemetry: { bootstrap: (event) => events.push(event) },
            });
            await (joiner.program as any).bootstrapDecision;
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBe(2);
            expect(end!.trusted).toBeGreaterThan(0);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(events.some((event) => event.type === "fallback")).toBe(
                false
            );
            // The snapshot came from the donor, not from the observer.
            const observerManifests = await (
                observer.program as any
            ).entries.index
                .iterate(
                    {
                        query: [
                            new StringMatch({
                                key: "kind",
                                value: "bootstrap-manifest",
                            }),
                        ],
                    },
                    { local: true, remote: false }
                )
                .all();
            expect(observerManifests).toHaveLength(0);
        }
    );

    it(
        "91: a replicator-only row that A' reads reachable but never answers does not hold discovery past a usable manifest; it is still asked",
        { timeout: 120_000 },
        async () => {
            const donor = await createDonor(20);
            // A dead ex-member as J reads it: a replication row whose route
            // is still in the table. Here a direct neighbour that does not
            // run the filesystem (A' reads it reachable, it never answers),
            // listed by J's replicator reads.
            const ghost = await createPeer();
            const joinerPeer = await createJoinerPeer();
            await joinerPeer.dial(ghost);
            await joinerPeer.dial(donor.peer);
            const ghostHash = hashOf(ghost);
            const replicators = PeerbitTransport.prototype.replicators;
            PeerbitTransport.prototype.replicators = async function (
                this: PeerbitTransport
            ) {
                const rows = await replicators.call(this);
                return this.node === joinerPeer ? [...rows, ghostHash] : rows;
            };
            restores.push(
                () => (PeerbitTransport.prototype.replicators = replicators)
            );
            const asked = recordAsked(joinerPeer, donor.fs);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-joiner",
                replicate: { factor: 1 },
                bootstrap: { discoveryTimeoutMs: LONG_TIMEOUT_MS },
                telemetry: { bootstrap: (event) => events.push(event) },
            } as any);
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const transport = transportOf(joiner);
            const visible = await transport.filesystemPeers();
            transport.dispose();
            expect(visible.subscribers).toEqual([hashOf(donor.peer)]);
            expect(visible.replicatorOnly).toEqual([ghostHash]);
            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.aborted).toBeUndefined();
            expect(end!.targets).toBe(2);
            expect(end!.trusted).toBeGreaterThan(0);
            // Ended on the donor's usable manifest, not at the deadline the
            // silent row would have held it to.
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(asked).toContain(ghostHash);
            expect(asked).toContain(hashOf(donor.peer));
        }
    );

    for (const mode of ["require", "auto"] as const) {
        it(
            `91 (no snapshot, ${mode}): a silent replicator-only row does not hold discovery once every readiness subscriber returned a manifest`,
            { timeout: 120_000 },
            async () => {
                // Test 91's dead ex-member beside a genesis-only donor: no
                // usable manifest exists, so only the end on "every peer
                // asked has answered" can end discovery before its deadline.
                // The donor, a readiness subscriber, returns its
                // zero-document manifest; the silent row must not hold
                // discovery to the deadline for that (K11).
                const donor = await createDonor();
                const ghost = await createPeer();
                const joinerPeer = await createJoinerPeer();
                await joinerPeer.dial(ghost);
                await joinerPeer.dial(donor.peer);
                const ghostHash = hashOf(ghost);
                const replicators = PeerbitTransport.prototype.replicators;
                PeerbitTransport.prototype.replicators = async function (
                    this: PeerbitTransport
                ) {
                    const rows = await replicators.call(this);
                    return this.node === joinerPeer
                        ? [...rows, ghostHash]
                        : rows;
                };
                restores.push(
                    () => (PeerbitTransport.prototype.replicators = replicators)
                );
                const asked = recordAsked(joinerPeer, donor.fs);
                const events: BootstrapTelemetryEvent[] = [];
                const timeoutMs = 20_000;
                const opening = openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.fs.address,
                    machineLabel: "discovery-joiner",
                    replicate: { factor: 1 },
                    bootstrap: { mode, discoveryTimeoutMs: timeoutMs },
                    telemetry: { bootstrap: (event) => events.push(event) },
                });
                if (mode === "require") {
                    await expect(opening).rejects.toMatchObject({
                        code: "EIO",
                    });
                } else {
                    await ((await opening).program as any).bootstrapDecision;
                }

                const end = discoveryEnd(events);
                expect(end).toBeDefined();
                expect(end!.aborted).toBeUndefined();
                expect(end!.targets).toBe(2);
                expect(end!.zeroDocument).toBeGreaterThanOrEqual(1);
                // Ended on the donor's answer, not at the deadline (nor at
                // its half, where the silent row is asked again).
                expect(end!.durationMs).toBeLessThan(timeoutMs / 2);
                expect(asked).toContain(ghostHash);
                expect(asked).toContain(hashOf(donor.peer));
                expect(
                    events.find((event) => event.type === "fallback")
                ).toMatchObject({
                    posture: "plain-join",
                    reason: expect.stringContaining("zero-document"),
                });
            }
        );
    }

    it(
        "mode require does not end discovery on answers with nothing: a donor listed after them is still asked",
        { timeout: 120_000 },
        async () => {
            const donor = await createDonor(20);
            // An observer runs the filesystem but holds no manifest, so it
            // answers a manifest query with nothing.
            const observerPeer = await createPeer();
            await observerPeer.dial(donor.peer);
            await openSharedFs({
                peerbit: observerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-observer",
                replicate: false,
                bootstrap: { mode: "off" },
            });

            // J's transport does not list the donor until `listed` (its
            // Subscribe lost, U-1, and its replicator row not yet arrived),
            // so the observer's empty answer is the only one J holds.
            const joinerPeer = await createPeer();
            await joinerPeer.dial(observerPeer);
            await joinerPeer.dial(donor.peer);
            const donorHash = hashOf(donor.peer);
            let listed = false;
            const filesystemPeers = PeerbitTransport.prototype.filesystemPeers;
            PeerbitTransport.prototype.filesystemPeers = async function (
                this: PeerbitTransport
            ) {
                const visible = await filesystemPeers.call(this);
                if (this.node !== joinerPeer || listed) return visible;
                const drop = (hashes: string[]) =>
                    hashes.filter((hash) => hash !== donorHash);
                return {
                    subscribers: drop(visible.subscribers),
                    replicatorOnly: drop(visible.replicatorOnly),
                };
            };
            restores.push(
                () =>
                    (PeerbitTransport.prototype.filesystemPeers =
                        filesystemPeers)
            );
            // J's own query to the observer, settled: discovery has seen the
            // empty answer once a macrotask has passed after it.
            const observerHash = hashOf(observerPeer);
            let observerQuery: Promise<unknown> | undefined;
            const prototype = Object.getPrototypeOf(
                (donor.fs.program as any).entries.index
            );
            const iterate = prototype.iterate;
            prototype.iterate = function (this: any, ...args: any[]) {
                const iterator = iterate.apply(this, args);
                const from = args[1]?.remote?.from;
                if (
                    this?.node === joinerPeer &&
                    Array.isArray(from) &&
                    from.includes(observerHash)
                ) {
                    const all = iterator.all.bind(iterator);
                    iterator.all = () => (observerQuery ??= all());
                }
                return iterator;
            };
            restores.push(() => (prototype.iterate = iterate));
            const asked = recordAsked(joinerPeer, donor.fs);
            const events: BootstrapTelemetryEvent[] = [];
            const timeoutMs = 20_000;
            const opening = openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "discovery-require",
                replicate: { factor: 1 },
                bootstrap: { mode: "require", discoveryTimeoutMs: timeoutMs },
                telemetry: { bootstrap: (event) => events.push(event) },
            });
            // Settled, and observed, if the open failed first.
            opening.catch(() => {});
            await waitFor(() => expect(observerQuery).toBeDefined());
            expect(await observerQuery).toEqual([]);
            await new Promise((resolve) => setImmediate(resolve));
            expect(asked).not.toContain(donorHash);

            // The donor shows up; a new connection is the transport event
            // that re-reads the peers.
            listed = true;
            await joinerPeer.dial(await createPeer());
            const joiner = await opening;
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBe(2);
            expect(end!.trusted).toBeGreaterThan(0);
            expect(end!.durationMs).toBeLessThan(timeoutMs / 2);
            expect(asked).toContain(donorHash);
        }
    );

    it(
        "asks a silent filesystem peer again at half the deadline",
        { timeout: 120_000 },
        async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "discovery-alone",
                replicate: { factor: 1 },
            });
            const program: any = fs.program;
            const laterPeer = await createPeer();
            await laterPeer.dial(peer);
            const later = await openSharedFs({
                peerbit: laterPeer,
                address: fs.address,
                machineLabel: "discovery-later",
                replicate: { factor: 1 },
            });
            const transport = transportOf(fs);
            await waitFor(async () =>
                expect((await transport.filesystemPeers()).subscribers).toEqual(
                    [hashOf(laterPeer)]
                )
            );
            transport.dispose();

            // The later peer drops every manifest query that reaches it
            // before half the deadline (as one still opening does), so only
            // the repeated ask can be answered.
            const timeoutMs = 12_000;
            const peerHash = hashOf(peer);
            const laterIndex = (later.program as any).entries.index;
            const processQuery = laterIndex.processQuery;
            let dropped = 0;
            let answered = 0;
            let started = Date.now();
            let releaseDropped!: () => void;
            const gate = new Promise<void>(
                (resolve) => (releaseDropped = resolve)
            );
            restores.push(() => releaseDropped());
            laterIndex.processQuery = async function (
                this: unknown,
                ...args: any[]
            ) {
                if (args[1]?.hashcode?.() === peerHash) {
                    if (Date.now() - started < timeoutMs / 2 - 1_000) {
                        dropped++;
                        await gate;
                    } else {
                        answered++;
                    }
                }
                return processQuery.apply(this, args);
            };
            restores.push(() => (laterIndex.processQuery = processQuery));
            started = Date.now();
            const found = await program.discoverManifests(
                new AbortController().signal,
                timeoutMs
            );
            const elapsed = Date.now() - started;
            expect(found.targets).toBe(1);
            expect(dropped).toBeGreaterThanOrEqual(1);
            expect(answered).toBeGreaterThanOrEqual(1);
            // Answered after the repeated ask, well before the deadline.
            expect(elapsed).toBeGreaterThanOrEqual(timeoutMs / 2);
            expect(elapsed).toBeLessThan(timeoutMs - 1_000);
            // The dropped queries are answered late, while the peers run.
            releaseDropped();
        }
    );

    it(
        "67 (M2 PR-2): mode require never cuts: it ends discovery on the donor's answer and fails when no snapshot is usable",
        { timeout: 120_000 },
        async () => {
            // A genesis-only donor beside a silent bystander: in mode "auto"
            // the readiness proof could end this bootstrap (the cut);
            // "require" awaits a snapshot before its join starts, so nothing
            // cuts it (O8). The bystander is never asked (test 69), so
            // discovery ends on the donor's answer.
            const donor = await createDonor();
            const bystander = await createPeer();
            // Recorded, not held: a call would show a cut was asked for.
            const joinerPeer = await createPeer();
            const cuts = holdCuts(joinerPeer);
            cutHolds.push(cuts);
            cuts.release();
            await joinerPeer.dial(bystander);
            await joinerPeer.dial(donor.peer);
            const events: BootstrapTelemetryEvent[] = [];
            const timeoutMs = 20_000;
            await expect(
                openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.fs.address,
                    machineLabel: "discovery-require",
                    replicate: { factor: 1 },
                    bootstrap: {
                        mode: "require",
                        discoveryTimeoutMs: timeoutMs,
                    },
                    telemetry: { bootstrap: (event) => events.push(event) },
                })
            ).rejects.toMatchObject({ code: "EIO" });
            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.aborted).toBeUndefined();
            expect(end!.targets).toBe(1);
            expect(end!.durationMs).toBeLessThan(timeoutMs / 2);
            expect(end!.zeroDocument).toBeGreaterThanOrEqual(1);
            expect(
                events.find((event) => event.type === "fallback")
            ).toMatchObject({
                posture: "plain-join",
                reason: expect.stringContaining("zero-document"),
            });
            expect(cuts.calls()).toEqual([]);
        }
    );

    it(
        "does not let a corrupted copy hide the genuine manifest",
        { timeout: 120_000 },
        async () => {
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "discovery-donor",
                replicate: { factor: 1 },
            });
            await donor.writeBatch(
                Array.from({ length: 20 }, (_, index) => ({
                    path: `/tree/file-${index}.txt`,
                    content: `content ${index}`,
                }))
            );
            expect((await donor.snapshotWrite()).segments).toBeGreaterThan(0);

            // Another peer serves each manifest with the genuine id and
            // signature but altered payload bytes, and its copy arrives
            // first.
            const prototype = SharedFileSystem.prototype as any;
            const original = prototype.discoverManifests;
            prototype.discoverManifests = async function (
                this: unknown,
                ...args: any[]
            ) {
                const found = await original.apply(this, args);
                const corrupted = found.results
                    .filter((raw: unknown) => raw instanceof BootstrapManifest)
                    .map((raw: BootstrapManifest) => {
                        const payloadBytes = raw.payloadBytes.slice();
                        payloadBytes[payloadBytes.length - 1] ^= 0xff;
                        return new BootstrapManifest({
                            id: raw.id,
                            payloadBytes,
                            signatureBytes: raw.signatureBytes,
                        });
                    });
                return { ...found, results: [...corrupted, ...found.results] };
            };
            const joinerPeer = await createJoinerPeer();
            await joinerPeer.dial(donorPeer);
            const events: BootstrapTelemetryEvent[] = [];
            let joiner: Awaited<ReturnType<typeof openSharedFs>>;
            try {
                joiner = await openSharedFs({
                    peerbit: joinerPeer,
                    address: donor.address,
                    machineLabel: "discovery-joiner",
                    replicate: { factor: 1 },
                    telemetry: { bootstrap: (event) => events.push(event) },
                });
                await (joiner.program as any).bootstrapDecision;
            } finally {
                prototype.discoverManifests = original;
            }
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.invalid).toBeGreaterThanOrEqual(1);
            expect(end!.trusted).toBe(1);
        }
    );

    it(
        "waits for the first filesystem peer by event and removes its listeners",
        { timeout: 120_000 },
        async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "discovery-alone",
                replicate: { factor: 1 },
            });
            const program: any = fs.program;
            const services = peer.services as any;
            const logEvents = program.entries.log.events;
            // Every source discovery's transport listens on (reachability.ts).
            const listenerCounts = () => [
                ...[services.pubsub, services.fanout, services.blocks].flatMap(
                    (stream) => [
                        stream.listenerCount("peer:reachable"),
                        stream.listenerCount("peer:unreachable"),
                    ]
                ),
                services.pubsub.listenerCount("subscribe"),
                services.pubsub.listenerCount("unsubscribe"),
                logEvents.listenerCount("replicator:join"),
                logEvents.listenerCount("replication:change"),
                logEvents.listenerCount("replicator:leave"),
                (peer as any).libp2p.listenerCount("peer:connect"),
                (peer as any).libp2p.listenerCount("peer:disconnect"),
            ];
            const baseline = listenerCounts();

            // Nobody to ask: ends at the deadline with the local index only.
            const alone = Date.now();
            const quiet = await program.discoverManifests(
                new AbortController().signal,
                300
            );
            expect(Date.now() - alone).toBeGreaterThanOrEqual(250);
            expect(quiet.targets).toBe(0);
            expect(listenerCounts()).toEqual(baseline);

            // Abort rejects with the signal's reason.
            const aborter = new AbortController();
            const aborted = program.discoverManifests(aborter.signal, 60_000);
            const reason = new Error("closing");
            setTimeout(() => aborter.abort(reason), 50);
            await expect(aborted).rejects.toBe(reason);
            expect(listenerCounts()).toEqual(baseline);

            // The cut (M2 PR-2) ends it with no error; meanwhile its own
            // transport listened on every source above.
            const cut = new AbortController();
            const cutRun = program.discoverManifests(
                new AbortController().signal,
                60_000,
                undefined,
                cut.signal
            );
            let during: number[] | undefined;
            setTimeout(() => {
                during = listenerCounts();
                cut.abort();
            }, 50);
            await expect(cutRun).resolves.toMatchObject({ targets: 0 });
            expect(during!.every((count, i) => count === baseline[i] + 1)).toBe(
                true
            );
            expect(listenerCounts()).toEqual(baseline);

            // A filesystem peer that connects and opens later ends the wait
            // as soon as it answers, not at the deadline.
            const started = Date.now();
            const waiting = program.discoverManifests(
                new AbortController().signal,
                60_000
            );
            const laterPeer = await createPeer();
            await laterPeer.dial(peer);
            await openSharedFs({
                peerbit: laterPeer,
                address: fs.address,
                machineLabel: "discovery-later",
                replicate: { factor: 1 },
            });
            const found = await waiting;
            expect(Date.now() - started).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(found.targets).toBe(1);
            // Pubsub's own delivery waits add and remove listeners on these
            // sources while peers publish; discovery's are gone for good.
            await waitFor(() => expect(listenerCounts()).toEqual(baseline));
        }
    );
});
