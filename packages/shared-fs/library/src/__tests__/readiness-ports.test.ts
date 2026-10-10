import { deserialize, serialize } from "@dao-xyz/borsh";
import {
    Ed25519Keypair,
    equals,
    randomBytes,
    sha256Base64Sync,
    type PublicSignKey,
} from "@peerbit/crypto";
import { DeleteOperation, PutOperation } from "@peerbit/document";
import { Timestamp } from "@peerbit/log";
import { IdentityRelation, TrustedNetwork } from "@peerbit/trusted-network";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SharedFileSystem,
    encodePublicSignKey,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import {
    BootstrapManifest,
    ChangesetManifest,
    ChangesetManifestPayload,
    FileChunk,
    FileVersion,
    NamingEvent,
    SharedFsEntry,
} from "../model.js";
import { DIGEST_BYTES, PULL_LANES } from "../readiness/constants.js";
import { digestToHead, headDigest } from "../readiness/digest.js";
import {
    Explainer,
    RejectionRecord,
    type EntryFacts,
    type RejectionReason,
} from "../readiness/explain.js";
import type { IdKey } from "../readiness/id-map.js";
import {
    documentsExplainPorts,
    installTrustRejectionNotes,
    rejectionOf,
    sessionScopeOf,
    sharedLogPullPorts,
    type ExplainStore,
    type LoggedEntry,
    type PullStore,
} from "../readiness/ports.js";
import { PullQueue } from "../readiness/pull-queue.js";
import type { ReadinessRuntime, ScopeState } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeDescriptor,
} from "../readiness/scopes.js";
import {
    ScopeTap,
    documentsIndexPort,
    scopeRowKey,
    type IndexedHead,
    type ScopeIndexPort,
} from "../readiness/tap.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The production bindings of the joiner session's ports (PR-3 commit 2,
 * SPEC2 section 4): `documentsExplainPorts`, `sharedLogPullPorts`,
 * `sessionScopeOf` and `rejectionOf`, against real Documents and SharedLog
 * on in-process Peerbit peers in the product's entries configuration (auto
 * document mode over the native log graph that `Peerbit.create` gives).
 *
 * `inspect` is the soundness-critical read: a `not-row` it returns wrongly
 * would exclude an honest peer. So every case below checks it against an
 * oracle that decodes the entry independently (borsh, by class) and against
 * the key the tap holds for the same head, for every row class of both
 * scopes, for local puts and remote arrivals, for CUTs, and for entries
 * that are not rows. The `canPerformEntry` split (index.ts) is pinned here
 * too: each refusal records its own reason through the real runtime hook,
 * with the signers a trust refusal names; and so are the trust graph's own
 * refusals, noted by the wrapper of its `canPerform` (PR-3 commit 3).
 */

const until = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 90_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await assertion();
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
};

const programOf = (fs: SharedFsHandle): any => fs.program as any;
const entriesOf = (fs: SharedFsHandle): any => programOf(fs).entries;
const trustStoreOf = (fs: SharedFsHandle): any =>
    programOf(fs).trustGraph.trustGraph;
const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    programOf(fs).readinessRuntime;
const storeOf = (fs: SharedFsHandle, scope: ScopeDescriptor) =>
    scope === NAMESPACE_V1 ? entriesOf(fs) : trustStoreOf(fs);

/** The runtime scope of `fs`, started. */
const scopeStateOf = async (
    fs: SharedFsHandle,
    scope: ScopeDescriptor = NAMESPACE_V1
): Promise<ScopeState> => {
    const runtime = runtimeOf(fs);
    await runtime.whenStarted();
    const state = runtime.scope(scope.id);
    if (!state) throw new Error(`no ${scope.name} scope`);
    return state;
};

/** `documentsExplainPorts` on `fs`'s store of `scope`, with its tap. */
const explainOf = async (
    fs: SharedFsHandle,
    scope: ScopeDescriptor = NAMESPACE_V1
) => {
    const state = await scopeStateOf(fs, scope);
    const store = storeOf(fs, scope);
    return {
        store,
        tap: state.tap,
        ports: documentsExplainPorts(store, scope, state.tap.port),
    };
};

const randomHead = () => digestToHead(randomBytes(DIGEST_BYTES));

/** Keys by hashcode, for comparing decoded and original instances. */
const hashesOf = (keys: readonly PublicSignKey[] | undefined) =>
    keys?.map((key) => key.hashcode());

const NAMESPACE_CLASSES = [NamingEvent, FileVersion, ChangesetManifest];

/**
 * What `entry` is, decoded independently of ports.ts: the payload's
 * operation class, then the value by borsh with the store's document class,
 * classified by `instanceof` (never through `ScopeDescriptor` or
 * `scopeRowKey`).
 */
const truthOf = async (
    entry: any,
    scope: ScopeDescriptor
): Promise<EntryFacts> => {
    const payload = await entry.getPayloadValue();
    if (payload instanceof DeleteOperation) {
        return { kind: "not-row", detail: "a delete" };
    }
    if (!(payload instanceof PutOperation)) {
        throw new Error(`unexpected operation ${payload?.constructor?.name}`);
    }
    const wallTime: bigint = entry.meta.clock.timestamp.wallTime;
    if (scope === TRUST_V1) {
        const value = deserialize(payload.data, IdentityRelation);
        return { kind: "row", key: value.id, wallTime };
    }
    const value: any = deserialize(payload.data, SharedFsEntry);
    if (NAMESPACE_CLASSES.some((cls) => value instanceof cls)) {
        return { kind: "row", key: value.id, wallTime };
    }
    return { kind: "not-row", detail: value.constructor.name };
};

const sameKey = (a: IdKey, b: IdKey) =>
    typeof a === "string" || typeof b === "string"
        ? a === b
        : equals(a as Uint8Array, b as Uint8Array);

/** Whether the tap holds `head` as the row of `key`. */
const tapHolds = (tap: ScopeTap, key: IdKey, head: string) => {
    const slot = tap.map.get(key);
    return slot >= 0 && tap.map.headEquals(slot, headDigest(head));
};

interface RecordedAdd {
    head: string;
    id: unknown;
    modified: bigint;
    value: unknown;
}

/** Records the values of `documents`' change events from now on. */
const recordAdds = (documents: any) => {
    const adds: RecordedAdd[] = [];
    const listener = (event: any) => {
        for (const value of event.detail.added) {
            adds.push({
                head: value.__context.head,
                id: value.id,
                modified: BigInt(value.__context.modified),
                value,
            });
        }
    };
    documents.events.addEventListener("change", listener);
    return {
        adds,
        stop: () => documents.events.removeEventListener("change", listener),
    };
};

/** The scope's index rows (`documentsIndexPort`, as a seed scan reads them). */
const indexRows = async (fs: SharedFsHandle, scope: ScopeDescriptor) => {
    const out: Array<IndexedHead & { key: IdKey }> = [];
    for await (const rows of documentsIndexPort(
        storeOf(fs, scope),
        scope
    ).scan()) {
        out.push(...rows);
    }
    return out;
};

/**
 * Every entry of `fs`'s scope log against the oracle, every recorded add
 * against its event's id and time, and every index row against the tap.
 * Returns the classes seen.
 */
const expectInspectMatches = async (
    fs: SharedFsHandle,
    scope: ScopeDescriptor,
    adds: RecordedAdd[] = []
) => {
    const { store, tap, ports } = await explainOf(fs, scope);
    const seen = new Set<string>();
    for (const entry of await store.log.log.toArray()) {
        const facts = await ports.inspect(entry.hash);
        const truth = await truthOf(entry, scope);
        if (truth.kind === "row" && facts?.kind === "row") {
            // Byte keys by content: a payload that arrived over the wire
            // decodes to a Buffer view, Documents' decoder to a copy.
            expect(sameKey(facts.key, truth.key), entry.hash).toBe(true);
            expect(facts.wallTime, entry.hash).toBe(truth.wallTime);
        } else {
            expect(facts, entry.hash).toEqual(truth);
        }
        seen.add(
            truth.kind === "row" ? "row" : (truth as { detail: string }).detail
        );
    }
    for (const add of adds) {
        const facts = await ports.inspect(add.head);
        if (!(await store.log.log.has(add.head))) {
            // Deleted since (Documents removes a cut put from its log).
            expect(facts, add.head).toBeUndefined();
            continue;
        }
        const inScope = scope.classify(add.value);
        if (!inScope) {
            expect(facts?.kind, add.head).toBe("not-row");
            continue;
        }
        expect(facts?.kind, add.head).toBe("row");
        const row = facts as Extract<EntryFacts, { kind: "row" }>;
        // The event's own id and `__context.modified`: what the tap keys
        // and what Documents' newest-wins compares.
        expect(sameKey(row.key, add.id as IdKey)).toBe(true);
        expect(row.wallTime).toBe(add.modified);
        seen.add(add.value!.constructor.name);
    }
    const rows = await indexRows(fs, scope);
    expect(rows.length).toBe(tap.count);
    for (const row of rows) {
        const facts = await ports.inspect(row.head);
        expect(facts?.kind, row.head).toBe("row");
        const key = (facts as Extract<EntryFacts, { kind: "row" }>).key;
        expect(sameKey(key, row.key)).toBe(true);
        expect(tapHolds(tap, key, row.head)).toBe(true);
        // readHead is the tap's own port: the same row, read the same way.
        const viaPorts = await ports.readHead(key);
        expect(viaPorts).toEqual(await tap.port.readHead(key));
        expect(viaPorts).toEqual({ head: row.head, modified: row.modified });
    }
    return seen;
};

/** `hasNext` against a scan of the whole log, for every head and a stranger. */
const expectHasNextExact = async (
    fs: SharedFsHandle,
    scope: ScopeDescriptor = NAMESPACE_V1
) => {
    const { store, ports } = await explainOf(fs, scope);
    const entries = await store.log.log.toArray();
    const named = new Set<string>();
    for (const entry of entries) {
        for (const next of entry.meta.next) named.add(next);
    }
    for (const entry of entries) {
        expect(await ports.hasNext(entry.hash), entry.hash).toBe(
            named.has(entry.hash)
        );
    }
    for (const head of named) {
        expect(await ports.hasNext(head), head).toBe(true);
    }
    expect(await ports.hasNext(randomHead())).toBe(false);
};

/** A fake operation as Documents hands it to `canPerform`. */
const putOperation = (
    value: unknown,
    head: string,
    signers: PublicSignKey[]
) => ({
    type: "put",
    value,
    entry: { hash: head, getPublicKeys: async () => signers },
});

/** A value decoded from the first log entry of `fs` of class `cls`. */
const valueOf = async <T>(
    fs: SharedFsHandle,
    cls: abstract new (...args: any[]) => T
): Promise<{ value: T; entry: any }> => {
    for (const entry of await entriesOf(fs).log.log.toArray()) {
        const payload: any = await entry.getPayloadValue();
        if (!(payload instanceof PutOperation)) continue;
        const value = deserialize(payload.data, SharedFsEntry);
        if (value instanceof cls) return { value: value as T, entry };
    }
    throw new Error(`no ${cls.name} in the log`);
};

/** A borsh copy of `value` with `patch` applied. */
const copyOf = <T extends SharedFsEntry>(value: T, patch: Partial<T>): T =>
    Object.assign(deserialize(serialize(value), SharedFsEntry) as T, patch);

describe("readiness ports", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        await stopTestPeers(peers);
        await Promise.all(
            roots
                .splice(0)
                .map((root) => rm(root, { recursive: true, force: true }))
        );
    });

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(
            directory ? { directory } : undefined
        );
        peers.push(peer);
        return peer;
    };
    const stopPeer = async (peer: Peerbit) => {
        peers.splice(peers.indexOf(peer), 1);
        await peer.stop();
    };
    const newRoot = async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-readiness-ports-")
        );
        roots.push(root);
        return root;
    };

    /** J opens `donor`'s address over a dial; `replicate: false` observes. */
    const joinFs = async (
        donorPeer: Peerbit,
        donor: SharedFsHandle,
        options: { replicate?: false; machineLabel?: string } = {}
    ) => {
        const peer = await createPeer();
        await peer.dial(donorPeer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donor.address,
            machineLabel: options.machineLabel ?? "joiner",
            gc: false,
            ...(options.replicate === false ? { replicate: false } : {}),
        } as any);
        return { peer, fs };
    };

    describe("inspect (SPEC2 4.1)", () => {
        it("1: a row's key and wall time are the tap's, for every namespace class, local puts and remote arrivals", async () => {
            const aPeer = await createPeer();
            const a = await openSharedFs({
                peerbit: aPeer,
                machineLabel: "a",
                gc: false,
            });
            const local = recordAdds(entriesOf(a));
            await a.writeFile("/x.txt", "one");
            await a.mkdir("/dir");
            await a.writeFile("/dir/y.txt", "two");
            await a.writeFile("/x.txt", "one, edited");
            await a.writeBatch(
                [
                    { path: "/turn/a.txt", content: "a" },
                    { path: "/turn/b.txt", content: "b" },
                ],
                { changesetId: "turn-1", manifest: true }
            );
            await a.rename("/dir/y.txt", "/dir/z.txt");
            await a.rm("/x.txt");
            await runtimeOf(a).namespace!.verifiesSettled();
            const seenLocal = await expectInspectMatches(
                a,
                NAMESPACE_V1,
                local.adds
            );
            local.stop();
            for (const name of [
                "NamingEvent",
                "FileVersion",
                "ChangesetManifest",
                "FileChunk",
                "BootstrapManifest",
            ]) {
                expect(seenLocal).toContain(name);
            }

            // Remote arrivals: values Documents decoded with its value
            // encoding, as the tap sees them on a joiner.
            const { fs: b } = await joinFs(aPeer, a, { machineLabel: "b" });
            const remote = recordAdds(entriesOf(b));
            await a.writeBatch(
                [
                    { path: "/turn2/c.txt", content: "c" },
                    { path: "/turn2/d/e.txt", content: "e" },
                ],
                { changesetId: "turn-2", manifest: true }
            );
            await a.writeFile("/late.txt", "late");
            // A CUT of a live row, as GC writes one: a superseded version
            // (the first of /x.txt, which its edit replaced). A CUT of a
            // content head would race Guard D on A, which puts the version
            // again under the same id with no link to the CUT. A joiner
            // that indexes that put first refuses the CUT for good
            // (Documents admits a delete of the indexed head or its
            // history only), so B would never hold all of A's heads, with
            // or without readiness pulls.
            const first = local.adds.find(
                (add) => add.value instanceof FileVersion
            )!;
            const [victim] = (await indexRows(a, NAMESPACE_V1)).filter(
                (row) => row.head === first.head
            );
            expect(victim).toBeDefined();
            const cut = await entriesOf(a).del(victim.key);
            const aHeads: string[] = (await entriesOf(a).log.log.toArray()).map(
                (entry: any) => entry.hash
            );
            await until(async () => {
                for (const hash of aHeads) {
                    expect(await entriesOf(b).log.log.has(hash)).toBe(true);
                }
                expect(runtimeOf(b).namespace!.count).toBe(
                    runtimeOf(a).namespace!.count
                );
            });
            await runtimeOf(b).namespace!.verifiesSettled();
            const remoteAdds = remote.adds;
            remote.stop();
            // Some arrivals were rows of every namespace class.
            const remoteClasses = new Set(
                remoteAdds
                    .filter((add) => NAMESPACE_V1.classify(add.value))
                    .map((add) => add.value!.constructor.name)
            );
            expect(remoteClasses).toEqual(
                new Set(["NamingEvent", "FileVersion", "ChangesetManifest"])
            );
            // No remote arrival carries the `kind` initializer (M0 P4), so
            // only the class can classify it.
            expect(
                remoteAdds.some((add) => (add.value as any).kind !== undefined)
            ).toBe(false);
            const seenRemote = await expectInspectMatches(
                b,
                NAMESPACE_V1,
                remoteAdds
            );
            expect(seenRemote).toContain("a delete");
            const { ports } = await explainOf(b);
            expect(await ports.inspect(cut.entry.hash)).toEqual({
                kind: "not-row",
                detail: "a delete",
            });
        });

        it("2: a CUT, a FileChunk and a BootstrapManifest are not rows; an absent head or a block never joined is undefined; nothing is read remotely", async () => {
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const { ports, store } = await explainOf(d);
            const chunk = await valueOf(d, FileChunk);
            expect(await ports.inspect(chunk.entry.hash)).toEqual({
                kind: "not-row",
                detail: "FileChunk",
            });
            const manifest = await valueOf(d, BootstrapManifest);
            expect(await ports.inspect(manifest.entry.hash)).toEqual({
                kind: "not-row",
                detail: "BootstrapManifest",
            });
            const version = await valueOf(d, FileVersion);
            const cut = await store.del(version.value.id);
            expect(cut.entry.meta.next).toEqual([version.entry.hash]);
            expect(await ports.inspect(cut.entry.hash)).toEqual({
                kind: "not-row",
                detail: "a delete",
            });
            // Documents removes a deleted put from its log: absent now,
            // superseded by the CUT that names it.
            expect(await store.log.log.has(version.entry.hash)).toBe(false);
            expect(await ports.inspect(version.entry.hash)).toBeUndefined();
            expect(await ports.hasNext(version.entry.hash)).toBe(true);

            const log = store.log.log;
            const get = vi.spyOn(log, "get");
            // An absent head: no read beyond the entry index.
            expect(await ports.inspect(randomHead())).toBeUndefined();
            expect(get).not.toHaveBeenCalled();

            // A block in J's block store that never entered J's log (G2-18):
            // `Log.get` alone would resolve it.
            const otherPeer = await createPeer();
            const other = await openSharedFs({
                peerbit: otherPeer,
                machineLabel: "other",
                gc: false,
            });
            await other.writeFile("/o.txt", "other");
            const foreign = await valueOf(other, FileVersion);
            const bytes = await entriesOf(other).log.log.blocks.get(
                foreign.entry.hash
            );
            expect(await log.blocks.put(bytes)).toBe(foreign.entry.hash);
            expect(await log.blocks.has(foreign.entry.hash)).toBe(true);
            expect(await log.get(foreign.entry.hash)).toBeDefined();
            get.mockClear();
            expect(await ports.inspect(foreign.entry.hash)).toBeUndefined();
            expect(get).not.toHaveBeenCalled();

            // Present heads are read with no options: no `remote`.
            await ports.inspect(version.entry.hash);
            await ports.inspect(cut.entry.hash);
            expect(get.mock.calls.length).toBeGreaterThan(0);
            for (const args of get.mock.calls) expect(args).toHaveLength(1);

            // A head only a connected donor holds: J (an observer, which
            // the donor does not push to) inspects it without fetching.
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            await d.writeFile("/b.txt", "beta");
            const donorOnly = (await indexRows(d, NAMESPACE_V1)).map(
                (row) => row.head
            );
            const jEntries = entriesOf(j);
            for (const head of donorOnly) {
                expect(await jEntries.log.log.has(head)).toBe(false);
            }
            const jBlocks = jEntries.log.remoteBlocks;
            expect(jEntries.log.log.blocks).toBe(jBlocks);
            const remoteReads = vi.spyOn(jBlocks, "_readFromPeers");
            const served = vi.spyOn(
                entriesOf(d).log.remoteBlocks,
                "handleFetchRequest"
            );
            const jPorts = (await explainOf(j)).ports;
            for (const head of donorOnly) {
                expect(await jPorts.inspect(head)).toBeUndefined();
            }
            expect(remoteReads).not.toHaveBeenCalled();
            expect(served).not.toHaveBeenCalled();
            // The spies see a fetch when one happens.
            await jEntries.log.join(donorOnly.slice(0, 1), { timeout: 10_000 });
            expect(served).toHaveBeenCalled();
            expect(await jPorts.inspect(donorOnly[0])).toMatchObject({
                kind: "row",
            });
        });

        it("3: an IdentityRelation of the trust graph is a row keyed by its id bytes, as the trust tap keys it; a revocation is not a row", async () => {
            const ownerPeer = await createPeer();
            const owner = await openSharedFs({
                peerbit: ownerPeer,
                machineLabel: "owner",
                rootKey: ownerPeer.identity.publicKey,
                gc: false,
            });
            const [k1, k2] = await Promise.all([
                Ed25519Keypair.create(),
                Ed25519Keypair.create(),
            ]);
            const local = recordAdds(trustStoreOf(owner));
            await owner.authorizeWriter(k1.publicKey);
            await owner.authorizeWriter(k2.publicKey);
            await owner.revokeWriter(k1.publicKey);
            await runtimeOf(owner).trust!.verifiesSettled();
            const seen = await expectInspectMatches(
                owner,
                TRUST_V1,
                local.adds
            );
            local.stop();
            expect(seen).toContain("IdentityRelation");
            expect(seen).toContain("a delete");
            // The revocation's CUT supersedes the relation it removed.
            await expectHasNextExact(owner, TRUST_V1);
            const { ports, tap, store } = await explainOf(owner, TRUST_V1);
            const relation = local.adds.find((add) =>
                (add.value as IdentityRelation).to.equals(k2.publicKey)
            )!;
            const facts = (await ports.inspect(relation.head)) as Extract<
                EntryFacts,
                { kind: "row" }
            >;
            expect(facts.key).toBeInstanceOf(Uint8Array);
            expect(
                equals(
                    facts.key as Uint8Array,
                    IdentityRelation.id(
                        k2.publicKey,
                        ownerPeer.identity.publicKey
                    )
                )
            ).toBe(true);
            expect(tapHolds(tap, facts.key, relation.head)).toBe(true);

            // Scopes are per log: a namespace head is absent from the trust
            // log and the other way round.
            const namespaceHead = (await entriesOf(owner).log.log.toArray())[0]
                .hash;
            expect(await ports.inspect(namespaceHead)).toBeUndefined();
            const namespacePorts = (await explainOf(owner)).ports;
            expect(await namespacePorts.inspect(relation.head)).toBeUndefined();
            // Classified by class: the namespace scope reads a trust value
            // as not a row of its own.
            const crossed = documentsExplainPorts(
                store,
                NAMESPACE_V1,
                tap.port
            );
            expect(await crossed.inspect(relation.head)).toEqual({
                kind: "not-row",
                detail: "IdentityRelation",
            });

            // Remote arrivals on a joiner's trust graph.
            const { fs: b } = await joinFs(ownerPeer, owner, {
                machineLabel: "trust-joiner",
            });
            const remote = recordAdds(trustStoreOf(b));
            const k3 = await Ed25519Keypair.create();
            await owner.authorizeWriter(k3.publicKey);
            await until(async () => {
                expect(
                    remote.adds.some((add) =>
                        (add.value as IdentityRelation).to.equals(k3.publicKey)
                    )
                ).toBe(true);
                expect(runtimeOf(b).trust!.count).toBe(
                    runtimeOf(owner).trust!.count
                );
            });
            await runtimeOf(b).trust!.verifiesSettled();
            await expectInspectMatches(b, TRUST_V1, remote.adds);
            remote.stop();
        });

        it("decodes nothing it cannot prove: decode failures, other operations and keyless values are unknown, never not-row", async () => {
            const wallTime = 7n;
            const put = (data: Uint8Array) => new PutOperation({ data });
            const naming = Object.assign(Object.create(NamingEvent.prototype), {
                id: "naming:x",
            });
            const keyless = Object.create(NamingEvent.prototype);
            const entries = new Map<string, LoggedEntry>();
            const entry = (payload: () => unknown, meta: any = undefined) => ({
                meta: meta ?? { clock: { timestamp: { wallTime } } },
                getPayloadValue: async () => payload(),
            });
            const decoded = new Map<string, unknown>([
                ["naming", naming],
                ["keyless", keyless],
                ["chunk", Object.create(FileChunk.prototype)],
            ]);
            const fakeStore = (
                has: (head: string) => boolean = (head) => entries.has(head)
            ): ExplainStore => ({
                log: {
                    log: {
                        has: async (head) => has(head),
                        get: async (head) => entries.get(head),
                        entryIndex: {
                            getHasNext: () => ({
                                next: async () => [],
                                close: async () => {},
                            }),
                        },
                    },
                },
                index: {
                    valueEncoding: {
                        decoder: (bytes) => {
                            const label = new TextDecoder().decode(bytes);
                            if (!decoded.has(label)) {
                                throw new Error(`cannot decode ${label}`);
                            }
                            return decoded.get(label);
                        },
                    },
                },
            });
            const bytes = (label: string) => new TextEncoder().encode(label);
            entries.set(
                "row",
                entry(() => put(bytes("naming")))
            );
            entries.set(
                "chunk",
                entry(() => put(bytes("chunk")))
            );
            entries.set(
                "garbage",
                entry(() => put(bytes("garbage")))
            );
            entries.set(
                "keyless",
                entry(() => put(bytes("keyless")))
            );
            entries.set(
                "throws",
                entry(() => {
                    throw new Error("Missing data");
                })
            );
            entries.set(
                "other-op",
                entry(() => ({ some: "operation" }))
            );
            entries.set(
                "cut",
                entry(() => new DeleteOperation({ key: {} as any }))
            );
            entries.set(
                "no-time",
                entry(() => put(bytes("naming")), { clock: {} })
            );
            const index: ScopeIndexPort = {
                readHead: async () => undefined,
                scan: async function* () {},
                count: async () => 0,
            };
            const ports = documentsExplainPorts(
                fakeStore(),
                NAMESPACE_V1,
                index
            );
            expect(await ports.inspect("row")).toEqual({
                kind: "row",
                key: "naming:x",
                wallTime,
            });
            expect(await ports.inspect("chunk")).toEqual({
                kind: "not-row",
                detail: "FileChunk",
            });
            expect(await ports.inspect("cut")).toEqual({
                kind: "not-row",
                detail: "a delete",
            });
            for (const head of [
                "garbage",
                "keyless",
                "throws",
                "other-op",
                "no-time",
            ]) {
                expect((await ports.inspect(head))?.kind, head).toBe("unknown");
            }
            // The entry index decides presence: `has` false is absent even
            // when `get` would resolve, and `has` true with `get` empty is
            // absent too (removed in between).
            const noHas = documentsExplainPorts(
                fakeStore(() => false),
                NAMESPACE_V1,
                index
            );
            expect(await noHas.inspect("row")).toBeUndefined();
            const removed = documentsExplainPorts(
                fakeStore(() => true),
                NAMESPACE_V1,
                index
            );
            expect(await removed.inspect("gone")).toBeUndefined();
            // A throwing log read reaches the explainer, which keeps the
            // hash pending (`unknown`), never a lie.
            const failing = documentsExplainPorts(
                {
                    ...fakeStore(),
                    log: {
                        log: {
                            ...fakeStore().log.log,
                            has: async () => {
                                throw new Error("index closed");
                            },
                        },
                    },
                },
                NAMESPACE_V1,
                index
            );
            await expect(failing.inspect("row")).rejects.toThrow(
                "index closed"
            );
            expect(await new Explainer(failing).beforePull(["row"])).toEqual([
                { kind: "unknown" },
            ]);
            // The tap keys the same values the same way.
            expect(scopeRowKey(NAMESPACE_V1, naming)).toBe("naming:x");
            expect(scopeRowKey(NAMESPACE_V1, keyless)).toBeUndefined();
            expect(scopeRowKey(NAMESPACE_V1, decoded.get("chunk"))).toBeNull();
        });
    });

    describe("hasNext and readHead (SPEC2 4.1)", () => {
        it("4: a CUT names its head, a childless head and a re-put have no child, and a reopen from disk keeps it", async () => {
            const directory = join(await newRoot(), "peer");
            let peer = await createPeer(directory);
            let fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "h",
                gc: false,
            });
            await fs.writeFile("/a.txt", "a");
            await fs.writeFile("/b.txt", "b");
            let { ports, store } = await explainOf(fs);
            const [row] = (await indexRows(fs, NAMESPACE_V1)).filter((r) =>
                (r.key as string).startsWith("version:")
            );
            expect(await ports.hasNext(row.head)).toBe(false);
            const entry = await store.log.log.get(row.head);
            const value = (await truthOf(entry, NAMESPACE_V1)) as any;
            expect(value.kind).toBe("row");
            const cut = await store.del(row.key);
            expect(await ports.hasNext(row.head)).toBe(true);
            expect(await ports.hasNext(cut.entry.hash)).toBe(false);
            // The recovery re-put of the same id (Guard D, GC): a new entry
            // that nothing names.
            const original = deserialize(
                (await entry.getPayloadValue()).data,
                SharedFsEntry
            );
            const reput = await store.put(original, { unique: true });
            expect(reput.entry.hash).not.toBe(row.head);
            expect(await ports.hasNext(reput.entry.hash)).toBe(false);
            expect(await ports.hasNext(row.head)).toBe(true);
            expect(await ports.hasNext(randomHead())).toBe(false);
            // Each call closes its iterator.
            const getHasNext = vi.spyOn(store.log.log.entryIndex, "getHasNext");
            await ports.hasNext(row.head);
            const iterator = getHasNext.mock.results[0].value;
            expect(getHasNext).toHaveBeenCalledWith(row.head, false);
            expect(iterator.done()).not.toBe(false);
            getHasNext.mockRestore();

            // `hasNext` is exactly "some entry of J's log names it in
            // `meta.next`", for every head J holds.
            await expectHasNextExact(fs);

            const address = fs.address!;
            await stopPeer(peer);
            peer = await createPeer(directory);
            fs = await openSharedFs({ peerbit: peer, address, gc: false });
            ({ ports } = await explainOf(fs));
            // From disk: the CUT still names the head it removed.
            expect(await ports.hasNext(row.head)).toBe(true);
            expect(await ports.inspect(cut.entry.hash)).toEqual({
                kind: "not-row",
                detail: "a delete",
            });
            expect(await ports.inspect(reput.entry.hash)).toEqual({
                kind: "row",
                key: row.key,
                wallTime: reput.entry.meta.clock.timestamp.wallTime,
            });
            // The open may re-put the version itself (a later put of the
            // same id names the re-put); whatever it wrote, the answer is
            // the log's.
            await expectHasNextExact(fs);
        });

        it("5: readHead is the tap port's answer, for present and absent ids", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "r",
                gc: false,
            });
            await fs.writeFile("/a.txt", "a");
            const { ports, tap } = await explainOf(fs);
            const readHead = vi.spyOn(tap.port, "readHead");
            for (const row of await indexRows(fs, NAMESPACE_V1)) {
                expect(await ports.readHead(row.key)).toEqual({
                    head: row.head,
                    modified: row.modified,
                });
            }
            expect(await ports.readHead("naming:absent")).toBeUndefined();
            expect(readHead).toHaveBeenCalledWith("naming:absent");
        });

        it("9: the newest-wins pin runs through the real ports: an older arrival J logged and Documents ignored is ignored-older", async () => {
            const jPeer = await createPeer();
            const j = await openSharedFs({
                peerbit: jPeer,
                machineLabel: "j",
                gc: false,
            });
            await j.writeFile("/a.txt", "a");
            const { fs: r } = await joinFs(jPeer, j, { machineLabel: "r" });
            const { ports, store } = await explainOf(j);
            const explainer = new Explainer(ports);
            const [row] = (await indexRows(j, NAMESPACE_V1)).filter((x) =>
                (x.key as string).startsWith("naming:")
            );
            await until(async () =>
                expect(await entriesOf(r).log.log.has(row.head)).toBe(true)
            );
            const value = deserialize(
                (await (await store.log.log.get(row.head)).getPayloadValue())
                    .data,
                SharedFsEntry
            );
            const at = (wallTime: bigint) => ({
                meta: { timestamp: new Timestamp({ wallTime }) },
            });
            // J indexes a newer put of the id (its next names the old head).
            const newer = await store.put(value, at(row.modified + 2_000_000n));
            expect((await ports.readHead(row.key))?.head).toBe(
                newer.entry.hash
            );
            // R puts an older one (`unique`: no next, any time), which
            // reaches J as a remote arrival and is compared.
            const older = await entriesOf(r).put(value, {
                ...at(row.modified + 1_000_000n),
                unique: true,
            });
            await until(async () =>
                expect(await store.log.log.has(older.entry.hash)).toBe(true)
            );
            expect((await ports.readHead(row.key))?.head).toBe(
                newer.entry.hash
            );
            expect(await ports.hasNext(older.entry.hash)).toBe(false);
            expect(await ports.inspect(older.entry.hash)).toEqual({
                kind: "row",
                key: row.key,
                wallTime: row.modified + 1_000_000n,
            });
            expect(await explainer.beforePull([older.entry.hash])).toEqual([
                { kind: "explained", reason: "ignored-older" },
            ]);
            expect(
                await explainer.afterPull([older.entry.hash], new Map())
            ).toEqual([{ kind: "explained", reason: "ignored-older" }]);
            // The indexed head is indexed; the head the newer put replaced
            // is superseded (its next names it).
            expect(
                await explainer.beforePull([newer.entry.hash, row.head])
            ).toEqual([
                { kind: "indexed", key: row.key },
                { kind: "explained", reason: "superseded" },
            ]);
            // A head J lacks is pulled; a FileChunk named as a row is a lie.
            const chunk = await valueOf(j, FileChunk);
            expect(
                await explainer.beforePull([randomHead(), chunk.entry.hash])
            ).toEqual([{ kind: "pull" }, { kind: "lie", detail: "FileChunk" }]);
        });
    });

    describe("pull ports (SPEC2 4.2)", () => {
        it("6: join fetches heads only a connected donor holds and indexes them; an unserved head settles within the timeout", async () => {
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            await d.writeBatch(
                [
                    { path: "/t/b.txt", content: "beta" },
                    { path: "/t/c.txt", content: "gamma" },
                ],
                { changesetId: "pull-turn", manifest: true }
            );
            const rows = await indexRows(d, NAMESPACE_V1);
            const heads = rows.map((row) => row.head);
            const jEntries = entriesOf(j);
            for (const head of heads) {
                expect(await jEntries.log.log.has(head)).toBe(false);
            }
            const jTap = (await scopeStateOf(j)).tap;
            const join = vi.spyOn(jEntries.log, "join");
            const rejections = new RejectionRecord();
            const queue = new PullQueue(
                sharedLogPullPorts(jEntries, jTap),
                rejections,
                { timeoutMs: 10_000 }
            );
            const report = await queue.pull("s1", heads);
            expect(report.error).toBeUndefined();
            expect(report.joined).toBe(heads.length);
            // One SharedLog.join per head, each landing at its first try,
            // with its share of the batch's one timeout (below) and the
            // queue's signal.
            expect(join).toHaveBeenCalledTimes(heads.length);
            expect(
                join.mock.calls.map(([joined]) => joined as string[])
            ).toEqual(expect.arrayContaining(heads.map((head) => [head])));
            for (const [, options] of join.mock.calls as any[]) {
                expect(options).toEqual({
                    timeout: expect.any(Number),
                    signal: expect.any(AbortSignal),
                });
                expect(options.timeout).toBeGreaterThan(0);
                expect(options.timeout).toBeLessThanOrEqual(10_000);
            }
            for (const head of heads) {
                expect(await jEntries.log.log.has(head)).toBe(true);
            }
            await until(() => {
                for (const row of rows) {
                    expect(tapHolds(jTap, row.key, row.head)).toBe(true);
                }
            });
            const explainer = new Explainer((await explainOf(j)).ports);
            const verdicts = await explainer.afterPull(
                heads,
                report.rejections
            );
            expect(
                verdicts.every((verdict) => verdict.kind === "indexed")
            ).toBe(true);
            queue.settled("s1", true);

            // Nobody serves this head: the join settles within its timeout,
            // and the head is fetch-failed.
            const unserved = randomHead();
            const short = new PullQueue(
                sharedLogPullPorts(jEntries, jTap),
                new RejectionRecord(),
                { timeoutMs: 300 }
            );
            const started = Date.now();
            const missing = await short.pull("s2", [unserved]);
            expect(Date.now() - started).toBeLessThan(5_000);
            expect(missing.heads).toEqual([unserved]);
            expect(await jEntries.log.log.has(unserved)).toBe(false);
            expect(
                await explainer.afterPull([unserved], missing.rejections)
            ).toEqual([{ kind: "failed" }]);
            queue.dispose();
            short.dispose();
        });

        it("6: a batch of heads nobody serves settles within about one timeout, and a served head in it lands with it (design 4.9)", async () => {
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            await d.writeFile("/b.txt", "beta");
            const served = (await indexRows(d, NAMESPACE_V1)).map(
                (row) => row.head
            );
            const jEntries = entriesOf(j);
            const fresh: string[] = [];
            for (const head of served) {
                if (!(await jEntries.log.log.has(head))) fresh.push(head);
            }
            expect(fresh.length).toBeGreaterThan(0);
            const unserved = Array.from({ length: 6 }, () => randomHead());
            const timeoutMs = 1_000;
            const queue = new PullQueue(
                sharedLogPullPorts(jEntries, (await scopeStateOf(j)).tap),
                new RejectionRecord(),
                { timeoutMs }
            );
            // s1's batch: the unserved heads, then the served ones. s2 asks
            // only for a served head, so it rides on s1's batch.
            const started = Date.now();
            const [own, rider] = await Promise.all([
                queue.pull("s1", [...unserved, ...fresh]).then((report) => ({
                    report,
                    ms: Date.now() - started,
                })),
                queue.pull("s2", [fresh[0]]).then((report) => ({
                    report,
                    ms: Date.now() - started,
                })),
            ]);
            // In one SharedLog.join the heads are fetched one after another,
            // each waiting the whole timeout: 6 s here, not about 1 s.
            expect(own.ms).toBeLessThan(3 * timeoutMs);
            expect(rider.ms).toBeLessThan(3 * timeoutMs);
            expect(own.report.joined).toBe(unserved.length + fresh.length);
            expect(rider.report.joined).toBe(0);
            for (const head of fresh) {
                expect(await jEntries.log.log.has(head)).toBe(true);
            }
            for (const head of unserved) {
                expect(await jEntries.log.log.has(head)).toBe(false);
            }
            queue.dispose();
        });

        it("6: joins on at most PULL_LANES lanes, shared by every batch of the store, one head per join", async () => {
            let active = 0;
            let most = 0;
            const calls: string[][] = [];
            const landed = new Set<string>();
            const store: PullStore = {
                log: {
                    join: async (heads) => {
                        calls.push(heads);
                        active++;
                        most = Math.max(most, active);
                        await new Promise((resolve) => setImmediate(resolve));
                        for (const head of heads) landed.add(head);
                        active--;
                    },
                    log: { has: async (head) => landed.has(head) },
                },
            };
            const ports = sharedLogPullPorts(store, {
                addSink: () => () => {},
            });
            const signal = new AbortController().signal;
            const a = Array.from({ length: 10 }, () => randomHead());
            const b = Array.from({ length: 5 }, () => randomHead());
            await Promise.all([
                ports.join(a, { timeout: 10_000, signal }),
                ports.join(b, { timeout: 10_000, signal }),
            ]);
            // Side by side these were 15 at once (A2), each a background
            // block request every other replica proxies (below).
            expect(PULL_LANES).toBe(2);
            expect(most).toBe(PULL_LANES);
            expect(calls.every((heads) => heads.length === 1)).toBe(true);
            expect(calls.flat().sort()).toEqual([...a, ...b].sort());
        });

        it("6: a batch ends at one deadline: each join gets its share of the time left, a head J's log still lacks gets one more try, an overrun leaves the rest unstarted", async () => {
            let now = 0;
            const calls: Array<{ head: string; timeout: number }> = [];
            const landed = new Set<string>();
            const served = new Set<string>();
            // Wall time a join takes, in multiples of its timeout: an
            // unserved head waits it out (no provider answers "not here"),
            // an overrun waits again for a missing parent (`Log.join`
            // fetches each with the same timeout, @peerbit/log
            // log.js:3926-3936).
            const overruns = new Map<string, number>();
            let abortAt: string | undefined;
            const controller = new AbortController();
            const store: PullStore = {
                log: {
                    join: async ([head], { timeout }) => {
                        calls.push({ head, timeout });
                        await Promise.resolve();
                        if (head === abortAt) {
                            controller.abort(new Error("disposed"));
                        }
                        if (served.has(head)) {
                            now += 1;
                            landed.add(head);
                        } else {
                            now += timeout * (overruns.get(head) ?? 1);
                        }
                    },
                    log: { has: async (head) => landed.has(head) },
                },
            };
            const ports = sharedLogPullPorts(
                store,
                { addSink: () => () => {} },
                { lanes: 1, now: () => now }
            );
            const signal = controller.signal;

            // One lane, 100 ms: two unserved heads, then two served ones.
            // Each join gets the time left over the heads still to start
            // (its own included); the unserved ones go again at the end.
            const [u1, u2, s1, s2] = Array.from({ length: 4 }, () =>
                randomHead()
            );
            served.add(s1).add(s2);
            await ports.join([u1, u2, s1, s2], { timeout: 100, signal });
            expect(calls).toEqual([
                { head: u1, timeout: 25 },
                { head: u2, timeout: 18 },
                { head: s1, timeout: 14 },
                { head: s2, timeout: 18 },
                { head: u1, timeout: 27 },
                { head: u2, timeout: 28 },
            ]);
            expect(now).toBe(100);

            // A join that overruns its share leaves the deadline behind:
            // the heads it kept from starting fail the batch, which names
            // them, and no join starts after the deadline.
            calls.length = 0;
            now = 0;
            const [o1, s3, s4] = Array.from({ length: 3 }, () => randomHead());
            served.add(s3).add(s4);
            overruns.set(o1, 4);
            await expect(
                ports.join([o1, s3, s4], { timeout: 100, signal })
            ).rejects.toThrow(/2 of 3 heads/);
            expect(calls).toEqual([{ head: o1, timeout: 33 }]);
            expect(landed.has(s3)).toBe(false);

            // An abort (the queue's dispose) starts nothing more and fails
            // the batch with its reason.
            calls.length = 0;
            now = 0;
            const [a1, a2, a3] = Array.from({ length: 3 }, () => randomHead());
            abortAt = a1;
            await expect(
                ports.join([a1, a2, a3], { timeout: 100, signal })
            ).rejects.toThrow("disposed");
            expect(calls.map((call) => call.head)).toEqual([a1]);
            await expect(
                ports.join([a2], { timeout: 100, signal })
            ).rejects.toThrow("disposed");
            expect(calls.map((call) => call.head)).toEqual([a1]);
        });

        it("6: pulls of heads nobody serves leave block reads between the other replicas fast (three replicas)", async () => {
            // A replica that lacks a requested block proxies the request to
            // the other replicas for the requester's remaining time, on one
            // of its log's 9 background slots, and no provider answers "not
            // here" (@peerbit/blocks remote.js:183-191, 843-882). Side by
            // side, J's 16 unserved heads held every slot of D and E past
            // the batch, and E's reads from D took 6-9 s (pr3-commit2
            // probes-pull-sync). With two peers the requests have nowhere
            // to cycle: the third replica is the case.
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const ePeer = await createPeer();
            await ePeer.dial(dPeer);
            const e = await openSharedFs({
                peerbit: ePeer,
                address: d.address,
                machineLabel: "e",
                gc: false,
            } as any);
            const jPeer = await createPeer();
            await jPeer.dial(dPeer);
            await jPeer.dial(ePeer);
            const j = await openSharedFs({
                peerbit: jPeer,
                address: d.address,
                machineLabel: "j",
                gc: false,
            } as any);
            await Promise.all(
                [e, j].map((fs) => fs.awaitWriteReady({ timeout: 60_000 }))
            );
            const blocksOf = (fs: SharedFsHandle) =>
                entriesOf(fs).log.remoteBlocks;
            /** An ordinary (background) read of a block only `holder` has. */
            const read = async (
                reader: SharedFsHandle,
                holder: SharedFsHandle,
                holderPeer: Peerbit
            ) => {
                const cid: string = await blocksOf(holder).put(randomBytes(64));
                const started = Date.now();
                const bytes = await blocksOf(reader).get(cid, {
                    remote: {
                        timeout: 30_000,
                        from: [holderPeer.identity.publicKey.hashcode()],
                    },
                });
                expect(bytes).toBeDefined();
                return Date.now() - started;
            };
            const both = async () => [
                await read(e, d, dPeer),
                await read(d, e, ePeer),
            ];
            const baseline = await both();

            const timeout = 10_000;
            const ports = sharedLogPullPorts(
                entriesOf(j),
                (await scopeStateOf(j)).tap
            );
            const started = Date.now();
            const pulling = ports
                .join(
                    Array.from({ length: 16 }, () => randomHead()),
                    { timeout, signal: new AbortController().signal }
                )
                .then(
                    () => Date.now() - started,
                    () => Date.now() - started
                );
            const at = (ms: number) =>
                new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        Math.max(0, ms - (Date.now() - started))
                    )
                );
            const reads: number[] = [];
            for (const ms of [1_000, 4_000, 8_000]) {
                await at(ms);
                reads.push(...(await both()));
            }
            const pulled = await pulling;
            // Side by side, the proxies outlived the batch by seconds.
            await at(12_000);
            reads.push(...(await both()));
            console.log(
                "[readiness-ports] reads during 16 unserved pulls " +
                    JSON.stringify({ baseline, reads, pulled })
            );
            // One deadline for the batch, and the replicas kept serving.
            expect(pulled).toBeLessThan(timeout + 5_000);
            for (const ms of reads) expect(ms).toBeLessThan(1_500);
        });

        it("6: a refused pull records its reason through the real canPerformEntry hook: structure, and an untrusted signer", async () => {
            // A donor that accepts what J refuses: its own canPerformEntry
            // is bypassed for the test.
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                rootKey: dPeer.identity.publicKey,
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            programOf(d).canPerformEntry = async () => true;
            const naming = await valueOf(d, NamingEvent);
            // Structurally invalid: an id without the naming prefix.
            const invalid = await entriesOf(d).put(
                copyOf(naming.value, { id: "not-a-naming-id" } as any),
                { unique: true }
            );
            // Structurally valid, signed by a key J does not trust.
            const stranger = await Ed25519Keypair.create();
            const untrusted = await entriesOf(d).put(
                copyOf(naming.value, {
                    id: `naming:${sha256Base64Sync(randomBytes(8))}`,
                } as any),
                { unique: true, signers: [stranger.sign.bind(stranger)] }
            );
            expect(
                untrusted.entry.signatures.map((s: any) =>
                    s.publicKey.hashcode()
                )
            ).toEqual([stranger.publicKey.hashcode()]);

            const bundle = runtimeOf(j).sessionScope(SCOPE_NAMESPACE_V1)!;
            expect(bundle).toBeDefined();
            const heads = [invalid.entry.hash, untrusted.entry.hash];
            const report = await bundle.pulls.pull("s", heads);
            expect(report.rejections.get(invalid.entry.hash)).toEqual({
                reason: "structure",
                permanent: true,
            });
            // A trust refusal names its signers (PR-3 commit 3).
            const { signers, ...refusal } = report.rejections.get(
                untrusted.entry.hash
            )!;
            expect(refusal).toEqual(rejectionOf("untrusted"));
            expect(hashesOf(signers)).toEqual([stranger.publicKey.hashcode()]);
            for (const head of heads) {
                expect(await entriesOf(j).log.log.has(head)).toBe(false);
            }
            // Released with the batch: a later refusal starts unrecorded.
            expect(bundle.rejections.size).toBe(0);
            const verdicts = await bundle.explainer.afterPull(
                heads,
                report.rejections
            );
            expect(verdicts).toHaveLength(2);
            expect(verdicts[0]).toEqual({
                kind: "explained",
                reason: "rejected-structure",
            });
            expect(verdicts[1]).toEqual({
                kind: "trust-pending",
                reason: "untrusted",
                signers: expect.any(Array),
            });
            expect(hashesOf((verdicts[1] as any).signers)).toEqual([
                stranger.publicKey.hashcode(),
            ]);
            bundle.pulls.settled("s", false);
        });

        it("7: subscribe calls back once per microtask of changes and on a re-seed; its removal detaches", async () => {
            const rows = new Map<string, IndexedHead>();
            const port: ScopeIndexPort = {
                readHead: async (key) => rows.get(key as string),
                scan: async function* () {
                    yield [...rows].map(([key, row]) => ({ key, ...row }));
                },
                count: async () => rows.size,
            };
            const tap = new ScopeTap(NAMESPACE_V1, port);
            await tap.seedChecked();
            const naming = (id: string, head: string) => {
                rows.set(id, { head, modified: 1n });
                return Object.assign(Object.create(NamingEvent.prototype), {
                    id,
                    __context: { head, modified: 1n },
                });
            };
            const change = (added: unknown[], removed: unknown[] = []) => ({
                detail: { added, removed },
            });
            const pull = sharedLogPullPorts(
                {
                    log: {
                        join: async () => {},
                        log: { has: async () => true },
                    },
                },
                tap
            );
            let calls = 0;
            const remove = pull.subscribe!(() => calls++);
            const microtasks = async () => {
                for (let i = 0; i < 5; i++) await Promise.resolve();
            };
            // Three adds in one event and two more events: one call.
            tap.onChange(
                change([
                    naming("a", randomHead()),
                    naming("b", randomHead()),
                    naming("c", randomHead()),
                ])
            );
            tap.onChange(change([naming("d", randomHead())]));
            tap.onChange(change([naming("e", randomHead())]));
            expect(calls).toBe(0);
            await microtasks();
            expect(calls).toBe(1);
            // A removal is an index change too (a CUT may supersede a head
            // whose fetch failed).
            const gone = rows.get("a")!;
            rows.delete("a");
            tap.onChange(
                change(
                    [],
                    [
                        Object.assign(Object.create(NamingEvent.prototype), {
                            id: "a",
                            __context: gone,
                        }),
                    ]
                )
            );
            await microtasks();
            expect(calls).toBe(2);
            // Events out of scope change nothing.
            tap.onChange(change([Object.create(FileChunk.prototype)]));
            await microtasks();
            expect(calls).toBe(2);
            // A re-seed: its reset, then the rows it applies again.
            await tap.reseed();
            await microtasks();
            expect(calls).toBeGreaterThanOrEqual(3);
            expect(calls).toBeLessThanOrEqual(4);
            // A re-seed of an empty index: the reset alone.
            const empty = new ScopeTap(NAMESPACE_V1, {
                ...port,
                scan: async function* () {},
                count: async () => 0,
            });
            await empty.seedChecked();
            let resets = 0;
            sharedLogPullPorts(
                {
                    log: {
                        join: async () => {},
                        log: { has: async () => true },
                    },
                },
                empty
            ).subscribe!(() => resets++);
            await empty.reseed();
            await microtasks();
            expect(resets).toBe(1);
            empty.dispose();
            const before = calls;
            remove();
            remove();
            tap.onChange(change([naming("f", randomHead())]));
            await microtasks();
            expect(calls).toBe(before);
            // A removal between the change and its microtask calls nothing.
            const late = pull.subscribe!(() => calls++);
            tap.onChange(change([naming("g", randomHead())]));
            late();
            await microtasks();
            expect(calls).toBe(before);
            tap.dispose();

            // On a filesystem: a write is an index change of the scope.
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "s",
                gc: false,
            });
            const state = await scopeStateOf(fs);
            let fsCalls = 0;
            const off = sharedLogPullPorts(entriesOf(fs), state.tap).subscribe!(
                () => fsCalls++
            );
            await fs.writeFile("/a.txt", "a");
            await until(() => expect(fsCalls).toBeGreaterThan(0));
            off();
        });
    });

    describe("sessionScopeOf (SPEC2 4.3)", () => {
        it("binds the runtime scope's tap, lane set, log id and store, and its dispose detaches the queue", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "b",
                gc: false,
            });
            await fs.writeFile("/a.txt", "a");
            const state = await scopeStateOf(fs);
            const runtime = runtimeOf(fs);
            const store = entriesOf(fs) as ExplainStore & PullStore;
            const bundle = sessionScopeOf(state, store, runtime.cellKey, {
                pull: { timeoutMs: 1_000 },
            });
            expect(bundle.id).toBe(SCOPE_NAMESPACE_V1);
            expect(bundle.ports.id).toBe(SCOPE_NAMESPACE_V1);
            expect(bundle.ports.logId).toBe(state.logId);
            expect(bundle.ports.pulls).toBe(bundle.pulls);
            expect(bundle.ports.explain).toBe(bundle.explainer);
            expect(bundle.pulls.rejections).toBe(bundle.rejections);
            expect(bundle.pulls.timeoutMs).toBe(1_000);
            expect(bundle.ports.local.cellKey).toEqual(runtime.cellKey);
            expect(bundle.ports.local.count).toBe(state.tap.count);
            expect(bundle.ports.local.epoch).toBe(state.tap.epoch);
            expect(await bundle.ports.local.confirmTrusted()).toBe(true);
            // The explainer reads this store and this tap's index port.
            const [row] = await indexRows(fs, NAMESPACE_V1);
            expect(await bundle.explainer.beforePull([row.head])).toEqual([
                { kind: "indexed", key: row.key },
            ]);
            // The queue listens on the tap until dispose.
            const retry = vi.spyOn(bundle.pulls, "noteIndexChange");
            await fs.writeFile("/b.txt", "b");
            await until(() => expect(retry).toHaveBeenCalled());
            bundle.dispose();
            bundle.dispose();
            retry.mockClear();
            await fs.writeFile("/c.txt", "c");
            await runtimeOf(fs).namespace!.verifiesSettled();
            for (let i = 0; i < 5; i++) await Promise.resolve();
            expect(retry).not.toHaveBeenCalled();
            const after = await bundle.pulls.pull("late", [row.head]);
            expect(String(after.error)).toMatch(/disposed/);
        });

        it("a close aborts the runtime's pulls in flight and lets them settle before the store closes", async () => {
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                gc: false,
            });
            await d.writeFile("/a.txt", "alpha");
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            const jEntries = entriesOf(j);
            await scopeStateOf(j);
            const bundle = runtimeOf(j).sessionScope(SCOPE_NAMESPACE_V1)!;
            // A pull whose join is still running (a commit, say) when the
            // filesystem closes: it ends only once its signal aborted.
            const held = randomHead();
            const log = jEntries.log;
            const join = log.join;
            let aborted = false;
            let settled = false;
            vi.spyOn(log, "join").mockImplementation(((
                heads: string[],
                options: { signal?: AbortSignal }
            ) => {
                if (heads.length !== 1 || heads[0] !== held) {
                    return join.call(log, heads, options);
                }
                return new Promise<void>((resolve) => {
                    const end = () => {
                        settled = true;
                        resolve();
                    };
                    options.signal?.addEventListener("abort", () => {
                        aborted = true;
                        setTimeout(end, 200);
                    });
                    // Never left running past the test.
                    setTimeout(end, 5_000);
                });
            }) as any);
            const close = log.close;
            const settledAtClose: boolean[] = [];
            vi.spyOn(log, "close").mockImplementation(function (
                this: unknown,
                ...args: unknown[]
            ) {
                settledAtClose.push(settled);
                return close.apply(this, args);
            } as any);

            const report = bundle.pulls.pull("s", [held]);
            await until(() =>
                expect(log.join).toHaveBeenCalledWith(
                    [held],
                    expect.objectContaining({ signal: expect.any(AbortSignal) })
                )
            );
            expect(await j.program.close()).toBe(true);
            expect(aborted).toBe(true);
            expect(settledAtClose.length).toBeGreaterThan(0);
            expect(settledAtClose.every(Boolean)).toBe(true);
            expect((await report).error).toBeUndefined();
        });

        it("rejectionOf: only a structural refusal is permanent", () => {
            const reasons: RejectionReason[] = [
                "structure",
                "untrusted",
                "trust-cache",
                "transient",
            ];
            expect(reasons.map((reason) => rejectionOf(reason))).toEqual([
                { reason: "structure", permanent: true },
                { reason: "untrusted", permanent: false },
                { reason: "trust-cache", permanent: false },
                { reason: "transient", permanent: false },
            ]);
            // The record copies what it keeps, so shared objects are safe.
            const record = new RejectionRecord();
            record.track(["h"]);
            record.note("h", rejectionOf("structure"));
            expect(record.take(["h"]).get("h")).not.toBe(
                rejectionOf("structure")
            );
        });

        it("P1: rejectionOf carries a trust refusal's signers in a new object; other refusals, and none, keep the shared one", async () => {
            const key = (await Ed25519Keypair.create()).publicKey;
            for (const reason of ["untrusted", "trust-cache"] as const) {
                const named = rejectionOf(reason, [key]);
                expect(named).toEqual({
                    reason,
                    permanent: false,
                    signers: [key],
                });
                expect(named).not.toBe(rejectionOf(reason));
                expect(rejectionOf(reason, [key])).not.toBe(named);
                expect(rejectionOf(reason, [])).toBe(rejectionOf(reason));
                expect(rejectionOf(reason)).not.toHaveProperty("signers");
            }
            for (const reason of ["structure", "transient"] as const) {
                expect(rejectionOf(reason, [key])).toBe(rejectionOf(reason));
            }
        });
    });

    describe("canPerformEntry split (SPEC2 4.4)", () => {
        /**
         * Each crafted operation is refused (the boolean is unchanged), and
         * the head a pull tracks carries the reason of the check that
         * refused it. An access-controlled store owned by J, so the trust
         * checks run.
         */
        it("8: every refusal site records its own reason; an untracked head records nothing", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "split",
                rootKey: peer.identity.publicKey,
                gc: false,
            });
            await fs.mkdir("/dir");
            await fs.writeBatch([{ path: "/dir/a.txt", content: "a" }], {
                changesetId: "split-turn",
                manifest: true,
            });
            await runtimeOf(fs).whenStarted();
            const program = programOf(fs);
            const owner = peer.identity.publicKey;
            const bundle = runtimeOf(fs).sessionScope(SCOPE_NAMESPACE_V1)!;
            const stranger = await Ed25519Keypair.create();

            /**
             * Refused, with `reason` noted for the tracked head; a trust
             * refusal names `signers`, by default every entry signer (the
             * keys whose trust would reverse it).
             */
            const refused = async (
                operation: ReturnType<typeof putOperation>,
                reason: RejectionReason | undefined,
                during?: () => void,
                signers?: PublicSignKey[]
            ) => {
                const head = operation.entry.hash;
                bundle.rejections.track([head]);
                try {
                    const verdict = program.canPerformEntry(operation);
                    during?.();
                    expect(await verdict).toBe(reason === undefined);
                    const noted = bundle.rejections.take([head]).get(head);
                    if (reason === undefined) {
                        expect(noted).toBeUndefined();
                        return;
                    }
                    const { signers: named, ...rest } = noted!;
                    expect(rest).toEqual(rejectionOf(reason));
                    expect(hashesOf(named)).toEqual(
                        reason === "untrusted" || reason === "trust-cache"
                            ? hashesOf(
                                  signers ??
                                      (await operation.entry.getPublicKeys())
                              )
                            : undefined
                    );
                } finally {
                    bundle.rejections.release([head]);
                }
            };
            const op = (value: unknown, signers: PublicSignKey[] = [owner]) =>
                putOperation(value, randomHead(), signers);

            // Accepted controls record nothing.
            const naming = await valueOf(fs, NamingEvent);
            await refused(op(naming.value), undefined);
            const dirNaming = (
                await Promise.all(
                    (await entriesOf(fs).log.log.toArray()).map(
                        async (entry: any) => {
                            const payload = await entry.getPayloadValue();
                            if (!(payload instanceof PutOperation)) return;
                            const value = deserialize(
                                payload.data,
                                SharedFsEntry
                            );
                            return value instanceof NamingEvent &&
                                value.nodeId.startsWith("dir:")
                                ? value
                                : undefined;
                        }
                    )
                )
            ).find(Boolean)!;
            expect(dirNaming).toBeDefined();
            const manifest = await valueOf(fs, BootstrapManifest);
            await refused(op(manifest.value), undefined);
            const changeset = await valueOf(fs, ChangesetManifest);
            await refused(op(changeset.value), undefined);

            // 4466: the pre-open probe's generation moved during its await.
            const previous = program.preOpenContent;
            const marker = {
                generation: program.openGeneration,
                probe: Promise.resolve(false),
            };
            program.preOpenContent = marker;
            try {
                await refused(op(naming.value), "transient", () => {
                    marker.generation = -1;
                });
            } finally {
                program.preOpenContent = previous;
            }

            // 4490 structurallyValidEntry, 4503 a sealed directory name.
            await refused(
                op(copyOf(naming.value, { id: "bad" } as any)),
                "structure"
            );
            await refused(
                op(copyOf(dirNaming, { name: "node_modules" } as any)),
                "structure"
            );

            // BootstrapManifest: 4515 cap, 4529 decode, 4537 id / store /
            // signature, 4543 an untrusted inner signer.
            const bm = manifest.value;
            await refused(
                op(
                    copyOf(bm, {
                        payloadBytes: new Uint8Array(100_001),
                    } as any)
                ),
                "structure"
            );
            await refused(
                op(copyOf(bm, { signatureBytes: randomBytes(9) } as any)),
                "structure"
            );
            await refused(
                op(copyOf(bm, { id: "bootstrap:someone-else" } as any)),
                "structure"
            );
            const strangerSignature = await stranger.sign(bm.payloadBytes);
            // The inner signer is the one whose trust would reverse it.
            await refused(
                op(
                    copyOf(bm, {
                        id: `bootstrap:${encodePublicSignKey(stranger.publicKey)}`,
                        signatureBytes: serialize(strangerSignature),
                    } as any)
                ),
                "untrusted",
                undefined,
                [stranger.publicKey]
            );

            // ChangesetManifest: 4556 cap, 4570 decode, the split `||`, and
            // 4599 an untrusted inner signer.
            const cm = changeset.value;
            const payload = deserialize(
                cm.payloadBytes,
                ChangesetManifestPayload
            );
            /** A manifest of `patch`ed payload, signed by `signer`. */
            const signedManifest = async (
                patch: Partial<ChangesetManifestPayload>,
                signer: {
                    sign(bytes: Uint8Array): Promise<any>;
                } = peer.identity,
                mirrors: Partial<ChangesetManifest> = {}
            ) => {
                const next = Object.assign(
                    deserialize(serialize(payload), ChangesetManifestPayload),
                    patch
                );
                const payloadBytes = serialize(next);
                const signature = await signer.sign(payloadBytes);
                return copyOf(cm, {
                    id: `changeset-manifest:${sha256Base64Sync(payloadBytes)}`,
                    changesetId: next.changesetId,
                    authorKey: encodePublicSignKey(signature.publicKey),
                    createdAtWallMs: next.createdAtWallMs,
                    payloadBytes,
                    signatureBytes: serialize(signature),
                    ...mirrors,
                } as any);
            };
            // The rebuilt control is accepted.
            await refused(op(await signedManifest({})), undefined);
            await refused(
                op(
                    copyOf(cm, {
                        payloadBytes: new Uint8Array(460_801),
                    } as any)
                ),
                "structure"
            );
            await refused(
                op(copyOf(cm, { payloadBytes: randomBytes(5) } as any)),
                "structure"
            );
            // Structure terms of the split condition.
            await refused(
                op(copyOf(cm, { id: "changeset-manifest:other" } as any)),
                "structure"
            );
            await refused(
                op(await signedManifest({ storeId: new Uint8Array(32) })),
                "structure"
            );
            await refused(
                op(
                    await signedManifest({}, peer.identity, {
                        changesetId: "x",
                    })
                ),
                "structure"
            );
            const future = BigInt(Date.now() + 2 * 3_600_000);
            // The clock-skew term alone: transient (a later clock reverses
            // it).
            await refused(
                op(await signedManifest({ createdAtWallMs: future })),
                "transient"
            );
            // The clock and a structure term: structure wins.
            await refused(
                op(
                    await signedManifest(
                        { createdAtWallMs: future },
                        peer.identity,
                        { changesetId: "x" }
                    )
                ),
                "structure"
            );
            // The signature term: structure.
            const otherSignature = await peer.identity.sign(randomBytes(16));
            await refused(
                op(
                    copyOf(await signedManifest({}), {
                        signatureBytes: serialize(otherSignature),
                    } as any)
                ),
                "structure"
            );
            await refused(
                op(await signedManifest({}, stranger)),
                "untrusted",
                undefined,
                [stranger.publicKey]
            );

            // 4604: the trust state moved during an inner signer check.
            const trustGraph = program.trustGraph;
            const isTrusted = trustGraph.isTrusted.bind(trustGraph);
            trustGraph.isTrusted = async (key: PublicSignKey) => {
                program.trustVerdictEpoch++;
                return isTrusted(key);
            };
            try {
                await refused(op(manifest.value), "transient");
            } finally {
                delete trustGraph.isTrusted;
            }
            // 4611: it moved while the entry's keys were read.
            await refused(
                putOperation(naming.value, randomHead(), [owner]),
                undefined
            );
            const moving = putOperation(naming.value, randomHead(), [owner]);
            moving.entry.getPublicKeys = async () => {
                program.trustVerdictEpoch++;
                return [owner];
            };
            await refused(moving, "transient");
            // 4638: it moved during a signer's trust check.
            program.trustVerdicts.clear();
            trustGraph.isTrusted = async (key: PublicSignKey) => {
                program.trustVerdictEpoch++;
                return isTrusted(key);
            };
            try {
                await refused(op(naming.value), "transient");
            } finally {
                delete trustGraph.isTrusted;
            }
            // 4653: no signer trusted. Judged now: untrusted. Only the 1 s
            // negative cache: trust-cache. Both: untrusted.
            program.trustVerdicts.delete(stranger.publicKey.hashcode());
            await refused(op(naming.value, [stranger.publicKey]), "untrusted");
            expect(
                program.trustVerdicts.get(stranger.publicKey.hashcode())?.ok
            ).toBe(false);
            await refused(
                op(naming.value, [stranger.publicKey]),
                "trust-cache"
            );
            const another = await Ed25519Keypair.create();
            await refused(
                op(naming.value, [stranger.publicKey, another.publicKey]),
                "untrusted"
            );
            // A delete (CUT) is judged by its signers alone.
            const deletion = (signers: PublicSignKey[]) => ({
                ...op(undefined, signers),
                type: "delete",
            });
            await refused(deletion([owner]), undefined);
            const deleter = await Ed25519Keypair.create();
            await refused(deletion([deleter.publicKey]), "untrusted");

            // An untracked head records nothing (one lookup).
            const untracked = op(copyOf(naming.value, { id: "bad" } as any));
            expect(await program.canPerformEntry(untracked)).toBe(false);
            expect(bundle.rejections.tracked(untracked.entry.hash)).toBe(false);
            expect(bundle.rejections.size).toBe(0);
            // The strongest reason of a head refused twice is kept.
            const twice = randomHead();
            bundle.rejections.track([twice]);
            await program.canPerformEntry(
                putOperation(
                    copyOf(naming.value, { id: "bad" } as any),
                    twice,
                    [owner]
                )
            );
            await program.canPerformEntry(
                putOperation(naming.value, twice, [stranger.publicKey])
            );
            expect(bundle.rejections.take([twice]).get(twice)).toEqual(
                rejectionOf("structure")
            );
            bundle.rejections.release([twice]);
        });
    });

    describe("trust graph notes (SPEC3 5)", () => {
        /** A put of `relation` as Documents hands it to `canPerform`. */
        const relationPut = (
            relation: IdentityRelation,
            signers: PublicSignKey[],
            head = randomHead(),
            keysRead: Promise<void> = Promise.resolve()
        ) => ({
            type: "put",
            value: relation,
            entry: {
                hash: head,
                getPublicKeys: async () => {
                    await keysRead;
                    return signers;
                },
            },
        });

        it("P3: the trust graph's own refusals reach J's trust bundle through a real pull: an untrusted owner, a relation its owner never signed; accepted puts and deletes note nothing; the boolean is the prototype's", async () => {
            const dPeer = await createPeer();
            const d = await openSharedFs({
                peerbit: dPeer,
                machineLabel: "d",
                rootKey: dPeer.identity.publicKey,
                gc: false,
            });
            const { fs: j } = await joinFs(dPeer, d, {
                replicate: false,
                machineLabel: "observer",
            });
            const owner = dPeer.identity.publicKey;
            const [stranger, x, y, z] = await Promise.all(
                [0, 1, 2, 3].map(() => Ed25519Keypair.create())
            );
            // A donor that keeps what J refuses: its trust store's
            // canPerform is bypassed for the test.
            const dTrust = trustStoreOf(d);
            dTrust._optionCanPerform = async () => true;
            // Owned and signed by a key J's graph does not trust.
            const owned = await dTrust.put(
                new IdentityRelation({
                    from: stranger.publicKey,
                    to: x.publicKey,
                }),
                { signers: [stranger.sign.bind(stranger)] }
            );
            // Owned by the stranger, signed by D: its owner never signed it.
            const forged = await dTrust.put(
                new IdentityRelation({
                    from: stranger.publicKey,
                    to: y.publicKey,
                })
            );
            // D's own grant: J accepts it.
            const granted = await dTrust.put(
                new IdentityRelation({ from: owner, to: z.publicKey })
            );
            // A revocation of the stranger's relation, which J never held.
            const revoked = await dTrust.del(
                IdentityRelation.id(x.publicKey, stranger.publicKey)
            );

            const bundle = runtimeOf(j).sessionScope(SCOPE_TRUST_V1)!;
            expect(bundle).toBeDefined();
            const heads = [
                owned.entry.hash,
                forged.entry.hash,
                granted.entry.hash,
                revoked.entry.hash,
            ];
            const report = await bundle.pulls.pull("s", heads);
            const untrusted = report.rejections.get(owned.entry.hash)!;
            expect({
                reason: untrusted.reason,
                permanent: untrusted.permanent,
            }).toEqual({ reason: "untrusted", permanent: false });
            expect(hashesOf(untrusted.signers)).toEqual([
                stranger.publicKey.hashcode(),
            ]);
            expect(report.rejections.get(forged.entry.hash)).toEqual({
                reason: "structure",
                permanent: true,
            });
            expect(report.rejections.has(granted.entry.hash)).toBe(false);
            expect(report.rejections.has(revoked.entry.hash)).toBe(false);
            const jTrust = trustStoreOf(j);
            await until(async () => {
                expect(await jTrust.log.log.has(granted.entry.hash)).toBe(true);
            });
            for (const refused of [owned, forged, revoked]) {
                expect(await jTrust.log.log.has(refused.entry.hash)).toBe(
                    false
                );
            }
            const verdicts = await bundle.explainer.afterPull(
                [owned.entry.hash, forged.entry.hash],
                report.rejections
            );
            expect(verdicts[0]).toMatchObject({
                kind: "trust-pending",
                reason: "untrusted",
            });
            expect(verdicts[1]).toEqual({
                kind: "explained",
                reason: "rejected-structure",
            });
            bundle.pulls.settled("s", false);

            // The wrapper never changes the boolean.
            const network = programOf(j).trustGraph;
            expect(network.canPerform).not.toBe(
                TrustedNetwork.prototype.canPerform
            );
            const cases = [
                relationPut(
                    new IdentityRelation({
                        from: stranger.publicKey,
                        to: x.publicKey,
                    }),
                    [stranger.publicKey]
                ),
                relationPut(
                    new IdentityRelation({
                        from: stranger.publicKey,
                        to: y.publicKey,
                    }),
                    [owner]
                ),
                relationPut(
                    new IdentityRelation({ from: owner, to: x.publicKey }),
                    [owner]
                ),
                {
                    type: "delete",
                    operation: {
                        key: IdentityRelation.id(z.publicKey, owner),
                    },
                    entry: {
                        hash: randomHead(),
                        getPublicKeys: async () => [owner],
                    },
                },
            ];
            const outcomes: boolean[] = [];
            for (const properties of cases) {
                const wrapped = await network.canPerform(properties);
                outcomes.push(wrapped);
                expect(wrapped).toBe(
                    await TrustedNetwork.prototype.canPerform.call(
                        network,
                        properties as any
                    )
                );
            }
            expect(outcomes).toEqual([false, false, true, true]);
        });

        /** The install marks on a trust graph instance (one per wrapper). */
        const notesMarks = (network: object) =>
            Object.getOwnPropertySymbols(network).filter(
                (symbol) =>
                    symbol.description === "shared-fs readiness trust notes"
            ).length;

        it("P4: installed once per instance, a reinstall (every open) replaces only its runtime; the program's bytes and address are unchanged; a check notes into the runtime of its start", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "notes",
                rootKey: peer.identity.publicKey,
                gc: false,
            });
            const program = programOf(fs);
            const network = program.trustGraph;
            const wrapper = network.canPerform;
            expect(
                Object.getOwnPropertyDescriptor(network, "canPerform")?.value
            ).toBe(wrapper);
            expect(wrapper).not.toBe(TrustedNetwork.prototype.canPerform);
            expect(notesMarks(network)).toBe(1);

            // No borsh field: the program's bytes, which its address names,
            // equal those of a copy without the wrapper, and a joiner that
            // opens the address decodes the same bytes (and installs its
            // own wrapper on its own instance).
            const bytes = serialize(program);
            const copy: any = deserialize(bytes, SharedFileSystem);
            expect(
                Object.getOwnPropertyDescriptor(copy.trustGraph, "canPerform")
            ).toBeUndefined();
            expect(serialize(copy)).toEqual(bytes);
            const { fs: joiner } = await joinFs(peer, fs, {
                replicate: false,
                machineLabel: "address-check",
            });
            expect(joiner.address).toBe(fs.address);
            expect(serialize(programOf(joiner))).toEqual(bytes);
            expect(notesMarks(programOf(joiner).trustGraph)).toBe(1);

            // A refusal whose entry keys are read only after the next open
            // installed again (as `open` does before the trust graph opens).
            const [stranger, x] = await Promise.all([
                Ed25519Keypair.create(),
                Ed25519Keypair.create(),
            ]);
            const first = runtimeOf(fs);
            const notedFirst = vi.spyOn(first, "noteRejection");
            let readKeys!: () => void;
            const keysRead = new Promise<void>(
                (resolve) => (readKeys = resolve)
            );
            const spanning = relationPut(
                new IdentityRelation({
                    from: stranger.publicKey,
                    to: x.publicKey,
                }),
                [stranger.publicKey],
                randomHead(),
                keysRead
            );
            const verdict = network.canPerform(spanning);
            const next = {
                noteRejection: vi.fn(),
            };
            installTrustRejectionNotes(network, () => next);
            // One wrapper, its runtime getter replaced.
            expect(network.canPerform).toBe(wrapper);
            expect(notesMarks(network)).toBe(1);
            readKeys();
            expect(await verdict).toBe(false);
            expect(notedFirst).toHaveBeenCalledTimes(1);
            expect(notedFirst.mock.calls[0].slice(0, 3)).toEqual([
                SCOPE_TRUST_V1,
                spanning.entry.hash,
                "untrusted",
            ]);
            expect(hashesOf(notedFirst.mock.calls[0][3])).toEqual([
                stranger.publicKey.hashcode(),
            ]);
            expect(next.noteRejection).not.toHaveBeenCalled();
            // A check that starts now notes into the new runtime.
            const later = relationPut(
                new IdentityRelation({
                    from: stranger.publicKey,
                    to: x.publicKey,
                }),
                [stranger.publicKey]
            );
            expect(await network.canPerform(later)).toBe(false);
            expect(next.noteRejection).toHaveBeenCalledTimes(1);
            expect(next.noteRejection.mock.calls[0].slice(0, 3)).toEqual([
                SCOPE_TRUST_V1,
                later.entry.hash,
                "untrusted",
            ]);
            expect(notedFirst).toHaveBeenCalledTimes(1);
            // Without a runtime nothing is noted, and the boolean holds.
            installTrustRejectionNotes(network, () => undefined);
            expect(
                await network.canPerform(
                    relationPut(
                        new IdentityRelation({
                            from: stranger.publicKey,
                            to: x.publicKey,
                        }),
                        [stranger.publicKey]
                    )
                )
            ).toBe(false);
            expect(next.noteRejection).toHaveBeenCalledTimes(1);
        });
    });
});
