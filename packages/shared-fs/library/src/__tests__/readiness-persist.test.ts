import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { NamingEvent } from "../model.js";
import { DIGEST_BYTES } from "../readiness/constants.js";
import { digestToHead } from "../readiness/digest.js";
import {
    decodeStructures,
    encodeStructures,
    structuresPath,
    takeStructures,
} from "../readiness/persist.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import { compareScope } from "../readiness/shadow.js";
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
    const cells = hex(scope.cells.toBytes());
    const { count, hlc } = scope.tap;
    const anchor = hex(await scope.laneSet.digestNow().digest);
    return { count, hlc, cells, anchor };
};

const writeFiles = async (fs: SharedFsHandle, n: number, prefix = "f") => {
    for (let i = 0; i < n; i++) {
        await fs.writeFile(`/${prefix}${i}.txt`, `content ${prefix} ${i}`);
    }
};

const namespaceFile = (directory: string, address: string) =>
    structuresPath(directory, address, NAMESPACE_V1);

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
        const ids: string[] = (
            await entriesOf(fs)
                .index.index.iterate(
                    { query: NAMESPACE_V1.scanQuery() },
                    { shape: { id: true } }
                )
                .all()
        ).map((row: any) => row.value.id);
        await stopPeer(peer);
        return { directory, address, before, ids };
    };
    const reopen = async (directory: string, address: string) => {
        const peer = await createPeer(directory);
        const fs = await openSharedFs({ peerbit: peer, address, gc: false });
        await runtimeOf(fs).whenStarted();
        return { peer, fs };
    };

    it("restores at a clean reopen and equals a fresh build (test 48)", async () => {
        const { directory, address, before } = await persisted();
        const file = await namespaceFile(directory, address);
        expect(existsSync(file)).toBe(true);
        // The trust scope is always rebuilt by scan: no file for it.
        expect(
            existsSync(await structuresPath(directory, address, TRUST_V1))
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
        // S14: the child's only remaining work was the close; it still
        // wrote the structures file before the process exited.
        expect(existsSync(await namespaceFile(directory, address))).toBe(true);
        expect(first.report.mode).toBe("worker");

        const crashed = await runChild(["crash", directory, address]);
        expect(crashed.signal, crashed.output).toBe("SIGKILL");
        expect(crashed.report.start).toEqual({ kind: "restored" });
        expect(existsSync(await namespaceFile(directory, address))).toBe(false);

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
        expect(existsSync(await namespaceFile(directory, address))).toBe(true);

        const again = await reopen(directory, address);
        peer = again.peer;
        expect(runtimeOf(again.fs).starts.get("namespace-v1")).toEqual({
            kind: "restored",
        });
        expect(await shadow(again.fs)).toMatchObject({ kind: "equal" });
    });

    it("rebuilds from a torn file (checksum) or a truncated one", async () => {
        const { directory, address } = await persisted(5);
        const file = await namespaceFile(directory, address);
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
        const { directory, address, ids } = await persisted(10);
        const file = await namespaceFile(directory, address);
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

    it("rejects a file of another address or scope", async () => {
        const directory = join(await newRoot(), "peer");
        const peer = await createPeer(directory);
        const one = await openSharedFs({ peerbit: peer, gc: false });
        const other = await openSharedFs({ peerbit: peer, gc: false });
        await writeFiles(one, 5, "one");
        await writeFiles(other, 7, "other");
        const [a, b] = [one.address!, other.address!];
        await stopPeer(peer);
        const fileA = await namespaceFile(directory, a);
        const fileB = await namespaceFile(directory, b);
        // B's file name, A's content.
        await copyFile(fileA, fileB);
        // A's namespace file as A's trust file.
        const trustA = await structuresPath(directory, a, TRUST_V1);
        await copyFile(fileA, trustA);
        expect(await takeStructures(directory, a, TRUST_V1)).toEqual({
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

    it("writes nothing when close() returns false (S7)", async () => {
        const { directory, address } = await persisted(3);
        const file = await namespaceFile(directory, address);
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
