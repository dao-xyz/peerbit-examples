import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * S13: tsx transforms with esbuild `keepNames`, which wraps inner functions
 * in `__name(...)`; without the shim the serialized anchor worker would
 * crash under `node --import tsx` and the host would silently fall back to
 * the inline path. A child opens a filesystem under tsx and reports the
 * host mode after a digest round trip through the namespace lane set.
 */

const childPath = fileURLToPath(
    new URL("./readiness-anchor.worker.ts", import.meta.url)
);

describe("readiness anchor worker under tsx", () => {
    it("runs in worker mode in a --import tsx child", async () => {
        const { code, output } = await new Promise<{
            code: number | null;
            output: string;
        }>((resolve, reject) => {
            const child = fork(childPath, ["filesystem"], {
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
            }, 90_000);
            child.once("close", (code) => {
                clearTimeout(timer);
                resolve({ code, output });
            });
        });
        expect(code, output).toBe(0);
        const line = output
            .split("\n")
            .find((candidate) => candidate.startsWith("{"));
        expect(line, output).toBeDefined();
        const report = JSON.parse(line!);
        expect(report.mode).toBe("worker");
        expect(report.failures).toBe(0);
        expect(report.inlineReason).toBeNull();
        // The digest was taken at the tap's epoch and matches the live set.
        expect(report.seq).toBe(report.epoch);
        expect(report.count).toBeGreaterThan(0);
        expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(report.digest).toBe(report.digestOfList);
    });
});
