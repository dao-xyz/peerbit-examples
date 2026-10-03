import { StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    SharedFileSystem,
    type BootstrapTelemetryEvent,
} from "../index.js";
import { BootstrapManifest } from "../model.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Snapshot-manifest discovery must not wait on peers that do not run the
 * filesystem longer than one discovery timeout, and must not give up on a
 * connected donor that is not visible yet.
 *
 * `bystander` runs Peerbit but not this filesystem, like the public relays
 * that peer.bootstrap() dials. It is a pubsub neighbour of the joiner and
 * never answers a manifest query. Before the fix a factor-1 joiner asked it,
 * waited out the 5 s discovery timeout, and retried it twice: discovery
 * took 15 s. Now a usable snapshot ends discovery in tens of milliseconds,
 * and without one the silent neighbour costs one timeout. The bounds below
 * separate those outcomes from 15 s without being timing-flaky.
 */

type DiscoveryEnd = Extract<
    BootstrapTelemetryEvent,
    { type: "manifest-discovery:end" }
>;

const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_BOUND_MS = DISCOVERY_TIMEOUT_MS;

describe("shared fs manifest discovery targets", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    const discoveryEnd = (events: BootstrapTelemetryEvent[]) =>
        events.find(
            (event): event is DiscoveryEnd =>
                event.type === "manifest-discovery:end"
        );

    const joinBesideBystander = async (donor: {
        peer: Peerbit;
        address: string;
    }) => {
        const bystander = await createPeer();
        const joinerPeer = await createPeer();
        await joinerPeer.dial(bystander);
        await joinerPeer.dial(donor.peer);
        // The bystander must be a target, or the bound proves nothing.
        expect(
            (joinerPeer.services.pubsub as any).peers.has(
                bystander.identity.publicKey.hashcode()
            )
        ).toBe(true);
        const events: BootstrapTelemetryEvent[] = [];
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address: donor.address,
            machineLabel: "discovery-joiner",
            replicate: { factor: 1 },
            telemetry: { bootstrap: (event) => events.push(event) },
        });
        return { joiner, events };
    };

    it(
        "waits one timeout, not three, when the only donor holds a zero-document manifest",
        { timeout: 120_000 },
        async () => {
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "discovery-donor",
                replicate: { factor: 1 },
            });
            await donor.writeFile("/seed.txt", "seed");

            const { joiner, events } = await joinBesideBystander({
                peer: donorPeer,
                address: donor.address,
            });
            await joiner.awaitWriteReady({ timeout: 60_000 });

            // The silent bystander could still be a donor whose answer is on
            // its way, so discovery waits for it until the deadline, once.
            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBeGreaterThanOrEqual(2);
            expect(end!.durationMs).toBeLessThan(2 * DISCOVERY_TIMEOUT_MS);
            // The genesis manifest is reported, not hidden behind
            // "0 candidates".
            expect(end!.candidates).toBe(0);
            expect(end!.zeroDocument).toBeGreaterThanOrEqual(1);
            expect(
                events.find((event) => event.type === "fallback")
            ).toMatchObject({ posture: "plain-join" });
        }
    );

    it(
        "installs the snapshot without waiting on a silent neighbour",
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

            const { joiner, events } = await joinBesideBystander({
                peer: donorPeer,
                address: donor.address,
            });
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBeGreaterThanOrEqual(2);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(end!.trusted).toBeGreaterThan(0);
            expect(events.some((event) => event.type === "fallback")).toBe(
                false
            );
        }
    );

    it(
        "still finds a connected donor before it is visible as a replicator or subscriber",
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

            // The subscriber view can lag (a lost Subscribe announcement):
            // the joiner then sees no filesystem peer at all. A directly
            // connected donor must still be asked, as before the fix.
            const prototype = SharedFileSystem.prototype as any;
            const original = prototype.visibleFilesystemPeers;
            prototype.visibleFilesystemPeers = async () => new Set<string>();
            let joined: Awaited<ReturnType<typeof joinBesideBystander>>;
            try {
                joined = await joinBesideBystander({
                    peer: donorPeer,
                    address: donor.address,
                });
                await (joined.joiner.program as any).bootstrapDecision;
            } finally {
                prototype.visibleFilesystemPeers = original;
            }
            const { joiner, events } = joined;
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );

            const end = discoveryEnd(events);
            expect(end).toBeDefined();
            expect(end!.targets).toBeGreaterThanOrEqual(2);
            expect(end!.durationMs).toBeLessThan(DISCOVERY_BOUND_MS);
            expect(end!.trusted).toBeGreaterThan(0);
        }
    );

    it(
        "still finds a hidden donor when a visible filesystem peer answers with nothing",
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

            // An observer runs the filesystem but holds no manifest, so it
            // answers a manifest query with nothing.
            const observerPeer = await createPeer();
            await observerPeer.dial(donorPeer);
            const observer = await openSharedFs({
                peerbit: observerPeer,
                address: donor.address,
                machineLabel: "discovery-observer",
                replicate: false,
                bootstrap: { mode: "off" },
            });

            const joinerPeer = await createPeer();
            await joinerPeer.dial(observerPeer);
            await joinerPeer.dial(donorPeer);
            // Only the observer is visible: the donor's Subscribe has not
            // arrived (U-1). The donor also answers the joiner 500 ms late,
            // so the observer's empty answer always comes first. The
            // donor's query must not be cancelled for that.
            const observerHash = observerPeer.identity.publicKey.hashcode();
            const joinerHash = joinerPeer.identity.publicKey.hashcode();
            const donorIndex = (donor.program as any).entries.index;
            const processQuery = donorIndex.processQuery;
            donorIndex.processQuery = async function (
                this: unknown,
                ...args: any[]
            ) {
                if (args[1]?.hashcode?.() === joinerHash) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                return processQuery.apply(this, args);
            };
            const prototype = SharedFileSystem.prototype as any;
            const original = prototype.visibleFilesystemPeers;
            prototype.visibleFilesystemPeers = async () =>
                new Set<string>([observerHash]);
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
                prototype.visibleFilesystemPeers = original;
                donorIndex.processQuery = processQuery;
            }
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
        "asks a silent neighbour again at half the deadline",
        { timeout: 120_000 },
        async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "discovery-alone",
                replicate: { factor: 1 },
            });
            const program: any = fs.program;
            // Nobody becomes visible as a filesystem peer (a lost Subscribe),
            // so only the repeated ask can reach the later peer.
            program.visibleFilesystemPeers = async () => new Set<string>();
            const laterPeer = await createPeer();
            await laterPeer.dial(peer);

            const timeoutMs = 12_000;
            const started = Date.now();
            // Asked at once, before the later peer runs the filesystem: it
            // drops that query.
            const waiting = program.discoverManifests(
                new AbortController().signal,
                timeoutMs
            );
            await openSharedFs({
                peerbit: laterPeer,
                address: fs.address,
                machineLabel: "discovery-later",
                replicate: { factor: 1 },
            });
            expect(Date.now() - started).toBeLessThan(timeoutMs / 2);
            const found = await waiting;
            const elapsed = Date.now() - started;
            expect(found.targets).toBe(1);
            // Answered after the repeated ask, well before the deadline.
            expect(elapsed).toBeGreaterThanOrEqual(timeoutMs / 2);
            expect(elapsed).toBeLessThan(timeoutMs - 1_000);
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
            const joinerPeer = await createPeer();
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
            const pubsub = peer.services.pubsub as any;
            const logEvents = program.entries.log.events;
            const listenerCounts = () => [
                pubsub.listenerCount("subscribe"),
                pubsub.listenerCount("peer:reachable"),
                pubsub.listenerCount("stream:outbound"),
                logEvents.listenerCount("replicator:join"),
                logEvents.listenerCount("replication:change"),
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
            expect(listenerCounts()).toEqual(baseline);
        }
    );
});
