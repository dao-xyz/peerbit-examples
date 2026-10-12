import { deserialize } from "@dao-xyz/borsh";
import type { PublicSignKey } from "@peerbit/crypto";
import { Documents } from "@peerbit/document";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFileSystem,
    encodePublicSignKey,
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsHandle,
} from "../index.js";
import { IgnorePolicyEngine } from "../ignore/policy.js";
import { SnapshotManifestPayload } from "../model.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { Responder } from "../readiness/responder.js";
import { OpenV1, type ReadinessMessage } from "../readiness/wire.js";
import { holdCuts } from "./readiness-cut-hold.js";
import { holdFlips } from "./readiness-flip-hold.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The bootstrap cut (M2 PR-2, design tests 63-66, 89 and 90; M2 plan 4.2):
 * a fresh full join whose readiness predicate holds but for its phase
 * clause, while its snapshot bootstrap is still `fetching` with no overlay
 * visible, ends that bootstrap as a plain join ("readiness proved the view
 * before a snapshot was needed"), and the next evaluation decides.
 *
 * In-process Peerbit peers. `bystander` runs Peerbit but not this
 * filesystem, as the public relays `peer.bootstrap()` dials do: a pubsub
 * neighbour that never answers a manifest query. Since M2 PR-3 discovery
 * never asks it (manifest-discovery-targets.test.ts, test 69), so beside
 * it the donors' answers to the joiner's manifest queries are held until
 * the test ends (`holdManifestAnswers`): a filesystem peer whose answer is
 * still on its way, which discovery waits for. Without the cut a joiner's
 * discovery then runs to its deadline (60 s here, so a test that does not
 * cut cannot pass by waiting).
 *
 * Probes: readiness-cut-hold.ts drops (and records) the cut of a peer's
 * filesystems while held, and calls the real handler on demand; the
 * prototype wrappers below are scoped to one peer's program and restored
 * after each test.
 */

const CUT_REASON = "readiness proved the view before a snapshot was needed";
const DEADLINE_MS = 60_000;

type Fallback = Extract<BootstrapTelemetryEvent, { type: "fallback" }>;
type DiscoveryEnd = Extract<
    BootstrapTelemetryEvent,
    { type: "manifest-discovery:end" }
>;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const programOf = (fs: SharedFsHandle): any => fs.program;
const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    programOf(fs).readinessRuntime;

const fallbackOf = (events: BootstrapTelemetryEvent[]) =>
    events.find((event): event is Fallback => event.type === "fallback");
const discoveryEndOf = (events: BootstrapTelemetryEvent[]) =>
    events.find(
        (event): event is DiscoveryEnd =>
            event.type === "manifest-discovery:end"
    );
const count = (events: BootstrapTelemetryEvent[], type: string) =>
    events.filter((event) => event.type === type).length;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 120_000 : 45_000
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

/** The overlay state abandonBootstrap clears, by size. */
const overlayOf = (fs: SharedFsHandle) => {
    const program = programOf(fs);
    return {
        docs: program.overlayDocs.size,
        naming: program.overlayNaming.size,
        versions: program.overlayVersions.size,
        pending: program.overlayPending.size,
        manifest: program.bootstrapManifestMeta,
    };
};
const NO_OVERLAY = {
    docs: 0,
    naming: 0,
    versions: 0,
    pending: 0,
    manifest: undefined,
};

describe("readiness bootstrap cut (M2 PR-2)", () => {
    const peers: Peerbit[] = [];
    const restores: Array<() => void> = [];

    /** Run before the peers stop. */
    const beforeStop: Array<() => void> = [];

    afterEach(async () => {
        for (const release of beforeStop.splice(0)) release();
        await stopTestPeers(peers);
        // After the peers stopped: a parked decision then finds its open
        // ended and flips nothing.
        for (const restore of restores.splice(0).reverse()) restore();
    });

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(directory ? { directory } : {});
        peers.push(peer);
        return peer;
    };

    const holdCutsOf = (peer: Peerbit) => {
        const hold = holdCuts(peer);
        restores.push(() => hold.restore());
        return hold;
    };

    const holdFlipsOf = (peer: Peerbit) => {
        const hold = holdFlips(peer);
        restores.push(() => hold.restore());
        return hold;
    };

    /**
     * Wraps a private SharedFileSystem method for `peer`'s programs only
     * (other programs call through); restored after the test.
     */
    const wrapMethod = (
        peer: Peerbit,
        name: string,
        wrapper: (
            original: (...args: any[]) => any,
            program: any,
            args: any[]
        ) => any
    ) => {
        const prototype = SharedFileSystem.prototype as any;
        const original = prototype[name];
        prototype[name] = function (this: any, ...args: any[]) {
            if (this?.node !== peer) return original.apply(this, args);
            return wrapper((...a) => original.apply(this, a), this, args);
        };
        restores.push(() => (prototype[name] = original));
    };

    /** Every bootstrap phase `peer`'s programs set, in order. */
    const recordPhases = (peer: Peerbit) => {
        const phases: string[] = [];
        wrapMethod(peer, "setBootstrapPhase", (original, _program, args) => {
            phases.push(args[0]);
            return original(...args);
        });
        return phases;
    };

    /**
     * Queues the readiness OPENs `fs`'s responder receives until release()
     * delivers them (a donor slow to answer; within the joiner's first
     * attempt the late answer counts).
     */
    const holdOpens = (fs: SharedFsHandle) => {
        const responder = runtimeOf(fs).responder!;
        const onMessage = responder.onMessage;
        const queued: Array<[ReadinessMessage, PublicSignKey | undefined]> = [];
        let holding = true;
        responder.onMessage = (message, from) => {
            if (holding && message instanceof OpenV1) {
                queued.push([message, from]);
                return;
            }
            onMessage.call(responder, message, from);
        };
        return {
            queued: () => queued.length,
            release: () => {
                holding = false;
                for (const [message, from] of queued.splice(0)) {
                    onMessage.call(responder, message, from);
                }
            },
        };
    };

    /** A creator that wrote nothing: its genesis manifest is no snapshot. */
    const genesisDonor = async () => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "cut-genesis-donor",
        });
        return { peer, fs };
    };

    /** A donor with a populated tree and a published snapshot. */
    const populatedDonor = async (fileCount = 20) => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "cut-snapshot-donor",
        });
        await fs.writeBatch(
            Array.from({ length: fileCount }, (_, i) => ({
                path: `/tree/dir-${i % 10}/file-${i}.txt`,
                content: `content ${i}`,
            }))
        );
        const snapshot = await fs.snapshotWrite();
        expect(snapshot.segments).toBeGreaterThan(0);
        const manifest = await programOf(fs).getDocument(
            `bootstrap:${encodePublicSignKey(peer.identity.publicKey)}`
        );
        const segments = new Set<string>(
            deserialize(
                manifest.payloadBytes,
                SnapshotManifestPayload
            ).segments.map((segment) => segment.cid)
        );
        return { peer, fs, segments, fileCount };
    };

    /**
     * The filesystems of `donors` answer `joiner`'s snapshot-manifest
     * queries only once the test ends (before the peers stop): a donor
     * whose answer is still on its way. Other queries pass. The wrapper
     * sits on the document index class, for those peers only.
     */
    const holdManifestAnswers = (donors: Peerbit[], joiner: Peerbit) => {
        const prototype = Object.getPrototypeOf(new Documents().index);
        const processQuery = prototype.processQuery;
        const joinerHash = joiner.identity.publicKey.hashcode();
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        prototype.processQuery = async function (this: any, ...args: any[]) {
            if (
                donors.includes(this?.node) &&
                args[1]?.hashcode?.() === joinerHash &&
                (args[0]?.query ?? []).some(
                    (match: any) => match?.value === "bootstrap-manifest"
                )
            ) {
                await released;
            }
            return processQuery.apply(this, args);
        };
        beforeStop.push(release);
        restores.push(() => (prototype.processQuery = processQuery));
    };

    /**
     * A joiner's peer dialed to every one of `to` and, unless `bystander`
     * is false, to a bystander, with `to`'s manifest answers held (see the
     * file comment).
     */
    const joinerPeerBeside = async (
        to: Peerbit[],
        options: { directory?: string; bystander?: boolean } = {}
    ) => {
        const peer = await createPeer(options.directory);
        if (options.bystander !== false) {
            const bystander = await createPeer();
            await peer.dial(bystander);
            expect(
                (peer.services.pubsub as any).peers.has(
                    bystander.identity.publicKey.hashcode()
                )
            ).toBe(true);
            holdManifestAnswers(to, peer);
        }
        for (const other of to) await peer.dial(other);
        return peer;
    };

    const openJoiner = async (
        peer: Peerbit,
        address: string,
        label: string,
        events: BootstrapTelemetryEvent[],
        options: object = {}
    ): Promise<SharedFsHandle> =>
        openSharedFs({
            peerbit: peer,
            address,
            machineLabel: label,
            bootstrap: { discoveryTimeoutMs: DEADLINE_MS },
            telemetry: { bootstrap: (event) => events.push(event) },
            ...options,
        } as any);

    it(
        "63: both bootstrap(): a genesis donor whose manifest answer is on its way, beside a peer that does not run the filesystem; ready on the proof, not the deadline",
        { timeout: 120_000 },
        async () => {
            const donor = await genesisDonor();
            const joinerPeer = await joinerPeerBeside([donor.peer]);
            const phases = recordPhases(joinerPeer);
            const events: BootstrapTelemetryEvent[] = [];
            const started = Date.now();
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-joiner",
                events
            );
            await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
            const readyMs = Date.now() - started;
            expect(readyMs).toBeLessThan(DEADLINE_MS / 2);

            // The cut ended discovery (nothing it found was examined), or
            // came before discovery started (the donor was contained while
            // the crash marker was written): either way no deadline.
            const end = discoveryEndOf(events);
            expect(count(events, "manifest-discovery:end")).toBe(
                count(events, "manifest-discovery:start")
            );
            if (end) {
                expect(end).toMatchObject({
                    aborted: "readiness",
                    candidates: 0,
                    trusted: 0,
                    zeroDocument: 0,
                });
                expect(end.durationMs).toBeLessThan(DEADLINE_MS / 2);
            }
            expect(fallbackOf(events)).toMatchObject({
                posture: "plain-join",
                reason: CUT_REASON,
            });
            const order = events.map((event) => event.type);
            expect(order.indexOf("fallback")).toBeLessThan(
                order.indexOf("write-ready")
            );
            expect(phases).toEqual(["fetching", "off"]);
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReady: true,
                writeReadinessSource: "reconciled",
                snapshotCoverageVerified: false,
                lastFailure: CUT_REASON,
                guardArmed: true,
            });
            expect(await joiner.awaitBootstrapConverged()).toEqual({
                verified: false,
            });
            expect(
                joiner.bootstrapStatus().readiness?.contained
            ).toContainEqual(
                expect.objectContaining({
                    peer: donor.peer.identity.publicKey.hashcode(),
                    qualified: true,
                    source: "creator",
                })
            );
            expect(programOf(joiner).bootstrapCut).toBe(true);
            expect(
                programOf(joiner).discoveryAbortController.signal.aborted
            ).toBe(true);
            await joiner.writeFile("/after-cut.txt", "written");
            await waitUntil(async () =>
                expect(decode(await donor.fs.readFile("/after-cut.txt"))).toBe(
                    "written"
                )
            );
        }
    );

    it(
        "64: complete while a segment fetch waits cuts (generation-guarded) and no overlay becomes visible",
        { timeout: 120_000 },
        async () => {
            const donor = await populatedDonor();
            const joinerPeer = await joinerPeerBeside([donor.peer], {
                bystander: false,
            });
            const cuts = holdCutsOf(joinerPeer);
            const phases = recordPhases(joinerPeer);
            // The joiner's fetch of the snapshot's segments waits for the
            // gate; the log's own block fetches do not.
            let openGate!: () => void;
            const gate = new Promise<void>((resolve) => (openGate = resolve));
            const fetched: string[] = [];
            const blocks = joinerPeer.services.blocks as any;
            const get = blocks.get;
            blocks.get = async function (
                this: unknown,
                cid: string,
                ...rest: any[]
            ) {
                if (donor.segments.has(cid)) {
                    fetched.push(cid);
                    await gate;
                }
                return get.call(this, cid, ...rest);
            };
            restores.push(() => (blocks.get = get));
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-segments",
                events
            );
            const program = programOf(joiner);
            // The predicate holds but for its phase while a segment fetch
            // waits: the (held) cut was asked for in "fetching".
            await waitUntil(() => {
                expect(fetched.length).toBeGreaterThan(0);
                expect(
                    cuts.calls().some(({ phase }) => phase === "fetching")
                ).toBe(true);
            });
            expect(count(events, "segments-fetch:start")).toBe(1);
            expect(program.bootstrapCut).toBe(false);

            // An older open generation's call cuts nothing.
            cuts.cut(program, program.openGeneration - 1);
            expect(program.bootstrapCut).toBe(false);
            expect(program.discoveryAbortController.signal.aborted).toBe(false);
            // This generation's cuts; a repeat is a no-op.
            cuts.cut(program, program.openGeneration);
            cuts.cut(program, program.openGeneration);
            expect(program.bootstrapCut).toBe(true);
            expect(program.discoveryAbortController.signal.aborted).toBe(true);
            openGate();
            await program.bootstrapDecision;

            expect(phases).toEqual(["fetching", "off"]);
            expect(count(events, "segments-fetch:end")).toBe(0);
            expect(count(events, "overlay-ready")).toBe(0);
            expect(fallbackOf(events)).toMatchObject({
                posture: "plain-join",
                reason: CUT_REASON,
            });
            expect(overlayOf(joiner)).toEqual(NO_OVERLAY);
            expect(await joiner.awaitBootstrapConverged()).toEqual({
                verified: false,
            });
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReadinessSource: "reconciled",
                lastFailure: CUT_REASON,
            });
            expect(joiner.bootstrapStatus().manifest).toBeUndefined();
            // The view is the log's.
            expect(
                decode(await joiner.readFile("/tree/dir-0/file-0.txt"))
            ).toBe("content 0");
        }
    );

    it(
        "64: complete once the overlay is installed does not cut; retirement keeps its own tracking",
        { timeout: 120_000 },
        async () => {
            const donor = await populatedDonor();
            // The donor answers the joiner's OPEN only once the overlay is
            // visible, so the predicate cannot hold while it is fetching.
            const opens = holdOpens(donor.fs);
            const joinerPeer = await joinerPeerBeside([donor.peer], {
                bystander: false,
            });
            const cuts = holdCutsOf(joinerPeer);
            cuts.release();
            const phases: string[] = [];
            let cutAtInstall: boolean | undefined;
            wrapMethod(
                joinerPeer,
                "setBootstrapPhase",
                (original, program, args) => {
                    phases.push(args[0]);
                    const result = original(...args);
                    if (args[0] === "overlay-active") {
                        // Right after installed = true became visible: a
                        // complete evaluation now must not cut.
                        cuts.cut(program, program.openGeneration);
                        cutAtInstall = program.bootstrapCut;
                        opens.release();
                    }
                    return result;
                }
            );
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-installed",
                events
            );
            expect((await joiner.awaitBootstrapConverged()).verified).toBe(
                true
            );
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(cutAtInstall).toBe(false);
            expect(programOf(joiner).bootstrapCut).toBe(false);
            expect(phases.slice(0, 2)).toEqual(["fetching", "overlay-active"]);
            expect(phases).not.toContain("off");
            // Every complete evaluation came after the install.
            expect(
                cuts.calls().every(({ phase }) => phase !== "fetching")
            ).toBe(true);
            expect(fallbackOf(events)).toBeUndefined();
            expect(discoveryEndOf(events)?.aborted).toBeUndefined();
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "converged",
                snapshotCoverageVerified: true,
                writeReadinessSource: "reconciled",
            });
        }
    );

    it(
        "65: a resumed store is cut to a plain join, not the unverified posture; its marker stays until the proof's commit, and a crash between reopens gated",
        { timeout: 180_000 },
        async () => {
            const root = await mkdtemp(join(tmpdir(), "shared-fs-cut-resume-"));
            restores.push(
                () => void rm(root, { recursive: true, force: true })
            );
            const directory = join(root, "joiner");
            const donor = await genesisDonor();
            await donor.fs.writeFile("/first.txt", "first");
            const address = donor.fs.address;
            const sidecar = async () =>
                JSON.parse(
                    await readFile(
                        join(
                            directory,
                            "shared-fs-bootstrap",
                            `${address}.json`
                        ),
                        "utf8"
                    )
                );

            // An earlier session stored the donor's content and stopped
            // while its bootstrap was still discovering: its "active"
            // marker stays over that content.
            let joinerPeer = await joinerPeerBeside([donor.peer], {
                directory,
            });
            holdCutsOf(joinerPeer);
            holdFlipsOf(joinerPeer);
            const first = await openJoiner(
                joinerPeer,
                address,
                "cut-first",
                []
            );
            await waitUntil(async () =>
                expect(decode(await first.readFile("/first.txt"))).toBe("first")
            );
            expect(first.bootstrapStatus().phase).toBe("fetching");
            await joinerPeer.stop();
            expect(await sidecar()).toMatchObject({
                writeReady: false,
                bootstrap: "active",
            });

            // Resumed: the cut ends its bootstrap as a plain join, with the
            // decision held so the marker can be read before the commit.
            joinerPeer = await joinerPeerBeside([donor.peer], { directory });
            const flips = holdFlipsOf(joinerPeer);
            const phases = recordPhases(joinerPeer);
            const events: BootstrapTelemetryEvent[] = [];
            const resumed = await openJoiner(
                joinerPeer,
                address,
                "cut-resumed",
                events
            );
            await waitUntil(() => {
                expect(fallbackOf(events)).toMatchObject({
                    posture: "plain-join",
                    reason: CUT_REASON,
                });
                expect(flips.parked()).toBeGreaterThan(0);
            });
            expect(phases).toEqual(["fetching", "off"]);
            const program = programOf(resumed);
            expect(program.quiescenceTimer).toBeUndefined();
            expect(resumed.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReady: false,
                guardArmed: false,
                lastFailure: CUT_REASON,
            });
            expect(await resumed.awaitBootstrapConverged()).toEqual({
                verified: false,
            });
            await program.stateWriteChain;
            expect(await sidecar()).toMatchObject({
                writeReady: false,
                bootstrap: "active",
            });

            // A crash before the commit: the next open is gated at once and
            // resumes; this time the proof's sidecar write clears the marker.
            await joinerPeer.stop();
            expect(await sidecar()).toMatchObject({
                writeReady: false,
                bootstrap: "active",
            });
            joinerPeer = await joinerPeerBeside([donor.peer], { directory });
            const againEvents: BootstrapTelemetryEvent[] = [];
            const again = await openJoiner(
                joinerPeer,
                address,
                "cut-again",
                againEvents
            );
            expect(again.bootstrapStatus().writeReady).toBe(false);
            await again.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
            expect(fallbackOf(againEvents)?.reason).toBe(CUT_REASON);
            expect(again.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReadinessSource: "reconciled",
                guardArmed: true,
            });
            await programOf(again).stateWriteChain;
            const state = await sidecar();
            expect(state).toMatchObject({
                writeReady: true,
                writeReadySource: "reconciled",
            });
            expect(state).not.toHaveProperty("bootstrap");
        }
    );

    it(
        "66: an access-controlled store whose only candidate is from an untrusted signer: the cut ends the trust-race wait",
        { timeout: 180_000 },
        async () => {
            // O owns the store; R, a trusted full replica, publishes the
            // only real snapshot and goes offline.
            const ownerPeer = await createPeer();
            const owner = await openSharedFs({
                peerbit: ownerPeer,
                machineLabel: "cut-acl-owner",
                rootKey: ownerPeer.identity.publicKey,
                gc: false,
            });
            await owner.writeBatch(
                Array.from({ length: 20 }, (_, i) => ({
                    path: `/acl/file-${i}.txt`,
                    content: `acl ${i}`,
                }))
            );
            const publisherPeer = await createPeer();
            await publisherPeer.dial(ownerPeer);
            const publisher = await openSharedFs({
                peerbit: publisherPeer,
                address: owner.address,
                machineLabel: "cut-acl-publisher",
                bootstrap: false,
                gc: false,
            });
            await owner.authorizeWriter(publisherPeer.identity.publicKey);
            await publisher.awaitWriteReady({ timeout: 60_000 });
            const publisherKey = publisherPeer.identity.publicKey;
            await waitUntil(async () =>
                expect(await publisher.isTrustedWriter(publisherKey)).toBe(true)
            );
            expect((await publisher.snapshotWrite()).segments).toBeGreaterThan(
                0
            );
            const manifestId = `bootstrap:${encodePublicSignKey(publisherKey)}`;
            await waitUntil(async () =>
                expect(
                    await programOf(owner).getDocument(manifestId)
                ).toBeDefined()
            );
            await publisherPeer.stop();

            // J's trust graph has not learned R yet (the trust race): R's
            // key reads untrusted on J only.
            const joinerPeer = await createPeer();
            const isTrusted = TrustedNetwork.prototype.isTrusted;
            let afterDiscovery = 0;
            let discovered = false;
            TrustedNetwork.prototype.isTrusted = function (
                this: any,
                trustee: PublicSignKey,
                ...rest: any[]
            ) {
                if (this.node === joinerPeer && trustee.equals(publisherKey)) {
                    // The trust-race loop's checks (not the write path's).
                    if (
                        discovered &&
                        new Error().stack?.includes("fetchAndInstallOverlay")
                    ) {
                        afterDiscovery++;
                    }
                    return Promise.resolve(false);
                }
                return (isTrusted as any).call(this, trustee, ...rest);
            };
            restores.push(
                () => (TrustedNetwork.prototype.isTrusted = isTrusted)
            );
            wrapMethod(
                joinerPeer,
                "discoverManifests",
                async (original, _program, args) => {
                    const found = await original(...args);
                    discovered = true;
                    return found;
                }
            );
            const cuts = holdCutsOf(joinerPeer);
            await joinerPeer.dial(ownerPeer);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                owner.address,
                "cut-acl-joiner",
                events,
                { gc: false }
            );
            const program = programOf(joiner);
            // In the wait: discovery ended, and the trust-race loop found
            // the candidate untrusted (since M2 PR-3 it then waits for a
            // trust-graph change, the deadline or the cut; no 250 ms
            // rounds). Readiness holds but for the phase (the held cut was
            // asked for).
            await waitUntil(() => {
                expect(afterDiscovery).toBeGreaterThanOrEqual(1);
                expect(
                    cuts.calls().some(({ phase }) => phase === "fetching")
                ).toBe(true);
            });
            expect(discoveryEndOf(events)).toBeUndefined();
            expect(program.bootstrapPhase).toBe("fetching");
            cuts.release();
            const cutAt = Date.now();
            runtimeOf(joiner).evaluate();
            await program.bootstrapDecision;
            expect(Date.now() - cutAt).toBeLessThan(DEADLINE_MS / 4);
            expect(discoveryEndOf(events)).toMatchObject({
                aborted: "readiness",
                candidates: 1,
                usable: 1,
                trusted: 0,
            });
            expect(fallbackOf(events)).toMatchObject({
                posture: "plain-join",
                reason: CUT_REASON,
            });
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReadinessSource: "reconciled",
                lastFailure: CUT_REASON,
            });
            expect(decode(await joiner.readFile("/acl/file-0.txt"))).toBe(
                "acl 0"
            );
        }
    );

    it(
        "89: a peer that turns Required between the cut and the commit is waited for and contained; discovery stays ended",
        { timeout: 180_000 },
        async () => {
            const donor = await genesisDonor();
            await donor.fs.writeFile("/donor.txt", "donor");
            const joinerPeer = await joinerPeerBeside([donor.peer]);
            const flips = holdFlipsOf(joinerPeer);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-k4",
                events
            );
            // Cut, and the decision that followed is parked.
            await waitUntil(() => {
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                expect(flips.parked()).toBeGreaterThan(0);
            });
            expect(joiner.bootstrapStatus().phase).toBe("off");

            // C opens the filesystem beside J before the commit: it turns
            // Required. Every responder but J's and the donor's (that is,
            // C's) queues the OPENs it receives until released.
            const known = new Set([
                runtimeOf(donor.fs).responder,
                runtimeOf(joiner).responder,
            ]);
            const queued: Array<[Responder, ReadinessMessage, any]> = [];
            let holding = true;
            const onMessage = Responder.prototype.onMessage;
            Responder.prototype.onMessage = function (
                this: Responder,
                message,
                from
            ) {
                if (holding && !known.has(this) && message instanceof OpenV1) {
                    queued.push([this, message, from]);
                    return;
                }
                return onMessage.call(this, message, from);
            };
            restores.push(() => (Responder.prototype.onMessage = onMessage));
            const latePeer = await createPeer();
            await latePeer.dial(joinerPeer);
            await openSharedFs({
                peerbit: latePeer,
                address: donor.fs.address,
                machineLabel: "cut-late",
                bootstrap: false,
            });
            const lateHash = latePeer.identity.publicKey.hashcode();
            await waitUntil(() => {
                expect(queued.length).toBeGreaterThan(0);
                expect(
                    runtimeOf(joiner).coordinator?.record(lateHash)?.state
                ).toBe("asking");
            });
            // The parked decision reads the predicate again: no flip.
            flips.release();
            await expect(
                joiner.awaitWriteReady({ timeout: 1_000 })
            ).rejects.toMatchObject({ code: "ETIMEDOUT" });
            expect(joiner.bootstrapStatus().writeReady).toBe(false);
            expect(joiner.bootstrapStatus().readiness?.required).toContain(
                lateHash
            );

            // C answers: contained, then ready.
            holding = false;
            for (const [responder, message, from] of queued.splice(0)) {
                onMessage.call(responder, message, from);
            }
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(
                joiner.bootstrapStatus().readiness?.contained
            ).toContainEqual(expect.objectContaining({ peer: lateHash }));
            // At most one discovery (none when the cut came before it
            // started), ended by the cut; never a second one.
            expect(
                count(events, "manifest-discovery:start")
            ).toBeLessThanOrEqual(1);
            expect(count(events, "manifest-discovery:end")).toBe(
                count(events, "manifest-discovery:start")
            );
            expect(discoveryEndOf(events)?.aborted ?? "readiness").toBe(
                "readiness"
            );
            expect(count(events, "fallback")).toBe(1);
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReadinessSource: "reconciled",
            });
        }
    );

    it(
        "90: a cut during the install loop stops it: nothing is made visible",
        { timeout: 120_000 },
        async () => {
            const donor = await populatedDonor();
            const joinerPeer = await joinerPeerBeside([donor.peer], {
                bystander: false,
            });
            const cuts = holdCutsOf(joinerPeer);
            const phases = recordPhases(joinerPeer);
            let installs = 0;
            wrapMethod(
                joinerPeer,
                "installOverlayDoc",
                (original, program, args) => {
                    const result = original(...args);
                    if (++installs === 1) {
                        cuts.cut(program, program.openGeneration);
                    }
                    return result;
                }
            );
            const returned: boolean[] = [];
            wrapMethod(
                joinerPeer,
                "fetchAndInstallOverlay",
                async (original, _program, args) => {
                    const installed = await original(...args);
                    returned.push(installed);
                    return installed;
                }
            );
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-install",
                events
            );
            await programOf(joiner).bootstrapDecision;
            expect(installs).toBeGreaterThan(0);
            expect(returned).toEqual([false]);
            expect(programOf(joiner).bootstrapCut).toBe(true);
            expect(phases).toEqual(["fetching", "off"]);
            expect(count(events, "overlay-ready")).toBe(0);
            expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
            expect(overlayOf(joiner)).toEqual(NO_OVERLAY);
            expect(await joiner.awaitBootstrapConverged()).toEqual({
                verified: false,
            });
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(joiner.bootstrapStatus().writeReadinessSource).toBe(
                "reconciled"
            );
        }
    );

    it(
        "90: a cut in the microtask gap after the install returned true: the phase never becomes overlay-active",
        { timeout: 120_000 },
        async () => {
            const donor = await populatedDonor();
            const joinerPeer = await joinerPeerBeside([donor.peer], {
                bystander: false,
            });
            const cuts = holdCutsOf(joinerPeer);
            const phases = recordPhases(joinerPeer);
            const returned: boolean[] = [];
            let overlayAtCut: ReturnType<typeof overlayOf> | undefined;
            let bootstrapReady = 0;
            wrapMethod(
                joinerPeer,
                "fetchAndInstallOverlay",
                async (original, program, args) => {
                    program.events.addEventListener(
                        "bootstrap:ready",
                        () => bootstrapReady++
                    );
                    const installed = await original(...args);
                    returned.push(installed);
                    // After `return true`, before startBootstrap reads it.
                    overlayAtCut = {
                        docs: program.overlayDocs.size,
                        naming: program.overlayNaming.size,
                        versions: program.overlayVersions.size,
                        pending: program.overlayPending.size,
                        manifest: program.bootstrapManifestMeta,
                    };
                    cuts.cut(program, program.openGeneration);
                    return installed;
                }
            );
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                "cut-gap",
                events
            );
            await programOf(joiner).bootstrapDecision;
            expect(returned).toEqual([true]);
            // The overlay was installed (invisible: still "fetching") ...
            expect(overlayAtCut!.docs).toBeGreaterThan(0);
            expect(overlayAtCut!.manifest).toBeDefined();
            // ... and is gone; it never became visible.
            expect(phases).toEqual(["fetching", "off"]);
            expect(bootstrapReady).toBe(0);
            expect(count(events, "overlay-ready")).toBe(0);
            expect(overlayOf(joiner)).toEqual(NO_OVERLAY);
            expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
            expect(await joiner.awaitBootstrapConverged()).toEqual({
                verified: false,
            });
            await joiner.awaitWriteReady({ timeout: 30_000 });
            expect(joiner.bootstrapStatus()).toMatchObject({
                phase: "off",
                writeReadinessSource: "reconciled",
            });
            expect(joiner.bootstrapStatus().manifest).toBeUndefined();
        }
    );

    it(
        "K5: an advisory-only fleet's joiner cut before discovery still takes the advisory ignore patterns of the manifest it holds",
        { timeout: 120_000 },
        async () => {
            // No /.artifactignore: the fleet's ignore policy reaches a
            // joiner only through its snapshot manifest.
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "cut-advisory-donor",
                ignore: { patterns: ["dist/"] },
            } as any);
            await donor.writeBatch(
                Array.from({ length: 120 }, (_, i) => ({
                    path: `/tree/d-${i % 10}/f-${i}.txt`,
                    content: `c${i}`,
                }))
            );
            await donor.snapshotWrite();
            const joinerPeer = await joinerPeerBeside([donorPeer]);
            // The order a cross-process join takes: the donor is contained
            // before discovery starts, so the cut ends the bootstrap before
            // any manifest is accepted.
            let cutDone!: () => void;
            const cut = new Promise<void>((resolve) => (cutDone = resolve));
            wrapMethod(
                joinerPeer,
                "onReadinessComplete",
                (original, program, args) => {
                    const result = original(...args);
                    if (program.bootstrapCut) cutDone();
                    return result;
                }
            );
            wrapMethod(
                joinerPeer,
                "fetchAndInstallOverlay",
                async (original, _program, args) => {
                    await cut;
                    return original(...args);
                }
            );
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.address,
                "cut-advisory",
                events,
                { ignore: {} }
            );
            await programOf(joiner).bootstrapDecision;
            expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
            expect(count(events, "manifest-discovery:start")).toBe(0);
            expect(programOf(joiner).bootstrapAdvisoryIgnorePatterns).toEqual([
                "dist/",
            ]);
            await joiner.awaitWriteReady({ timeout: 30_000 });
            await joiner.awaitBootstrapConverged();
            await waitUntil(() =>
                expect((joiner as any).ignoreStatus()).toMatchObject({
                    provenance: "manifest-advisory",
                    patterns: ["dist/"],
                })
            );
            await expect(joiner.writeFile("/dist/x.js", "1")).rejects.toThrow(
                /artifact-ignored/
            );
            // Its own snapshots pass the policy on.
            expect(programOf(joiner).advisoryIgnorePublish).toEqual(["dist/"]);
            // The policy settled on them: the advisory watch detached.
            await waitUntil(() =>
                expect(programOf(joiner).advisoryIgnoreWatch).toBeUndefined()
            );
        }
    );

    describe("K5: advisory ignore patterns after a cut", () => {
        /**
         * A creator whose ignore policy publishes ["dist/"] in its
         * manifests: no /.artifactignore unless `rulesFile`, and no
         * snapshot yet (its genesis manifest is no candidate), so a
         * joiner's cut holds no usable manifest.
         */
        const advisoryDonor = async (
            label: string,
            options: { rulesFile?: string } = {}
        ) => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: label,
                ignore: { patterns: ["dist/"] },
            } as any);
            if (options.rulesFile !== undefined) {
                await fs.writeFile("/.artifactignore", options.rulesFile);
            }
            await fs.writeBatch(
                Array.from({ length: 10 }, (_, i) => ({
                    path: `/tree/f-${i}.txt`,
                    content: `c${i}`,
                }))
            );
            return { peer, fs };
        };

        /** `fs` holds `author`'s manifest, and it names a snapshot. */
        const holdsSnapshotManifest = (fs: SharedFsHandle, author: Peerbit) =>
            waitUntil(async () => {
                const manifest = await programOf(fs).getDocument(
                    `bootstrap:${encodePublicSignKey(author.identity.publicKey)}`
                );
                expect(manifest).toBeDefined();
                expect(
                    deserialize(manifest.payloadBytes, SnapshotManifestPayload)
                        .segments.length
                ).toBeGreaterThan(0);
            });

        /** Counts `type` events dispatched on `fs`'s program. */
        const countProgramEvents = (fs: SharedFsHandle, type: string) => {
            const counter = { count: 0 };
            const events = programOf(fs).events;
            const listener = () => counter.count++;
            events.addEventListener(type, listener);
            restores.push(() => events.removeEventListener(type, listener));
            return counter;
        };

        /** A joiner of `donor` cut before it held a usable manifest. */
        const cutJoiner = async (
            donor: { peer: Peerbit; fs: SharedFsHandle },
            label: string,
            options: object = { ignore: {} }
        ) => {
            const joinerPeer = await joinerPeerBeside([donor.peer]);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openJoiner(
                joinerPeer,
                donor.fs.address,
                label,
                events,
                options
            );
            await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
            expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
            return { joinerPeer, joiner, events };
        };

        it(
            "a manifest arriving after the cut: its patterns are adopted, and already-written files stay in the store but turn ignored",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-late-donor");
                const { joiner } = await cutJoiner(donor, "k5-late");
                const program = programOf(joiner);
                const policy = (joiner as any).ignorePolicy;
                const advisories = countProgramEvents(
                    joiner,
                    "ignore:advisory-available"
                );
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect(program.advisoryIgnoreWatch).toBeDefined();
                expect(program.advisoryIgnorePending).toBe(true);
                // The store is settled (phase "off") and holds no rules
                // file, yet the policy does not conclude absent.
                await policy.refresh();
                expect(policy.fileRead).toBe(false);
                expect(program.ignorePolicySettled).toBe(false);
                expect((joiner as any).ignoreStatus()).toMatchObject({
                    provenance: "none",
                    patterns: [],
                });
                // Written before the manifest arrives.
                await joiner.mkdir("/dist");
                await joiner.writeFile("/dist/early.js", "early");

                await donor.fs.snapshotWrite();
                await waitUntil(() => {
                    expect(program.bootstrapAdvisoryIgnorePatterns).toEqual([
                        "dist/",
                    ]);
                    expect((joiner as any).ignoreStatus()).toMatchObject({
                        provenance: "manifest-advisory",
                        patterns: ["dist/"],
                    });
                });
                expect(advisories.count).toBe(1);
                // The policy then settles on the advisory rules, and the
                // watch detaches.
                await waitUntil(() => {
                    expect(policy.fileRead).toBe(true);
                    expect(program.ignorePolicySettled).toBe(true);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
                expect(program.advisoryIgnorePending).toBe(false);
                await expect(
                    joiner.writeFile("/dist/late.js", "late")
                ).rejects.toThrow(/artifact-ignored/);
                // The earlier write is shared data, untouched: hidden by
                // default, marked on stat, readable on both peers.
                expect(
                    (await joiner.list("/")).map((entry) => entry.path)
                ).not.toContain("/dist");
                expect(
                    (
                        await (joiner as any).list("/", {
                            includeIgnored: true,
                        })
                    ).map((entry: any) => entry.path)
                ).toContain("/dist");
                expect(await joiner.stat("/dist/early.js")).toMatchObject({
                    ignoredLeak: true,
                });
                expect(decode(await joiner.readFile("/dist/early.js"))).toBe(
                    "early"
                );
                await waitUntil(async () =>
                    expect(
                        decode(await donor.fs.readFile("/dist/early.js"))
                    ).toBe("early")
                );
            }
        );

        it(
            "a manifest without advisory patterns arriving after the cut: the policy concludes the rules file absent",
            { timeout: 180_000 },
            async () => {
                // A fleet with no ignore policy: its manifests carry none.
                const donorPeer = await createPeer();
                const donorFs = await openSharedFs({
                    peerbit: donorPeer,
                    machineLabel: "k5-none-donor",
                });
                await donorFs.writeFile("/f.txt", "f");
                const { joiner } = await cutJoiner(
                    { peer: donorPeer, fs: donorFs },
                    "k5-none"
                );
                const program = programOf(joiner);
                const policy = (joiner as any).ignorePolicy;
                const resolved = countProgramEvents(
                    joiner,
                    "ignore:advisory-resolved"
                );
                await policy.refresh();
                expect(policy.fileRead).toBe(false);
                expect(program.advisoryIgnorePending).toBe(true);

                await donorFs.snapshotWrite();
                await waitUntil(() => {
                    expect(resolved.count).toBe(1);
                    expect(policy.fileRead).toBe(true);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect((joiner as any).ignoreStatus()).toMatchObject({
                    provenance: "none",
                    patterns: [],
                });
            }
        );

        it(
            "a held manifest whose signer is trusted only after the cut: adopted on the trust change",
            { timeout: 240_000 },
            async () => {
                // O owns the store; R, trusted, publishes the only snapshot
                // (advisory ["dist/"]) and goes offline.
                const ownerPeer = await createPeer();
                const owner = await openSharedFs({
                    peerbit: ownerPeer,
                    machineLabel: "k5-trust-owner",
                    rootKey: ownerPeer.identity.publicKey,
                    gc: false,
                });
                await owner.writeBatch(
                    Array.from({ length: 10 }, (_, i) => ({
                        path: `/acl/file-${i}.txt`,
                        content: `acl ${i}`,
                    }))
                );
                const publisherPeer = await createPeer();
                await publisherPeer.dial(ownerPeer);
                const publisher = await openSharedFs({
                    peerbit: publisherPeer,
                    address: owner.address,
                    machineLabel: "k5-trust-publisher",
                    bootstrap: false,
                    gc: false,
                    ignore: { patterns: ["dist/"] },
                } as any);
                const publisherKey = publisherPeer.identity.publicKey;
                await owner.authorizeWriter(publisherKey);
                await publisher.awaitWriteReady({ timeout: 60_000 });
                await waitUntil(async () =>
                    expect(await publisher.isTrustedWriter(publisherKey)).toBe(
                        true
                    )
                );
                await publisher.snapshotWrite();
                await holdsSnapshotManifest(owner, publisherPeer);
                await publisherPeer.stop();

                // J holds R's manifest (admitted while R was trusted), and
                // R is revoked before J's cut bootstrap looks at it.
                const joinerPeer = await createPeer();
                let cutDone!: () => void;
                const cut = new Promise<void>((resolve) => (cutDone = resolve));
                wrapMethod(
                    joinerPeer,
                    "onReadinessComplete",
                    (original, program, args) => {
                        const result = original(...args);
                        if (program.bootstrapCut) cutDone();
                        return result;
                    }
                );
                let revoked!: () => void;
                const revocation = new Promise<void>(
                    (resolve) => (revoked = resolve)
                );
                wrapMethod(
                    joinerPeer,
                    "fetchAndInstallOverlay",
                    async (original, _program, args) => {
                        await cut;
                        await revocation;
                        return original(...args);
                    }
                );
                await joinerPeer.dial(ownerPeer);
                const events: BootstrapTelemetryEvent[] = [];
                const joiner = await openJoiner(
                    joinerPeer,
                    owner.address,
                    "k5-trust-joiner",
                    events,
                    { gc: false, ignore: {} }
                );
                const program = programOf(joiner);
                await cut;
                await holdsSnapshotManifest(joiner, publisherPeer);
                await owner.revokeWriter(publisherKey);
                await waitUntil(async () =>
                    expect(await joiner.isTrustedWriter(publisherKey)).toBe(
                        false
                    )
                );
                revoked();
                await program.bootstrapDecision;
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                await joiner.awaitWriteReady({ timeout: 30_000 });
                // Held, untrusted: nothing taken; the policy waits.
                await program.advisoryIgnoreWatch?.running;
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect(program.advisoryIgnorePending).toBe(true);
                expect((joiner as any).ignoreStatus().provenance).toBe("none");

                // R is trusted again: J's trust graph changes, and the
                // watch takes the held manifest on that change.
                await owner.authorizeWriter(publisherKey);
                await waitUntil(() => {
                    expect(program.bootstrapAdvisoryIgnorePatterns).toEqual([
                        "dist/",
                    ]);
                    expect((joiner as any).ignoreStatus()).toMatchObject({
                        provenance: "manifest-advisory",
                        patterns: ["dist/"],
                    });
                });
                await expect(
                    joiner.writeFile("/dist/x.js", "1")
                ).rejects.toThrow(/artifact-ignored/);
                await waitUntil(() =>
                    expect(program.advisoryIgnoreWatch).toBeUndefined()
                );
            }
        );

        it(
            "a rules file present: the policy takes it, the watch detaches, and a later manifest's patterns are never adopted",
            { timeout: 180_000 },
            async () => {
                // The donor's effective set, which its manifests carry, is
                // open-args ["dist/"] plus the file's ["build/"].
                const donor = await advisoryDonor("k5-file-donor", {
                    rulesFile: "build/\n",
                });
                const { joiner } = await cutJoiner(donor, "k5-file");
                const program = programOf(joiner);
                await waitUntil(() => {
                    expect((joiner as any).ignoreStatus()).toMatchObject({
                        provenance: "rules-file",
                        patterns: ["build/"],
                    });
                    expect(program.ignorePolicySettled).toBe(true);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
                const advisories = countProgramEvents(
                    joiner,
                    "ignore:advisory-available"
                );
                await donor.fs.snapshotWrite();
                expect(
                    deserialize(
                        (
                            await programOf(donor.fs).getDocument(
                                `bootstrap:${encodePublicSignKey(donor.peer.identity.publicKey)}`
                            )
                        ).payloadBytes,
                        SnapshotManifestPayload
                    ).advisoryIgnorePatterns
                ).toEqual(["build/", "dist/"]);
                await holdsSnapshotManifest(joiner, donor.peer);
                expect(advisories.count).toBe(0);
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect((joiner as any).ignoreStatus()).toMatchObject({
                    provenance: "rules-file",
                    patterns: ["build/"],
                });
                await joiner.mkdir("/dist");
                await joiner.writeFile("/dist/ok.js", "1");
                await expect(
                    joiner.writeFile("/build/x.js", "1")
                ).rejects.toThrow(/artifact-ignored/);
            }
        );

        it(
            "close and reopen detach the watch; an evaluation in flight never adopts into the reopened generation",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-reopen-donor");
                const { joinerPeer, joiner } = await cutJoiner(
                    donor,
                    "k5-reopen"
                );
                const program = programOf(joiner);
                const watch = program.advisoryIgnoreWatch;
                expect(watch).toBeDefined();
                expect(watch.generation).toBe(program.openGeneration);
                // The evaluation the manifest's arrival starts is held
                // after its scan, with the manifest chosen.
                let gated = false;
                let scans = 0;
                let openGate!: () => void;
                const gate = new Promise<void>(
                    (resolve) => (openGate = resolve)
                );
                wrapMethod(
                    joinerPeer,
                    "newestHeldManifestCandidate",
                    async (original) => {
                        const chosen = await original();
                        if (gated && chosen) {
                            scans++;
                            await gate;
                        }
                        return chosen;
                    }
                );
                gated = true;
                await donor.fs.snapshotWrite();
                await waitUntil(() => expect(scans).toBe(1));
                expect(watch.running).toBeDefined();

                await program.close();
                expect(watch.detached).toBe(true);
                expect(program.advisoryIgnoreWatch).toBeUndefined();
                expect(program.advisoryIgnorePending).toBe(false);
                const reopened = await joinerPeer.open(program, {
                    existing: "reuse",
                    args: {
                        machineLabel: "k5-reopened",
                        allowPartialWrites: true,
                        addressOpen: true,
                        bootstrap: false,
                        gc: false,
                    },
                } as any);
                expect(reopened).toBe(program);
                expect(program.openGeneration).toBeGreaterThan(
                    watch.generation
                );
                const advisories = countProgramEvents(
                    joiner,
                    "ignore:advisory-available"
                );
                openGate();
                await watch.running;
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect(advisories.count).toBe(0);
                // The reopened generation has no watch: a newer manifest
                // arriving in its log is not adopted either.
                gated = false;
                await donor.fs.writeFile("/tree/more.txt", "more");
                const before = (
                    await programOf(donor.fs).getDocument(
                        `bootstrap:${encodePublicSignKey(donor.peer.identity.publicKey)}`
                    )
                ).payloadBytes;
                await donor.fs.snapshotWrite();
                await waitUntil(async () => {
                    const held = await program.getDocument(
                        `bootstrap:${encodePublicSignKey(donor.peer.identity.publicKey)}`
                    );
                    expect(held).toBeDefined();
                    expect(held.payloadBytes).not.toEqual(before);
                });
                expect(program.advisoryIgnoreWatch).toBeUndefined();
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                expect(advisories.count).toBe(0);
            }
        );

        it(
            "write readiness never waits on the ignore policy settling",
            { timeout: 180_000 },
            async () => {
                // No manifest with a snapshot and no rules file ever: the
                // policy never settles.
                const donor = await advisoryDonor("k5-ready-donor");
                // Every evaluation after the cut's first one is held, so
                // nothing the watch does later can be awaited by readiness.
                let held = 0;
                const holdLaterEvaluations = (peer: Peerbit) => {
                    let first = true;
                    wrapMethod(
                        peer,
                        "newestHeldManifestCandidate",
                        async (original) => {
                            if (first) {
                                first = false;
                                return original();
                            }
                            held++;
                            return new Promise(() => {});
                        }
                    );
                };
                const joinerPeer = await joinerPeerBeside([donor.peer]);
                holdLaterEvaluations(joinerPeer);
                const events: BootstrapTelemetryEvent[] = [];
                const joiner = await openJoiner(
                    joinerPeer,
                    donor.fs.address,
                    "k5-ready",
                    events,
                    { ignore: {} }
                );
                await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
                const program = programOf(joiner);
                const policy = (joiner as any).ignorePolicy;
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                const order = events.map((event) => event.type);
                expect(order.indexOf("fallback")).toBeLessThan(
                    order.indexOf("write-ready")
                );
                expect(joiner.bootstrapStatus()).toMatchObject({
                    phase: "off",
                    writeReady: true,
                    writeReadinessSource: "reconciled",
                });
                expect(program.advisoryIgnorePending).toBe(true);
                await policy.refresh();
                expect(policy.fileRead).toBe(false);
                await joiner.writeFile("/written.txt", "written");
                // A manifest arriving now (the donor's genesis, delivered
                // again) starts an evaluation that hangs; writes go on.
                let genesis: unknown;
                await waitUntil(async () => {
                    genesis = await program.getDocument(
                        `bootstrap:${encodePublicSignKey(donor.peer.identity.publicKey)}`
                    );
                    expect(genesis).toBeDefined();
                });
                program.entries.events.dispatchEvent(
                    new CustomEvent("change", {
                        detail: { added: [genesis], removed: [] },
                    })
                );
                await waitUntil(() => expect(held).toBe(1));
                await joiner.writeFile("/written-2.txt", "written");
                expect(joiner.bootstrapStatus().writeReady).toBe(true);
                // Closing the handle stops the engine; the watch detaches
                // with the program.
                (joiner as any).close();
                expect(program.ignorePolicySettled).toBe(undefined);
                await program.close();
                expect(program.advisoryIgnoreWatch).toBeUndefined();
            }
        );
        /** `author`'s manifest as `fs` holds it, decoded (or undefined). */
        const heldManifestOf = async (fs: SharedFsHandle, author: Peerbit) => {
            const manifest = await programOf(fs).getDocument(
                `bootstrap:${encodePublicSignKey(author.identity.publicKey)}`
            );
            return manifest
                ? deserialize(manifest.payloadBytes, SnapshotManifestPayload)
                : undefined;
        };

        it(
            "the joiner's own snapshot while it waits: never taken, advertises nothing, and the donor's later manifest is still adopted",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-own-donor");
                const { joinerPeer, joiner } = await cutJoiner(donor, "k5-own");
                const program = programOf(joiner);
                const policy = (joiner as any).ignorePolicy;
                expect(program.advisoryIgnorePending).toBe(true);
                await waitUntil(async () =>
                    expect((await joiner.list("/tree")).length).toBe(10)
                );
                // A manual snapshot while waiting: the policy's effective
                // set is only open-args ([]) now, so it advertises none.
                await joiner.snapshotWrite();
                const own = await heldManifestOf(joiner, joinerPeer);
                expect(own!.segments.length).toBeGreaterThan(0);
                expect(own!.advisoryIgnorePatterns).toBe(undefined);
                // Its arrival in the log ran a round, which skips it.
                await program.advisoryIgnoreWatch?.running;
                expect(program.advisoryIgnorePending).toBe(true);
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                await policy.refresh();
                expect(policy.fileRead).toBe(false);

                await donor.fs.snapshotWrite();
                await waitUntil(() => {
                    expect((joiner as any).ignoreStatus()).toMatchObject({
                        provenance: "manifest-advisory",
                        patterns: ["dist/"],
                    });
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
                await joiner.mkdir("/dist").catch(() => {});
                await expect(
                    joiner.writeFile("/dist/x.js", "1")
                ).rejects.toThrow(/artifact-ignored/);
                // Published after the answer, it carries the fleet's set.
                await joiner.snapshotWrite();
                expect(
                    (await heldManifestOf(joiner, joinerPeer))!
                        .advisoryIgnorePatterns
                ).toEqual(["dist/"]);
            }
        );

        it(
            "the automatic publisher holds back while the watch waits and publishes the adopted set once it answers",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-tick-donor");
                const joinerPeer = await joinerPeerBeside([donor.peer]);
                const published: boolean[] = [];
                wrapMethod(
                    joinerPeer,
                    "snapshotWrite",
                    (original, program, args) => {
                        published.push(program.advisoryIgnorePending);
                        return original(...args);
                    }
                );
                const events: BootstrapTelemetryEvent[] = [];
                const joiner = await openJoiner(
                    joinerPeer,
                    donor.fs.address,
                    "k5-tick",
                    events,
                    // The publisher's own interval; no due check is skipped
                    // by waiting for it.
                    { ignore: {}, snapshot: { publishIntervalMs: 100 } }
                );
                await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                const program = programOf(joiner);
                // A due check found the store populated and held back.
                await waitUntil(() =>
                    expect(program.deferredSnapshotTick).toBeDefined()
                );
                expect(program.advisoryIgnorePending).toBe(true);
                expect(await heldManifestOf(joiner, joinerPeer)).toBe(
                    undefined
                );

                await donor.fs.snapshotWrite();
                await waitUntil(async () =>
                    expect(
                        (await heldManifestOf(joiner, joinerPeer))
                            ?.advisoryIgnorePatterns
                    ).toEqual(["dist/"])
                );
                expect(published.length).toBeGreaterThan(0);
                expect(published).not.toContain(true);
            }
        );

        it(
            "an ignore policy started while the open's bootstrap has not decided does not conclude absent at phase off",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-early-donor");
                const joinerPeer = await joinerPeerBeside([donor.peer]);
                // The bootstrap's content probe waits until the handle
                // (and its policy's first refresh) returned: the phase is
                // still "off" with the decision outstanding.
                let release!: () => void;
                const released = new Promise<void>(
                    (resolve) => (release = resolve)
                );
                wrapMethod(
                    joinerPeer,
                    "contentStoredBeforeOpen",
                    async (original) => {
                        await released;
                        return original();
                    }
                );
                const events: BootstrapTelemetryEvent[] = [];
                const joiner = await openJoiner(
                    joinerPeer,
                    donor.fs.address,
                    "k5-early",
                    events,
                    { ignore: {} }
                );
                const program = programOf(joiner);
                const policy = (joiner as any).ignorePolicy;
                try {
                    expect(joiner.bootstrapStatus().phase).toBe("off");
                    expect(program.bootstrapDecisionPending).toBe(true);
                    await policy.refresh();
                    expect(policy.fileRead).toBe(false);
                    expect(program.ignorePolicySettled).toBe(false);
                } finally {
                    // A failed assertion must not leave the open's
                    // bootstrap parked for the teardown.
                    release();
                }
                await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                expect(program.advisoryIgnorePending).toBe(true);
                await donor.fs.snapshotWrite();
                await waitUntil(() => {
                    expect((joiner as any).ignoreStatus()).toMatchObject({
                        provenance: "manifest-advisory",
                        patterns: ["dist/"],
                    });
                    expect(program.ignorePolicySettled).toBe(true);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
            }
        );

        it(
            "no watch without an engine that takes advisory patterns; one attaching after the cut starts it",
            { timeout: 240_000 },
            async () => {
                const donor = await advisoryDonor("k5-engine-donor");
                for (const [label, options, settled] of [
                    [
                        "k5-engine-replace",
                        { ignore: { defaultsMode: "replace" } },
                        true,
                    ],
                    [
                        "k5-engine-nofile",
                        { ignore: { defaultsFile: false } },
                        true,
                    ],
                    ["k5-engine-none", {}, undefined],
                ] as const) {
                    const { joiner } = await cutJoiner(donor, label, options);
                    const program = programOf(joiner);
                    expect(program.ignorePolicySettled).toBe(settled);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                    expect(program.advisoryIgnorePending).toBe(false);
                }
                // The last joiner (no engine) holds the donor's manifest
                // with no watch to take it.
                const { joiner } = await cutJoiner(donor, "k5-engine-late", {});
                const program = programOf(joiner);
                await donor.fs.snapshotWrite();
                await holdsSnapshotManifest(joiner, donor.peer);
                expect(program.advisoryIgnoreWatch).toBeUndefined();
                expect(program.bootstrapAdvisoryIgnorePatterns).toBe(undefined);
                // An engine attaching now starts the watch, which takes it.
                const engine = new IgnorePolicyEngine(program, {});
                restores.push(() => engine.stop());
                await engine.start();
                await waitUntil(() => {
                    expect(engine.status()).toMatchObject({
                        provenance: "manifest-advisory",
                        patterns: ["dist/"],
                    });
                    expect(program.ignorePolicySettled).toBe(true);
                    expect(program.advisoryIgnoreWatch).toBeUndefined();
                });
                // Its stop leaves no engine and no watch.
                engine.stop();
                expect(program.ignorePolicySettled).toBe(undefined);
            }
        );

        it(
            "the cut awaits only the watch's first round, not the rounds events add",
            { timeout: 180_000 },
            async () => {
                const donor = await advisoryDonor("k5-round-donor");
                const joinerPeer = await joinerPeerBeside([donor.peer]);
                // An event lands during the first round (it asks for one
                // more), and every later round never finishes.
                let rounds = 0;
                wrapMethod(
                    joinerPeer,
                    "newestHeldManifestCandidate",
                    async (original, program) => {
                        if (++rounds > 1) return new Promise(() => {});
                        const chosen = await original();
                        void program.evaluateAdvisoryIgnoreWatch();
                        return chosen;
                    }
                );
                const events: BootstrapTelemetryEvent[] = [];
                const joiner = await openJoiner(
                    joinerPeer,
                    donor.fs.address,
                    "k5-round",
                    events,
                    { ignore: {} }
                );
                await joiner.awaitWriteReady({ timeout: DEADLINE_MS / 2 });
                expect(fallbackOf(events)?.reason).toBe(CUT_REASON);
                const program = programOf(joiner);
                expect(rounds).toBeGreaterThanOrEqual(2);
                expect(program.advisoryIgnoreWatch.running).toBeDefined();
                expect(joiner.bootstrapStatus()).toMatchObject({
                    phase: "off",
                    writeReady: true,
                });
            }
        );
    });
});
