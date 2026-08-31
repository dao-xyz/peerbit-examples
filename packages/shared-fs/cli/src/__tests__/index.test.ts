import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Peerbit, openSharedFs } from "@peerbit/shared-fs";
import { describe, expect, it, vi } from "vitest";
import { normalizeNativeMountpoint, runCli } from "../index.js";

const stopPeer = async (peer: Peerbit) => {
    await peer.stop();
    await peer.services.blocks.stop();
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

    it("creates an address and exits cleanly", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);
        } finally {
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
