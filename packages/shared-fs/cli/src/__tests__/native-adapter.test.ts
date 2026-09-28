import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
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
    nativeAdapterInstallRecordPath,
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

/** Resolve as a darwin-arm64 host, whatever the test host is. */
const darwinArm64 = { platform: "darwin", arch: "arm64" } as const;

/**
 * Write a darwin managed adapter binary into the `slot` release directory
 * and, optionally, its install record.
 */
const writeManagedAdapter = async (
    installDir: string,
    options: {
        slot: string;
        contents: string;
        recordTag?: string;
        recordTarget?: string;
        recordSha256?: string;
    }
) => {
    const binaryPath = defaultNativeAdapterPath({
        tag: options.slot,
        installDir,
        platform: "darwin",
    });
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.writeFile(binaryPath, options.contents);
    if (options.recordTag !== undefined) {
        await writeInstallRecord(binaryPath, {
            tag: options.recordTag,
            target: options.recordTarget ?? "darwin-arm64",
            sha256: options.recordSha256 ?? sha256(options.contents),
        });
    }
    return binaryPath;
};

const writeInstallRecord = (
    binaryPath: string,
    record: { tag: string; target: string; sha256: string }
) =>
    fs.writeFile(
        nativeAdapterInstallRecordPath(binaryPath),
        JSON.stringify({
            schema: "peerbit.shared-fs.native-adapter-install",
            schemaVersion: 1,
            ...record,
        })
    );

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
        /** Tags whose release asset answers 404. */
        unavailable: Set<string>;
        binaryContents: (tag: string) => string;
    }) => Promise<void>
) =>
    withTempDirectory("peerbit-shared-fs-native-release-", async (root) => {
        const target = getNativeAdapterTarget(process.platform, process.arch);
        const installDir = path.join(root, "bin");
        const binaryContents = (tag: string) => `#!/bin/sh\n# ${tag}\n`;
        const downloads: string[] = [];
        const unavailable = new Set<string>();
        const server = http.createServer((request, response) => {
            void (async () => {
                const match = /^\/([^/]+)\/([^/]+)$/.exec(request.url ?? "");
                if (!match || match[2] !== nativeAdapterAssetName(target)) {
                    response.writeHead(404).end();
                    return;
                }
                const tag = decodeURIComponent(match[1]);
                if (unavailable.has(tag)) {
                    response.writeHead(404).end();
                    return;
                }
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
                unavailable,
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
            tag: "1.2.3",
            installDir,
            platform: "darwin",
        });
        expect(managedPath).toBe(
            path.join(
                installDir,
                "shared-fs-native-v1.2.3",
                "peerbit-shared-fs-native"
            )
        );
        const options = {
            installDir,
            platform: "darwin" as const,
            cliVersion: "1.2.3",
        };

        try {
            expect(
                await resolveExternalNativeAdapter("custom-adapter", {
                    ...options,
                    commandExists: async () => true,
                })
            ).toBe("custom-adapter");

            expect(
                await resolveExternalNativeAdapter(undefined, {
                    ...options,
                    env: {
                        PEERBIT_SHARED_FS_NATIVE_ADAPTER: "env-adapter",
                    },
                    commandExists: async () => true,
                })
            ).toBe("env-adapter");

            await fs.mkdir(path.dirname(managedPath));
            await fs.writeFile(managedPath, "");
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    ...options,
                    env: {},
                    commandExists: async () => true,
                })
            ).toBe(managedPath);

            // Only this CLI's release slot is managed; another is ignored.
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    ...options,
                    cliVersion: "1.2.4",
                    env: {},
                    commandExists: async (command) =>
                        command === nativeAdapterBinaryName("darwin"),
                })
            ).toBe("peerbit-shared-fs-native");

            await fs.rm(managedPath);
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    ...options,
                    env: {},
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
                    slot: "1.2.3",
                    contents: "current adapter",
                    recordTag: "shared-fs-native-v1.2.3",
                });
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        ...darwinArm64,
                        env: {},
                        installDir,
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
                const ownPath = await writeManagedAdapter(installDir, {
                    slot: cliVersion,
                    contents: "current adapter",
                    recordTag: nativeAdapterReleaseTag(cliVersion),
                });
                await expect(
                    resolveMountNativeAdapter(undefined, {
                        ...darwinArm64,
                        env: {},
                        installDir,
                    })
                ).resolves.toEqual({ command: ownPath, source: "managed" });
            }
        );
    });

    it("refuses a stale, other-target, unrecorded, or modified managed adapter at mount and names both versions", async () => {
        await withTempDirectory(
            "peerbit-shared-fs-native-pin-",
            async (installDir) => {
                const mount = () =>
                    resolveMountNativeAdapter(undefined, {
                        ...darwinArm64,
                        env: {},
                        installDir,
                        cliVersion: "1.2.3",
                    });

                const binaryPath = await writeManagedAdapter(installDir, {
                    slot: "1.2.3",
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
                    `Installed native adapter ${binaryPath} is shared-fs-native-v1.2.2, but @peerbit/shared-fs-cli 1.2.3 requires shared-fs-native-v1.2.3. Run \`peerbit-fs install-adapter --force\` to install shared-fs-native-v1.2.3. An adapter passed with --native-adapter is not checked; one from 0.13.15 or earlier mounts but fails every operation.`
                );

                // The right release built for another platform.
                await writeManagedAdapter(installDir, {
                    slot: "1.2.3",
                    contents: "linux adapter",
                    recordTag: "shared-fs-native-v1.2.3",
                    recordTarget: "linux-x64",
                });
                await expect(mount()).rejects.toMatchObject({
                    installed: {
                        state: "other-target",
                        tag: "shared-fs-native-v1.2.3",
                        target: "linux-x64",
                    },
                    message: expect.stringContaining(
                        "is shared-fs-native-v1.2.3 built for linux-x64, but @peerbit/shared-fs-cli 1.2.3 requires shared-fs-native-v1.2.3 built for darwin-arm64."
                    ),
                });

                // Adapters copied in without an install have no record.
                await fs.rm(nativeAdapterInstallRecordPath(binaryPath));
                await expect(mount()).rejects.toMatchObject({
                    name: "NativeAdapterVersionError",
                    installed: { state: "unrecorded" },
                    message: expect.stringContaining(
                        "is of unknown version: it has no install record"
                    ),
                });

                // A record never vouches for bytes it did not install.
                await writeManagedAdapter(installDir, {
                    slot: "1.2.3",
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
                    nativeAdapterInstallRecordPath(binaryPath),
                    "{"
                );
                await expect(
                    inspectNativeAdapterInstall(
                        binaryPath,
                        "shared-fs-native-v1.2.3",
                        "darwin-arm64"
                    )
                ).resolves.toEqual({ state: "unrecorded" });
            }
        );
    });

    it("does not pin explicit or PATH adapters", async () => {
        await withTempDirectory(
            "peerbit-shared-fs-native-pin-",
            async (installDir) => {
                const binaryPath = await writeManagedAdapter(installDir, {
                    slot: "1.2.3",
                    contents: "older adapter",
                    recordTag: "shared-fs-native-v1.2.2",
                });
                const options = {
                    ...darwinArm64,
                    installDir,
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

                await fs.rm(binaryPath);
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
                    const target = getNativeAdapterTarget(
                        process.platform,
                        process.arch
                    );
                    const first = await install("1.2.2");
                    expect(first).toMatchObject({
                        installed: true,
                        tag,
                        binaryPath: path.join(
                            installDir,
                            tag,
                            target.binaryName
                        ),
                    });
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
                    expect(
                        (await fs.readdir(path.join(installDir, tag))).sort()
                    ).toEqual(
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
        "keeps adapters of different releases side by side",
        () =>
            withReleaseFixture(
                async ({ installDir, install, downloads, binaryContents }) => {
                    const older = await install("1.2.2", { ifNeeded: true });
                    const newer = await install("1.2.3", { ifNeeded: true });
                    expect(newer).toMatchObject({ installed: true });
                    expect(newer.replaced).toBeUndefined();
                    expect(newer.binaryPath).not.toBe(older.binaryPath);

                    const target = getNativeAdapterTarget(
                        process.platform,
                        process.arch
                    );
                    for (const [version, installed] of [
                        ["1.2.2", older],
                        ["1.2.3", newer],
                    ] as const) {
                        await expect(
                            inspectNativeAdapterInstall(
                                installed.binaryPath,
                                installed.tag,
                                target.id
                            )
                        ).resolves.toEqual({
                            state: "current",
                            tag: installed.tag,
                        });
                        expect(
                            await fs.readFile(installed.binaryPath, "utf8")
                        ).toBe(binaryContents(installed.tag));
                        // Each CLI version mounts its own adapter.
                        await expect(
                            resolveMountNativeAdapter(undefined, {
                                env: {},
                                installDir,
                                cliVersion: version,
                            })
                        ).resolves.toEqual({
                            command: installed.binaryPath,
                            source: "managed",
                        });
                        // Reinstalling either release keeps it.
                        await expect(
                            install(version, { ifNeeded: true })
                        ).resolves.toMatchObject({ installed: false });
                    }
                    expect(downloads).toEqual([older.tag, newer.tag]);
                }
            )
    );

    it.skipIf(process.platform === "win32")(
        "replaces a stale, other-target, corrupt, unrecorded, or modified adapter under --if-needed",
        () =>
            withReleaseFixture(
                async ({ install, downloads, binaryContents }) => {
                    const ifNeeded = { ifNeeded: true };
                    const current = "shared-fs-native-v1.2.3";
                    const { binaryPath, target } = await install(
                        "1.2.3",
                        ifNeeded
                    );
                    const record = {
                        tag: current,
                        target: target.id,
                        sha256: sha256(binaryContents(current)),
                    };
                    const reinstall = async () => {
                        const result = await install("1.2.3", ifNeeded);
                        expect(result).toMatchObject({
                            installed: true,
                            tag: current,
                        });
                        await expect(
                            inspectNativeAdapterInstall(
                                binaryPath,
                                current,
                                target.id
                            )
                        ).resolves.toEqual({ state: "current", tag: current });
                        return result;
                    };

                    // A record naming another release.
                    await writeInstallRecord(binaryPath, {
                        ...record,
                        tag: "shared-fs-native-v1.2.2",
                    });
                    const stale = await reinstall();
                    expect(stale.replaced).toEqual({
                        state: "stale",
                        tag: "shared-fs-native-v1.2.2",
                    });
                    expect(describeNativeAdapterInstall(stale)).toBe(
                        `Replaced native adapter shared-fs-native-v1.2.2 with ${current} at ${binaryPath}`
                    );

                    // A record naming another platform or architecture.
                    await writeInstallRecord(binaryPath, {
                        ...record,
                        target: "linux-foreign",
                    });
                    const otherTarget = await reinstall();
                    expect(otherTarget.replaced).toEqual({
                        state: "other-target",
                        tag: current,
                        target: "linux-foreign",
                    });
                    expect(describeNativeAdapterInstall(otherTarget)).toBe(
                        `Replaced native adapter ${current} built for linux-foreign with ${current} at ${binaryPath}`
                    );

                    // A corrupt record, and no record at all.
                    await fs.writeFile(
                        nativeAdapterInstallRecordPath(binaryPath),
                        "{ not json"
                    );
                    expect((await reinstall()).replaced).toEqual({
                        state: "unrecorded",
                    });
                    await fs.rm(nativeAdapterInstallRecordPath(binaryPath));
                    const unrecorded = await reinstall();
                    expect(unrecorded.replaced).toEqual({
                        state: "unrecorded",
                    });
                    expect(describeNativeAdapterInstall(unrecorded)).toContain(
                        "Replaced an unrecorded native adapter of unknown version"
                    );

                    // An adapter overwritten after its install.
                    await fs.writeFile(binaryPath, "overwritten");
                    expect((await reinstall()).replaced).toEqual({
                        state: "modified",
                        tag: current,
                    });
                    await expect(
                        install("1.2.3", ifNeeded)
                    ).resolves.toMatchObject({ installed: false });
                    expect(downloads).toEqual(Array(6).fill(current));
                }
            )
    );

    it.skipIf(process.platform === "win32")(
        "leaves the previous adapter and record intact when a download or replacement fails",
        () =>
            withReleaseFixture(async ({ install, unavailable }) => {
                const tag = "shared-fs-native-v1.2.3";
                const { binaryPath, target } = await install("1.2.3");
                const recordPath = nativeAdapterInstallRecordPath(binaryPath);
                const snapshot = async () => ({
                    binary: await fs.readFile(binaryPath, "utf8"),
                    record: await fs.readFile(recordPath, "utf8"),
                    files: (await fs.readdir(path.dirname(binaryPath))).sort(),
                });
                const before = await snapshot();
                const expectIntact = async () => {
                    expect(await snapshot()).toEqual(before);
                    await expect(
                        inspectNativeAdapterInstall(binaryPath, tag, target.id)
                    ).resolves.toEqual({ state: "current", tag });
                };

                unavailable.add(tag);
                await expect(install("1.2.3", { force: true })).rejects.toThrow(
                    "Download failed with HTTP 404"
                );
                await expectIntact();
                unavailable.delete(tag);

                // Windows refuses to replace a running or scanner-locked exe.
                const rename = fs.rename;
                const locked = vi
                    .spyOn(fs, "rename")
                    .mockImplementation(async (from, to) => {
                        if (to === binaryPath) {
                            throw Object.assign(
                                new Error("EBUSY: resource busy or locked"),
                                { code: "EBUSY" }
                            );
                        }
                        return rename(from, to);
                    });
                try {
                    await expect(
                        install("1.2.3", { force: true })
                    ).rejects.toThrow("EBUSY");
                    expect(locked).toHaveBeenCalled();
                } finally {
                    locked.mockRestore();
                }
                await expectIntact();
            })
    );
});
