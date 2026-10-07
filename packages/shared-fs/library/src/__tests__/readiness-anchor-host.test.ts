import { fork } from "node:child_process";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnchorMath } from "../readiness/anchor.js";
import {
    AnchorHost,
    AnchorUnavailableError,
    anchorWorkerSource,
    type LaneSet,
} from "../readiness/anchor-host.js";
import { Cells } from "../readiness/cells.js";
import { LANES, M } from "../readiness/constants.js";

/**
 * The anchor host (M1 plan sections 4 and 8): sequence points, sub/add,
 * digestOf, restore, process lifetime (S14), intentional terminate,
 * respawn and rebuild from the slab after a crash, the inline fallback,
 * and the serialized worker source; each for the cells a set keeps too.
 */

const childPath = fileURLToPath(
    new URL("./readiness-anchor.worker.ts", import.meta.url)
);
const iv = new Uint8Array(16).fill(5);
const math = createAnchorMath(crypto as any);
const element = (i: number) =>
    new Uint8Array(
        crypto
            .createHash("sha256")
            .update("host-" + i)
            .digest()
    );
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The digest of a set built from scratch, inline. */
const fresh = (elements: Uint8Array[]) => {
    const lanes = new Uint32Array(LANES);
    for (const e of elements) math.applyMany(lanes, iv, e, 1);
    return hex(math.digest(lanes, iv));
};

const cellSpec = { m: M, k0: 0x1234567, k1: -0x7654321 };
/** The cells of a set built from scratch on the main thread (`Cells`). */
const freshCells = (elements: Uint8Array[]) => {
    const cells = new Cells(cellSpec.m, cellSpec.k0, cellSpec.k1);
    for (const e of elements) cells.apply(e, 1);
    return hex(cells.toBytes());
};

/** A live set with a slab and cells, as a tap would hold it. */
const tracked = (host: AnchorHost) => {
    const live = new Map<string, Uint8Array>();
    const set: LaneSet = host.open(iv, {
        slab: () => ({
            size: live.size,
            forEach: (fn) => live.forEach((digest) => fn(digest)),
        }),
        cells: cellSpec,
    });
    return {
        set,
        live,
        add(e: Uint8Array) {
            live.set(hex(e), e);
            set.apply(e, 1);
        },
        remove(e: Uint8Array) {
            live.delete(hex(e));
            set.apply(e, -1);
        },
    };
};

const hosts: AnchorHost[] = [];
const sets: LaneSet[] = [];
const newHost = async (mode?: "inline") => {
    const host = await AnchorHost.create({ mode });
    hosts.push(host);
    return host;
};

afterEach(() => {
    for (const set of sets.splice(0)) set.close();
    hosts.splice(0);
});

const runChild = (scenario: string, timeoutMs = 60_000) =>
    new Promise<{ code: number | null; lines: any[]; output: string }>(
        (resolve, reject) => {
            const child = fork(childPath, [scenario], {
                execArgv: ["--import", "tsx"],
                env: { ...process.env, NODE_ENV: "test" },
                stdio: ["ignore", "pipe", "pipe", "ipc"],
            });
            let output = "";
            child.stdout?.on("data", (chunk) => (output += chunk));
            child.stderr?.on("data", (chunk) => (output += chunk));
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(
                    new Error(
                        `child "${scenario}" did not exit within ${timeoutMs} ms:\n${output}`
                    )
                );
            }, timeoutMs);
            child.once("close", (code) => {
                clearTimeout(timer);
                const lines = output
                    .split("\n")
                    .filter((line) => line.startsWith("{"))
                    .map((line) => JSON.parse(line));
                resolve({ code, lines, output });
            });
        }
    );

describe("readiness anchor host", () => {
    it("answers digestNow at the sequence point, unflushed applies included", async () => {
        const host = await newHost();
        expect(host.mode).toBe("worker");
        const { set, add, remove } = tracked(host);
        sets.push(set);
        const elements = Array.from({ length: 1500 }, (_, i) => element(i));
        for (let i = 0; i < 1000; i++) add(elements[i]);
        // 1000 % 256 elements are still in the unflushed batch here.
        const first = set.digestNow();
        const firstCells = set.cellsNow();
        for (let i = 1000; i < 1500; i++) add(elements[i]);
        remove(elements[0]);
        const second = set.digestNow();
        const secondCells = set.cellsNow();
        expect(first.seq).toBe(1000);
        expect(second.seq).toBe(1501);
        expect(hex(await first.digest)).toBe(fresh(elements.slice(0, 1000)));
        expect(hex(await second.digest)).toBe(fresh(elements.slice(1, 1500)));
        // The cells answer for the same sequence points.
        expect(firstCells.seq).toBe(1000);
        expect(hex(await firstCells.cells)).toBe(
            freshCells(elements.slice(0, 1000))
        );
        expect(hex(await secondCells.cells)).toBe(
            freshCells(elements.slice(1, 1500))
        );
        // Lag drains to zero once the worker acknowledged everything.
        await vi.waitFor(() => expect(set.lag()).toBe(0), { timeout: 5_000 });
        expect(host.stats.lagHighWater).toBeGreaterThan(0);
        expect(host.stats.failures).toBe(0);
    });

    it("subtracts and adds at the sequence point, and digests arbitrary sets", async () => {
        const host = await newHost();
        const { set, add } = tracked(host);
        sets.push(set);
        const elements = Array.from({ length: 50 }, (_, i) => element(i));
        for (const e of elements.slice(0, 40)) add(e);
        // J - X + E: drop two rows, add three that are not in the set.
        const sub = [elements[3], elements[17]];
        const extra = elements.slice(40, 43);
        const { digest } = set.digestNow(sub, extra);
        const expected = elements
            .slice(0, 40)
            .filter((e) => !sub.includes(e))
            .concat(extra);
        expect(hex(await digest)).toBe(fresh(expected));
        // The live lanes are unchanged by the certificate.
        expect(hex(await set.digestNow().digest)).toBe(
            fresh(elements.slice(0, 40))
        );
        const list = new Uint8Array(32 * 7);
        elements.slice(10, 17).forEach((e, i) => list.set(e, 32 * i));
        expect(hex(await set.digestOf(list))).toBe(
            fresh(elements.slice(10, 17))
        );
        await expect(set.digestOf(new Uint8Array(33))).rejects.toThrow();
        expect(() => set.apply(new Uint8Array(31), 1)).toThrow();
    });

    it("restores persisted lanes at their seq and resets to the empty set", async () => {
        const host = await newHost();
        const a = tracked(host);
        sets.push(a.set);
        const elements = Array.from({ length: 300 }, (_, i) => element(i));
        for (const e of elements.slice(0, 200)) a.add(e);
        const { seq, lanes } = a.set.lanesNow();
        const bytes = await lanes;
        const cells = await a.set.cellsNow().cells;
        expect(seq).toBe(200);
        expect(bytes.length).toBe(LANES * 4);
        expect(cells.length).toBe(M * 44);

        const b = host.open(iv, {
            restore: { lanes: bytes, cells, seq },
            cells: cellSpec,
        });
        sets.push(b);
        expect(b.seq).toBe(200);
        expect(hex(await b.digestNow().digest)).toBe(
            fresh(elements.slice(0, 200))
        );
        for (const e of elements.slice(200)) b.apply(e, 1);
        expect(b.seq).toBe(300);
        expect(hex(await b.digestNow().digest)).toBe(fresh(elements));
        expect(hex(await b.cellsNow().cells)).toBe(freshCells(elements));
        // Restore only fits an untouched set, and cells only a set that
        // keeps them, at their size.
        expect(() => b.restore(bytes, 5)).toThrow();
        expect(() =>
            host.open(iv, { restore: { lanes: bytes, cells, seq } })
        ).toThrow(/no cells/);
        expect(() =>
            host.open(iv, {
                restore: { lanes: bytes, cells: cells.subarray(44), seq },
                cells: cellSpec,
            })
        ).toThrow(/bytes of cells/);
        const plain = host.open(iv);
        sets.push(plain);
        await expect(plain.cellsNow().cells).rejects.toThrow(/no cells/);

        b.reset(400);
        expect(b.seq).toBe(400);
        expect(hex(await b.digestNow().digest)).toBe(fresh([]));
        expect(hex(await b.cellsNow().cells)).toBe(freshCells([]));
    });

    it("terminates the worker after the last set closes and never respawns", async () => {
        const host = await newHost();
        const one = tracked(host);
        const two = tracked(host);
        one.add(element(1));
        two.add(element(2));
        await one.set.digestNow().digest;
        expect(host.workerRunning).toBe(true);
        one.set.close();
        expect(host.workerRunning).toBe(true);
        two.set.close();
        expect(host.workerRunning).toBe(false);
        expect(host.openSets).toBe(0);
        await expect(one.set.digestNow().digest).rejects.toThrow(/closed/);
        // Give the intentional exit time to arrive: it is not a failure.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(host.stats.failures).toBe(0);
        expect(host.stats.respawns).toBe(0);
        expect(host.workerRunning).toBe(false);
        // A later set starts a fresh worker.
        const three = tracked(host);
        sets.push(three.set);
        three.add(element(3));
        expect(hex(await three.set.digestNow().digest)).toBe(
            fresh([element(3)])
        );
        expect(host.mode).toBe("worker");
    });

    it("defers terminate while a request is pending", async () => {
        const host = await newHost();
        const one = tracked(host);
        for (let i = 0; i < 500; i++) one.add(element(i));
        const { lanes } = one.set.lanesNow();
        one.set.close();
        // The set closed after the request was posted: it is still answered.
        expect((await lanes).length).toBe(LANES * 4);
        expect(host.workerRunning).toBe(false);
        expect(host.pendingRequests).toBe(0);
    });

    it("respawns after a crash, rebuilds every set from its slab, then falls back inline", async () => {
        const host = await newHost();
        const a = tracked(host);
        const b = tracked(host);
        const lost = host.open(iv);
        sets.push(a.set, b.set, lost);
        const elements = Array.from({ length: 600 }, (_, i) => element(i));
        for (const e of elements.slice(0, 400)) a.add(e);
        for (const e of elements.slice(400)) b.add(e);
        a.remove(elements[0]);
        lost.apply(element(9999), 1);
        await a.set.digestNow().digest;

        host.crashWorkerForTest();
        // Posted after the crash: the dead worker never answers it.
        const pending = a.set.digestNow();
        await expect(pending.digest).rejects.toBeInstanceOf(
            AnchorUnavailableError
        );
        expect(host.stats.failures).toBe(1);
        expect(host.stats.respawns).toBe(1);
        expect(host.mode).toBe("worker");
        // Rebuilt from the slab at the same seq; later applies continue.
        expect(a.set.seq).toBe(401);
        expect(hex(await a.set.digestNow().digest)).toBe(
            fresh(elements.slice(1, 400))
        );
        expect(hex(await a.set.cellsNow().cells)).toBe(
            freshCells(elements.slice(1, 400))
        );
        b.add(element(5000));
        expect(hex(await b.set.digestNow().digest)).toBe(
            fresh([...elements.slice(400), element(5000)])
        );
        // A set without a slab cannot be rebuilt: it refuses, never lies.
        await expect(lost.digestNow().digest).rejects.toBeInstanceOf(
            AnchorUnavailableError
        );

        // A second failure within 10 minutes: inline, same answers.
        host.crashWorkerForTest();
        await vi.waitFor(() => expect(host.mode).toBe("inline"), {
            timeout: 10_000,
        });
        expect(host.stats.failures).toBe(2);
        expect(host.stats.inlineReason).toMatch(/twice/);
        expect(hex(await a.set.digestNow().digest)).toBe(
            fresh(elements.slice(1, 400))
        );
        a.add(element(6000));
        expect(hex(await a.set.digestNow().digest)).toBe(
            fresh([...elements.slice(1, 400), element(6000)])
        );
        expect(hex(await a.set.cellsNow().cells)).toBe(
            freshCells([...elements.slice(1, 400), element(6000)])
        );
    });

    it("rebuilds once, inline, when the respawned worker cannot start", async () => {
        // Node throws ERR_WORKER_INIT_FAILED synchronously when it cannot
        // create a thread: the second construction throws here.
        let constructed = 0;
        const posted: any[] = [];
        class FailingWorker extends EventEmitter {
            constructor() {
                super();
                if (++constructed > 1)
                    throw new Error("ERR_WORKER_INIT_FAILED");
            }
            postMessage(message: any) {
                posted.push(message);
            }
            ref() {}
            unref() {}
            terminate() {
                return Promise.resolve(0);
            }
        }
        const host = AnchorHost.fromModules(crypto, FailingWorker);
        hosts.push(host);
        const a = tracked(host);
        const b = tracked(host);
        sets.push(a.set, b.set);
        const elements = Array.from({ length: 6 }, (_, i) => element(i));
        for (const e of elements.slice(0, 3)) a.add(e);
        for (const e of elements.slice(3)) b.add(e);
        await Promise.resolve();
        expect(posted.some((message) => message.type === "batch")).toBe(true);
        (host as any).worker.emit("error", new Error("boom"));
        expect(host.mode).toBe("inline");
        expect(host.stats.inlineReason).toMatch(/did not start/);
        // Each set holds its live heads once, not its slab applied twice.
        expect(hex(await a.set.digestNow().digest)).toBe(
            fresh(elements.slice(0, 3))
        );
        expect(hex(await b.set.digestNow().digest)).toBe(
            fresh(elements.slice(3))
        );
        expect(hex(await b.set.cellsNow().cells)).toBe(
            freshCells(elements.slice(3))
        );
    });

    it("runs inline without a Worker export and refuses without crypto", async () => {
        // A bundler's empty stub for node:worker_threads: no Worker.
        const host = AnchorHost.fromModules(crypto, undefined);
        hosts.push(host);
        expect(host.mode).toBe("inline");
        expect(host.stats.inlineReason).toBe("worker_threads unavailable");
        const t = tracked(host);
        sets.push(t.set);
        t.add(element(1));
        t.add(element(2));
        expect(hex(await t.set.digestNow().digest)).toBe(
            fresh([element(1), element(2)])
        );
        expect(hex(await t.set.lanesNow().lanes)).toHaveLength(LANES * 8);
        // A worker-mode host that loses its constructor goes inline at the
        // first spawn instead of answering from lanes it never had.
        const stranded = AnchorHost.fromModules(crypto, function () {});
        hosts.push(stranded);
        (stranded as any).workerConstructor = undefined;
        const s = tracked(stranded);
        sets.push(s.set);
        s.add(element(3));
        expect(stranded.mode).toBe("inline");
        expect(hex(await s.set.digestNow().digest)).toBe(fresh([element(3)]));

        expect(() => AnchorHost.fromModules({}, undefined)).toThrow(
            /node:crypto/
        );
    });

    it("does not cache a failed process-wide host", async () => {
        const saved = (AnchorHost as any).sharedHost;
        const create = vi
            .spyOn(AnchorHost, "create")
            .mockRejectedValueOnce(new Error("no crypto"));
        try {
            (AnchorHost as any).sharedHost = undefined;
            await expect(AnchorHost.shared()).rejects.toThrow("no crypto");
            const host = await AnchorHost.shared();
            expect(host).toBeInstanceOf(AnchorHost);
            expect(create).toHaveBeenCalledTimes(2);
        } finally {
            create.mockRestore();
            (AnchorHost as any).sharedHost = saved;
        }
    });

    it("the inline fallback gives the worker's digests", async () => {
        const worker = await newHost();
        const inline = await newHost("inline");
        expect(inline.mode).toBe("inline");
        const w = worker.open(iv, { cells: cellSpec });
        const i = inline.open(iv, { cells: cellSpec });
        sets.push(w, i);
        const elements = Array.from({ length: 700 }, (_, n) => element(n));
        for (const e of elements) {
            w.apply(e, 1);
            i.apply(e, 1);
        }
        for (const e of elements.slice(0, 100)) {
            w.apply(e, -1);
            i.apply(e, -1);
        }
        const sub = [elements[200]];
        const add = [element(9000)];
        expect(hex(await i.digestNow(sub, add).digest)).toBe(
            hex(await w.digestNow(sub, add).digest)
        );
        expect(hex(await i.lanesNow().lanes)).toBe(
            hex(await w.lanesNow().lanes)
        );
        expect(hex(await i.cellsNow().cells)).toBe(
            hex(await w.cellsNow().cells)
        );
        expect(hex(await i.cellsNow().cells)).toBe(
            freshCells(elements.slice(100))
        );
        expect(i.lag()).toBe(0);
        expect(inline.workerRunning).toBe(false);
    });

    it("the eval source is self-contained and round-trips", () => {
        const source = anchorWorkerSource();
        expect(source).toContain("var __name");
        const replies: any[] = [];
        let listener: ((message: any) => void) | undefined;
        const port = {
            on: (_event: string, fn: (message: any) => void) => {
                listener = fn;
            },
            postMessage: (message: any) => replies.push(message),
        };
        const require = createRequire(import.meta.url);
        // A fresh context: only what the eval worker would have.
        vm.runInNewContext(source, {
            require: (name: string) =>
                name === "node:worker_threads"
                    ? { parentPort: port }
                    : require(name),
            setImmediate: () => {},
            Uint8Array,
            Uint32Array,
            Int8Array,
            Map,
            Set,
            Error,
        });
        const elements = Array.from({ length: 3 }, (_, n) => element(n));
        const buf = new Uint8Array(3 * 33);
        elements.forEach((e, n) => buf.set(e, 32 * n));
        buf.fill(1, 96);
        listener!({ type: "init", set: 1, iv, seq: 0, cells: cellSpec });
        listener!({ type: "batch", set: 1, buf: buf.buffer, n: 3, seqEnd: 3 });
        listener!({ type: "digestNow", id: 7, set: 1, seq: 3 });
        listener!({ type: "digestNow", id: 8, set: 1, seq: 2 });
        listener!({ type: "cells", id: 9, set: 1, seq: 3 });
        const digest = replies.find((reply) => reply.id === 7);
        expect(digest.type).toBe("digest");
        expect(hex(digest.digest)).toBe(fresh(elements));
        const cells = replies.find((reply) => reply.id === 9);
        expect(cells.type).toBe("cells");
        expect(hex(cells.cells)).toBe(freshCells(elements));
        // An out-of-step request is refused, never answered for another set.
        expect(replies.find((reply) => reply.id === 8).type).toBe("error");
    });

    it("a pending request keeps the process alive (S14)", async () => {
        const { code, lines, output } = await runChild("pending");
        expect(code, output).toBe(0);
        expect(lines, output).toHaveLength(1);
        expect(lines[0].mode).toBe("worker");
        expect(lines[0].digest).toBe(lines[0].expected);
    });

    it("an idle host does not keep the process alive (S14)", async () => {
        const { code, lines, output } = await runChild("idle");
        expect(code, output).toBe(0);
        expect(lines[0].mode).toBe("worker");
        expect(lines[0].workerRunning).toBe(true);
        expect(lines[0].openSets).toBe(1);
        expect(lines[0].digest).toBe(lines[0].expected);
    });
});
