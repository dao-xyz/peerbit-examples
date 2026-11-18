import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONFLICTS_DIR,
    ROOT_NODE_ID,
    createSharedFsMountBackend,
    localOverlayDirectory,
    openMountLocalOverlay,
    openSharedFs,
    pathSegments,
    type IgnoreAwareFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
    type SharedFsMountBackendOptions,
    type SharedFsMountBackendTarget,
    type SharedFsNamespaceChange,
} from "../index.js";
import {
    bindMountLocalOverlay,
    guardSharedMutations,
    hostRefusesName,
    localLinkTargetError,
    localOverlayErrorCode,
    localOverlayHost,
} from "../mount-local-overlay.js";

/**
 * A mount's local overlay, through the mount backend as the native adapter
 * drives it: one peer, temporary directories, no FUSE. Every wait resolves
 * on an event and only gives up at a labelled deadline.
 */

/** Give-up bound for one awaited event; never a pass condition. */
const STEP_MS = 20_000;

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) =>
    bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const hex = (nodeId: string) => Buffer.from(nodeId, "utf8").toString("hex");
const ROOT_KEY = hex(ROOT_NODE_ID);

/** Whether this host lets this user create symlinks (Windows may not). */
const canSymlink = (() => {
    const probe = nodeFs.mkdtempSync(join(tmpdir(), "shared-fs-link-probe-"));
    try {
        nodeFs.symlinkSync("target", join(probe, "link"), "file");
        return true;
    } catch {
        return false;
    } finally {
        nodeFs.rmSync(probe, { recursive: true, force: true });
    }
})();

/** `promise`, or a rejection naming `label` once STEP_MS pass. */
const within = async <T>(promise: Promise<T>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(`gave up after ${STEP_MS} ms: ${label}`)
                        ),
                    STEP_MS
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/** The next namespace change of `fs` that `matches`; subscribe before acting. */
const nextNamespaceChange = (
    fs: SharedFsHandle,
    matches: (change: SharedFsNamespaceChange) => boolean
) => {
    let unsubscribe: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
        unsubscribe = fs.onNamespaceChange((change) => {
            if (matches(change)) resolve();
        });
    });
    return within(seen, "the namespace change arrives").finally(() =>
        unsubscribe?.()
    );
};

/** Write `.artifactignore` and wait until the handle applies it. */
const setIgnoreRules = async (
    fs: IgnoreAwareFs,
    rules: string,
    applied: () => boolean
) => {
    const events = fs.program.events as unknown as EventTarget;
    let check: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
        check = () => {
            if (applied()) resolve();
        };
        events.addEventListener("ignore:rules-changed", check);
    });
    try {
        await fs.program.writeFile("/.artifactignore", rules);
        await within(changed, "the ignore rules change");
    } finally {
        events.removeEventListener("ignore:rules-changed", check!);
    }
};

const writeThrough = async (
    backend: SharedFsMountBackend,
    path: string,
    text: string
) => {
    const handle = await backend.open(path, {
        write: true,
        create: true,
        truncate: true,
    });
    await backend.write(handle, encode(text), 0);
    await backend.release(handle);
};

const readThrough = async (backend: SharedFsMountBackend, path: string) => {
    const handle = await backend.open(path, { read: true });
    try {
        return decode(await backend.read(handle, 1 << 20, 0));
    } finally {
        await backend.release(handle);
    }
};

const names = async (backend: SharedFsMountBackend, path: string) =>
    (await backend.readdir(path)).map((entry) => entry.name).sort();

/**
 * What a package manager does under `base`/node_modules: directories, files
 * with exec bits and times, a bin link, a staged rename, removals.
 */
const localWorkload = async (backend: SharedFsMountBackend, base = "") => {
    const root = `${base}/node_modules`;
    await backend.mkdir(root);
    for (const dir of ["a", "b", "@scope", "@scope/c", ".bin", ".staging"]) {
        await backend.mkdir(`${root}/${dir}`);
    }
    for (const pkg of ["a", "b", "@scope/c"]) {
        await writeThrough(
            backend,
            `${root}/${pkg}/package.json`,
            JSON.stringify({ name: pkg })
        );
        await writeThrough(backend, `${root}/${pkg}/index.js`, "exports.x=1\n");
        await backend.setattr(`${root}/${pkg}/index.js`, {
            mode: 0o755,
            mtimeMs: 499_162_500_000,
        });
    }
    if (canSymlink) await backend.symlink("../a/index.js", `${root}/.bin/a`);
    await writeThrough(backend, `${root}/.staging/d.js`, "staged");
    await backend.rename(`${root}/.staging/d.js`, `${root}/a/d.js`);
    await backend.rmdir(`${root}/.staging`);
    await backend.unlink(`${root}/b/index.js`);
    await backend.truncate(`${root}/a/package.json`, 0);
    await backend.readdir(root, { includeStats: true });
    await backend.getattr(`${root}/a/d.js`);
};

describe("mount local overlay", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let temp: string;
    let overlayDir: string;
    const backends: Array<{ dispose(): void }> = [];

    beforeEach(async () => {
        temp = await mkdtemp(join(tmpdir(), "shared-fs-local-overlay-"));
        overlayDir = join(temp, "overlay");
        peer = await Peerbit.create();
        // No background publication: every log entry is one this test made.
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "local",
            gc: false,
            snapshot: { disabled: true },
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        for (const backend of backends.splice(0)) backend.dispose();
        await peer.stop();
        await rm(temp, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
        });
    });

    const openOverlay = (address = fs.address, directory = overlayDir) =>
        openMountLocalOverlay({
            directory,
            address,
            sealedNames: fs.program.sealedIgnoredNames,
        });

    const mount = async (
        target: SharedFsMountBackendTarget & { address?: string } = fs,
        options: Omit<SharedFsMountBackendOptions, "localOverlay"> = {}
    ) => {
        const localOverlay = await openOverlay(target.address ?? fs.address);
        const backend = createSharedFsMountBackend(target, {
            ...options,
            localOverlay,
        });
        backends.push(backend);
        return { backend, localOverlay };
    };

    const openIgnoring = async (
        ignore: Parameters<typeof openSharedFs>[0]["ignore"]
    ) =>
        (await openSharedFs({
            peerbit: peer,
            machineLabel: "local",
            gc: false,
            snapshot: { disabled: true },
            ignore,
        })) as IgnoreAwareFs;

    it("classifies by path only, at the shallowest sealed name or ignored boundary", async () => {
        const ignoring = await openIgnoring({
            patterns: ["dist/", "cache/", "/Build/"],
            casefold: "unicode-simple",
        });
        const overlay = bindMountLocalOverlay(
            await openOverlay(ignoring.address),
            ignoring,
            { allocateHandle: () => 0, bumpStamp: () => {} }
        );
        const route = (path: string) => overlay.route(path);
        expect(route("/")).toBeUndefined();
        expect(route(`/${CONFLICTS_DIR}/x/node_modules/y`)).toBeUndefined();
        expect(route("/src/index.js")).toBeUndefined();
        expect(route("/node_modules")).toEqual({
            path: "/node_modules",
            anchorPath: "/",
            boundary: "node_modules",
            rest: [],
        });
        expect(route("/a/node_modules/b/node_modules/c")).toEqual({
            path: "/a/node_modules/b/node_modules/c",
            anchorPath: "/a",
            boundary: "node_modules",
            rest: ["b", "node_modules", "c"],
        });
        // Byte-exact: another spelling is an ordinary shared name.
        expect(route("/Node_Modules/x")).toBeUndefined();
        // An ignored boundary below a sealed name: the sealed name wins.
        expect(route("/a/node_modules/cache/x")).toMatchObject({
            anchorPath: "/a",
            boundary: "node_modules",
            rest: ["cache", "x"],
        });
        // Above it: the ignored boundary wins.
        expect(route("/pkg/dist/node_modules/x")).toMatchObject({
            anchorPath: "/pkg",
            boundary: "dist",
            rest: ["node_modules", "x"],
        });
        // A casefolded rule reports a folded boundary; only its depth counts.
        expect(ignoring.ignoreCheck("/BUILD/out.js")).toMatchObject({
            ignored: true,
            boundary: "/build",
        });
        expect(route("/BUILD/out.js")).toEqual({
            path: "/BUILD/out.js",
            anchorPath: "/",
            boundary: "BUILD",
            rest: ["out.js"],
        });
    });

    it("serves a sealed directory locally with POSIX behaviour", async () => {
        // A clock that moves on every reading, from mid-second: a directory
        // time never runs more than a second ahead of the clock, so with
        // the wall clock a mount started at a whole second could keep the
        // root's time through a change made in that same millisecond.
        let now = 1_700_000_000_500;
        const { backend } = await mount(fs, { clock: () => (now += 1) });
        const rootTime = (await backend.getattr("/")).mtimeMs;
        await backend.mkdir("/node_modules");
        // A new name under the anchor moves the anchor's time.
        expect((await backend.getattr("/")).mtimeMs).toBeGreaterThan(rootTime);
        expect(await backend.readdir("/")).toEqual([
            { name: "node_modules", kind: "directory" },
        ]);
        await backend.mkdir("/node_modules/pkg");
        const file = "/node_modules/pkg/index.js";

        const handle = await backend.open(
            file,
            { read: true, write: true, create: true, exclusive: true },
            0o644
        );
        expect(await backend.write(handle, encode("hello"), 0)).toBe(5);
        expect(decode(await backend.read(handle, 64, 0))).toBe("hello");
        await backend.flush(handle);
        await backend.fsync(handle);
        await backend.release(handle);
        const appending = await backend.open(file, {
            write: true,
            append: true,
        });
        await backend.write(appending, encode(" world"), 0);
        await backend.release(appending);
        expect(await readThrough(backend, file)).toBe("hello world");

        // chmod keeps every permission bit; utimens sets the time.
        await backend.setattr(file, {
            mode: 0o750,
            mtimeMs: 1_600_000_000_000,
        });
        const stat = await backend.getattr(file);
        expect(stat).toMatchObject({
            path: file,
            kind: "file",
            size: 11,
            mtimeMs: 1_600_000_000_000,
        });
        if (process.platform !== "win32") expect(stat.mode).toBe(0o100750);

        await backend.truncate(file, 5);
        expect(await readThrough(backend, file)).toBe("hello");
        const truncating = await backend.open(file, {
            read: true,
            write: true,
        });
        await backend.truncate(truncating, 2);
        expect(decode(await backend.read(truncating, 64, 0))).toBe("he");
        await backend.release(truncating);

        if (canSymlink) {
            await backend.symlink("pkg/index.js", "/node_modules/link");
            expect(await backend.readlink("/node_modules/link")).toBe(
                "pkg/index.js"
            );
            expect(await backend.getattr("/node_modules/link")).toMatchObject({
                kind: "symlink",
                size: 12,
                mode: 0o120777,
            });
        }

        await backend.rename(file, "/node_modules/pkg/main.js");
        // mknod: the adapter opens {write, create, exclusive}, then releases.
        await backend.release(
            await backend.open("/node_modules/pkg/empty", {
                write: true,
                create: true,
                exclusive: true,
            })
        );
        const listed = await backend.readdir("/node_modules/pkg", {
            includeStats: true,
        });
        expect(listed.map((entry) => [entry.name, entry.kind]).sort()).toEqual([
            ["empty", "file"],
            ["main.js", "file"],
        ]);
        // A listing's stats are getattr's.
        const {
            path: _,
            kind: __,
            ...mainStat
        } = await backend.getattr("/node_modules/pkg/main.js");
        expect(mainStat).toMatchObject({ size: 2, nlink: 1 });
        expect(listed.find((entry) => entry.name === "main.js")?.stat).toEqual(
            mainStat
        );
        await expect(
            backend.open("/node_modules/pkg/empty", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });
        await expect(
            backend.open("/node_modules/pkg", { read: true })
        ).rejects.toMatchObject({ code: "EISDIR" });

        await backend.unlink("/node_modules/pkg/main.js");
        await backend.unlink("/node_modules/pkg/empty");
        await expect(backend.rmdir("/node_modules")).rejects.toMatchObject({
            code: "ENOTEMPTY",
        });
        await backend.rmdir("/node_modules/pkg");
        if (canSymlink) await backend.unlink("/node_modules/link");
        expect(await backend.readdir("/node_modules")).toEqual([]);
        // It all lives on this machine, under the root's node id.
        expect(
            await readdir(join(overlayDir, "n", ROOT_KEY, "node_modules"))
        ).toEqual([]);
        expect(await fs.stat("/node_modules")).toBeUndefined();
    });

    it("publishes nothing from local paths", async () => {
        const { backend } = await mount();
        // The store the filesystem's log writes its blocks to (not the
        // peer's block service), and the local store under it.
        const logBlocks = fs.program.entries.log.log.blocks as any;
        const blockWrites = [logBlocks, logBlocks.localStore].flatMap((store) =>
            ["put", "putMany", "putKnown", "putKnownMany"]
                .filter((method) => typeof store?.[method] === "function")
                .map((method) => vi.spyOn(store, method))
        );
        const blocksWritten = () =>
            blockWrites.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
        await writeThrough(backend, "/shared.txt", "shared");
        await backend.mkdir("/nested");
        // Control: the spies see a shared change's blocks.
        expect(blocksWritten()).toBeGreaterThan(0);
        const state = async () => ({
            logHashes: (await fs.program.entries.log.log.toArray())
                .map((entry) => entry.hash)
                .sort(),
            pending: fs.pendingLocalWrites().entries,
            listing: (await fs.list("/")).map((entry) => entry.name),
            conflicts: await backend.readdir(`/${CONFLICTS_DIR}`),
        });
        const before = await state();
        for (const spy of blockWrites) spy.mockClear();
        await localWorkload(backend);
        await localWorkload(backend, "/nested");
        expect(blocksWritten()).toBe(0);
        expect(await state()).toEqual(before);
        expect([...before.listing].sort()).toEqual(["nested", "shared.txt"]);
    });

    it("lists local entries in their shared parent and hides a shared entry of the same name", async () => {
        const { backend } = await mount();
        // A file named node_modules is legal and replicates.
        await fs.mkdir("/p");
        await fs.writeFile("/p/node_modules", "shared bytes");
        await fs.writeFile("/p/readme.md", "readme");
        expect(await names(backend, "/p")).toEqual(["readme.md"]);
        await expect(backend.getattr("/p/node_modules")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(backend.unlink("/p/node_modules")).rejects.toMatchObject({
            code: "ENOENT",
        });

        // mkdir never depends on the shared side.
        await backend.mkdir("/p/node_modules");
        await writeThrough(backend, "/p/node_modules/x.js", "x");
        expect(
            (await backend.readdir("/p")).sort((a, b) =>
                a.name.localeCompare(b.name)
            )
        ).toEqual([
            { name: "node_modules", kind: "directory" },
            { name: "readme.md", kind: "file" },
        ]);
        const withStats = await backend.readdir("/p", { includeStats: true });
        expect(
            withStats.find((entry) => entry.name === "node_modules")
        ).toMatchObject({ kind: "directory", stat: { size: 0 } });

        await backend.rename("/p/node_modules/x.js", "/p/node_modules/y.js");
        await backend.unlink("/p/node_modules/y.js");
        await backend.rmdir("/p/node_modules");
        expect(await names(backend, "/p")).toEqual(["readme.md"]);
        // The shared file is untouched, and the library still shows it.
        expect(decode(await fs.readFile("/p/node_modules"))).toBe(
            "shared bytes"
        );
        expect((await fs.list("/p")).map((entry) => entry.name).sort()).toEqual(
            ["node_modules", "readme.md"]
        );
    });

    it("refuses renames between local and shared paths with EXDEV and changes nothing", async () => {
        const { backend } = await mount();
        await writeThrough(backend, "/main.js", "main");
        await backend.mkdir("/lib");
        await backend.mkdir("/node_modules");
        await writeThrough(backend, "/node_modules/dep.js", "dep");
        const state = async () => ({
            shared: (await fs.list("/")).map((entry) => entry.name).sort(),
            local: await names(backend, "/node_modules"),
            main: await readThrough(backend, "/main.js"),
            dep: await readThrough(backend, "/node_modules/dep.js"),
        });
        const before = await state();

        for (const [from, to] of [
            ["/main.js", "/node_modules/main.js"],
            ["/node_modules/dep.js", "/dep.js"],
            ["/node_modules", "/modules"],
            ["/lib", "/node_modules/lib"],
        ]) {
            await expect(backend.rename(from, to)).rejects.toMatchObject({
                code: "EXDEV",
            });
        }
        // A missing source is ENOENT, as for any rename.
        await expect(
            backend.rename("/missing.js", "/node_modules/missing.js")
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            backend.rename("/node_modules/missing.js", "/missing.js")
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await state()).toEqual(before);
    });

    it("keeps a shared directory holding local entries from being removed or replaced", async () => {
        const { backend } = await mount();
        await backend.mkdir("/p");
        await backend.mkdir("/q");
        await backend.mkdir("/p/node_modules");
        await writeThrough(backend, "/p/node_modules/x.js", "x");
        await expect(backend.rmdir("/p")).rejects.toMatchObject({
            code: "ENOTEMPTY",
        });
        await expect(backend.rename("/q", "/p")).rejects.toMatchObject({
            code: "ENOTEMPTY",
        });
        await backend.unlink("/p/node_modules/x.js");
        // An empty local directory is still an entry.
        await expect(backend.rmdir("/p")).rejects.toMatchObject({
            code: "ENOTEMPTY",
        });
        expect(await fs.stat("/p")).toMatchObject({ kind: "directory" });
        expect(await fs.stat("/q")).toMatchObject({ kind: "directory" });

        await backend.rmdir("/p/node_modules");
        // Once they are gone, the target answers: it replaces no directory.
        await expect(backend.rename("/q", "/p")).rejects.toMatchObject({
            code: "EISDIR",
        });
        await backend.rmdir("/p");
        expect(await fs.stat("/p")).toBeUndefined();
        expect(await fs.stat("/q")).toMatchObject({ kind: "directory" });
    });

    it("follows its directory through the mount's own rename and another writer's", async () => {
        const { backend } = await mount();
        await backend.mkdir("/p");
        await backend.mkdir("/p/node_modules");
        await writeThrough(backend, "/p/node_modules/x.js", "x");

        await backend.rename("/p", "/r");
        expect(await readThrough(backend, "/r/node_modules/x.js")).toBe("x");
        await expect(
            backend.getattr("/p/node_modules/x.js")
        ).rejects.toMatchObject({ code: "ENOENT" });

        const moved = nextNamespaceChange(fs, (change) =>
            change.moves.some((move) => move.to?.name === "s")
        );
        await fs.rename("/r", "/s");
        await moved;
        expect(await readThrough(backend, "/s/node_modules/x.js")).toBe("x");
        expect(await names(backend, "/s")).toEqual(["node_modules"]);
        await expect(
            backend.getattr("/r/node_modules/x.js")
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps local entries across remounts and refuses another filesystem's or format's directory", async () => {
        expect(localOverlayDirectory("/state", fs.address)).toBe(
            join(
                "/state",
                "shared-fs-local-overlay",
                createHash("sha256")
                    .update(fs.address)
                    .digest("hex")
                    .slice(0, 32)
            )
        );
        const first = await mount();
        await first.backend.mkdir("/node_modules");
        await writeThrough(first.backend, "/node_modules/kept.js", "kept");
        first.backend.dispose();
        expect(
            JSON.parse(await readFile(join(overlayDir, "meta.json"), "utf8"))
        ).toEqual({ format: 1, address: fs.address });

        const second = await mount();
        expect(await readThrough(second.backend, "/node_modules/kept.js")).toBe(
            "kept"
        );
        // One overlay serves one backend.
        expect(() =>
            createSharedFsMountBackend(fs, {
                localOverlay: second.localOverlay,
            })
        ).toThrow(expect.objectContaining({ code: "EINVAL" }));

        await expect(openOverlay("another-address")).rejects.toMatchObject({
            code: "EINVAL",
            message: expect.stringMatching(/move or delete/),
        });
        const future = join(temp, "future");
        await mkdir(future, { recursive: true });
        await writeFile(
            join(future, "meta.json"),
            JSON.stringify({ format: 2, address: fs.address })
        );
        await expect(openOverlay(fs.address, future)).rejects.toMatchObject({
            code: "EINVAL",
            message: `this local overlay has format 2; this version reads format 1: move or delete ${future}`,
        });
    });

    it("removes only empty attachment directories when it opens", async () => {
        const nodes = join(overlayDir, "n");
        await mkdir(join(nodes, hex("dir:empty")), { recursive: true });
        await mkdir(join(nodes, hex("dir:held"), "node_modules"), {
            recursive: true,
        });
        await mkdir(join(nodes, "not-hex"), { recursive: true });
        await writeFile(join(nodes, hex("dir:file")), "x");
        await writeFile(
            join(overlayDir, "meta.json"),
            JSON.stringify({ format: 1, address: fs.address })
        );
        await openOverlay();
        expect((await readdir(nodes)).sort()).toEqual(
            [hex("dir:file"), hex("dir:held"), "not-hex"].sort()
        );
    });

    it("maps host errors onto backend codes and prints an unexpected one once", async () => {
        for (const [code, expected] of [
            ["ENOENT", "ENOENT"],
            ["EEXIST", "EEXIST"],
            ["ENOTEMPTY", "ENOTEMPTY"],
            ["EACCES", "EACCES"],
            ["EROFS", "EROFS"],
            ["ENAMETOOLONG", "ENAMETOOLONG"],
            ["EXDEV", "EXDEV"],
            ["ENOSPC", "ENOSPC"],
            ["EDQUOT", "EDQUOT"],
            ["EPERM", "EPERM"],
            ["EBUSY", "EPERM"],
            ["ENOTSUP", "EPERM"],
            ["EOPNOTSUPP", "EPERM"],
            ["ELOOP", "EINVAL"],
            ["ERR_INVALID_ARG_VALUE", "EINVAL"],
            ["ERR_INVALID_ARG_TYPE", "EINVAL"],
            ["EMFILE", undefined],
            ["ENFILE", undefined],
            ["EIO", undefined],
        ] as const) {
            expect(
                localOverlayErrorCode(Object.assign(new Error(code), { code }))
            ).toBe(expected);
        }
        expect(localOverlayErrorCode(new Error("no code"))).toBeUndefined();

        const { backend } = await mount();
        await backend.mkdir("/node_modules");
        const printed = vi.spyOn(console, "error").mockImplementation(() => {});
        const lstatCall = vi.spyOn(localOverlayHost, "lstat");
        for (const [code, expected] of [
            ["EBUSY", "EPERM"],
            ["ENOSPC", "ENOSPC"],
            ["EDQUOT", "EDQUOT"],
            ["EMFILE", "EIO"],
            ["EMFILE", "EIO"],
        ] as const) {
            lstatCall.mockRejectedValueOnce(
                Object.assign(new Error(`${code}: injected`), { code })
            );
            await expect(
                backend.getattr("/node_modules")
            ).rejects.toMatchObject({ code: expected });
        }
        expect(printed.mock.calls.map((args) => args.join(" "))).toEqual([
            "shared-fs local overlay: lstat /node_modules: EMFILE EMFILE: injected",
        ]);
    });

    it("validates names before they reach the host", async () => {
        const { backend } = await mount();
        await backend.mkdir("/node_modules");
        const hostCalls = [
            vi.spyOn(localOverlayHost, "mkdir"),
            vi.spyOn(localOverlayHost, "open"),
            vi.spyOn(localOverlayHost, "symlink"),
            vi.spyOn(localOverlayHost, "rename"),
        ];
        await expect(
            backend.mkdir(`/node_modules/${"x".repeat(256)}`)
        ).rejects.toMatchObject({ code: "ENAMETOOLONG" });
        await expect(
            backend.open("/node_modules/a\u0001b", {
                write: true,
                create: true,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.symlink("target", "/node_modules/a\u007fb")
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.symlink("", "/node_modules/empty-target")
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(backend.mkdir("/node_modules/a\\b")).rejects.toMatchObject(
            { code: "EINVAL" }
        );
        for (const spy of hostCalls) expect(spy).not.toHaveBeenCalled();

        // A Windows host also refuses these, before anything is created.
        for (const name of [
            "a:b",
            "a*b",
            "a?b",
            'a"b',
            "a<b",
            "a>b",
            "a|b",
            "trailing.",
            "trailing ",
            "CON",
            "con.txt",
            "Nul",
            "AUX",
            "PRN",
            "COM1",
            "com9.js",
            "LPT1",
            "lpt9.tar.gz",
        ]) {
            expect(hostRefusesName(name, "win32"), name).toBe(true);
            expect(hostRefusesName(name, "linux"), name).toBe(false);
        }
        for (const name of ["a.b", "console", "com10", "nul_", ".bin", "a b"]) {
            expect(hostRefusesName(name, "win32"), name).toBe(false);
        }
        expect(localLinkTargetError("x".repeat(1023))).toBeUndefined();
        expect(localLinkTargetError("../a/b", "win32")).toBeUndefined();
        for (const target of ["", "x".repeat(1024), "a\0b"]) {
            expect(localLinkTargetError(target)).toBeDefined();
        }
        for (const target of ["/abs", "a\\b", "c:x"]) {
            expect(localLinkTargetError(target, "win32"), target).toBeDefined();
        }
        expect(localLinkTargetError("/abs", "linux")).toBeUndefined();
    });

    it.skipIf(!canSymlink)("never follows a final host symlink", async () => {
        const { backend } = await mount();
        await backend.mkdir("/node_modules");
        await writeThrough(backend, "/node_modules/target.txt", "target");
        await backend.setattr("/node_modules/target.txt", {
            mode: 0o644,
            mtimeMs: 1_600_000_000_000,
        });
        await backend.symlink("target.txt", "/node_modules/link");
        await expect(
            backend.open("/node_modules/link", { read: true })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.open("/node_modules/link", { write: true })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.truncate("/node_modules/link", 0)
        ).rejects.toMatchObject({ code: "EINVAL" });
        await backend.setattr("/node_modules/link", { mode: 0o600 });
        await backend.setattr("/node_modules/link", {
            mtimeMs: 1_700_000_000_000,
        });
        expect(await backend.getattr("/node_modules/link")).toMatchObject({
            kind: "symlink",
            mtimeMs: 1_700_000_000_000,
        });
        const target = await backend.getattr("/node_modules/target.txt");
        expect(target).toMatchObject({
            size: 6,
            mtimeMs: 1_600_000_000_000,
        });
        if (process.platform !== "win32") {
            expect(target.mode).toBe(0o100644);
        }
        expect(await readThrough(backend, "/node_modules/target.txt")).toBe(
            "target"
        );
    });

    it.skipIf(!canSymlink)(
        "never passes through a host symlink, so nothing outside the overlay is reached",
        async () => {
            const { backend } = await mount();
            // Outside the overlay, next to it in the test's directory.
            const outside = join(temp, "outside");
            await mkdir(join(outside, "sub"), { recursive: true });
            await writeFile(join(outside, "secret.txt"), "secret");
            await chmod(join(outside, "secret.txt"), 0o600);
            const outsideState = async () => ({
                names: (await readdir(outside)).sort(),
                sub: await readdir(join(outside, "sub")),
                secret: await readFile(join(outside, "secret.txt"), "utf8"),
                mode: (await stat(join(outside, "secret.txt"))).mode & 0o777,
            });
            const before = await outsideState();

            await backend.mkdir("/node_modules");
            await writeThrough(backend, "/node_modules/inside.txt", "inside");
            // <overlay>/n/<root>/node_modules/up climbs to the test directory.
            await backend.symlink("../../../../outside", "/node_modules/up");
            const links = ["/node_modules/up"];
            if (process.platform !== "win32") {
                await backend.symlink(outside, "/node_modules/abs");
                links.push("/node_modules/abs");
            }
            // A boundary that is itself a link, in a shared directory.
            await backend.mkdir("/q");
            await backend.symlink("../../../outside", "/q/node_modules");
            links.push("/q/node_modules");

            const refused = { code: "ENOTDIR" };
            for (const link of links) {
                const secret = `${link}/secret.txt`;
                await expect(backend.readdir(link), link).rejects.toMatchObject(
                    refused
                );
                const attempts: Array<[string, () => Promise<unknown>]> = [
                    ["getattr", () => backend.getattr(secret)],
                    ["read", () => backend.open(secret, { read: true })],
                    [
                        "create",
                        () =>
                            backend.open(`${link}/planted.txt`, {
                                write: true,
                                create: true,
                            }),
                    ],
                    ["chmod", () => backend.setattr(secret, { mode: 0o777 })],
                    ["utimens", () => backend.setattr(secret, { mtimeMs: 1 })],
                    ["truncate", () => backend.truncate(secret, 0)],
                    ["readlink", () => backend.readlink(secret)],
                    ["unlink", () => backend.unlink(secret)],
                    [
                        "rename out",
                        () =>
                            backend.rename(secret, "/node_modules/stolen.txt"),
                    ],
                    [
                        "rename in",
                        () =>
                            backend.rename(
                                "/node_modules/inside.txt",
                                `${link}/inside.txt`
                            ),
                    ],
                    ["mkdir", () => backend.mkdir(`${link}/made`)],
                    ["rmdir", () => backend.rmdir(`${link}/sub`)],
                    ["symlink", () => backend.symlink("x", `${link}/made`)],
                ];
                for (const [label, attempt] of attempts) {
                    await expect(
                        attempt(),
                        `${label} through ${link}`
                    ).rejects.toMatchObject(refused);
                }
            }
            expect(await outsideState()).toEqual(before);
            expect(await readThrough(backend, "/node_modules/inside.txt")).toBe(
                "inside"
            );

            // A directory checked once, then replaced by a link through the
            // mount, is checked again: after rmdir and after rename.
            await backend.mkdir("/node_modules/d");
            await writeThrough(backend, "/node_modules/d/f.txt", "f");
            await backend.unlink("/node_modules/d/f.txt");
            await backend.rmdir("/node_modules/d");
            await backend.symlink("../../../../outside", "/node_modules/d");
            await expect(
                backend.getattr("/node_modules/d/secret.txt")
            ).rejects.toMatchObject(refused);
            await backend.mkdir("/node_modules/e");
            await writeThrough(backend, "/node_modules/e/f.txt", "f");
            await backend.rename("/node_modules/e", "/node_modules/e2");
            await backend.symlink("../../../../outside", "/node_modules/e");
            await expect(
                backend.open("/node_modules/e/secret.txt", { read: true })
            ).rejects.toMatchObject(refused);
            expect(await readThrough(backend, "/node_modules/e2/f.txt")).toBe(
                "f"
            );
            expect(await outsideState()).toEqual(before);
        }
    );

    it.skipIf(!canSymlink)(
        "never takes a link in its attachment list for an attachment",
        async () => {
            // Another filesystem's tree, linked in as the root's attachment.
            const elsewhere = join(temp, "elsewhere");
            await mkdir(join(elsewhere, "node_modules"), { recursive: true });
            await writeFile(join(elsewhere, "node_modules", "x.js"), "x");
            await mkdir(join(overlayDir, "n"), { recursive: true });
            await writeFile(
                join(overlayDir, "meta.json"),
                JSON.stringify({ format: 1, address: fs.address })
            );
            await symlink(elsewhere, join(overlayDir, "n", ROOT_KEY), "dir");
            const { backend } = await mount();
            expect(await names(backend, "/")).toEqual([]);
            await expect(
                backend.getattr("/node_modules/x.js")
            ).rejects.toMatchObject({ code: "ENOENT" });
            expect(
                await readFile(join(elsewhere, "node_modules", "x.js"), "utf8")
            ).toBe("x");
        }
    );

    it("keeps an open handle on its side when the ignore rules change", async () => {
        const ignoring = await openIgnoring({});
        await setIgnoreRules(
            ignoring,
            "*.log\n",
            () => ignoring.ignoreCheck("/app.log").ignored
        );
        const { backend } = await mount(ignoring);
        const handle = await backend.open("/app.log", {
            read: true,
            write: true,
            create: true,
        });
        await backend.write(handle, encode("before "), 0);
        expect(await names(backend, "/")).toContain("app.log");

        await setIgnoreRules(
            ignoring,
            "other.tmp\n",
            () => !ignoring.ignoreCheck("/app.log").ignored
        );
        // A new lookup goes to the shared side...
        await expect(backend.getattr("/app.log")).rejects.toMatchObject({
            code: "ENOENT",
        });
        // ...while the open handle keeps writing the local file.
        await backend.write(handle, encode("after"), 7);
        expect(decode(await backend.read(handle, 64, 0))).toBe("before after");
        await backend.release(handle);
        expect(await ignoring.stat("/app.log")).toBeUndefined();
        expect(
            await readFile(join(overlayDir, "n", ROOT_KEY, "app.log"), "utf8")
        ).toBe("before after");
    });

    it("keeps local handles apart from shared ones and closes them at shutdown without reporting them unsaved", async () => {
        const { backend } = await mount();
        await backend.mkdir("/node_modules");
        const opened = [
            await backend.open("/a.txt", { write: true, create: true }),
            await backend.open("/node_modules/a.txt", {
                write: true,
                create: true,
            }),
            await backend.open("/b.txt", { write: true, create: true }),
            await backend.open("/node_modules/b.txt", {
                read: true,
                write: true,
                create: true,
            }),
        ];
        expect(new Set(opened).size).toBe(4);
        await backend.write(opened[0], encode("shared"), 0);
        await backend.write(opened[1], encode("local"), 0);

        await backend.release(opened[1]);
        await expect(backend.read(opened[1], 1, 0)).rejects.toMatchObject({
            code: "EBADF",
        });
        await expect(
            backend.write(opened[1], encode("x"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(backend.fsync(opened[1])).rejects.toMatchObject({
            code: "EBADF",
        });

        // A local close that fails is printed, never reported unsaved.
        const printed = vi.spyOn(console, "error").mockImplementation(() => {});
        const close = promisify(nodeFs.close);
        vi.spyOn(localOverlayHost, "close").mockImplementationOnce(
            async (fd: number) => {
                await close(fd);
                throw Object.assign(new Error("EIO: injected"), {
                    code: "EIO",
                });
            }
        );
        const { failed } = await backend.drain!();
        expect(failed).toEqual([]);
        expect(printed.mock.calls.map((args) => args.join(" "))).toEqual([
            "shared-fs local overlay: close /node_modules/b.txt: EIO: injected",
        ]);
        await expect(backend.read(opened[3], 1, 0)).rejects.toMatchObject({
            code: "EBADF",
        });
        expect(decode(await fs.readFile("/a.txt"))).toBe("shared");
        expect(
            await readFile(
                join(overlayDir, "n", ROOT_KEY, "node_modules", "a.txt"),
                "utf8"
            )
        ).toBe("local");

        const leftover = await backend.open("/node_modules/b.txt", {
            read: true,
        });
        const closeSync = vi.spyOn(localOverlayHost, "closeSync");
        backend.dispose();
        expect(closeSync).toHaveBeenCalledOnce();
        await expect(backend.read(leftover, 1, 0)).rejects.toMatchObject({
            code: "EBADF",
        });
    });

    it("reports local entries whose shared directory another writer deleted", async () => {
        const first = await mount();
        await first.backend.mkdir("/node_modules");
        for (const dir of ["/p", "/q"]) {
            await first.backend.mkdir(dir);
            await first.backend.mkdir(`${dir}/node_modules`);
            await writeThrough(first.backend, `${dir}/node_modules/x.js`, "x");
        }
        expect(await first.localOverlay.detached(fs)).toBe(0);
        await fs.rm("/p");
        const reopened = await openOverlay();
        expect(await reopened.detached(fs)).toBe(1);
        // Nothing was deleted.
        expect(await readdir(join(overlayDir, "n"))).toHaveLength(3);
    });

    it("refuses shared mutations of local paths without calling the target", async () => {
        const target = {
            writeFile: vi.fn(async () => ({})),
            setMetadata: vi.fn(async () => ({})),
            mkdir: vi.fn(async () => undefined),
            mutateNamespaceForMount: vi.fn(async () => ({})),
            writeNodeForMount: vi.fn(async () => ({})),
            stat: vi.fn(async () => undefined),
        } as unknown as SharedFsMountBackendTarget;
        const guarded = guardSharedMutations(target, (path) =>
            pathSegments(path).includes("node_modules")
        );
        const refused = { code: "EACCES" };
        await expect(
            guarded.writeFile("/node_modules/x", "x")
        ).rejects.toMatchObject({
            ...refused,
            message: "kept local by this mount: /node_modules/x",
        });
        await expect(
            guarded.setMetadata("/a/node_modules", { mode: 0o100755 })
        ).rejects.toMatchObject(refused);
        await expect(guarded.mkdir("/node_modules")).rejects.toMatchObject(
            refused
        );
        await expect(
            guarded.mutateNamespaceForMount({
                type: "rename",
                from: "/a",
                to: "/node_modules/a",
                expectedSourceNodeId: "dir:a",
                expectedDestinationNodeId: null,
                expectedDestinationParentNodeId: ROOT_NODE_ID,
            })
        ).rejects.toMatchObject(refused);
        await expect(
            guarded.mutateNamespaceForMount({
                type: "remove",
                path: "/node_modules",
                expectedNodeId: "dir:n",
                expectedKind: "directory",
            })
        ).rejects.toMatchObject(refused);
        expect(target.writeFile).not.toHaveBeenCalled();
        expect(target.setMetadata).not.toHaveBeenCalled();
        expect(target.mkdir).not.toHaveBeenCalled();
        expect(target.mutateNamespaceForMount).not.toHaveBeenCalled();

        // Shared paths, node-id saves and lookups pass through.
        await guarded.writeFile("/a.txt", "a");
        expect(target.writeFile).toHaveBeenCalledWith("/a.txt", "a", undefined);
        await guarded.writeNodeForMount!(
            "node",
            "/node_modules",
            encode(""),
            {}
        );
        expect(target.writeNodeForMount).toHaveBeenCalledOnce();
        await guarded.stat("/node_modules");
        expect(target.stat).toHaveBeenCalledWith("/node_modules");
    });

    it("refuses to save an open shared file whose path became local, without calling the target", async () => {
        const ignoring = await openIgnoring({});
        const mutators = {
            writeFile: vi.fn(ignoring.writeFile.bind(ignoring)),
            writeNodeForMount: vi.fn(ignoring.writeNodeForMount.bind(ignoring)),
            setMetadata: vi.fn(ignoring.setMetadata.bind(ignoring)),
            mkdir: vi.fn(ignoring.mkdir.bind(ignoring)),
            mutateNamespaceForMount: vi.fn(
                ignoring.mutateNamespaceForMount.bind(ignoring)
            ),
        };
        const recording = new Proxy(ignoring, {
            get: (original, property) => {
                if (Object.hasOwn(mutators, property)) {
                    return mutators[property as keyof typeof mutators];
                }
                const value = Reflect.get(original, property, original);
                return typeof value === "function"
                    ? value.bind(original)
                    : value;
            },
        });
        const { backend } = await mount(recording);
        await backend.mkdir("/cache");
        const handle = await backend.open("/cache/x", {
            write: true,
            create: true,
        });
        await backend.write(handle, encode("shared"), 0);
        expect(mutators.mkdir).toHaveBeenCalledOnce();

        await setIgnoreRules(
            ignoring,
            "cache/\n",
            () => ignoring.ignoreCheck("/cache/x").ignored
        );
        for (const spy of Object.values(mutators)) spy.mockClear();
        // The save goes by path, now a local one: the backend refuses it.
        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EACCES",
            message: "kept local by this mount: /cache/x",
        });
        for (const spy of Object.values(mutators)) {
            expect(spy).not.toHaveBeenCalled();
        }
        expect(await ignoring.stat("/cache/x")).toBeUndefined();
    });

    it("makes only lookups on its target for a local workload", async () => {
        const mutators = {
            writeFile: vi.fn(fs.writeFile.bind(fs)),
            writeNodeForMount: vi.fn(fs.writeNodeForMount.bind(fs)),
            setMetadata: vi.fn(fs.setMetadata.bind(fs)),
            mkdir: vi.fn(fs.mkdir.bind(fs)),
            mutateNamespaceForMount: vi.fn(fs.mutateNamespaceForMount.bind(fs)),
        };
        const recording = new Proxy(fs, {
            get: (original, property) => {
                if (Object.hasOwn(mutators, property)) {
                    return mutators[property as keyof typeof mutators];
                }
                const value = Reflect.get(original, property, original);
                return typeof value === "function"
                    ? value.bind(original)
                    : value;
            },
        });
        const { backend } = await mount(recording);
        await localWorkload(backend);
        for (const spy of Object.values(mutators)) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it("saves an open shared file by node id after another writer renames it to a sealed name", async () => {
        const { backend } = await mount();
        await fs.mkdir("/p");
        await fs.writeFile("/p/f.txt", "before");
        const handle = await backend.open("/p/f.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("after!"), 0);
        const renamed = nextNamespaceChange(fs, (change) =>
            change.moves.some((move) => move.to?.name === "node_modules")
        );
        await fs.rename("/p/f.txt", "/p/node_modules");
        await renamed;
        await backend.release(handle);
        expect(decode(await fs.readFile("/p/node_modules"))).toBe("after!");
        await expect(backend.getattr("/p/node_modules")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("unlinks an open local file, keeps reading it and creates the name again", async () => {
        const { backend } = await mount();
        await backend.mkdir("/node_modules");
        const handle = await backend.open("/node_modules/u.txt", {
            read: true,
            write: true,
            create: true,
        });
        await backend.write(handle, encode("still here"), 0);
        await backend.unlink("/node_modules/u.txt");
        expect(decode(await backend.read(handle, 64, 0))).toBe("still here");
        await backend.release(handle);
        await writeThrough(backend, "/node_modules/u.txt", "again");
        expect(await readThrough(backend, "/node_modules/u.txt")).toBe("again");
    });

    it("serves host paths longer than 260 characters", async () => {
        const { backend } = await mount();
        let path = "/node_modules";
        await backend.mkdir(path);
        for (let i = 0; i < 4; i++) {
            path += `/${String(i).repeat(60)}`;
            await backend.mkdir(path);
        }
        await writeThrough(backend, `${path}/deep.txt`, "deep");
        const hostPath = join(
            overlayDir,
            "n",
            ROOT_KEY,
            ...pathSegments(path),
            "deep.txt"
        );
        expect(hostPath.length).toBeGreaterThan(260);
        expect((await lstat(hostPath)).isFile()).toBe(true);
        expect(await readThrough(backend, `${path}/deep.txt`)).toBe("deep");
        expect(await names(backend, path)).toEqual(["deep.txt"]);
    });
});
