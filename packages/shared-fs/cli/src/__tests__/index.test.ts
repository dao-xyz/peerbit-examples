import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    FileVersion,
    Peerbit,
    PrepareForDisposalError,
    SharedFileSystem,
    SharedFsHandle,
    encodePublicSignKey,
    openSharedFs,
} from "@peerbit/shared-fs";
import { describe, expect, it, vi } from "vitest";
import {
    conflictScanIsPartial,
    connectMountToNetwork,
    normalizeNativeMountpoint,
    openMountProfileFiles,
    resolveMountProfileDirectory,
    runCli,
    stopMountSession,
} from "../index.js";

const stopPeer = async (peer: Peerbit) => {
    await peer.stop();
    await peer.services.blocks.stop();
};

const decode = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const seedConflicts = async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "peerbit-shared-fs-cli-conflicts-")
    );
    const peer = await Peerbit.create({ directory });
    let seeded = false;
    try {
        const shared = await openSharedFs({
            peerbit: peer,
            machineLabel: "cli-conflict-seed",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        await shared.writeFile("/content.txt", "base");
        const baseVersionIds = (await shared.versions("/content.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        const selected = await shared.writeFile("/content.txt", "left", {
            baseVersionIds,
        });
        // A third head with selected's bytes: conflicts() lists only one.
        const twin = await shared.writeFile("/content.txt", "left", {
            baseVersionIds,
            mtime: 7,
        });
        const other = await shared.writeFile("/content.txt", "right", {
            baseVersionIds,
        });

        await shared.writeFile("/duplicate.txt", "first life");
        const first = await shared.stat("/duplicate.txt");
        await shared.rm("/duplicate.txt");
        await shared.writeFile("/duplicate.txt", "second life");
        await shared.resolveNamingConflict(first!.nodeId, {
            type: "restore",
        });
        const duplicate = (await shared.namingConflicts()).find(
            (conflict) => conflict.type === "duplicate-name"
        );
        if (!duplicate?.shadowedNodeIds?.[0]) {
            throw new Error("failed to seed duplicate-name conflict");
        }

        await shared.writeFile("/delete-race.txt", "recoverable delete");
        const deletedEntry = (await shared.stat("/delete-race.txt"))!;
        const [deletedBaseInfo] = await shared.versions("/delete-race.txt");
        const deletedBase = (await shared.program.entries.index.get(
            deletedBaseInfo.id,
            { local: true, remote: false, resolve: true }
        )) as unknown as FileVersion;
        await shared.rm("/delete-race.txt");
        const concurrentDeleteVersion = new FileVersion({
            id: "version:cli-delete-vs-edit",
            nodeId: deletedEntry.nodeId,
            parentVersionIds: [deletedBase.id],
            causalDepth: deletedBase.causalDepth + 1n,
            contentHash: deletedBase.contentHash,
            size: deletedBase.size,
            mode: deletedBase.mode,
            mtime: deletedBase.mtime,
            chunkIds: deletedBase.chunkIds,
            createdAt: deletedBase.createdAt + 1n,
            authorKey: deletedBase.authorKey,
            machineLabel: deletedBase.machineLabel,
        });
        await shared.program.entries.put(concurrentDeleteVersion, {
            unique: true,
        });
        const deleteConflict = (await shared.namingConflicts()).find(
            (conflict) =>
                conflict.type === "delete-vs-edit" &&
                conflict.nodeId === deletedEntry.nodeId
        );
        if (!deleteConflict) {
            throw new Error("failed to seed delete-vs-edit conflict");
        }

        seeded = true;
        return {
            directory,
            address: shared.address,
            selectedVersionId: selected.id,
            twinVersionId: twin.id,
            otherVersionId: other.id,
            duplicate,
            shadowedNodeId: duplicate.shadowedNodeIds[0],
            deleteConflict,
            concurrentDeleteVersionId: concurrentDeleteVersion.id,
        };
    } finally {
        await stopPeer(peer);
        if (!seeded) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
};

const seedDirectoryConflict = async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "peerbit-shared-fs-cli-directory-merge-")
    );
    const peer = await Peerbit.create({ directory });
    let seeded = false;
    try {
        const shared = await openSharedFs({
            peerbit: peer,
            machineLabel: "cli-directory-merge-seed",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        await shared.mkdir("/shared");
        const target = (await shared.stat("/shared"))!;
        await shared.writeFile("/shared/from-target.txt", "target");
        await shared.rename("/shared", "/held");
        await shared.mkdir("/shared");
        const source = (await shared.stat("/shared"))!;
        await shared.writeFile("/shared/from-source.txt", "source");
        const sourceFile = (await shared.stat("/shared/from-source.txt"))!;
        await shared.resolveNamingConflict(target.nodeId, {
            type: "move",
            to: "/shared",
        });
        const duplicate = (await shared.namingConflicts()).find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );
        if (!duplicate) {
            throw new Error("failed to seed directory duplicate conflict");
        }

        seeded = true;
        return {
            directory,
            address: shared.address,
            sourceNodeId: source.nodeId,
            targetNodeId: target.nodeId,
            sourceFileNodeId: sourceFile.nodeId,
        };
    } finally {
        await stopPeer(peer);
        if (!seeded) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
};

const mockCliBootstrap = () => {
    const createPeerbit = Peerbit.create.bind(Peerbit);
    return vi.spyOn(Peerbit, "create").mockImplementation(async (options) => {
        const peer = await createPeerbit(options);
        vi.spyOn(peer, "bootstrap").mockResolvedValue({
            connectedPeerIds: [],
            failures: [],
        });
        return peer;
    });
};

describe("mount network connection", () => {
    const fakePeer = (bootstrap: () => Promise<unknown>) => ({
        bootstrap: vi.fn(bootstrap),
        dial: vi.fn(async () => true),
        enableBootstrapRecovery: vi.fn(),
    });

    it("mounts from local state when bootstrap nodes are unreachable", async () => {
        const peer = fakePeer(async () => {
            throw new Error("Failed to succefully dial any bootstrap node");
        });
        const warn = vi.fn();
        await connectMountToNetwork(peer as never, undefined, warn);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(
            "Failed to succefully dial any bootstrap node"
        );
        expect(peer.enableBootstrapRecovery).toHaveBeenCalledTimes(1);
    });

    it("keeps reconnecting after a successful bootstrap", async () => {
        const peer = fakePeer(async () => ({
            connectedPeerIds: [],
            failures: [],
        }));
        const warn = vi.fn();
        await connectMountToNetwork(peer as never, undefined, warn);
        expect(warn).not.toHaveBeenCalled();
        expect(peer.enableBootstrapRecovery).toHaveBeenCalledTimes(1);
    });

    it("dials explicit peers without the public bootstrap network", async () => {
        const peer = fakePeer(async () => {
            throw new Error("unexpected bootstrap");
        });
        const address =
            "/ip4/127.0.0.1/tcp/8002/p2p/12D3KooWKj1J1hHxrYyB37qDDGCi9aU2vcHzDZhtMk7te7dEmqqT";
        await connectMountToNetwork(peer as never, [address], vi.fn());
        expect(peer.dial).toHaveBeenCalledWith(address);
        expect(peer.bootstrap).not.toHaveBeenCalled();
        expect(peer.enableBootstrapRecovery).not.toHaveBeenCalled();
    });
});

describe("peerbit-fs cli", () => {
    it("exports the CLI entry point", () => {
        expect(runCli).toBeTypeOf("function");
    });

    it("accepts and prints a reproducible benchmark seed", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            await runCli([
                "benchmark",
                "--directory",
                "",
                "--seed",
                "cli-benchmark-seed",
                "--large-size",
                "8",
                "--small-files",
                "1",
                "--small-size",
                "4",
                "--cleanup",
            ]);
            expect(log.mock.calls.flat()).toContain(
                "corpus seed: cli-benchmark-seed"
            );
        } finally {
            log.mockRestore();
        }
    });

    it("keeps Windows drive mountpoints in WinFsp drive form", () => {
        expect(normalizeNativeMountpoint("P:", "win32")).toBe("P:");
        expect(normalizeNativeMountpoint("p:\\", "win32")).toBe("P:");
        expect(normalizeNativeMountpoint("q:/", "win32")).toBe("Q:");
        expect(normalizeNativeMountpoint("C:\\tmp\\peerbit", "win32")).toBe(
            path.win32.resolve("C:\\tmp\\peerbit")
        );
    });

    it("classifies only a stable verified full-replica conflict scan as complete", () => {
        const status = (
            phase:
                | "off"
                | "fetching"
                | "overlay-active"
                | "converged"
                | "unverified",
            snapshotCoverageVerified = false,
            writeReady = false,
            pendingDocs = 0
        ) => ({
            phase,
            snapshotCoverageVerified,
            writeReady,
            pendingDocs,
        });
        const complete = status("converged", true, true);

        expect(conflictScanIsPartial(true, complete, complete)).toBe(false);
        expect(
            conflictScanIsPartial(true, status("fetching"), status("fetching"))
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("overlay-active"),
                status("overlay-active")
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("unverified"),
                status("unverified")
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("converged", false, true),
                status("converged", false, true)
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(true, status("off", false, true), complete)
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                false,
                status("off", false, true),
                status("off", false, true)
            )
        ).toBe(true);
    });

    it("creates an address and exits cleanly", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let reopenedPeer: Peerbit | undefined;

        try {
            await runCli(["create", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);
            const address = String(log.mock.calls[0]?.[0]);

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "cli-create-reopen",
            });
            expect(reopened.bootstrapStatus().writeReady).toBe(true);
            await expect(
                reopened.awaitWriteReady({ timeout: 100 })
            ).resolves.toBeUndefined();
            // The still-empty filesystem carries the creator's genesis
            // manifest, whose replication lets remote peers become ready.
            expect(
                await (reopened.program as any).getDocument(
                    `bootstrap:${encodePublicSignKey(reopenedPeer.identity.publicKey)}`
                )
            ).toBeDefined();
        } finally {
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("fails create when the genesis manifest was not published", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const genesis = vi
            .spyOn(SharedFileSystem.prototype, "snapshotWrite")
            .mockRejectedValueOnce(new Error("genesis put failed"));
        try {
            await expect(runCli(["create", "--directory", ""])).rejects.toThrow(
                "create could not publish the genesis manifest, so no other peer could join the new filesystem"
            );
            expect(genesis).toHaveBeenCalledTimes(1);
            expect(log).not.toHaveBeenCalled();
        } finally {
            genesis.mockRestore();
            log.mockRestore();
        }
    });

    it("creates an access-controlled address by default and prints the local writer key", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-auth-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);

            log.mockClear();
            await runCli(["whoami", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^[A-Za-z0-9+/]+=*$/);
        } finally {
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("allows unauthenticated filesystems as an explicit opt-in", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-no-auth-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--no-auth", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);
        } finally {
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("rejects disposal preparation when replication is disabled", async () => {
        await expect(
            runCli([
                "prepare-disposal",
                "zb2rh-not-opened",
                "--no-replicate",
                "--directory",
                "",
            ])
        ).rejects.toThrow(
            "prepare-disposal requires a full replica; --no-replicate is not allowed"
        );
    });

    it("rejects create when replication is disabled", async () => {
        await expect(
            runCli(["create", "--no-replicate", "--directory", ""])
        ).rejects.toThrow(
            "create requires a full replica; --no-replicate is not allowed"
        );
    });

    it("rejects a writable mount when replication is disabled", async () => {
        await expect(
            runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--no-replicate",
                "--directory",
                "",
            ])
        ).rejects.toThrow(
            "mount requires a full replica; --no-replicate is not allowed for a writable mount"
        );
    });

    it("requires an output directory for --mount-profile before mounting", async () => {
        await expect(
            runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--mount-profile",
                "--directory",
                "",
            ])
        ).rejects.toThrow("--mount-profile requires an output directory");
        expect(resolveMountProfileDirectory(undefined)).toBeUndefined();
        expect(resolveMountProfileDirectory("profile-out")).toBe(
            path.resolve("profile-out")
        );
    });

    it("reports and refuses a missing or unpinned managed adapter before opening Peerbit", async () => {
        const installDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-adapter-pin-")
        );
        const saved = {
            adapter: process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER,
            installDir: process.env.PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR,
            path: process.env.PATH,
            exitCode: process.exitCode,
        };
        const { version } = JSON.parse(
            await fs.readFile(
                new URL("../../package.json", import.meta.url),
                "utf8"
            )
        ) as { version: string };
        const binaryPath = path.join(
            installDir,
            `shared-fs-native-v${version}`,
            process.platform === "win32"
                ? "peerbit-shared-fs-native.exe"
                : "peerbit-shared-fs-native"
        );
        // An adapter copied into this CLI's slot without an install record.
        await fs.mkdir(path.dirname(binaryPath));
        await fs.writeFile(binaryPath, "adapter from an older CLI");
        const refusal = `Installed native adapter ${binaryPath} is of unknown version: it has no install record (installed before adapter version pinning, copied manually, or left by an interrupted install), but @peerbit/shared-fs-cli ${version} requires shared-fs-native-v${version}. Run \`peerbit-fs install-adapter --force\``;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const createPeerbit = vi.spyOn(Peerbit, "create");
        try {
            delete process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER;
            process.env.PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR = installDir;

            await runCli(["status", "--json"]);
            const { nativeMount } = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(nativeMount).toMatchObject({
                externalAdapter: binaryPath,
                available: false,
                missing: expect.arrayContaining([
                    expect.stringContaining(refusal),
                ]),
            });
            // status must not publish the adapter for a later command.
            expect(
                process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER
            ).toBeUndefined();

            await expect(
                runCli([
                    "mount",
                    "zb2rh-not-opened",
                    "/tmp/peerbit-shared-fs-not-mounted",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(refusal);
            expect(createPeerbit).not.toHaveBeenCalled();

            // Without any adapter, mount points at install-adapter and lists
            // the platform requirements instead of dumping usage.
            await fs.rm(path.dirname(binaryPath), { recursive: true });
            process.env.PATH = "";
            error.mockClear();
            await runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--directory",
                "",
            ]);
            expect(process.exitCode).toBe(1);
            expect(error).toHaveBeenCalledTimes(1);
            expect(String(error.mock.calls[0]?.[0])).toContain(
                "No native mount adapter found. Run `peerbit-fs install-adapter`"
            );
            expect(log).toHaveBeenCalledWith(
                "  - peerbit-shared-fs-native adapter binary"
            );
            expect(createPeerbit).not.toHaveBeenCalled();
        } finally {
            process.exitCode = saved.exitCode;
            log.mockRestore();
            error.mockRestore();
            createPeerbit.mockRestore();
            for (const [name, value] of [
                ["PEERBIT_SHARED_FS_NATIVE_ADAPTER", saved.adapter],
                ["PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR", saved.installDir],
                ["PATH", saved.path],
            ] as const) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
            await fs.rm(installDir, { recursive: true, force: true });
        }
    });

    it("never reuses or truncates an existing mount profile", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-profile-")
        );
        try {
            const opened: string[] = [];
            const writer = {
                sink: () => {},
                stats: () => ({}) as any,
                close: async () => ({}) as any,
            };
            const target = path.join(directory, "run");
            const files = await openMountProfileFiles(target, async (file) => {
                opened.push(file);
                await fs.writeFile(file, "started\n", { flag: "wx" });
                return writer;
            });
            expect(opened).toEqual([path.join(target, "node-daemon.ndjson")]);
            expect(files.nativeAdapterFile).toBe(
                path.join(target, "native-adapter.ndjson")
            );

            await expect(
                openMountProfileFiles(target, async () => writer)
            ).rejects.toThrow("--mount-profile output already exists");

            const adapterOnly = path.join(directory, "adapter-only");
            await fs.mkdir(adapterOnly);
            await fs.writeFile(
                path.join(adapterOnly, "native-adapter.ndjson"),
                "old\n"
            );
            await expect(
                openMountProfileFiles(adapterOnly, async () => writer)
            ).rejects.toThrow("native-adapter.ndjson");
            expect(
                await fs.readFile(
                    path.join(adapterOnly, "native-adapter.ndjson"),
                    "utf8"
                )
            ).toBe("old\n");
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("detaches the backend and closes the mount profile before stopping Peerbit", async () => {
        const order: string[] = [];
        const profileWriter = {
            sink: () => {},
            stats: () => ({}) as any,
            close: async () => {
                order.push("profile");
                return {
                    emitted: 0,
                    written: 0,
                    dropped: 0,
                    lost: 0,
                    droppedAfterClose: 0,
                    writeErrors: 0,
                    closeTimedOut: false,
                    maxQueuedEvents: 1,
                    maxQueuedBytes: 1,
                };
            },
        };
        const session = (failures: Partial<Record<string, Error>> = {}) => ({
            mounted: {
                unmount: async () => {
                    order.push("unmount");
                    if (failures.unmount) throw failures.unmount;
                },
            },
            ipc: {
                close: async () => {
                    order.push("ipc");
                },
            },
            backend: {
                dispose: () => {
                    order.push("dispose");
                },
            },
            profileWriter,
            stopPeerbit: async () => {
                order.push("peerbit");
                if (failures.peerbit) throw failures.peerbit;
            },
        });

        await stopMountSession(session());
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);

        // A failing Peerbit shutdown no longer loses the profile summary.
        order.length = 0;
        const stopFailure = new Error("peerbit stop failed");
        await expect(
            stopMountSession(session({ peerbit: stopFailure }))
        ).rejects.toBe(stopFailure);
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);

        // A failing unmount still detaches the backend and closes the
        // profile before rethrowing.
        order.length = 0;
        const unmountFailure = new Error("unmount failed");
        await expect(
            stopMountSession(session({ unmount: unmountFailure }))
        ).rejects.toBe(unmountFailure);
        expect(order).toEqual(["unmount", "dispose", "profile"]);

        // The error path runs every step and swallows failures.
        order.length = 0;
        await stopMountSession(
            session({ unmount: unmountFailure, peerbit: stopFailure }),
            { ignoreErrors: true }
        );
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);
    });

    it.each([
        {
            label: "success after shutdown",
            preparation: "none",
            shutdown: "none",
        },
        { label: "shutdown only", preparation: "none", shutdown: "error" },
        { label: "preparation only", preparation: "error", shutdown: "none" },
        {
            label: "preparation and shutdown",
            preparation: "error",
            shutdown: "error",
        },
        {
            label: "undefined rejection and shutdown",
            preparation: "undefined",
            shutdown: "error",
        },
        {
            label: "preparation and undefined shutdown",
            preparation: "error",
            shutdown: "undefined",
        },
        {
            label: "unprintable preparation and shutdown",
            preparation: "unprintable",
            shutdown: "error",
        },
    ] as const)(
        "reports disposal correctly for $label",
        async ({ preparation, shutdown }) => {
            const directory = await fs.mkdtemp(
                path.join(os.tmpdir(), "peerbit-shared-fs-cli-disposal-")
            );
            const createPeerbit = Peerbit.create.bind(Peerbit);
            let seedPeer: Peerbit | undefined;
            let cliPeer: Peerbit | undefined;
            let restoreCliStop: (() => void) | undefined;
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            let createSpy: ReturnType<typeof vi.spyOn> | undefined;
            let prepareSpy: ReturnType<typeof vi.spyOn> | undefined;

            try {
                seedPeer = await createPeerbit({ directory });
                const seeded = await openSharedFs({
                    peerbit: seedPeer,
                    machineLabel: "cli-disposal-seed",
                    replicate: { factor: 1 },
                    bootstrap: false,
                    gc: false,
                });
                const address = seeded.address;
                await stopPeer(seedPeer);
                seedPeer = undefined;

                const shutdownFailure =
                    shutdown === "undefined"
                        ? undefined
                        : new Error("simulated shutdown failure");
                // Fault injection tests CLI reporting, not actual remote durability.
                // Library disposal tests separately exercise real receipt failure.
                const receiptFailure = Object.assign(
                    new Error("simulated persisted receipt timeout"),
                    {
                        name: "PersistedDeliveryError",
                        localCommitSucceeded: true,
                        retrySafe: false,
                        committedHashes: ["exact-failed-entry-evidence"],
                    }
                );
                const preparationFailure =
                    preparation === "undefined"
                        ? undefined
                        : new PrepareForDisposalError(receiptFailure, 1);
                const preparationStack = preparationFailure?.stack;
                if (preparation === "unprintable") {
                    Object.defineProperty(preparationFailure, "message", {
                        get() {
                            throw new Error("message getter failed");
                        },
                    });
                }
                if (preparation !== "none") {
                    prepareSpy = vi
                        .spyOn(SharedFsHandle.prototype, "prepareForDisposal")
                        .mockRejectedValueOnce(preparationFailure);
                }
                createSpy = vi
                    .spyOn(Peerbit, "create")
                    .mockImplementation(async (options) => {
                        const peer = await createPeerbit(options);
                        cliPeer = peer;
                        vi.spyOn(peer, "bootstrap").mockResolvedValue({
                            connectedPeerIds: [],
                            failures: [],
                        });
                        const originalStop = peer.stop.bind(peer);
                        const stop = vi.spyOn(peer, "stop");
                        if (shutdown !== "none")
                            stop.mockRejectedValueOnce(shutdownFailure);
                        else
                            stop.mockImplementation(async () => {
                                await originalStop();
                                expect(log).not.toHaveBeenCalled();
                            });
                        restoreCliStop = () => stop.mockRestore();
                        return peer;
                    });

                const result = await runCli([
                    "prepare-disposal",
                    address,
                    "--directory",
                    directory,
                    "--json",
                ]).then(
                    () => ({ ok: true as const }),
                    (error) => ({ ok: false as const, error })
                );
                expect(cliPeer?.stop).toHaveBeenCalledTimes(1);
                if (prepareSpy) expect(prepareSpy).toHaveBeenCalledTimes(1);
                expect((await fs.stat(directory)).isDirectory()).toBe(true);
                if (preparation === "none" && shutdown === "none") {
                    expect(result.ok).toBe(true);
                    expect(log).toHaveBeenCalledTimes(1);
                    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
                        safeToDispose: true,
                        empty: true,
                    });
                    return;
                }
                expect(result.ok).toBe(false);
                if (result.ok)
                    throw new Error("failed disposal unexpectedly succeeded");
                if (preparation !== "none" && shutdown !== "none") {
                    expect(result.error).toBeInstanceOf(AggregateError);
                    const combined = result.error as AggregateError;
                    expect(combined.errors).toHaveLength(2);
                    expect(combined.errors[0]).toBe(preparationFailure);
                    expect(combined.errors[1]).toBe(shutdownFailure);
                    expect(combined.cause).toBe(preparationFailure);
                    expect(combined.message).toContain(
                        "keep the source machine"
                    );
                    expect(combined.message).toContain(
                        shutdownFailure?.message ?? "undefined"
                    );
                    if (preparation === "unprintable") {
                        expect(combined.message).toContain(
                            "unprintable rejection"
                        );
                    } else if (preparationFailure) {
                        expect(combined.message).toContain(
                            preparationFailure.message
                        );
                        expect(preparationFailure.stack).toBe(preparationStack);
                        expect(preparationFailure.cause).toBe(receiptFailure);
                        expect(receiptFailure.committedHashes).toEqual([
                            "exact-failed-entry-evidence",
                        ]);
                        expect(receiptFailure.retrySafe).toBe(false);
                    }
                } else {
                    expect(result.error).toBe(
                        shutdown !== "none"
                            ? shutdownFailure
                            : preparationFailure
                    );
                }
                expect(log).not.toHaveBeenCalled();
            } finally {
                createSpy?.mockRestore();
                prepareSpy?.mockRestore();
                restoreCliStop?.();
                log.mockRestore();
                if (cliPeer) {
                    await stopPeer(cliPeer);
                }
                if (seedPeer) {
                    await stopPeer(seedPeer);
                }
                await fs.rm(directory, { recursive: true, force: true });
            }
        }
    );

    it("validates conflict resolution safety options before opening a peer", async () => {
        const createSpy = vi.spyOn(Peerbit, "create");
        try {
            await expect(
                runCli([
                    "resolve-conflict",
                    "zb2rh-not-opened",
                    "/file.txt",
                    "version-missing",
                    "--no-replicate",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-conflict requires a full replica; --no-replicate is not allowed"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "keep",
                    "--no-replicate",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict requires a full replica; --no-replicate is not allowed"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "move",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict move requires --to <path>"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "keep",
                    "--to",
                    "/elsewhere.txt",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict --to is only valid with the move action"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "dir:missing",
                    "merge-directory",
                    "--to",
                    "/elsewhere",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict --to is only valid with the move action"
            );
            expect(createSpy).not.toHaveBeenCalled();
        } finally {
            createSpy.mockRestore();
        }
    });

    it("prints stable content, naming, and status JSON from one local view", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            await runCli([
                "conflicts",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const contentResult = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(Object.keys(contentResult).sort()).toEqual([
                "address",
                "conflicts",
                "path",
                "view",
            ]);
            expect(contentResult.view).toEqual({
                fullReplica: false,
                bootstrapPhase: "off",
                snapshotCoverageVerified: false,
            });
            const content = contentResult.conflicts;
            expect(content).toHaveLength(1);
            expect(content[0]).toMatchObject({
                path: "/content.txt",
                versions: expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.toBeOneOf([
                            fixture.selectedVersionId,
                            fixture.twinVersionId,
                        ]),
                        size: expect.stringMatching(/^\d+$/),
                        createdAt: expect.stringMatching(/^\d+$/),
                    }),
                    expect.objectContaining({ id: fixture.otherVersionId }),
                ]),
            });
            expect(content[0].versions).toHaveLength(2);
            expect(
                content[0].versions.map((version: { id: string }) => version.id)
            ).toContain(content[0].visibleVersionId);
            for (const version of content[0].versions) {
                expect(version.parentVersionIds).toEqual(
                    [...version.parentVersionIds].sort()
                );
            }

            log.mockClear();
            await runCli([
                "conflicts",
                fixture.address,
                "--path",
                "/missing",
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(
                JSON.parse(String(log.mock.calls[0]?.[0])).conflicts
            ).toEqual([]);

            log.mockClear();
            await runCli([
                "naming-conflicts",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const namingResult = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(Object.keys(namingResult).sort()).toEqual([
                "address",
                "conflicts",
                "path",
                "view",
            ]);
            expect(namingResult.view).toEqual({
                fullReplica: false,
                bootstrapPhase: "off",
                snapshotCoverageVerified: false,
            });
            const naming = namingResult.conflicts;
            expect(naming).toContainEqual(
                expect.objectContaining({
                    type: "duplicate-name",
                    nodeId: fixture.duplicate.nodeId,
                    eventIds: expect.any(Array),
                    shadowedNodeIds: expect.arrayContaining([
                        fixture.shadowedNodeId,
                    ]),
                })
            );
            for (const conflict of naming) {
                expect(conflict.eventIds).toEqual(
                    [...conflict.eventIds].sort()
                );
                if (conflict.shadowedNodeIds) {
                    expect(conflict.shadowedNodeIds).toEqual(
                        [...conflict.shadowedNodeIds].sort()
                    );
                }
                if (conflict.recoverableVersionIds) {
                    expect(conflict.recoverableVersionIds).toEqual(
                        [...conflict.recoverableVersionIds].sort()
                    );
                }
            }

            log.mockClear();
            await runCli([
                "status",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const status = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(status.nativeMount).toMatchObject({
                platform: expect.any(String),
                available: expect.any(Boolean),
            });
            expect(status.filesystem).toMatchObject({
                address: fixture.address,
                conflicts: null,
            });

            log.mockClear();
            await runCli([
                "status",
                fixture.address,
                "--json",
                "--include-conflicts",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const statusWithConflicts = JSON.parse(
                String(log.mock.calls[0]?.[0])
            );
            expect(statusWithConflicts.filesystem).toMatchObject({
                address: fixture.address,
                conflicts: {
                    partial: true,
                    scope: "local-replica",
                    bootstrapPhaseBefore: "off",
                    bootstrapPhaseAfter: "off",
                    bootstrapStateChangedDuringScan: false,
                    contentCount: 1,
                    namingCount: naming.length,
                    content: expect.any(Array),
                    naming: expect.any(Array),
                },
            });

            log.mockClear();
            await runCli(["status", "--json"]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
                nativeMount: { platform: expect.any(String) },
                filesystem: null,
            });
        } finally {
            log.mockRestore();
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("publishes a selected content resolution and preserves history", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await expect(
                runCli([
                    "resolve-conflict",
                    fixture.address,
                    "/content.txt",
                    "version-not-current",
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                "Version version-not-current is not a current conflict head"
            );
            expect(log).not.toHaveBeenCalled();
            await expect(
                runCli([
                    "resolve-conflict",
                    fixture.address,
                    "/",
                    fixture.selectedVersionId,
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                `Version ${fixture.selectedVersionId} is not a current conflict head for /`
            );
            expect(log).not.toHaveBeenCalled();

            await runCli([
                "resolve-conflict",
                fixture.address,
                "/content.txt",
                fixture.selectedVersionId,
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                path: "/content.txt",
                selectedVersionId: fixture.selectedVersionId,
                observedHeadVersionIds: [
                    fixture.selectedVersionId,
                    fixture.twinVersionId,
                    fixture.otherVersionId,
                ].sort(),
                supersededHeadVersionIds: [
                    fixture.selectedVersionId,
                    fixture.twinVersionId,
                    fixture.otherVersionId,
                ].sort(),
                headSetChangedDuringResolution: false,
                resolution: {
                    size: expect.stringMatching(/^\d+$/),
                    createdAt: expect.stringMatching(/^\d+$/),
                },
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-content-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(await reopened.conflicts("/content.txt")).toEqual([]);
            expect(decode(await reopened.readFile("/content.txt"))).toBe(
                "left"
            );
            expect(
                decode(
                    await reopened.readVersion(
                        "/content.txt",
                        fixture.otherVersionId
                    )
                )
            ).toBe("right");
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("moves a shadowed claimant and preserves both duplicate-name files", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    fixture.address,
                    "file:not-a-conflict",
                    "keep",
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                "Node file:not-a-conflict is not part of a currently visible naming conflict"
            );
            expect(log).not.toHaveBeenCalled();

            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.shadowedNodeId,
                "move",
                "--to",
                "temporary/../duplicate-restored.txt",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.shadowedNodeId,
                action: {
                    type: "move",
                    to: "/duplicate-restored.txt",
                },
                observedConflicts: expect.arrayContaining([
                    expect.objectContaining({ type: "duplicate-name" }),
                ]),
                remainingConflicts: [],
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-naming-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(
                (await reopened.namingConflicts()).filter(
                    (conflict) => conflict.type === "duplicate-name"
                )
            ).toEqual([]);
            expect(
                new Set([
                    decode(await reopened.readFile("/duplicate.txt")),
                    decode(await reopened.readFile("/duplicate-restored.txt")),
                ])
            ).toEqual(new Set(["first life", "second life"]));
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("merges a shadowed directory through the CLI and reports the repair", async () => {
        const fixture = await seedDirectoryConflict();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.sourceNodeId,
                "merge-directory",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.sourceNodeId,
                action: { type: "merge-directory" },
                observedConflicts: [
                    expect.objectContaining({ type: "duplicate-name" }),
                ],
                remainingConflicts: [],
                resolution: {
                    type: "directory-merged",
                    sourceNodeId: fixture.sourceNodeId,
                    targetNodeId: fixture.targetNodeId,
                    movedNodeIds: [fixture.sourceFileNodeId],
                    eventIds: expect.any(Array),
                },
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-directory-merge-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(
                decode(await reopened.readFile("/shared/from-target.txt"))
            ).toBe("target");
            expect(
                decode(await reopened.readFile("/shared/from-source.txt"))
            ).toBe("source");
            expect(
                (await reopened.stat("/shared/from-source.txt"))?.nodeId
            ).toBe(fixture.sourceFileNodeId);
            expect(
                (await reopened.namingConflicts()).find(
                    (conflict) =>
                        conflict.type === "duplicate-name" &&
                        conflict.path === "/shared"
                )
            ).toBeUndefined();
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("acknowledges a delete-vs-edit conflict with an event-fenced delete", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.deleteConflict.nodeId,
                "delete",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.deleteConflict.nodeId,
                action: { type: "delete" },
                expectedEventIds: expect.arrayContaining(
                    fixture.deleteConflict.eventIds
                ),
                observedConflicts: expect.arrayContaining([
                    expect.objectContaining({
                        type: "delete-vs-edit",
                        recoverableVersionIds: [
                            fixture.concurrentDeleteVersionId,
                        ],
                    }),
                ]),
                remainingConflicts: [],
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-delete-conflict-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(await reopened.stat("/delete-race.txt")).toBeUndefined();
            expect(
                (await reopened.namingConflicts()).filter(
                    (conflict) =>
                        conflict.nodeId === fixture.deleteConflict.nodeId
                )
            ).toEqual([]);
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("opens shared-fs addresses with the CLI dependency graph", async () => {
        const writerPeer = await Peerbit.create();
        const readerPeer = await Peerbit.create();
        try {
            await writerPeer.dial(readerPeer);
            const writer = await openSharedFs({
                peerbit: writerPeer,
                machineLabel: "writer",
                replicate: false,
            });
            const reader = await openSharedFs({
                peerbit: readerPeer,
                address: writer.address,
                machineLabel: "reader",
                replicate: false,
            });
            expect(reader.address).toBe(writer.address);
        } finally {
            await Promise.all([stopPeer(writerPeer), stopPeer(readerPeer)]);
        }
    });
});
