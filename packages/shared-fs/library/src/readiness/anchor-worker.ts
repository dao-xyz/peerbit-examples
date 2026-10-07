import type { AnchorMath } from "./anchor.js";
import type { CellsMath } from "./cells.js";

/**
 * The anchor worker (M1 plan section 4): one thread per process holds the
 * lanes of every lane set, so the 4 KiB expansion of each element stays off
 * the main heap (M0 P4: 2.2-2.9 µs per element in a worker at any main heap
 * size, against 20-52 µs inline at a 1.9 GB heap), and the maintained cells
 * of every set that keeps them, so their 180 KB stay out of the main
 * thread's caches (cells.ts `createCellsMath`).
 *
 * `anchorWorkerMain` is serialized with `toString()` into an eval worker
 * (anchor-host.ts), so it must stay self-contained: no imports, no outer
 * bindings, no classes. Messages are handled strictly in order, so a request
 * posted after a batch sees that batch applied.
 *
 * Main -> worker: `init`, `batch` (n x 32 digests followed by n signs, one
 * transferred buffer), `digestNow`, `digestOf`, `lanes`, `cells`, `state`
 * (the cells with the lanes or the digest), `drop`, and `crash` (tests
 * only). Worker -> main: `ack` (every 16 batches and when the queue
 * empties), `digest`, `lanes`, `cells` and `state` (cells and lanes
 * transferred), `error`.
 */

/** The `parentPort` surface the worker uses. */
export interface AnchorWorkerPort {
    on(event: "message", listener: (message: any) => void): unknown;
    postMessage(message: any, transfer?: any[]): void;
}

export function anchorWorkerMain(
    port: AnchorWorkerPort,
    math: AnchorMath,
    cellsMath: CellsMath
) {
    const ACK_EVERY = 16;
    const sets = new Map<
        number,
        {
            iv: Uint8Array;
            lanes: Uint32Array;
            /** The maintained cells and their key, when the set keeps them. */
            cells?: Uint32Array;
            k0: number;
            k1: number;
            seq: number;
            batches: number;
        }
    >();
    const unacked = new Set<number>();
    let flushScheduled = false;
    const ack = (id: number) => {
        const set = sets.get(id);
        unacked.delete(id);
        if (set) {
            set.batches = 0;
            port.postMessage({ type: "ack", set: id, seq: set.seq });
        }
    };
    const flushAcks = () => {
        flushScheduled = false;
        for (const id of [...unacked]) ack(id);
    };
    const fail = (id: number, message: string) =>
        port.postMessage({ type: "error", id, message });
    // An element count mismatch is a host bug; answering it would hand out
    // a digest of the wrong set.
    const atSeq = (message: any, run: (set: any) => void) => {
        const set = sets.get(message.set);
        if (!set) return fail(message.id, "unknown lane set");
        if (set.seq !== message.seq) {
            return fail(
                message.id,
                "lane set at seq " + set.seq + ", asked for " + message.seq
            );
        }
        run(set);
    };
    port.on("message", (message: any) => {
        switch (message.type) {
            case "init": {
                const lanes = message.lanes
                    ? math.bytesToLanes(message.lanes)
                    : new Uint32Array(math.lanes);
                const cells = message.cells;
                sets.set(message.set, {
                    iv: message.iv,
                    lanes,
                    cells: cells
                        ? cells.bytes
                            ? cellsMath.fromBytes(cells.bytes)
                            : cellsMath.create(cells.m)
                        : undefined,
                    k0: cells ? cells.k0 : 0,
                    k1: cells ? cells.k1 : 0,
                    seq: message.seq,
                    batches: 0,
                });
                return;
            }
            case "batch": {
                const set = sets.get(message.set);
                if (!set) return;
                const n = message.n;
                const digests = new Uint8Array(message.buf, 0, 32 * n);
                const signs = new Int8Array(message.buf, 32 * n, n);
                math.applyMany(set.lanes, set.iv, digests, signs);
                if (set.cells) {
                    cellsMath.applyMany(
                        set.cells,
                        set.k0,
                        set.k1,
                        digests,
                        signs
                    );
                }
                set.seq = message.seqEnd;
                unacked.add(message.set);
                if (++set.batches >= ACK_EVERY) ack(message.set);
                if (!flushScheduled) {
                    flushScheduled = true;
                    setImmediate(flushAcks);
                }
                return;
            }
            case "digestNow":
                return atSeq(message, (set) => {
                    const lanes = set.lanes.slice();
                    if (message.sub)
                        math.applyMany(lanes, set.iv, message.sub, -1);
                    if (message.add)
                        math.applyMany(lanes, set.iv, message.add, 1);
                    port.postMessage({
                        type: "digest",
                        id: message.id,
                        digest: math.digest(lanes, set.iv),
                    });
                });
            case "digestOf": {
                const set = sets.get(message.set);
                if (!set) return fail(message.id, "unknown lane set");
                const lanes = new Uint32Array(math.lanes);
                math.applyMany(lanes, set.iv, message.buf, 1);
                port.postMessage({
                    type: "digest",
                    id: message.id,
                    digest: math.digest(lanes, set.iv),
                });
                return;
            }
            case "lanes":
                return atSeq(message, (set) => {
                    const bytes = math.lanesToBytes(set.lanes);
                    port.postMessage(
                        { type: "lanes", id: message.id, lanes: bytes },
                        [bytes.buffer]
                    );
                });
            case "cells":
                return atSeq(message, (set) => {
                    if (!set.cells) {
                        return fail(message.id, "lane set keeps no cells");
                    }
                    const bytes = cellsMath.toBytes(set.cells);
                    port.postMessage(
                        { type: "cells", id: message.id, cells: bytes },
                        [bytes.buffer]
                    );
                });
            case "state":
                // One reply, so the host settles both parts together.
                return atSeq(message, (set) => {
                    if (!set.cells) {
                        return fail(message.id, "lane set keeps no cells");
                    }
                    const cells = cellsMath.toBytes(set.cells);
                    if (message.part === "lanes") {
                        const lanes = math.lanesToBytes(set.lanes);
                        port.postMessage(
                            {
                                type: "state",
                                id: message.id,
                                state: { cells, lanes },
                            },
                            [cells.buffer, lanes.buffer]
                        );
                        return;
                    }
                    port.postMessage(
                        {
                            type: "state",
                            id: message.id,
                            state: {
                                cells,
                                digest: math.digest(set.lanes, set.iv),
                            },
                        },
                        [cells.buffer]
                    );
                });
            case "drop":
                sets.delete(message.set);
                unacked.delete(message.set);
                return;
            case "crash":
                throw new Error("anchor worker: forced crash (test)");
        }
    });
}
