import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const patternedBytes = (size: number, seed = 0) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = (i + seed) % 251;
    }
    return bytes;
};

const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array) =>
    !!a && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/** CI runners are slow, shared 2-4 core machines; give them a wider budget. */
const DEFAULT_WAIT_MS = process.env.CI ? 90_000 : 30_000;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const intervalMs = options.intervalMs ?? 200;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientOpenError = (error: unknown) =>
    error instanceof Error &&
    (error.message.includes("Failed to load program") ||
        error.message.includes("Failed to resolve program with address"));

/** Retried whenever the freshly announced manifest has not propagated yet. */
const openByAddressWithRetry = async (
    peerbit: Peerbit,
    address: string,
    machineLabel: string,
    extra: {
        remoteChunkFetch?: { timeoutMs: number };
        allowPartialWrites?: boolean;
    } = {}
) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await openSharedFs({
                peerbit,
                address,
                machineLabel,
                ...extra,
            });
        } catch (error) {
            if (!isTransientOpenError(error)) {
                throw error;
            }
            lastError = error;
            await sleep(2_000);
        }
    }
    throw lastError;
};

/**
 * Five in-process peers connected in a star-plus-one-edge topology. Every
 * test asserts the invariant that matters for a sync filesystem: all peers
 * eventually expose the SAME namespace and the same bytes, no matter which
 * peer performed the operation — and, where the outcome set is knowable, that
 * the agreed state is one of the legitimate outcomes (agreement alone can be
 * satisfied by uniformly wrong states).
 *
 * These tests intentionally retry once: they are convergence tests over a
 * real gossip network, fully isolated per attempt (fresh peers each run).
 */
describe("shared fs multi-peer", () => {
    const peers: Peerbit[] = [];

    const stopPeer = async (peer: Peerbit) => {
        try {
            await peer.stop();
        } catch (error) {
            // Known benign close race in the document index; match by message
            // only (stack shape differs between transpile targets).
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    };

    afterEach(async () => {
        const stopping = peers.splice(0);
        const results = await Promise.allSettled(stopping.map(stopPeer));
        const failures = results.filter(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (failures.length > 0) {
            throw failures[0].reason;
        }
    });

    const createNetwork = async (count: number) => {
        const created: Peerbit[] = [];
        for (let i = 0; i < count; i++) {
            const peer = await Peerbit.create();
            peers.push(peer);
            created.push(peer);
        }
        // Star around peer 0 plus one extra edge so not all routes are 1 hop.
        for (let i = 1; i < count; i++) {
            await created[0].dial(created[i]);
        }
        if (count > 2) {
            await created[1].dial(created[2]);
        }
        return created;
    };

    const openAll = async (
        network: Peerbit[],
        options: {
            rootKey?: boolean;
            remoteChunkFetch?: { timeoutMs: number };
        } = {}
    ): Promise<SharedFsHandle[]> => {
        const first = await openSharedFs({
            peerbit: network[0],
            machineLabel: "machine-0",
            rootKey: options.rootKey
                ? network[0].identity.publicKey
                : undefined,
            remoteChunkFetch: options.remoteChunkFetch,
        });
        const rest = await Promise.all(
            network.slice(1).map((peer, index) =>
                openByAddressWithRetry(
                    peer,
                    first.address!,
                    `machine-${index + 1}`,
                    {
                        remoteChunkFetch: options.remoteChunkFetch,
                        // Several cases deliberately race the first
                        // namespace write from otherwise-empty peers.
                        allowPartialWrites: true,
                    }
                )
            )
        );
        return [first, ...rest];
    };

    /**
     * One directory level (name -> kind) plus readable bytes for every file
     * in it. Intentionally single-level: every caller compares a directory
     * whose relevant entries all live at that level.
     */
    const snapshot = async (fs: SharedFsHandle, root = "/") => {
        const entries = await fs.list(root);
        const files: Record<string, string | undefined> = {};
        for (const entry of entries) {
            if (entry.kind === "file") {
                files[entry.path] = decode(await fs.readFile(entry.path));
            }
        }
        return {
            names: entries.map((entry) => `${entry.kind}:${entry.name}`).sort(),
            files,
        };
    };

    const expectAllAgree = async (
        handles: SharedFsHandle[],
        root = "/"
    ): Promise<
        ReturnType<typeof snapshot> extends Promise<infer T> ? T : never
    > => {
        const reference = await snapshot(handles[0], root);
        for (const handle of handles.slice(1)) {
            expect(await snapshot(handle, root)).toEqual(reference);
        }
        return reference;
    };

    /**
     * Agreement can be observed before the second racing operation has even
     * replicated. Wait for agreement, let the network settle, then require
     * agreement again together with the caller's outcome assertions.
     */
    const expectSettledAgreement = async (
        handles: SharedFsHandle[],
        assertOutcome: (
            reference: Awaited<ReturnType<typeof snapshot>>
        ) => void | Promise<void>
    ) => {
        await waitUntil(async () => {
            await expectAllAgree(handles);
        });
        await sleep(1_500);
        await waitUntil(async () => {
            const reference = await expectAllAgree(handles);
            await assertOutcome(reference);
        });
    };

    it(
        "replicates a multi-chunk file and small files to all five peers",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [writer] = handles;

            const big = patternedBytes(DEFAULT_FILE_CHUNK_SIZE * 2 + 123, 7);
            await writer.mkdir("/data");
            await writer.writeFile("/data/big.bin", big);
            for (let i = 0; i < 10; i++) {
                await writer.writeFile(`/data/small-${i}.txt`, `payload ${i}`);
            }

            // The pre-0.1.0 failure mode: at >=4 peers the adaptive
            // replicator could shard the store and prune records, leaving
            // partial trees / missing chunks. One shared deadline for all
            // peers keeps the worst case inside the test timeout.
            await waitUntil(
                async () => {
                    for (const handle of handles) {
                        const entries = await handle.list("/data");
                        expect(entries).toHaveLength(11);
                        expect(
                            bytesEqual(
                                await handle.readFile("/data/big.bin"),
                                big
                            )
                        ).toBe(true);
                        for (let i = 0; i < 10; i++) {
                            expect(
                                decode(
                                    await handle.readFile(
                                        `/data/small-${i}.txt`
                                    )
                                )
                            ).toBe(`payload ${i}`);
                        }
                    }
                },
                { timeoutMs: process.env.CI ? 100_000 : 45_000 }
            );

            // Regression guard for adaptive pruning of a writer's own data:
            // after every peer replicated, the writer must still serve its
            // own bytes from its local store (keep: "self" / full replica).
            // The pre-0.1.0 code failed exactly here — the writer's records
            // were pruned once other replicators confirmed them.
            expect(
                bytesEqual(await writer.readFile("/data/big.bin"), big)
            ).toBe(true);
        }
    );

    it(
        "converges concurrent same-name file creates to one deterministic winner",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [, b, c] = handles;

            // Both writers create the same brand-new path without waiting
            // for each other; depending on delivery timing this yields one
            // node with two heads (a content conflict) or two nodes with one
            // deterministic winner. Both shapes must converge identically on
            // every peer. (Pre-0.1.0 code returned BOTH entries from list().)
            await Promise.all([
                b.writeFile("/notes.txt", "from machine-1"),
                c.writeFile("/notes.txt", "from machine-2"),
            ]);

            await waitUntil(async () => {
                // Exactly one visible entry named notes.txt on every peer...
                for (const handle of handles) {
                    const names = (await handle.list("/")).map(
                        (entry) => entry.name
                    );
                    expect(names).toEqual(["notes.txt"]);
                }
                // ...resolving to the same node and the same bytes — and the
                // bytes must be one of the two payloads actually written.
                const reference = await handles[0].stat("/notes.txt");
                expect(reference).toBeDefined();
                const referenceBytes = decode(
                    await handles[0].readFile("/notes.txt")
                );
                expect(["from machine-1", "from machine-2"]).toContain(
                    referenceBytes
                );
                for (const handle of handles.slice(1)) {
                    const stat = await handle.stat("/notes.txt");
                    expect(stat?.nodeId).toBe(reference!.nodeId);
                    expect(decode(await handle.readFile("/notes.txt"))).toBe(
                        referenceBytes
                    );
                }
            });
        }
    );

    it(
        "converges concurrent same-name directory creates on every peer",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [, b, c] = handles;

            await Promise.all([b.mkdir("/shared"), c.mkdir("/shared")]);
            // Each creator writes a child under the path it just created.
            await Promise.all([
                b.writeFile("/shared/from-b.txt", "b"),
                c.writeFile("/shared/from-c.txt", "c"),
            ]);

            await waitUntil(async () => {
                // Namespace agreement first so a failure is attributable to
                // divergence, not to a missing API. Children created under a
                // losing duplicate node may be unreachable — a known v0
                // model limitation — but reachability must be identical on
                // every peer, and at least one child must be visible.
                const referenceSnapshot = await snapshot(handles[0], "/shared");
                expect(referenceSnapshot.names.length).toBeGreaterThanOrEqual(
                    1
                );
                for (const handle of handles.slice(1)) {
                    expect(await snapshot(handle, "/shared")).toEqual(
                        referenceSnapshot
                    );
                }
                const reference = await handles[0].stat("/shared");
                expect(reference?.kind).toBe("directory");
                for (const handle of handles.slice(1)) {
                    const stat = await handle.stat("/shared");
                    expect(stat?.nodeId).toBe(reference!.nodeId);
                }
            });
        }
    );

    it(
        "converges delete racing a concurrent write to one agreed, legitimate outcome",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [a, b] = handles;

            await a.writeFile("/contested.txt", "base");
            await waitUntil(async () => {
                for (const handle of handles) {
                    expect(
                        decode(await handle.readFile("/contested.txt"))
                    ).toBe("base");
                }
            });

            await Promise.all([
                a.rm("/contested.txt"),
                b.writeFile("/contested.txt", "overwritten while deleting"),
            ]);

            // The agreed state must be a legitimate outcome: absent
            // everywhere (delete-head bias may still hide the file when the
            // heads merge that way), or present everywhere with the
            // concurrent write's content. Uniform "base" would mean the race
            // resurrected superseded content.
            await expectSettledAgreement(handles, (reference) => {
                if (reference.names.length === 0) {
                    return;
                }
                expect(reference.names).toEqual(["file:contested.txt"]);
                expect(reference.files["/contested.txt"]).toBe(
                    "overwritten while deleting"
                );
            });

            // Causal naming makes the hidden write recoverable: when the
            // delete won, the unobserved concurrent version is surfaced as a
            // delete-vs-edit naming conflict, and restore resurrects it —
            // with the edit intact — on every peer.
            const finalState = await snapshot(handles[0]);
            if (finalState.names.length === 0) {
                let conflict:
                    | Awaited<
                          ReturnType<SharedFsHandle["namingConflicts"]>
                      >[number]
                    | undefined;
                await waitUntil(async () => {
                    const conflicts = await handles[2].namingConflicts();
                    conflict = conflicts.find(
                        (candidate) => candidate.type === "delete-vs-edit"
                    );
                    expect(conflict).toBeDefined();
                    expect(
                        conflict!.recoverableVersionIds?.length
                    ).toBeGreaterThan(0);
                });
                await handles[2].resolveNamingConflict(conflict!.nodeId, {
                    type: "restore",
                });
                await waitUntil(async () => {
                    for (const handle of handles) {
                        expect(
                            decode(await handle.readFile("/contested.txt"))
                        ).toBe("overwritten while deleting");
                    }
                });
            }
        }
    );

    it(
        "surfaces concurrent renames as a naming conflict and settles with keep",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [a, b] = handles;

            await a.writeFile("/subject.txt", "content");
            await waitUntil(async () => {
                for (const handle of handles) {
                    expect(decode(await handle.readFile("/subject.txt"))).toBe(
                        "content"
                    );
                }
            });

            await Promise.all([
                a.rename("/subject.txt", "/from-a.txt"),
                b.rename("/subject.txt", "/from-b.txt"),
            ]);

            // Both renames are naming heads on one node: every peer shows
            // the same deterministic winner name (no clock involvement) and
            // reports the losing head as a multi-head naming conflict.
            let winnerName: string | undefined;
            let nodeId: string | undefined;
            await waitUntil(async () => {
                const reference = await expectAllAgree(handles);
                expect(reference.names).toHaveLength(1);
                winnerName = reference.names[0].replace("file:", "");
                expect(["from-a.txt", "from-b.txt"]).toContain(winnerName);
                const conflicts = await handles[3].namingConflicts();
                const multiHead = conflicts.find(
                    (candidate) => candidate.type === "multi-head"
                );
                expect(multiHead).toBeDefined();
                nodeId = multiHead!.nodeId;
            });

            // keep settles the conflict; a second keep is a quiescent no-op.
            await handles[3].resolveNamingConflict(nodeId!, { type: "keep" });
            await waitUntil(async () => {
                for (const handle of handles) {
                    expect(
                        (await handle.namingConflicts()).filter(
                            (candidate) => candidate.type === "multi-head"
                        )
                    ).toEqual([]);
                    expect(
                        decode(await handle.readFile(`/${winnerName}`))
                    ).toBe("content");
                }
            });
            await handles[0].resolveNamingConflict(nodeId!, { type: "keep" });
            await expectAllAgree(handles);
        }
    );

    it(
        "converges rename racing a concurrent write to one agreed, legitimate namespace",
        { retry: 1 },
        async () => {
            const network = await createNetwork(5);
            const handles = await openAll(network);
            const [a, b] = handles;

            await a.writeFile("/doc.txt", "original");
            await waitUntil(async () => {
                for (const handle of handles) {
                    expect(decode(await handle.readFile("/doc.txt"))).toBe(
                        "original"
                    );
                }
            });

            await Promise.all([
                a.rename("/doc.txt", "/renamed.txt"),
                b.writeFile("/doc.txt", "edited during rename"),
            ]);

            // Causal naming makes silent rename loss impossible: the rename
            // is a naming event the content write never touches. Legitimate
            // outcomes: the common case — the file lives at /renamed.txt
            // with the edited bytes — or, when the rename replicated to the
            // writer before its path lookup, the writer legitimately created
            // a fresh node at the old path (both names visible, edited bytes
            // at the old path, original bytes at the new).
            await expectSettledAgreement(handles, (reference) => {
                if (reference.names.length === 1) {
                    expect(reference.names).toEqual(["file:renamed.txt"]);
                    expect(reference.files["/renamed.txt"]).toBe(
                        "edited during rename"
                    );
                } else {
                    expect(reference.names).toEqual([
                        "file:doc.txt",
                        "file:renamed.txt",
                    ]);
                    expect(reference.files["/doc.txt"]).toBe(
                        "edited during rename"
                    );
                    expect(reference.files["/renamed.txt"]).toBe("original");
                }
            });
        }
    );

    it(
        "lets a cold joiner read the full tree of an access-controlled filesystem",
        { retry: 1 },
        async () => {
            const network = await createNetwork(2);
            const [ownerFs, writerFs] = await openAll(network, {
                rootKey: true,
            });

            await ownerFs.authorizeWriter(network[1].identity.publicKey);
            await waitUntil(async () => {
                expect(
                    await writerFs.isTrustedWriter(
                        network[1].identity.publicKey
                    )
                ).toBe(true);
            });

            const big = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 99, 3);
            await ownerFs.mkdir("/docs");
            await ownerFs.mkdir("/docs/nested");
            for (let i = 0; i < 20; i++) {
                await ownerFs.writeFile(`/docs/owner-${i}.txt`, `owner ${i}`);
            }
            await ownerFs.writeFile("/docs/nested/big.bin", big);

            // The writer resolves parents against its local index; wait for
            // /docs to replicate before writing under it.
            await waitUntil(async () => {
                expect((await writerFs.stat("/docs"))?.kind).toBe("directory");
            });
            await writerFs.writeFile("/docs/writer.txt", "from trusted writer");

            // Both existing peers agree before the cold join.
            await waitUntil(async () => {
                expect(decode(await ownerFs.readFile("/docs/writer.txt"))).toBe(
                    "from trusted writer"
                );
                expect((await writerFs.list("/docs")).length).toBe(22);
            });

            // A fresh peer joins long after the writes happened.
            const late = await Peerbit.create();
            peers.push(late);
            await late.dial(network[0]);
            const lateFs = await openByAddressWithRetry(
                late,
                ownerFs.address!,
                "cold-joiner"
            );

            await waitUntil(async () => {
                expect((await lateFs.list("/docs")).length).toBe(22);
                expect(decode(await lateFs.readFile("/docs/owner-0.txt"))).toBe(
                    "owner 0"
                );
                expect(decode(await lateFs.readFile("/docs/writer.txt"))).toBe(
                    "from trusted writer"
                );
                expect(
                    bytesEqual(
                        await lateFs.readFile("/docs/nested/big.bin"),
                        big
                    )
                ).toBe(true);
            });
        }
    );

    it(
        "never serves torn reads while a multi-chunk file replicates",
        { retry: 1 },
        async () => {
            const network = await createNetwork(4);
            // Short remote-fetch timeout keeps every poll attempt cheap.
            const handles = await openAll(network, {
                remoteChunkFetch: { timeoutMs: 1_500 },
            });
            const [writer, ...readers] = handles;

            // 8+ chunks widen the replication window the test wants to
            // observe reads inside.
            const big = patternedBytes(DEFAULT_FILE_CHUNK_SIZE * 8 + 41, 11);
            const writing = writer.writeFile("/torn.bin", big);

            // Poll during replication. A read may return undefined (not yet
            // visible) or fail with a transient missing-chunk error, but any
            // bytes returned must be the complete, correct content — never a
            // partial or corrupted view.
            let sawWindow = 0;
            const deadline = Date.now() + (process.env.CI ? 60_000 : 30_000);
            const settled = new Set<number>();
            while (Date.now() < deadline && settled.size < readers.length) {
                await Promise.all(
                    readers.map(async (reader, index) => {
                        let bytes: Uint8Array | undefined;
                        try {
                            bytes = await reader.readFile("/torn.bin");
                        } catch (error) {
                            const message =
                                error instanceof Error ? error.message : "";
                            // Transient while chunks are in flight.
                            expect(message).toMatch(/Missing chunk/);
                            sawWindow++;
                            return;
                        }
                        if (bytes === undefined) {
                            sawWindow++;
                            return;
                        }
                        expect(bytesEqual(bytes, big)).toBe(true);
                        settled.add(index);
                    })
                );
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            await writing;
            // Timing-dependent; logged so CI output shows whether the
            // interesting window (reads during replication) was exercised.
            console.log(
                `torn-read: observed ${sawWindow} in-flight reads before settle`
            );
            // The loop above may exit before slow readers settle; the
            // invariant is "no torn bytes", not "all readers settle in the
            // polling window" — give stragglers a final grace period.
            await waitUntil(async () => {
                for (const reader of readers) {
                    expect(
                        bytesEqual(await reader.readFile("/torn.bin"), big)
                    ).toBe(true);
                }
            });
        }
    );
});
