import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BLOCKED_IMPORT = "blocked @peerbit/shared-fs runtime import";
const cliEntry = fileURLToPath(new URL("../bin.ts", import.meta.url));
const cliDirectory = fileURLToPath(new URL("../../", import.meta.url));
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@peerbit/shared-fs") {
        throw new Error(${JSON.stringify(BLOCKED_IMPORT)});
    }
    return nextResolve(specifier, context);
}
`;
const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`;

type ProbeResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

const runProbe = (args: string[]) =>
    new Promise<ProbeResult>((resolve) => {
        execFile(
            process.execPath,
            [
                "--no-warnings",
                "--import",
                "tsx",
                "--experimental-loader",
                loaderUrl,
                cliEntry,
                ...args,
            ],
            {
                cwd: cliDirectory,
                encoding: "utf8",
                env: { ...process.env, FORCE_COLOR: "0" },
                timeout: 30_000,
            },
            (error, stdout, stderr) => {
                resolve({
                    exitCode:
                        error && typeof error.code === "number"
                            ? error.code
                            : error
                              ? 1
                              : 0,
                    stdout,
                    stderr,
                });
            }
        );
    });

describe("peerbit-fs lazy runtime loading", () => {
    it("prints top-level help without importing the filesystem runtime", async () => {
        const result = await runProbe(["--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("peerbit-fs <command>");
        expect(result.stderr).not.toContain(BLOCKED_IMPORT);
    });

    it("reports parser errors without importing the filesystem runtime", async () => {
        const result = await runProbe(["install-adapter", "--unknown-option"]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/Unknown arguments?: unknown-option/);
        expect(result.stderr).not.toContain(BLOCKED_IMPORT);
    });

    it("keeps a current native adapter without importing the filesystem runtime", async () => {
        const prefix = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-lazy-")
        );
        const binaryPath = path.join(
            prefix,
            process.platform === "win32"
                ? "peerbit-shared-fs-native.exe"
                : "peerbit-shared-fs-native"
        );
        await fs.writeFile(binaryPath, "");
        // --if-needed keeps the adapter only because this record pins it to
        // the CLI's own release; otherwise it would download a replacement.
        const { version } = JSON.parse(
            await fs.readFile(path.join(cliDirectory, "package.json"), "utf8")
        ) as { version: string };
        await fs.writeFile(
            path.join(prefix, "peerbit-shared-fs-native.install.json"),
            JSON.stringify({
                schema: "peerbit.shared-fs.native-adapter-install",
                schemaVersion: 1,
                tag: `shared-fs-native-v${version}`,
                target: `${process.platform}-${process.arch}`,
                sha256: createHash("sha256").update("").digest("hex"),
            })
        );

        try {
            const result = await runProbe([
                "install-adapter",
                "--prefix",
                prefix,
                "--if-needed",
                "--print-path",
            ]);

            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe(binaryPath);
            expect(result.stderr).not.toContain(BLOCKED_IMPORT);
        } finally {
            await fs.rm(prefix, { recursive: true, force: true });
        }
    });

    it("proves the loader blocks a filesystem command's dynamic import", async () => {
        const result = await runProbe(["whoami", "--directory", ""]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(BLOCKED_IMPORT);
    });
});
