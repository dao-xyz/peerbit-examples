import type { PublicSignKey } from "@peerbit/crypto";
import {
    ExchangeHeadsMessage,
    RawExchangeHeadsMessage,
    SharedLog,
    StashBackedRawExchangeHeadsMessage,
} from "@peerbit/shared-log";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFileSystem,
    SharedFsHandle,
    SharedFsWritePendingError,
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type BootstrapTelemetryEvent,
    type FreshnessStatus,
} from "../index.js";
import type { Coordinator } from "../readiness/coordinator.js";
import { parseHlcProved } from "../readiness/proof.js";
import { logIdOf, type ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import { documentsIndexPort } from "../readiness/tap.js";
import {
    HeaderV1,
    NOTICE_REASON,
    OpenV1,
    PROVENANCE_SOURCES,
    StateNoticeV1,
    type ReadinessMessage,
} from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Warm freshness, host wiring (M2 PR-4 commits 3 and 4; M2 plan 4.1, 7.4,
 * design tests 73-79, 92 and 93), on in-process Peerbit peers and real
 * filesystems. A warm full-replica open runs the join's coordinator in its
 * freshness purpose at the end of the open: it contains every peer it sees
 * (no donor clause, no phase clause, at least one contained), then reports
 * `warm-fresh` to askers that set `CAP_FRESHNESS` and sends WARM_FRESH
 * notices. W stays writable throughout unless
 * `writeReadiness.requireFreshOnReopen`, which gates it until the check
 * holds and flips it with the source and proof it persisted.
 *
 * Fault injection is patched by name and undone after each test: a
 * responder's OPENs held or dropped (`holdOpens`, `dropOpens`), and W's
 * namespace sync withheld (`withholdSync`: its shared log drops exchange
 * heads, so the freshness pull is the only way R's rows reach W, as
 * readiness-trust.test.ts does for the trust log). Waits poll an assertion
 * at 50 ms; the product arms no timer for any of it.
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const freshnessOf = (fs: SharedFsHandle): FreshnessStatus | undefined =>
    fs.bootstrapStatus().freshness;
/** The freshness check's coordinator (the runtime's join getter hides it). */
const checkOf = (fs: SharedFsHandle): Coordinator => {
    const coordinator = (runtimeOf(fs) as any).coordinatorValue;
    if (!coordinator || coordinator.purpose !== "freshness") {
        throw new Error("no freshness check runs for this open");
    }
    return coordinator;
};
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

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

/** The sidecar of the one filesystem `directory` holds, as text. */
const sidecarText = async (directory: string) => {
    const state = joinPath(directory, "shared-fs-bootstrap");
    const [name] = await readdir(state);
    return readFile(joinPath(state, name), "utf8");
};
const sidecarOf = async (directory: string) =>
    JSON.parse(await sidecarText(directory));

/** The object on `target`'s prototype chain that defines `name`. */
const ownerOf = (target: object, name: string): any => {
    for (let owner: any = target; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.hasOwn(owner, name)) return owner;
    }
    throw new Error(`no ${name} on the prototype chain`);
};

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
    a instanceof Uint8Array &&
    a.length === b.length &&
    a.every((byte, i) => byte === b[i]);

describe("readiness freshness (M2 PR-4, in-process)", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    /** Undone first in afterEach: held gates and patched prototypes. */
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
        const root = await mkdtemp(joinPath(tmpdir(), "shared-fs-fresh-"));
        roots.push(root);
        return joinPath(root, "peer");
    };

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(
            (directory ? { directory } : {}) as any
        );
        peers.push(peer);
        return peer;
    };

    const stopPeer = async (peer: Peerbit) => {
        const index = peers.indexOf(peer);
        if (index >= 0) peers.splice(index, 1);
        await peer.stop();
    };

    /** A creator with `files`, on disk at `directory` when given. */
    const createCreator = async (
        directory?: string,
        files: Record<string, string> = { "/creator.txt": "from the creator" }
    ): Promise<Node> => {
        const peer = await createPeer(directory);
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "fresh-creator",
            gc: false,
        });
        for (const [path, content] of Object.entries(files)) {
            await fs.writeFile(path, content);
        }
        return { peer, fs };
    };

    /** A fresh full address-open of `address` dialed to `donor`, ready. */
    const readyJoiner = async (
        donor: Peerbit,
        address: string,
        directory?: string,
        label = "fresh-joiner"
    ): Promise<Node> => {
        const peer = await createPeer(directory);
        await peer.dial(donor);
        const fs = await openSharedFs({
            peerbit: peer,
            address,
            machineLabel: label,
            bootstrap: false,
            gc: false,
        });
        await fs.awaitWriteReady({ timeout: 60_000 });
        return { peer, fs };
    };

    /**
     * A warm reopen of `address` from `directory` (its peer stopped
     * before), dialed to each of `dial`.
     */
    const reopenWarm = async (
        directory: string,
        address: string,
        dial: Peerbit[] = [],
        options: Record<string, unknown> = {},
        label = "fresh-warm"
    ): Promise<Node> => {
        const peer = await createPeer(directory);
        for (const other of dial) await peer.dial(other);
        const fs = await openSharedFs({
            peerbit: peer,
            address,
            machineLabel: label,
            bootstrap: false,
            gc: false,
            ...options,
        });
        return { peer, fs };
    };

    /**
     * Holds every OPEN `fs`'s responder receives until `release`, which
     * delivers them in order (a busy peer that stays reachable).
     */
    const holdOpens = (fs: SharedFsHandle) => {
        const responder = runtimeOf(fs).responder!;
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

    /** `fs`'s responder drops every OPEN (a hung peer that stays reachable). */
    const dropOpens = (fs: SharedFsHandle) => {
        const responder = runtimeOf(fs).responder!;
        const onMessage = responder.onMessage;
        const state = { dropped: 0 };
        responder.onMessage = (message, from) => {
            if (message instanceof OpenV1) {
                state.dropped++;
                return;
            }
            onMessage.call(responder, message, from);
        };
        restores.push(() => (responder.onMessage = onMessage));
        return state;
    };

    /** Every header and notice `fs`'s responder sends, with its recipient. */
    const recordSends = (fs: SharedFsHandle) => {
        const ports = (runtimeOf(fs).responder as any).ports;
        const send = ports.send;
        const sent: Array<{ message: ReadinessMessage; to: string }> = [];
        ports.send = (
            message: ReadinessMessage,
            to: PublicSignKey | string
        ) => {
            sent.push({
                message,
                to: typeof to === "string" ? to : to.hashcode(),
            });
            return send(message, to);
        };
        restores.push(() => (ports.send = send));
        return {
            notices: () =>
                sent.flatMap(({ message, to }) =>
                    message instanceof StateNoticeV1
                        ? [
                              {
                                  to,
                                  reason: message.reason,
                                  source: PROVENANCE_SOURCES[
                                      message.provenance.source
                                  ],
                                  writeReady: message.provenance.writeReady,
                              },
                          ]
                        : []
                ),
            headers: () =>
                sent.flatMap(({ message, to }) =>
                    message instanceof HeaderV1
                        ? [
                              {
                                  to,
                                  source: PROVENANCE_SOURCES[
                                      message.provenance.source
                                  ],
                              },
                          ]
                        : []
                ),
        };
    };

    /**
     * Drops the exchange heads the shared log of `logId` on the peer named
     * `hash` receives (sync delivers nothing; the readiness pull, a
     * `SharedLog.join`, still does). Installed before that peer opens.
     */
    const withholdSync = (hash: string, logId: Uint8Array) => {
        const owner = ownerOf(SharedLog.prototype, "onMessage");
        const onMessage = owner.onMessage;
        const state = { dropped: 0 };
        owner.onMessage = function (
            this: any,
            message: unknown,
            context: unknown
        ) {
            if (
                (message instanceof ExchangeHeadsMessage ||
                    message instanceof RawExchangeHeadsMessage ||
                    message instanceof StashBackedRawExchangeHeadsMessage) &&
                this?.node?.identity?.publicKey?.hashcode?.() === hash &&
                sameBytes(this?.log?.id, logId)
            ) {
                state.dropped++;
                return Promise.resolve();
            }
            return onMessage.call(this, message, context);
        };
        restores.push(() => (owner.onMessage = onMessage));
        return state;
    };

    /**
     * Re-puts one of `fs`'s namespace rows linked to its live head (the
     * Guard D heal's `putPreferLinked`): the new head's entry names the
     * old one, so a peer that still holds the old head holds a row this
     * log superseded.
     */
    const relinkOneRow = async (fs: SharedFsHandle) => {
        const program = programOf(fs);
        const port = documentsIndexPort(program.entries, NAMESPACE_V1);
        let row: { key: string; head: string } | undefined;
        for await (const page of port.scan()) {
            row = page[0] as { key: string; head: string } | undefined;
            if (row) break;
        }
        if (!row) throw new Error("no namespace row to re-put");
        const document = await program.getDocument(row.key);
        await program.putPreferLinked(document);
        const rows = new Map<string, string>();
        for await (const page of port.scan()) {
            for (const { key, head } of page) rows.set(key as string, head);
        }
        expect(rows.get(row.key)).not.toBe(row.head);
        return { key: row.key, old: row.head };
    };

    it("73: a warm W alone with a fresh J contains J, turns warm-fresh and sends WARM_FRESH; J's session with W sees warm-fresh", async () => {
        const directory = await newDirectory();
        const creator = await createCreator(directory);
        const address = creator.fs.address;
        await stopPeer(creator.peer);

        const warm = await reopenWarm(directory, address);
        // Writable at once from its own proof; nobody to compare with.
        expect(warm.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "creator",
            readiness: undefined,
        });
        expect(freshnessOf(warm.fs)).toMatchObject({
            state: "unchecked",
            contained: [],
            requests: 0,
        });
        expect(programOf(warm.fs).readinessProvenance().source).toBe("warm");
        // J's OPEN waits until W's own check held, so J's session freezes
        // W's provenance after the label.
        const held = holdOpens(warm.fs);
        const sends = recordSends(warm.fs);

        const joinerPeer = await createPeer();
        await joinerPeer.dial(warm.peer);
        const joiner = await openSharedFs({
            peerbit: joinerPeer,
            address,
            machineLabel: "fresh-joiner",
            bootstrap: false,
            gc: false,
        });
        const joinerHash = hashOf(joinerPeer);
        await waitUntil(() =>
            expect(freshnessOf(warm.fs)).toMatchObject({
                state: "fresh",
                contained: [joinerHash],
                required: 0,
                ms: expect.any(Number),
            })
        );
        // W contained a gated J: its check has no donor clause.
        expect(joiner.bootstrapStatus().writeReady).toBe(false);
        expect(held.held).toBeGreaterThan(0);
        expect(programOf(warm.fs).readinessProvenance()).toMatchObject({
            writeReady: true,
            source: "warm-fresh",
        });
        expect(sends.notices()).toEqual([
            {
                to: joinerHash,
                reason: NOTICE_REASON.WARM_FRESH,
                source: "warm-fresh",
                writeReady: true,
            },
        ]);
        expect(freshnessOf(warm.fs)!.requests).toBeGreaterThanOrEqual(1);

        held.release();
        await joiner.awaitWriteReady({ timeout: 60_000 });
        const contained = joiner.bootstrapStatus().readiness!.contained;
        expect(contained).toEqual([
            expect.objectContaining({
                peer: hashOf(warm.peer),
                qualified: true,
                source: "warm-fresh",
            }),
        ]);
        // Every header W sent J said warm-fresh (J sets CAP_FRESHNESS).
        expect(sends.headers().length).toBeGreaterThan(0);
        for (const header of sends.headers()) {
            expect(header).toEqual({ to: joinerHash, source: "warm-fresh" });
        }
        expect(decode(await joiner.readFile("/creator.txt"))).toBe(
            "from the creator"
        );
        // At rest: the check finished and arms nothing.
        expect(runtimeOf(warm.fs).debug().coordinator?.purpose).toBe(
            "freshness"
        );
        expect(checkOf(warm.fs).phase).toBe("finished");
    }, 180_000);

    it("74: two warm peers reopened together both turn fresh (no donor clause, no deadlock), writable throughout", async () => {
        const creatorDirectory = await newDirectory();
        const joinerDirectory = await newDirectory();
        const creator = await createCreator(creatorDirectory);
        const address = creator.fs.address;
        const joiner = await readyJoiner(
            creator.peer,
            address,
            joinerDirectory
        );
        await joiner.fs.writeFile("/joiner.txt", "from the joiner");
        await waitUntil(async () =>
            expect(decode(await creator.fs.readFile("/joiner.txt"))).toBe(
                "from the joiner"
            )
        );
        await stopPeer(joiner.peer);
        await stopPeer(creator.peer);

        const a = await reopenWarm(creatorDirectory, address, [], {}, "a");
        const b = await reopenWarm(joinerDirectory, address, [a.peer], {}, "b");
        expect(a.fs.bootstrapStatus().writeReady).toBe(true);
        expect(b.fs.bootstrapStatus().writeReady).toBe(true);
        await waitUntil(() => {
            expect(freshnessOf(a.fs)).toMatchObject({
                state: "fresh",
                contained: [hashOf(b.peer)],
            });
            expect(freshnessOf(b.fs)).toMatchObject({
                state: "fresh",
                contained: [hashOf(a.peer)],
            });
        });
        for (const node of [a, b]) {
            expect(programOf(node.fs).readinessProvenance().source).toBe(
                "warm-fresh"
            );
            // A freshness check is not a join: the join-only readers.
            expect(node.fs.bootstrapStatus().readiness).toBeUndefined();
            expect(runtimeOf(node.fs).coordinator).toBeUndefined();
            await node.fs.writeFile(
                `/after-${node === a ? "a" : "b"}.txt`,
                "written"
            );
        }
    }, 180_000);

    it("75: a silent visible peer keeps W checking with its reason named and nothing armed after its attempts; W stays writable", async () => {
        const directory = await newDirectory();
        const creator = await createCreator(directory);
        const address = creator.fs.address;
        // An observer that holds the address and never answers an OPEN; it
        // runs no join, so it asks W nothing either.
        const silentPeer = await createPeer();
        await silentPeer.dial(creator.peer);
        const silent = await openSharedFs({
            peerbit: silentPeer,
            address,
            machineLabel: "fresh-silent",
            replicate: false,
            bootstrap: false,
            gc: false,
        });
        const dropped = dropOpens(silent);
        await stopPeer(creator.peer);

        const warm = await reopenWarm(directory, address, [silentPeer], {
            writeReadiness: { requestTimeoutMs: 100 },
        });
        const silentHash = hashOf(silentPeer);
        await waitUntil(() =>
            expect(freshnessOf(warm.fs)).toMatchObject({
                state: "checking",
                required: 1,
                silent: [silentHash],
                reason: "reachable-silent",
                contained: [],
            })
        );
        expect(dropped.dropped).toBe(3);
        expect(freshnessOf(warm.fs)!.requests).toBe(3);
        // No re-check timer and no poll once its attempts ended.
        expect(runtimeOf(warm.fs).debug().armedTimers).toBe(0);
        expect(programOf(warm.fs).readinessProvenance().source).toBe("warm");
        await warm.fs.writeFile("/while-checking.txt", "writable");
        expect(warm.fs.bootstrapStatus().writeReady).toBe(true);
    }, 180_000);

    it("76: W reopened after R wrote pulls R's row through the queue and turns fresh only after containing R; a head W's log superseded is explained without a pull", async () => {
        const warmDirectory = await newDirectory();
        const replicaDirectory = await newDirectory();
        const creator = await createCreator(warmDirectory, {
            "/x.txt": "from w",
        });
        const address = creator.fs.address;
        const namespaceLog = logIdOf(programOf(creator.fs).entries);
        const replica = await readyJoiner(
            creator.peer,
            address,
            replicaDirectory,
            "fresh-replica"
        );
        await waitUntil(async () =>
            expect(decode(await replica.fs.readFile("/x.txt"))).toBe("from w")
        );
        await stopPeer(replica.peer);
        // While R is away, W re-puts one of its rows linked to the live
        // head (as a Guard D heal does): R keeps the head W's log
        // superseded.
        const superseded = await relinkOneRow(creator.fs);
        await stopPeer(creator.peer);
        const hlcBefore = parseHlcProved(
            (await sidecarOf(warmDirectory)).hlcProved
        );

        // R reopens warm alone and writes a row W never saw.
        const r = await reopenWarm(replicaDirectory, address, [], {}, "r");
        await r.fs.writeFile("/y.txt", "from r");
        // Sync never delivers to W: the check's pull is the only path.
        const warmPeer = await createPeer(warmDirectory);
        withholdSync(hashOf(warmPeer), namespaceLog);
        await warmPeer.dial(r.peer);
        const w = await openSharedFs({
            peerbit: warmPeer,
            address,
            machineLabel: "fresh-w",
            bootstrap: false,
            gc: false,
            writeReadiness: { requestTimeoutMs: 500 },
        });
        expect(w.bootstrapStatus().writeReady).toBe(true);
        const rHash = hashOf(r.peer);
        await waitUntil(() =>
            expect(freshnessOf(w)).toMatchObject({
                state: "fresh",
                contained: [rHash],
            })
        );
        const result = checkOf(w)
            .record(rHash)!
            .results.get(SCOPE_NAMESPACE_V1)!;
        expect(result.pulled).toBeGreaterThanOrEqual(1);
        expect(result.explainedBy.superseded).toBeGreaterThanOrEqual(1);
        // Explained in W's own log: never pulled, never asked of R.
        expect(await programOf(w).entries.log.log.has(superseded.old)).toBe(
            true
        );
        // The pulled row is indexed: W holds R's write and its own.
        expect(decode(await w.readFile("/y.txt"))).toBe("from r");
        expect(decode(await w.readFile("/x.txt"))).toBe("from w");
        // The hint for the next check's gap estimate moved forward; the
        // source did not change.
        await waitUntil(async () => {
            const sidecar = await sidecarOf(warmDirectory);
            expect(parseHlcProved(sidecar.hlcProved)).toBeGreaterThan(
                hlcBefore
            );
            expect(sidecar).toMatchObject({
                writeReady: true,
                writeReadySource: "creator",
            });
        });
    }, 240_000);

    it("76b: a check that contains only a peer older than W's proof keeps the newer hlcProved hint", async () => {
        const replicaDirectory = await newDirectory();
        const warmDirectory = await newDirectory();
        const creator = await createCreator(undefined, {
            "/f1.txt": "first",
        });
        const address = creator.fs.address;
        const namespaceLog = logIdOf(programOf(creator.fs).entries);
        // R holds f1 only; W joins after f2, so its proof is newer.
        const replica = await readyJoiner(
            creator.peer,
            address,
            replicaDirectory,
            "fresh-replica"
        );
        await waitUntil(async () =>
            expect(decode(await replica.fs.readFile("/f1.txt"))).toBe("first")
        );
        await stopPeer(replica.peer);
        await creator.fs.writeFile("/f2.txt", "second");
        const warm = await readyJoiner(
            creator.peer,
            address,
            warmDirectory,
            "fresh-w"
        );
        await waitUntil(async () =>
            expect(decode(await warm.fs.readFile("/f2.txt"))).toBe("second")
        );
        await stopPeer(warm.peer);
        await stopPeer(creator.peer);
        const hlcBefore = parseHlcProved(
            (await sidecarOf(warmDirectory)).hlcProved
        );
        expect(hlcBefore).toBeGreaterThan(0n);

        // R reopens alone, runs no check of its own and never syncs W's f2.
        const replicaPeer = await createPeer(replicaDirectory);
        withholdSync(hashOf(replicaPeer), namespaceLog);
        const r = await openSharedFs({
            peerbit: replicaPeer,
            address,
            machineLabel: "r",
            bootstrap: false,
            gc: false,
            allowPartialWrites: true,
        });
        const w = await reopenWarm(warmDirectory, address, [replicaPeer]);
        const rHash = hashOf(replicaPeer);
        await waitUntil(() =>
            expect(freshnessOf(w.fs)).toMatchObject({
                state: "fresh",
                contained: [rHash],
            })
        );
        expect(await r.readFile("/f2.txt").catch(() => undefined)).toBe(
            undefined
        );
        // The check's own hint is R's, older than W's proof.
        expect(runtimeOf(w.fs).freshnessHlcProved()).toBeLessThan(hlcBefore);
        // The label queued any patch; the sidecar keeps the newer hint.
        await programOf(w.fs).stateWriteChain;
        expect(parseHlcProved((await sidecarOf(warmDirectory)).hlcProved)).toBe(
            hlcBefore
        );
    }, 240_000);

    it("78: requireFreshOnReopen gates a warm W (EAGAIN, Guard D armed) until fresh, then writable with its persisted source; offline it stays gated with no timer until assumeComplete releases it as operator", async () => {
        const directory = await newDirectory();
        const creator = await createCreator(directory);
        const address = creator.fs.address;
        const joiner = await readyJoiner(creator.peer, address);
        await stopPeer(creator.peer);
        // J answers W's check only when the test says so.
        const held = holdOpens(joiner.fs);

        const gated = await reopenWarm(directory, address, [joiner.peer], {
            writeReadiness: { requireFreshOnReopen: true },
        });
        const fs = gated.fs;
        const sends = recordSends(fs);
        // write:ready comes at the flip, after the open returned.
        const events: string[] = [];
        const target = programOf(fs).events as EventTarget;
        // A write:ready listener reads the state the provenance says.
        let atWriteReady: FreshnessStatus | undefined;
        target.addEventListener("write:ready", () => {
            events.push("write:ready");
            atWriteReady = freshnessOf(fs);
        });
        target.addEventListener("freshness:change", (event) =>
            events.push(`freshness:${(event as CustomEvent).detail.state}`)
        );
        expect(fs.bootstrapStatus()).toMatchObject({
            writeReady: false,
            guardArmed: true,
            writeReadinessSource: undefined,
            readiness: undefined,
        });
        expect(programOf(fs).readinessProvenance()).toMatchObject({
            writeReady: false,
            source: "none",
        });
        const refused = await fs.writeFile("/gated.txt", "no").then(
            () => undefined,
            (error: unknown) => error
        );
        expect(refused).toBeInstanceOf(SharedFsWritePendingError);
        expect(refused).toMatchObject({ code: "EAGAIN" });
        await waitUntil(() => expect(held.held).toBeGreaterThan(0));
        expect(freshnessOf(fs)!.state).toBe("checking");
        expect(fs.bootstrapStatus().writeReady).toBe(false);

        held.release();
        await fs.awaitWriteReady({ timeout: 60_000 });
        expect(fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            guardArmed: true,
            writeReadinessSource: "creator",
        });
        expect(freshnessOf(fs)!.state).toBe("fresh");
        expect(atWriteReady!.state).toBe("fresh");
        expect(atWriteReady!.ms).toBeGreaterThanOrEqual(0);
        // The event follows the flip, in the label's transition.
        await waitUntil(() => expect(events).toContain("freshness:fresh"));
        // The flip (write:ready) inside the label's transition, then the
        // freshness event.
        expect(events.filter((e) => e !== "freshness:checking")).toEqual([
            "write:ready",
            "freshness:fresh",
        ]);
        expect(programOf(fs).readinessProvenance().source).toBe("warm-fresh");
        // The label was recorded before the flip, so the flip's READY
        // notice already said warm-fresh, and no WARM_FRESH followed it.
        expect(sends.notices()).toEqual([
            {
                to: hashOf(joiner.peer),
                reason: NOTICE_REASON.READY,
                source: "warm-fresh",
                writeReady: true,
            },
        ]);
        await fs.writeFile("/fresh.txt", "yes");
        expect(await sidecarOf(directory)).toMatchObject({
            writeReady: true,
            writeReadySource: "creator",
        });

        // Offline: gated, nothing armed, until the operator vouches.
        await stopPeer(joiner.peer);
        await stopPeer(gated.peer);
        const alone = await reopenWarm(directory, address, [], {
            writeReadiness: { requireFreshOnReopen: true },
        });
        expect(alone.fs.bootstrapStatus().writeReady).toBe(false);
        expect(freshnessOf(alone.fs)!.state).toBe("unchecked");
        expect(runtimeOf(alone.fs).debug().armedTimers).toBe(0);
        const timeout = await alone.fs.awaitWriteReady({ timeout: 300 }).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(timeout).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
        expect(runtimeOf(alone.fs).debug().armedTimers).toBe(0);
        await alone.fs.assumeComplete();
        expect(alone.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "operator",
            guardArmed: true,
        });
        expect(await sidecarOf(directory)).toMatchObject({
            writeReady: true,
            writeReadySource: "operator",
        });
        // The check goes on for its label; nothing changed it here.
        expect(freshnessOf(alone.fs)!.state).toBe("unchecked");
        await alone.fs.writeFile("/operator.txt", "vouched");
    }, 240_000);

    it("78b: requireFreshOnReopen must be a boolean and is refused with allowPartialWrites", async () => {
        const peer = await createPeer();
        await expect(
            openSharedFs({
                peerbit: peer,
                machineLabel: "fresh-invalid",
                writeReadiness: { requireFreshOnReopen: "yes" as any },
            })
        ).rejects.toMatchObject({
            code: "EINVAL",
            message: "writeReadiness.requireFreshOnReopen must be a boolean",
        });
        await expect(
            openSharedFs({
                peerbit: peer,
                machineLabel: "fresh-invalid",
                allowPartialWrites: true,
                writeReadiness: { requireFreshOnReopen: true },
            })
        ).rejects.toMatchObject({
            code: "EINVAL",
            message:
                "writeReadiness.requireFreshOnReopen cannot be combined with allowPartialWrites",
        });
        // A creating open is ready at once with it: it changes warm
        // reopens only.
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "fresh-creator-option",
            gc: false,
            writeReadiness: { requireFreshOnReopen: true },
        });
        expect(fs.bootstrapStatus().writeReady).toBe(true);
        expect(freshnessOf(fs)).toBeUndefined();
    }, 120_000);

    it("79: a warm reopen keeps readiness undefined and reports freshness, freshness:change unchecked to checking to fresh, and freshness telemetry with its requests", async () => {
        const directory = await newDirectory();
        const peer = await createPeer(directory);
        const program = new SharedFileSystem();
        const args = {
            machineLabel: "fresh-surface",
            bootstrap: false,
            gc: false,
        };
        await peer.open(program, { args: args as any });
        await program.writeFile("/surface.txt", "written");
        const handle = new SharedFsHandle(program);
        const joiner = await readyJoiner(peer, handle.address);
        expect(handle.bootstrapStatus().freshness).toBeUndefined();
        expect(joiner.fs.bootstrapStatus().freshness).toBeUndefined();

        await program.close();
        const changes: unknown[] = [];
        (program.events as EventTarget).addEventListener(
            "freshness:change",
            (event) => changes.push((event as CustomEvent).detail)
        );
        const telemetry: BootstrapTelemetryEvent[] = [];
        await peer.open(program, {
            existing: "reuse",
            args: {
                ...args,
                addressOpen: true,
                bootstrapTelemetry: (event: BootstrapTelemetryEvent) =>
                    telemetry.push(event),
            } as any,
        });
        expect(program.bootstrapStatus().readiness).toBeUndefined();
        expect(program.bootstrapStatus().freshness).toBeDefined();
        const joinerHash = hashOf(joiner.peer);
        await waitUntil(() =>
            expect(program.bootstrapStatus().freshness).toMatchObject({
                state: "fresh",
                contained: [joinerHash],
            })
        );
        expect(program.bootstrapStatus().readiness).toBeUndefined();
        expect(changes).toEqual([
            { state: "checking", contained: 0 },
            { state: "fresh", contained: 1, ms: expect.any(Number) },
        ]);
        const freshness = telemetry.filter(
            (event) => event.type === "freshness"
        );
        expect(freshness).toEqual([
            {
                type: "freshness",
                atMs: expect.any(Number),
                state: "checking",
                contained: 0,
                excluded: 0,
                gaps: 0,
                requests: expect.any(Number),
            },
            {
                type: "freshness",
                atMs: expect.any(Number),
                state: "fresh",
                contained: 1,
                excluded: 0,
                gaps: 0,
                ms: expect.any(Number),
                requests: expect.any(Number),
            },
        ]);
        const requests = (freshness[1] as { requests: number }).requests;
        expect(requests).toBeGreaterThanOrEqual(1);
        expect(requests).toBe(program.bootstrapStatus().freshness!.requests);
        const sent = runtimeOf(handle).stats.sent;
        expect(sent.freshness.open).toBeGreaterThanOrEqual(1);
        expect(sent.join).toEqual({ open: 0, cellsReq: 0, listPage: 0 });
        // A warm open's write-ready counts nothing and is not a join's.
        expect(
            telemetry.filter((event) => event.type === "readiness-peer")
        ).toEqual([]);
        expect(
            telemetry.filter((event) => event.type === "write-ready")
        ).toEqual([expect.objectContaining({ source: "creator", warm: true })]);
    }, 180_000);

    it("92: requireFreshOnReopen starts no join; the flip keeps the persisted proof byte for byte, with writeReady and the source unchanged", async () => {
        const creator = await createCreator();
        const directory = await newDirectory();
        const replica = await readyJoiner(
            creator.peer,
            creator.fs.address,
            directory,
            "fresh-reconciled"
        );
        const address = replica.fs.address;
        await stopPeer(replica.peer);
        const before = await sidecarOf(directory);
        expect(before).toMatchObject({
            writeReady: true,
            writeReadySource: "reconciled",
            proof: expect.any(Object),
        });

        const warm = await reopenWarm(directory, address, [creator.peer], {
            writeReadiness: { requireFreshOnReopen: true },
        });
        expect(warm.fs.bootstrapStatus().writeReady).toBe(false);
        // Only the freshness purpose runs: no join, no join status.
        expect(runtimeOf(warm.fs).debug().coordinator?.purpose).toBe(
            "freshness"
        );
        expect(runtimeOf(warm.fs).coordinator).toBeUndefined();
        expect(warm.fs.bootstrapStatus().readiness).toBeUndefined();
        await warm.fs.awaitWriteReady({ timeout: 60_000 });
        expect(warm.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "reconciled",
            readiness: undefined,
        });
        expect(runtimeOf(warm.fs).stats.sent.join).toEqual({
            open: 0,
            cellsReq: 0,
            listPage: 0,
        });
        const after = await sidecarOf(directory);
        expect(JSON.stringify(after.proof)).toBe(JSON.stringify(before.proof));
        expect(after).toMatchObject({
            writeReady: true,
            writeReadySource: "reconciled",
        });
        expect(after.bootstrap).toBeUndefined();
    }, 180_000);

    it("93: two warm peers reopened together, both requireFreshOnReopen, both flip without assumeComplete", async () => {
        const creatorDirectory = await newDirectory();
        const joinerDirectory = await newDirectory();
        const creator = await createCreator(creatorDirectory);
        const address = creator.fs.address;
        const joiner = await readyJoiner(
            creator.peer,
            address,
            joinerDirectory
        );
        await stopPeer(joiner.peer);
        await stopPeer(creator.peer);

        const options = { writeReadiness: { requireFreshOnReopen: true } };
        const a = await reopenWarm(creatorDirectory, address, [], options, "a");
        expect(a.fs.bootstrapStatus().writeReady).toBe(false);
        const b = await reopenWarm(
            joinerDirectory,
            address,
            [a.peer],
            options,
            "b"
        );
        expect(b.fs.bootstrapStatus().writeReady).toBe(false);
        await Promise.all([
            a.fs.awaitWriteReady({ timeout: 60_000 }),
            b.fs.awaitWriteReady({ timeout: 60_000 }),
        ]);
        expect(a.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "creator",
            freshness: { state: "fresh", contained: [hashOf(b.peer)] },
        });
        expect(b.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "reconciled",
            freshness: { state: "fresh", contained: [hashOf(a.peer)] },
        });
    }, 180_000);
});
