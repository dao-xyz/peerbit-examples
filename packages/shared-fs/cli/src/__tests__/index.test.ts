import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileVersion, Peerbit, openSharedFs } from "@peerbit/shared-fs";
import { describe, expect, it, vi } from "vitest";
import {
    conflictScanIsPartial,
    normalizeNativeMountpoint,
    runCli,
} from "../index.js";

const stopPeer = async (peer: Peerbit) => {
    await peer.stop();
    await peer.services.blocks.stop();
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

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
        )) as FileVersion;
        await shared.rm("/delete-race.txt");
        const concurrentDeleteVersion = new FileVersion({
            id: "version:cli-delete-vs-edit",
            nodeId: deletedEntry.nodeId,
            parentVersionIds: [deletedBase.id],
            causalDepth: deletedBase.causalDepth + 1n,
            contentHash: deletedBase.contentHash,
            size: deletedBase.size,
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

describe("peerbit-fs cli", () => {
    it("exports the CLI entry point", () => {
        expect(runCli).toBeTypeOf("function");
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
        } finally {
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
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

    it("persists an explicit legacy-replica trust assertion", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-legacy-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let reopenedPeer: Peerbit | undefined;
        try {
            await runCli(["create", "--directory", directory]);
            const address = String(log.mock.calls[0]?.[0]);
            const stateDirectory = path.join(directory, "shared-fs-bootstrap");
            const [stateName] = await fs.readdir(stateDirectory);
            const statePath = path.join(stateDirectory, stateName);
            const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
            delete legacy.writeReady;
            delete legacy.writeReadySource;
            delete legacy.legacyUnproven;
            await fs.writeFile(statePath, JSON.stringify(legacy));

            log.mockClear();
            const command = [
                "trust-legacy-replica",
                address,
                "--assume-local-replica-complete",
                "--timeout-ms",
                "15000",
                "--directory",
                directory,
            ];
            await runCli(command);
            expect(log.mock.calls.at(-1)?.[0]).toContain(
                "explicit operator assertion"
            );
            // Repeating the command is harmless once the marker is durable.
            await expect(runCli(command)).resolves.toBeUndefined();

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "cli-legacy-reopen",
                bootstrap: false,
            });
            expect(reopened.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "legacy-operator-assertion",
                legacyPromotionEligible: false,
            });
        } finally {
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("does not print disposal success when peer shutdown fails", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-disposal-")
        );
        const createPeerbit = Peerbit.create.bind(Peerbit);
        let seedPeer: Peerbit | undefined;
        let cliPeer: Peerbit | undefined;
        let restoreCliStop: (() => void) | undefined;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof vi.spyOn> | undefined;

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

            const shutdownFailure = new Error("simulated shutdown failure");
            createSpy = vi
                .spyOn(Peerbit, "create")
                .mockImplementation(async (options) => {
                    const peer = await createPeerbit(options);
                    cliPeer = peer;
                    vi.spyOn(peer, "bootstrap").mockResolvedValue({
                        connectedPeerIds: [],
                        failures: [],
                    });
                    const stop = vi
                        .spyOn(peer, "stop")
                        .mockRejectedValueOnce(shutdownFailure);
                    restoreCliStop = () => stop.mockRestore();
                    return peer;
                });

            await expect(
                runCli([
                    "prepare-disposal",
                    address,
                    "--directory",
                    directory,
                    "--json",
                ])
            ).rejects.toBe(shutdownFailure);
            expect(cliPeer?.stop).toHaveBeenCalledTimes(1);
            expect(log).not.toHaveBeenCalled();
        } finally {
            createSpy?.mockRestore();
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
    });

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
                        id: fixture.selectedVersionId,
                        size: expect.stringMatching(/^\d+$/),
                        createdAt: expect.stringMatching(/^\d+$/),
                    }),
                    expect.objectContaining({ id: fixture.otherVersionId }),
                ]),
            });
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
                nativeMount: expect.any(Object),
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
                observedHeadVersionIds: expect.arrayContaining([
                    fixture.selectedVersionId,
                    fixture.otherVersionId,
                ]),
                supersededHeadVersionIds: expect.arrayContaining([
                    fixture.selectedVersionId,
                    fixture.otherVersionId,
                ]),
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
