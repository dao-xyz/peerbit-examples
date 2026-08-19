import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSharedFs } from "@peerbit/shared-fs";
import { Peerbit } from "peerbit";
import { describe, expect, it, vi } from "vitest";
import {
    isRetryableSharedFsAddressOpenError,
    normalizeNativeMountpoint,
    openWithSharedFsAddressResolveRetry,
    runCli,
} from "../index.js";

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

    it("classifies only transient address-open failures as retryable", () => {
        expect(
            isRetryableSharedFsAddressOpenError(
                new Error("Failed to load program")
            )
        ).toBe(true);
        expect(
            isRetryableSharedFsAddressOpenError(
                new Error(
                    "Failed to resolve program with address: zb2rhExample"
                )
            )
        ).toBe(true);
        expect(
            isRetryableSharedFsAddressOpenError(
                new Error("Not allowed to append")
            )
        ).toBe(false);
    });

    it("retries transient shared-fs address-open failures", async () => {
        let attempts = 0;
        const retries: number[] = [];
        const result = await openWithSharedFsAddressResolveRetry(
            async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("Failed to load program");
                }
                return "mounted";
            },
            {
                address: "zb2rhExample",
                timeoutMs: 10,
                retryIntervalMs: 1,
                sleep: async () => {},
                onRetry: ({ attempt }) => retries.push(attempt),
            }
        );

        expect(result).toBe("mounted");
        expect(attempts).toBe(2);
        expect(retries).toEqual([1]);
    });

    it("times out bounded shared-fs address-open retries", async () => {
        let now = 0;
        let attempts = 0;

        await expect(
            openWithSharedFsAddressResolveRetry(
                async () => {
                    attempts += 1;
                    throw new Error("Failed to load program");
                },
                {
                    address: "zb2rhExample",
                    timeoutMs: 5,
                    retryIntervalMs: 2,
                    now: () => now,
                    sleep: async (ms) => {
                        now += ms;
                    },
                }
            )
        ).rejects.toThrow(
            "Timed out resolving shared filesystem address after 5ms"
        );
        expect(attempts).toBe(4);
    });

    it("does not retry non-resolution open failures", async () => {
        let attempts = 0;

        await expect(
            openWithSharedFsAddressResolveRetry(
                async () => {
                    attempts += 1;
                    throw new Error("Not allowed to append");
                },
                {
                    address: "zb2rhExample",
                    timeoutMs: 10,
                    retryIntervalMs: 1,
                    sleep: async () => {},
                }
            )
        ).rejects.toThrow("Not allowed to append");
        expect(attempts).toBe(1);
    });
});
