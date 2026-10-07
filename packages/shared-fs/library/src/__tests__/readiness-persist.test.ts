import { fork } from "node:child_process";
import * as nodeCrypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, promises as fsPromises } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { NamingEvent } from "../model.js";
import { createAnchorMath } from "../readiness/anchor.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import { anchorWorkerMain } from "../readiness/anchor-worker.js";
import { createCellsMath } from "../readiness/cells.js";
import { DIGEST_BYTES } from "../readiness/constants.js";
import { digestToHead } from "../readiness/digest.js";
import {
    decodeStructures,
    encodeStructures,
    structuresPath,
    takeStructures,
} from "../readiness/persist.js";
import { ReadinessRuntime, logIdOf } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import { compareScope, optOutOfReadinessShadow } from "../readiness/shadow.js";
import { ScopeTap, type IndexedHead } from "../readiness/tap.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Persistence of the readiness structures (M1 plan section 6.2; tests 48
 * and 57): written at a clean close after the stores closed, unlinked at
 * open before ingest, restored only when the file is intact, for this
 * address and scope, and its count matches the index at a stable epoch;
 * anything else rebuilds by scan.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const childPath = fileURLToPath(
    new URL("./readiness-persist.child.ts", import.meta.url)
);

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;
const entriesOf = (fs: SharedFsHandle): any => (fs.program as any).entries;

const shadow = async (
    fs: SharedFsHandle,
    scope: ScopeId = SCOPE_NAMESPACE_V1
) => {
    const runtime = runtimeOf(fs);
    await runtime.whenStarted();
    return compareScope(runtime.scope(scope)!, runtime.cellKey);
};

/** Count, hlc, cells and anchor of the namespace scope, now. */
const stateOf = async (fs: SharedFsHandle) => {
    const runtime = runtimeOf(fs);
    await runtime.whenStarted();
    const scope = runtime.scope(SCOPE_NAMESPACE_V1)!;
    await scope.tap.verifyIdle();
    const { count, hlc } = scope.tap;
    const cells = scope.laneSet.cellsNow().cells;
    const anchor = hex(await scope.laneSet.digestNow().digest);
    return { count, hlc, cells: hex(await cells), anchor };
};

const writeFiles = async (fs: SharedFsHandle, n: number, prefix = "f") => {
    for (let i = 0; i < n; i++) {
        await fs.writeFile(`/${prefix}${i}.txt`, `content ${prefix} ${i}`);
    }
};

/** The namespace store's log id: its structures file's name. */
const storeOf = (fs: SharedFsHandle): Uint8Array => logIdOf(entriesOf(fs));

const namespaceFile = (directory: string, store: Uint8Array) =>
    structuresPath(directory, store, NAMESPACE_V1);

/**
 * Removals of `path` fail with EPERM until the returned function runs, as
 * for a file another process holds (Windows sharing locks) or an immutable
 * one.
 */
const lockRemoval = (path: string) => {
    const rm = fsPromises.rm;
    fsPromises.rm = (async (target: any, options?: any) => {
        if (String(target) === path) {
            throw Object.assign(
                new Error(`EPERM: operation not permitted, unlink '${path}'`),
                { code: "EPERM" }
            );
        }
        return rm(target, options);
    }) as typeof rm;
    // The library's `import("node:fs/promises")` sees the patched export.
    syncBuiltinESMExports();
    return () => {
        fsPromises.rm = rm;
        syncBuiltinESMExports();
    };
};

const runChild = (args: string[]) =>
    new Promise<{
        code: number | null;
        signal: string | null;
        report: any;
        output: string;
    }>((resolve, reject) => {
        const child = fork(childPath, args, {
            execArgv: ["--import", "tsx"],
            env: { ...process.env, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let output = "";
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.on("data", (chunk) => (output += chunk));
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`child did not exit:\n${output}`));
        }, 120_000);
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            const line = output
                .split("\n")
                .find((candidate) => candidate.startsWith("{"));
            resolve({
                code,
                signal,
                report: line ? JSON.parse(line) : undefined,
                output,
            });
        });
    });

/**
 * A worker running the real worker code on this thread, one message per
 * later turn. `failAfter` picks a request: the worker answers it, then
 * fails (`error`) in the same turn, before it reads another message. That
 * is a crash between two replies, made deterministic.
 */
class InProcessWorker extends EventEmitter {
    static failAfter?: (message: any) => boolean;
    private dead = false;
    private listener!: (message: any) => void;
    private held?: any[];

    constructor() {
        super();
        anchorWorkerMain(
            {
                on: (_event, listener) => (this.listener = listener),
                postMessage: (message) => {
                    if (this.held) this.held.push(message);
                    else setImmediate(() => this.emit("message", message));
                },
            },
            createAnchorMath(nodeCrypto as any),
            createCellsMath()
        );
    }

    postMessage(message: any) {
        setImmediate(() => {
            if (this.dead) return;
            const fail = InProcessWorker.failAfter;
            if (message.id === undefined || !fail?.(message)) {
                this.listener(message);
                return;
            }
            InProcessWorker.failAfter = undefined;
            this.dead = true;
            const replies: any[] = (this.held = []);
            this.listener(message);
            this.held = undefined;
            setImmediate(() => {
                for (const reply of replies) this.emit("message", reply);
                this.emit("error", new Error("injected worker failure"));
            });
        });
    }

    ref() {}
    unref() {}
    terminate() {
        this.dead = true;
        return Promise.resolve(0);
    }
}

describe("readiness persistence", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    afterEach(async () => {
        await stopTestPeers(peers);
        await Promise.all(
            roots
                .splice(0)
                .map((root) => rm(root, { recursive: true, force: true }))
        );
    });

    const newRoot = async () => {
        const root = await mkdtemp(
            join(tmpdir(), "shared-fs-readiness-persist-")
        );
        roots.push(root);
        return root;
    };
    const createPeer = async (directory: string) => {
        const peer = await Peerbit.create({ directory });
        peers.push(peer);
        return peer;
    };
    const stopPeer = async (peer: Peerbit) => {
        peers.splice(peers.indexOf(peer), 1);
        await peer.stop();
    };
    /** A filesystem with `n` files, closed cleanly; its directory and address. */
    const persisted = async (n = 20) => {
        const directory = join(await newRoot(), "peer");
        const peer = await createPeer(directory);
        const fs = await openSharedFs({
            peerbit: peer,
            rootKey: peer.identity.publicKey,
            gc: false,
        });
        await writeFiles(fs, n);
        const before = await stateOf(fs);
        const address = fs.address!;
        const store = storeOf(fs);
        const ids: string[] = (
            await entriesOf(fs)
                .index.index.iterate(
                    { query: NAMESPACE_V1.scanQuery() },
                    { shape: { id: true } }
                )
                .all()
        ).map((row: any) => row.value.id);
        await stopPeer(peer);
        return { directory, address, store, before, ids };
    };
    const reopen = async (directory: string, address: string) => {
        const peer = await createPeer(directory);
        const fs = await openSharedFs({ peerbit: peer, address, gc: false });
        await runtimeOf(fs).whenStarted();
        return { peer, fs };
    };

    it("restores at a clean reopen and equals a fresh build (test 48)", async () => {
        const { directory, address, store, before } = await persisted();
        const file = await namespaceFile(directory, store);
        expect(existsSync(file)).toBe(true);
        // The trust scope is always rebuilt by scan: no file for it.
        expect(
            existsSync(await structuresPath(directory, store, TRUST_V1))
        ).toBe(false);

        const { fs } = await reopen(directory, address);
        const runtime = runtimeOf(fs);
        expect(runtime.starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(runtime.starts.get("trust-v1")).toEqual({ kind: "scanned" });
        // Unlinked at open, before ingest: a crash now leaves no file.
        expect(existsSync(file)).toBe(false);
        expect(await stateOf(fs)).toEqual(before);
        expect(await shadow(fs)).toMatchObject({ kind: "equal" });
        expect(await shadow(fs, SCOPE_TRUST_V1)).toMatchObject({
            kind: "equal",
        });
        // The restored state keeps following the store.
        await writeFiles(fs, 3, "later");
        expect(await shadow(fs)).toMatchObject({ kind: "equal" });
    });

    it("leaves no file after a crash, so the next open rebuilds (test 48)", async () => {
        const directory = join(await newRoot(), "peer");
        const first = await runChild(["close", directory]);
        expect(first.code, first.output).toBe(0);
        const address: string = first.report.address;
        const store = Buffer.from(first.report.store, "hex");
        // S14: the child's only remaining work was the close; it still
        // wrote the structures file before the process exited.
        expect(existsSync(await namespaceFile(directory, store))).toBe(true);
        expect(first.report.mode).toBe("worker");

        const crashed = await runChild(["crash", directory, address]);
        if (process.platform === "win32") {
            // Windows has no signals: the self-kill terminates the process
            // with a nonzero exit code and no signal.
            expect(crashed.signal, crashed.output).toBeNull();
            expect(crashed.code, crashed.output).not.toBe(0);
        } else {
            expect(crashed.signal, crashed.output).toBe("SIGKILL");
        }
        expect(crashed.report.start).toEqual({ kind: "restored" });
        expect(existsSync(await namespaceFile(directory, store))).toBe(false);

        const { fs } = await reopen(directory, address);
        expect(runtimeOf(fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
        });
        // The writes after the restore are in the rebuilt state.
        expect(runtimeOf(fs).namespace!.count).toBeGreaterThan(
            crashed.report.count - 1
        );
        expect(await shadow(fs)).toMatchObject({ kind: "equal" });
    });

    it("writes the file after Guard D re-puts in flight at close, equal on reopen (test 57)", async () => {
        const directory = join(await newRoot(), "peer");
        let peer = await createPeer(directory);
        const fs = await openSharedFs({
            peerbit: peer,
            rootKey: peer.identity.publicKey,
            gc: false,
        });
        await writeFiles(fs, 30);
        await runtimeOf(fs).whenStarted();
        const address = fs.address!;
        const store = storeOf(fs);
        // CUTs of live rows: Guard D re-puts them. Close without waiting.
        const rows = await entriesOf(fs)
            .index.index.iterate(
                { query: [] },
                { shape: { id: true, kind: true } }
            )
            .all();
        const ids = rows
            .map((row: any) => row.value)
            .filter((value: any) => value.kind === "naming")
            .slice(0, 8)
            .map((value: any) => value.id);
        const repairs = runtimeOf(fs).namespace!.stats;
        const before = { ...repairs };
        const cuts = ids.map((id: string) =>
            entriesOf(fs)
                .del(id)
                .catch(() => {})
        );
        await Promise.all(cuts);
        await stopPeer(peer);
        // The CUTs and the re-puts both reached the tap before the file.
        expect(repairs.removes - before.removes).toBeGreaterThan(0);
        expect(repairs.adds - before.adds).toBeGreaterThan(0);
        expect(existsSync(await namespaceFile(directory, store))).toBe(true);

        const again = await reopen(directory, address);
        peer = again.peer;
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(await shadow(again.fs)).toMatchObject({ kind: "equal" });
    });

    it("persists and compares across a worker failure right after the answer", async () => {
        // The persist takes the lanes with the cells, the shadow compare the
        // digest with the cells, each in one request: a worker that fails
        // right after answering cannot leave one of the two unanswered.
        const directory = join(await newRoot(), "peer");
        const saved = (AnchorHost as any).sharedHost;
        const host = AnchorHost.fromModules(nodeCrypto, InProcessWorker);
        (AnchorHost as any).sharedHost = Promise.resolve(host);
        let address: string;
        let store: Uint8Array;
        try {
            const peer = await createPeer(directory);
            const fs = await openSharedFs({
                peerbit: peer,
                rootKey: peer.identity.publicKey,
                gc: false,
            });
            await writeFiles(fs, 10);
            address = fs.address!;
            store = storeOf(fs);
            InProcessWorker.failAfter = (message) =>
                message.type === "digestNow" ||
                (message.type === "state" && message.part === "digest");
            expect(await shadow(fs)).toMatchObject({ kind: "equal" });
            expect(host.stats.failures).toBe(1);
            // A second failure within 10 minutes would switch to inline.
            (host as any).lastFailureAt = undefined;
            InProcessWorker.failAfter = (message) =>
                message.type === "lanes" ||
                (message.type === "state" && message.part === "lanes");
            await stopPeer(peer);
            expect(host.stats.failures).toBe(2);
            expect(host.mode).toBe("worker");
        } finally {
            InProcessWorker.failAfter = undefined;
            (AnchorHost as any).sharedHost = saved;
        }
        expect(existsSync(await namespaceFile(directory, store))).toBe(true);
        const { fs } = await reopen(directory, address);
        expect(runtimeOf(fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(await shadow(fs)).toMatchObject({ kind: "equal" });
    });

    it("rebuilds from a torn file (checksum) or a truncated one", async () => {
        const { directory, address, store } = await persisted(5);
        const file = await namespaceFile(directory, store);
        const bytes = await readFile(file);
        bytes[100] ^= 0xff;
        await writeFile(file, bytes);
        const torn = await reopen(directory, address);
        expect(runtimeOf(torn.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "checksum",
        });
        expect(existsSync(file)).toBe(false);
        expect(await shadow(torn.fs)).toMatchObject({ kind: "equal" });
        await stopPeer(torn.peer);

        const intact = await readFile(file);
        await writeFile(file, intact.subarray(0, 20));
        const truncated = await reopen(directory, address);
        expect(runtimeOf(truncated.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "truncated",
        });
        expect(await shadow(truncated.fs)).toMatchObject({ kind: "equal" });
    });

    it("rebuilds when the restored count does not match the index", async () => {
        const { directory, address, store, ids } = await persisted(10);
        const file = await namespaceFile(directory, store);
        const decoded = decodeStructures(
            await readFile(file),
            address,
            SCOPE_NAMESPACE_V1
        );
        if (!decoded.ok) throw new Error(decoded.reason);
        // A consistent, checksummed file whose map lacks one row.
        const { map } = decoded.state;
        expect(map.delete(ids[0]).prev).toBeDefined();
        await writeFile(
            file,
            encodeStructures(address, { ...decoded.state, count: map.size })
        );
        const again = await reopen(directory, address);
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "count",
        });
        // The discarded restore is not kept alive by the runtime.
        expect((runtimeOf(again.fs) as any).persisted).toBeUndefined();
        expect(await shadow(again.fs)).toMatchObject({ kind: "equal" });
    });

    it("persists only a verified count, compared once more at close", async () => {
        const { directory, address, store } = await persisted(5);
        const file = await namespaceFile(directory, store);
        /** The tap's count reads add one row while `wrong()` holds. */
        const skewCount = (fs: SharedFsHandle, wrong: () => boolean) => {
            const tap = runtimeOf(fs).namespace!;
            const count = tap.port.count.bind(tap.port);
            (tap.port as any).count = async () =>
                (await count()) + (wrong() ? 1 : 0);
            return tap;
        };

        // Every read differs: scanned again at once, then a difference no
        // change confirms. Unverified at close, so nothing is written.
        const first = await reopen(directory, address);
        const skewed = skewCount(first.fs, () => true);
        expect(skewed.countVerified).toBe(true);
        expect(await skewed.checkCount()).toBe(false);
        await skewed.countSettled();
        expect(skewed.stats.rescans).toBe(1);
        expect(skewed.countVerified).toBe(false);
        const reads = skewed.stats.countReads;
        await stopPeer(first.peer);
        expect(skewed.stats.countReads).toBe(reads + 1);
        expect(existsSync(file)).toBe(false);

        // Two reads differ: the close's comparison verifies the count, and
        // the file is written.
        const second = await reopen(directory, address);
        expect(runtimeOf(second.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
        });
        let wrong = 2;
        const recovering = skewCount(second.fs, () => wrong-- > 0);
        expect(await recovering.checkCount()).toBe(false);
        await recovering.countSettled();
        expect(recovering.countVerified).toBe(false);
        await stopPeer(second.peer);
        expect(recovering.countVerified).toBe(true);
        expect(existsSync(file)).toBe(true);
        const third = await reopen(directory, address);
        expect(runtimeOf(third.fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(await shadow(third.fs)).toMatchObject({ kind: "equal" });
    });

    it("rejects a file of another address or scope", async () => {
        const directory = join(await newRoot(), "peer");
        const peer = await createPeer(directory);
        const one = await openSharedFs({ peerbit: peer, gc: false });
        const other = await openSharedFs({ peerbit: peer, gc: false });
        await writeFiles(one, 5, "one");
        await writeFiles(other, 7, "other");
        const [a, b] = [one.address!, other.address!];
        const [storeA, storeB] = [storeOf(one), storeOf(other)];
        await stopPeer(peer);
        const fileA = await namespaceFile(directory, storeA);
        const fileB = await namespaceFile(directory, storeB);
        // B's file name, A's content.
        await copyFile(fileA, fileB);
        // A's namespace file as a trust file of A's store.
        const trustA = await structuresPath(directory, storeA, TRUST_V1);
        await copyFile(fileA, trustA);
        expect(await takeStructures(directory, storeA, a, TRUST_V1)).toEqual({
            ok: false,
            reason: "scope",
        });
        expect(existsSync(trustA)).toBe(false);

        const reopened = await reopen(directory, b);
        expect(runtimeOf(reopened.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "address",
        });
        expect(await shadow(reopened.fs)).toMatchObject({ kind: "equal" });
    });

    it("takes the file of another address over the same store, so a later restore is never stale", async () => {
        // Two addresses share one store when only `sealedIgnoredNames` (or
        // the rootKey) differs: the store is keyed by the log id.
        const directory = join(await newRoot(), "peer");
        const id = randomBytes(32);
        let peer = await createPeer(directory);
        const rootKey = peer.identity.publicKey;
        const first = await openSharedFs({
            peerbit: peer,
            id,
            rootKey,
            gc: false,
        });
        await writeFiles(first, 5);
        const a = first.address!;
        const store = storeOf(first);
        await stopPeer(peer);
        const file = await namespaceFile(directory, store);
        expect(existsSync(file)).toBe(true);

        peer = await createPeer(directory);
        const second = await openSharedFs({
            peerbit: peer,
            id,
            rootKey,
            sealedIgnoredNames: [],
            gc: false,
        });
        expect(second.address).not.toBe(a);
        expect(hex(storeOf(second))).toBe(hex(store));
        await runtimeOf(second).whenStarted();
        // The open took A's file (and rejected it: another address).
        expect(runtimeOf(second).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "address",
        });
        expect(existsSync(file)).toBe(false);
        // A change that keeps the count: overwrites, then GC retires the
        // superseded versions.
        const count = runtimeOf(second).namespace!.count;
        await writeFiles(second, 5);
        await second.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: Date.now() + 40 * 24 * 3600 * 1000,
            keepVersions: 1,
            retentionMs: 0,
            graceMs: 0,
        });
        await runtimeOf(second).namespace!.verifyIdle();
        expect(runtimeOf(second).namespace!.count).toBe(count);
        await stopPeer(peer);

        // A again: B's file is for B, so A scans the changed store.
        const again = await reopen(directory, a);
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "address",
        });
        expect(await shadow(again.fs)).toMatchObject({ kind: "equal" });
    });

    it("removes the file beside the trust graph's open, and before the store ingests", async () => {
        const { directory, address, store } = await persisted(3);
        const file = await namespaceFile(directory, store);
        expect(existsSync(file)).toBe(true);
        // The removal waits until the trust graph's open began (or 2 s).
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fallback = setTimeout(() => release(), 2_000);
        let taking = true;
        const rm = fsPromises.rm;
        fsPromises.rm = (async (target: any, options?: any) => {
            if (String(target) === file) {
                await gate;
                taking = false;
            }
            return rm(target, options);
        }) as typeof rm;
        syncBuiltinESMExports();
        const order: string[] = [];
        const trustOpen = TrustedNetwork.prototype.open;
        TrustedNetwork.prototype.open = async function (
            this: any,
            ...args: any[]
        ) {
            order.push(taking ? "trust open, file taking" : "trust open");
            release();
            return trustOpen.apply(this, args as any);
        };
        const attach = ReadinessRuntime.prototype.attachNamespace;
        ReadinessRuntime.prototype.attachNamespace = function (
            this: ReadinessRuntime,
            entries: any
        ) {
            order.push(existsSync(file) ? "attach, file present" : "attach");
            return attach.call(this, entries);
        };
        let again: Awaited<ReturnType<typeof reopen>>;
        try {
            again = await reopen(directory, address);
        } finally {
            clearTimeout(fallback);
            fsPromises.rm = rm;
            syncBuiltinESMExports();
            TrustedNetwork.prototype.open = trustOpen;
            ReadinessRuntime.prototype.attachNamespace = attach;
        }
        expect(order).toEqual(["trust open, file taking", "attach"]);
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
    });

    it("writes nothing when close() returns false (S7)", async () => {
        const { directory, address, store } = await persisted(3);
        const file = await namespaceFile(directory, store);
        const { peer, fs } = await reopen(directory, address);
        expect(existsSync(file)).toBe(false);
        // Another parent still holds the program: Program.close returns
        // false and the stores stay open.
        const program = fs.program as any;
        const close = Program.prototype.close;
        Program.prototype.close = function (this: any, from?: any) {
            if (this === program) {
                Program.prototype.close = close;
                return Promise.resolve(false);
            }
            return close.call(this, from);
        };
        try {
            expect(await program.close()).toBe(false);
        } finally {
            Program.prototype.close = close;
        }
        expect(existsSync(file)).toBe(false);
        expect(program.entries.closed).toBe(false);
        await stopPeer(peer);
        // The real close ran without a runtime: still no file.
        expect(existsSync(file)).toBe(false);
        const again = await reopen(directory, address);
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
        });
    });

    it("never restores a file an open could not remove (void marker)", async () => {
        const { directory, address, store } = await persisted(5);
        const file = await namespaceFile(directory, store);
        const marker = `${file}.void`;
        // Held while the open runs: the open cannot unlink it.
        let unlock = lockRemoval(file);
        const second = await reopen(directory, address).finally(unlock);
        expect(runtimeOf(second.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "unlink: EPERM",
        });
        expect(existsSync(file)).toBe(true);
        expect(existsSync(marker)).toBe(true);
        // A change that keeps the count: overwrites, then GC retires the
        // superseded versions.
        const count = runtimeOf(second.fs).namespace!.count;
        await writeFiles(second.fs, 5);
        await second.fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: Date.now() + 40 * 24 * 3600 * 1000,
            keepVersions: 1,
            retentionMs: 0,
            graceMs: 0,
        });
        await runtimeOf(second.fs).namespace!.verifyIdle();
        expect(runtimeOf(second.fs).namespace!.count).toBe(count);
        // A crash: no replacement file is written.
        optOutOfReadinessShadow(second.fs.program);
        runtimeOf(second.fs).disposeWithoutPersist();
        (second.fs.program as any).readinessRuntime = undefined;
        await stopPeer(second.peer);
        expect(existsSync(file)).toBe(true);

        // The stale file matches the count, but its marker voids it.
        const third = await reopen(directory, address);
        expect(runtimeOf(third.fs).starts.get("namespace-v1")).toEqual({
            kind: "scanned",
            rejected: "void",
        });
        expect(existsSync(file)).toBe(false);
        expect(existsSync(marker)).toBe(false);
        expect(await shadow(third.fs)).toMatchObject({ kind: "equal" });
        await stopPeer(third.peer);

        // A clean close replaces a voided file and drops its marker.
        unlock = lockRemoval(file);
        const fourth = await reopen(directory, address).finally(unlock);
        expect(existsSync(marker)).toBe(true);
        await writeFiles(fourth.fs, 2, "later");
        await stopPeer(fourth.peer);
        expect(existsSync(marker)).toBe(false);
        const fifth = await reopen(directory, address);
        expect(runtimeOf(fifth.fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(await shadow(fifth.fs)).toMatchObject({ kind: "equal" });
    });

    it("releases the readiness state on drop and never persists it", async () => {
        const directory = join(await newRoot(), "peer");
        const peer = await createPeer(directory);
        const host = await AnchorHost.shared();
        const before = host.openSets;
        const fs = await openSharedFs({
            peerbit: peer,
            rootKey: peer.identity.publicKey,
            gc: false,
        });
        await writeFiles(fs, 3);
        const runtime = runtimeOf(fs);
        await runtime.whenStarted();
        const store = storeOf(fs);
        expect(host.openSets).toBe(before + 2);
        // Program.drop does not run close(): the override releases the
        // lane sets, which would otherwise pin the dropped program on the
        // process-wide host.
        expect(await fs.program.drop()).toBe(true);
        expect(runtime.disposed).toBe(true);
        expect(runtime.namespace).toBeUndefined();
        expect(host.openSets).toBe(before);
        // A close after the drop has nothing to write.
        await fs.program.close();
        await stopPeer(peer);
        expect(existsSync(await namespaceFile(directory, store))).toBe(false);
    });

    it("compares the restore count only at a stable epoch (S11)", async () => {
        const rows = new Map<string, IndexedHead>();
        const port = {
            onCount: undefined as undefined | (() => void),
            readHead: async (key: any) => rows.get(key),
            async *scan() {
                yield [...rows].map(([key, row]) => ({ key, ...row }));
            },
            count: async () => {
                const n = rows.size;
                await Promise.resolve();
                const hook = port.onCount;
                port.onCount = undefined;
                hook?.();
                return n;
            },
        };
        const head = () => digestToHead(randomBytes(DIGEST_BYTES));
        const naming = (id: string, h: string) => {
            const value = Object.create(NamingEvent.prototype);
            value.id = id;
            value.__context = { head: h, modified: 1n };
            return value;
        };
        /** The index's rows as a map, optionally without one id. */
        const mapOf = async (drop?: string) => {
            const seed = new ScopeTap(NAMESPACE_V1, port);
            await seed.seedFromScan();
            if (drop) seed.map.delete(drop);
            return seed.map;
        };
        for (let i = 0; i < 5; i++) {
            rows.set(`n${i}`, { head: head(), modified: 1n });
        }
        const arrival = naming("late", head());

        // A correct restore with an arrival inside the count await: a naive
        // compare sees 5 indexed against 6 maintained and discards it.
        const correct = new ScopeTap(NAMESPACE_V1, port);
        correct.restore({
            map: await mapOf(),
            hlc: 1n,
            epoch: 5,
        });
        port.onCount = () => {
            rows.set("late", { head: arrival.__context.head, modified: 1n });
            correct.onChange({ detail: { added: [arrival] } });
        };
        expect(await correct.restoredCountMatches()).toBe(true);

        // A wrong restore (one row missing) with an arrival inside the
        // await: a naive compare sees 6 against 6 and accepts it.
        rows.delete("late");
        const wrong = new ScopeTap(NAMESPACE_V1, port);
        wrong.restore({
            map: await mapOf("n0"),
            hlc: 1n,
            epoch: 4,
        });
        port.onCount = () => {
            rows.set("late", { head: arrival.__context.head, modified: 1n });
            wrong.onChange({ detail: { added: [arrival] } });
        };
        expect(await wrong.restoredCountMatches()).toBe(false);
    });
});
