import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeNativeMountpoint, runCli } from "../index.js";

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

    it("creates an access-controlled address and prints the local writer key", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-auth-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--auth", "--directory", directory]);
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
});
