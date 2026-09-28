import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
    defaultNativeAdapterPath,
    describeNativeAdapterInstall,
    getNativeAdapterTarget,
    inspectNativeAdapterInstall,
    installNativeAdapter,
    NATIVE_ADAPTER_INSTALL_RECORD,
    nativeAdapterAssetName,
    nativeAdapterBinaryName,
    nativeAdapterDownloadUrl,
    nativeAdapterReleaseTag,
    NativeAdapterVersionError,
    readCliPackageVersion,
    readNativeAdapterInstallRecord,
    resolveExternalNativeAdapter,
    resolveMountNativeAdapter,
} from "../native-adapter.js";

const execFileAsync = promisify(execFile);

const sha256 = (bytes: string | Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

const withTempDirectory = async <T>(
    prefix: string,
    run: (directory: string) => Promise<T>
) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
        return await run(directory);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
};

/** Write a managed adapter binary and, optionally, its install record. */
const writeManagedAdapter = async (
    installDir: string,
    options: { contents: string; recordTag?: string; recordSha256?: string }
) => {
    const binaryPath = defaultNativeAdapterPath({
        installDir,
        platform: "darwin",
    });
    await fs.writeFile(binaryPath, options.contents);
    if (options.recordTag !== undefined) {
        await fs.writeFile(
            path.join(installDir, NATIVE_ADAPTER_INSTALL_RECORD),
            JSON.stringify({
                schema: "peerbit.shared-fs.native-adapter-install",
                schemaVersion: 1,
                tag: options.recordTag,
                target: "darwin-arm64",
                sha256: options.recordSha256 ?? sha256(options.contents),
            })
        );
    }
    return binaryPath;
};

type InstallFlags = { force?: boolean; ifNeeded?: boolean };

/**
 * Serve one tar.gz release asset per tag from a loopback HTTP server and
 * install from it into a fresh directory. Each asset's adapter binary contains
 * its tag, so an install proves which release it fetched.
 */
const withReleaseFixture = async (
    run: (fixture: {
        installDir: string;
        install: (
            version: string,
            flags?: InstallFlags
        ) => ReturnType<typeof installNativeAdapter>;
        downloads: string[];
        binaryContents: (tag: string) => string;
    }) => Promise<void>
) =>
    withTempDirectory("peerbit-shared-fs-native-release-", async (root) => {
        const target = getNativeAdapterTarget(process.platform, process.arch);
        const installDir = path.join(root, "bin");
        const binaryContents = (tag: string) => `#!/bin/sh\n# ${tag}\n`;
        const downloads: string[] = [];
        const server = http.createServer((request, response) => {
            void (async () => {
                const match = /^\/([^/]+)\/([^/]+)$/.exec(request.url ?? "");
                if (!match || match[2] !== nativeAdapterAssetName(target)) {
                    response.writeHead(404).end();
                    return;
                }
                const tag = decodeURIComponent(match[1]);
                downloads.push(tag);
                const staging = path.join(root, `stage-${downloads.length}`);
                await fs.mkdir(staging);
                await fs.writeFile(
                    path.join(staging, target.binaryName),
                    binaryContents(tag)
                );
                const archive = path.join(root, `${downloads.length}.tar.gz`);
                await execFileAsync("tar", [
                    "-czf",
                    archive,
                    "-C",
                    staging,
                    target.binaryName,
                ]);
                response.writeHead(200);
                response.end(await fs.readFile(archive));
            })().catch((error) => {
                response.writeHead(500).end(String(error));
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve)
        );
        const address = server.address();
        if (address == null || typeof address === "string") {
            throw new Error("release fixture server has no TCP address");
        }
        try {
            await run({
                installDir,
                install: (version, flags = {}) =>
                    installNativeAdapter({
                        installDir,
                        version,
                        baseUrl: `http://127.0.0.1:${address.port}/${encodeURIComponent(
                            nativeAdapterReleaseTag(version)
                        )}`,
                        ...flags,
                    }),
                downloads,
                binaryContents,
            });
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        }
    });

describe("native adapter installer helpers", () => {
    it("maps supported platforms to release assets", () => {
        const mac = getNativeAdapterTarget("darwin", "arm64");
        expect(mac.id).toBe("darwin-arm64");
        expect(mac.binaryName).toBe("peerbit-shared-fs-native");
        expect(nativeAdapterAssetName(mac)).toBe(
            "peerbit-shared-fs-native-darwin-arm64.tar.gz"
        );

        const windows = getNativeAdapterTarget("win32", "x64");
        expect(windows.id).toBe("win32-x64");
        expect(windows.binaryName).toBe("peerbit-shared-fs-native.exe");
        expect(nativeAdapterAssetName(windows)).toBe(
            "peerbit-shared-fs-native-win32-x64.zip"
        );
    });

    it("builds release URLs from versions and base URL overrides", () => {
        expect(nativeAdapterReleaseTag("0.0.1")).toBe(
            "shared-fs-native-v0.0.1"
        );
        expect(nativeAdapterReleaseTag("shared-fs-native-v0.0.2")).toBe(
            "shared-fs-native-v0.0.2"
        );
        expect(
            nativeAdapterDownloadUrl({
                assetName: "peerbit-shared-fs-native-linux-x64.tar.gz",
                baseUrl: "https://example.com/releases/",
                tag: "shared-fs-native-v0.0.1",
            })
        ).toBe(
            "https://example.com/releases/peerbit-shared-fs-native-linux-x64.tar.gz"
        );
    });

    it("resolves explicit, environment, managed, and PATH adapters in order", async () => {
        const installDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-native-test-")
        );
        const managedPath = defaultNativeAdapterPath({
            installDir,
            platform: "darwin",
        });

        try {
            expect(
                await resolveExternalNativeAdapter("custom-adapter", {
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe("custom-adapter");

            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {
                        PEERBIT_SHARED_FS_NATIVE_ADAPTER: "env-adapter",
                    },
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe("env-adapter");

            await fs.writeFile(managedPath, "");
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {},
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe(managedPath);

            await fs.rm(managedPath);
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {},
                    installDir,
                    platform: "darwin",
                    commandExists: async (command) =>
                        command === nativeAdapterBinaryName("darwin"),
                })
            ).toBe("peerbit-shared-fs-native");
        } finally {
            await fs.rm(installDir, { recursive: true, force: true });
        }
    });

    it("resolves a managed adapter pinned to this CLI's release for mounting", async () => {
        await withTempDirectory(
            "peerbit-shared-fs-native-pin-",
            async (installDir) => {
                const binaryPath = await writeManagedAdapter(installDir, {
                    contents: "current adapter",
                    recordTag: "shared-fs-native-v1.2.3",
                });
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        env: {},
                        installDir,
                        platform: "darwin",
                        cliVersion: "1.2.3",
                    })
                ).resolves.toEqual({ command: binaryPath, source: "managed" });

                // Without an injected version the pin is this package's own
                // version: shared-fs-native-v<cli version>.
                const cliVersion = await readCliPackageVersion();
                const packageJson = JSON.parse(
                    await fs.readFile(
                        new URL("../../package.json", import.meta.url),
                        "utf8"
                    )
                ) as { version: string };
                expect(cliVersion).toBe(packageJson.version);
                await writeManagedAdapter(installDir, {
                    contents: "current adapter",
                    recordTag: nativeAdapterReleaseTag(cliVersion),
                });
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        env: {},
                        installDir,
                        platform: "darwin",
                    })
                ).resolves.toEqual({ command: binaryPath, source: "managed" });
            }
        );
    });

    it("refuses a stale, unrecorded, or modified managed adapter at mount and names both versions", async () => {
        await withTempDirectory(
            "peerbit-shared-fs-native-pin-",
            async (installDir) => {
                const mount = () =>
                    resolveMountNativeAdapter(undefined, {
                        env: {},
                        installDir,
                        platform: "darwin",
                        cliVersion: "1.2.3",
                    });

                const binaryPath = await writeManagedAdapter(installDir, {
                    contents: "older adapter",
                    recordTag: "shared-fs-native-v1.2.2",
                });
                const stale = await mount().catch((error: unknown) => error);
                expect(stale).toBeInstanceOf(NativeAdapterVersionError);
                expect(stale).toMatchObject({
                    binaryPath,
                    cliVersion: "1.2.3",
                    expectedTag: "shared-fs-native-v1.2.3",
                    installed: {
                        state: "stale",
                        tag: "shared-fs-native-v1.2.2",
                    },
                });
                expect((stale as Error).message).toBe(
                    `Installed native adapter ${binaryPath} is shared-fs-native-v1.2.2, but @peerbit/shared-fs-cli 1.2.3 requires shared-fs-native-v1.2.3. Run \`peerbit-fs install-adapter --force\` to install shared-fs-native-v1.2.3, or pass --native-adapter <path> to use a specific adapter build (the IPC handshake still rejects an incompatible one).`
                );

                // Adapters installed before the pin existed have no record.
                await fs.rm(
                    path.join(installDir, NATIVE_ADAPTER_INSTALL_RECORD)
                );
                await expect(mount()).rejects.toMatchObject({
                    name: "NativeAdapterVersionError",
                    installed: { state: "unrecorded" },
                    message: expect.stringContaining(
                        "is of unknown version: it has no install record"
                    ),
                });

                // A record never vouches for bytes it did not install.
                await writeManagedAdapter(installDir, {
                    contents: "replaced adapter",
                    recordTag: "shared-fs-native-v1.2.3",
                    recordSha256: sha256("the installed adapter"),
                });
                await expect(mount()).rejects.toMatchObject({
                    installed: {
                        state: "modified",
                        tag: "shared-fs-native-v1.2.3",
                    },
                    message: expect.stringContaining(
                        "no longer matches its shared-fs-native-v1.2.3 install record"
                    ),
                });

                // A malformed record is as good as none.
                await fs.writeFile(
                    path.join(installDir, NATIVE_ADAPTER_INSTALL_RECORD),
                    "{"
                );
                await expect(
                    inspectNativeAdapterInstall(
                        binaryPath,
                        "shared-fs-native-v1.2.3"
                    )
                ).resolves.toEqual({ state: "unrecorded" });
            }
        );
    });

    it("does not pin explicit or PATH adapters", async () => {
        await withTempDirectory(
            "peerbit-shared-fs-native-pin-",
            async (installDir) => {
                await writeManagedAdapter(installDir, {
                    contents: "older adapter",
                    recordTag: "shared-fs-native-v1.2.2",
                });
                const options = {
                    installDir,
                    platform: "darwin" as const,
                    cliVersion: "1.2.3",
                    commandExists: async () => true,
                };
                await expect(
                    resolveMountNativeAdapter("/builds/adapter", {
                        ...options,
                        env: {},
                    })
                ).resolves.toEqual({
                    command: "/builds/adapter",
                    source: "argument",
                });
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        ...options,
                        env: {
                            PEERBIT_SHARED_FS_NATIVE_ADAPTER: "env-adapter",
                        },
                    })
                ).resolves.toEqual({
                    command: "env-adapter",
                    source: "environment",
                });

                await fs.rm(
                    defaultNativeAdapterPath({ installDir, platform: "darwin" })
                );
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        ...options,
                        env: {},
                    })
                ).resolves.toEqual({
                    command: "peerbit-shared-fs-native",
                    source: "path",
                });
            }
        );
    });

    // Archive extraction uses the host tar for tar.gz assets; Windows hosts
    // install zip assets through PowerShell, which this fixture does not build.
    it.skipIf(process.platform === "win32")(
        "records the installed release and keeps only a current adapter",
        () =>
            withReleaseFixture(
                async ({ installDir, install, downloads, binaryContents }) => {
                    const tag = "shared-fs-native-v1.2.2";
                    const first = await install("1.2.2");
                    expect(first).toMatchObject({ installed: true, tag });
                    expect(first.replaced).toBeUndefined();
                    expect(describeNativeAdapterInstall(first)).toBe(
                        `Installed native adapter ${tag} at ${first.binaryPath}`
                    );
                    expect(await fs.readFile(first.binaryPath, "utf8")).toBe(
                        binaryContents(tag)
                    );
                    expect((await fs.stat(first.binaryPath)).mode & 0o777).toBe(
                        0o755
                    );
                    const target = getNativeAdapterTarget(
                        process.platform,
                        process.arch
                    );
                    await expect(
                        readNativeAdapterInstallRecord(first.binaryPath)
                    ).resolves.toEqual({
                        schema: "peerbit.shared-fs.native-adapter-install",
                        schemaVersion: 1,
                        tag,
                        target: target.id,
                        sha256: sha256(binaryContents(tag)),
                    });
                    // No staged binary or record is left behind.
                    expect((await fs.readdir(installDir)).sort()).toEqual(
                        [
                            NATIVE_ADAPTER_INSTALL_RECORD,
                            target.binaryName,
                        ].sort()
                    );

                    // A current adapter is kept without a download, and the
                    // postinstall path (--if-needed) never forces.
                    for (const flags of [
                        { ifNeeded: true },
                        {},
                        { ifNeeded: true, force: true },
                    ]) {
                        const kept = await install("1.2.2", flags);
                        expect(kept).toMatchObject({
                            installed: false,
                            skippedReason: "already-installed",
                            tag,
                        });
                        expect(describeNativeAdapterInstall(kept)).toBe(
                            `Native adapter ${tag} already installed at ${kept.binaryPath}`
                        );
                    }
                    expect(downloads).toEqual([tag]);

                    const forced = await install("1.2.2", { force: true });
                    expect(forced).toMatchObject({
                        installed: true,
                        replaced: { state: "current", tag },
                    });
                    expect(downloads).toEqual([tag, tag]);
                }
            )
    );

    it.skipIf(process.platform === "win32")(
        "replaces a stale, unrecorded, or modified adapter under --if-needed",
        () =>
            withReleaseFixture(
                async ({ installDir, install, downloads, binaryContents }) => {
                    const ifNeeded = { ifNeeded: true };
                    const current = "shared-fs-native-v1.2.3";

                    await install("1.2.2", ifNeeded);
                    const upgraded = await install("1.2.3", ifNeeded);
                    expect(upgraded).toMatchObject({
                        installed: true,
                        tag: current,
                        replaced: {
                            state: "stale",
                            tag: "shared-fs-native-v1.2.2",
                        },
                    });
                    expect(describeNativeAdapterInstall(upgraded)).toBe(
                        `Replaced native adapter shared-fs-native-v1.2.2 with ${current} at ${upgraded.binaryPath}`
                    );
                    expect(await fs.readFile(upgraded.binaryPath, "utf8")).toBe(
                        binaryContents(current)
                    );

                    // An adapter installed before the pin existed.
                    await fs.rm(
                        path.join(installDir, NATIVE_ADAPTER_INSTALL_RECORD)
                    );
                    const unrecorded = await install("1.2.3", ifNeeded);
                    expect(unrecorded.replaced).toEqual({
                        state: "unrecorded",
                    });
                    expect(describeNativeAdapterInstall(unrecorded)).toContain(
                        "Replaced an unrecorded native adapter of unknown version"
                    );

                    // An adapter overwritten after its install.
                    await fs.writeFile(unrecorded.binaryPath, "overwritten");
                    const modified = await install("1.2.3", ifNeeded);
                    expect(modified.replaced).toEqual({
                        state: "modified",
                        tag: current,
                    });
                    await expect(
                        inspectNativeAdapterInstall(
                            modified.binaryPath,
                            current
                        )
                    ).resolves.toEqual({ state: "current", tag: current });
                    await expect(
                        install("1.2.3", ifNeeded)
                    ).resolves.toMatchObject({ installed: false });
                    expect(downloads).toEqual([
                        "shared-fs-native-v1.2.2",
                        current,
                        current,
                        current,
                    ]);
                }
            )
    );
});
