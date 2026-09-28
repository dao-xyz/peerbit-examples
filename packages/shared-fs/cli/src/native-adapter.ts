import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_NAME = "@peerbit/shared-fs-cli";
const DEFAULT_RELEASE_REPOSITORY = "dao-xyz/peerbit-examples";
const DEFAULT_PATH_COMMAND = "peerbit-shared-fs-native";
const INSTALL_RECORD_SCHEMA = "peerbit.shared-fs.native-adapter-install";
/** A release download that receives no bytes for this long is abandoned. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/**
 * Sidecar written next to a managed adapter binary. It pins that binary to the
 * release it was downloaded from; the SHA-256 binds the record to those exact
 * bytes so a binary replaced by any other means is not trusted as current.
 */
export const NATIVE_ADAPTER_INSTALL_RECORD = `${DEFAULT_PATH_COMMAND}.install.json`;

export type NativeAdapterTarget = {
    id: string;
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    archiveExtension: "tar.gz" | "zip";
    binaryName: string;
};

export type ResolveNativeAdapterOptions = {
    env?: NodeJS.ProcessEnv;
    installDir?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    /** Selects the managed adapter's release slot; defaults to this CLI's. */
    cliVersion?: string;
    commandExists?: (command: string) => Promise<boolean>;
};

export type InstallNativeAdapterOptions = {
    installDir?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    version?: string;
    baseUrl?: string;
    force?: boolean;
    ifNeeded?: boolean;
};

export type InstallNativeAdapterResult = {
    binaryPath: string;
    installed: boolean;
    skippedReason?: "already-installed";
    /** Release tag of the adapter now at binaryPath. */
    tag: string;
    /** State of the adapter this install replaced, when one existed. */
    replaced?: NativeAdapterInstallState;
    target: NativeAdapterTarget;
    assetName: string;
    url: string;
};

export type NativeAdapterInstallRecord = {
    schema: typeof INSTALL_RECORD_SCHEMA;
    schemaVersion: 1;
    tag: string;
    target: string;
    sha256: string;
};

/**
 * How a managed adapter binary relates to an expected release:
 * - current: its install record names the expected tag and target and matches
 *   its bytes;
 * - stale: its install record names another release;
 * - other-target: its install record names another platform/architecture;
 * - modified: its bytes no longer match its install record;
 * - unrecorded: it has no readable install record (pre-pin installs, manual
 *   copies, or an interrupted install), so its release is unknown.
 */
export type NativeAdapterInstallState =
    | { state: "current"; tag: string }
    | { state: "stale"; tag: string }
    | { state: "other-target"; tag: string; target: string }
    | { state: "modified"; tag: string }
    | { state: "unrecorded" };

export type ResolvedNativeAdapter = {
    command: string;
    source: "argument" | "environment" | "managed" | "path";
};

export class NativeAdapterInstallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeAdapterInstallError";
    }
}

const describeInstallState = (state: NativeAdapterInstallState) => {
    switch (state.state) {
        case "current":
        case "stale":
            return state.tag;
        case "other-target":
            return `${state.tag} built for ${state.target}`;
        case "modified":
            return `a binary that no longer matches its ${state.tag} install record`;
        case "unrecorded":
            return "of unknown version: it has no install record (installed before adapter version pinning, copied manually, or left by an interrupted install)";
    }
};

export class NativeAdapterVersionError extends Error {
    readonly binaryPath: string;
    readonly cliVersion: string;
    readonly expectedTag: string;
    readonly installed: NativeAdapterInstallState;

    constructor(options: {
        binaryPath: string;
        cliVersion: string;
        expectedTag: string;
        expectedTarget: string;
        installed: NativeAdapterInstallState;
    }) {
        const required =
            options.installed.state === "other-target"
                ? `${options.expectedTag} built for ${options.expectedTarget}`
                : options.expectedTag;
        super(
            `Installed native adapter ${options.binaryPath} is ${describeInstallState(
                options.installed
            )}, but ${CLI_PACKAGE_NAME} ${options.cliVersion} requires ${required}. Run \`peerbit-fs install-adapter --force\` to install ${
                options.expectedTag
            }. An adapter passed with --native-adapter is not checked; one from 0.13.15 or earlier mounts but fails every operation.`
        );
        this.name = "NativeAdapterVersionError";
        this.binaryPath = options.binaryPath;
        this.cliVersion = options.cliVersion;
        this.expectedTag = options.expectedTag;
        this.installed = options.installed;
    }
}

export const nativeAdapterBinaryName = (
    platform: NodeJS.Platform = process.platform
) =>
    platform === "win32" ? `${DEFAULT_PATH_COMMAND}.exe` : DEFAULT_PATH_COMMAND;

const nativeAdapterTargetId = (
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture
) => `${platform}-${arch}`;

export const getNativeAdapterTarget = (
    platform: NodeJS.Platform = process.platform,
    arch: NodeJS.Architecture = process.arch
): NativeAdapterTarget => {
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
        throw new NativeAdapterInstallError(
            `No prebuilt native adapter target for platform ${platform}.`
        );
    }
    if (arch !== "x64" && arch !== "arm64") {
        throw new NativeAdapterInstallError(
            `No prebuilt native adapter target for architecture ${arch}.`
        );
    }

    return {
        id: nativeAdapterTargetId(platform, arch),
        platform,
        arch,
        archiveExtension: platform === "win32" ? "zip" : "tar.gz",
        binaryName: nativeAdapterBinaryName(platform),
    };
};

export const nativeAdapterAssetName = (target: NativeAdapterTarget) =>
    `peerbit-shared-fs-native-${target.id}.${target.archiveExtension}`;

export const nativeAdapterReleaseTag = (version: string) => {
    const tag = version.startsWith("shared-fs-native-v")
        ? version
        : `shared-fs-native-v${version.replace(/^v/, "")}`;
    // The tag names the managed adapter's directory, so it must stay one
    // path segment.
    if (!/^shared-fs-native-v[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(tag)) {
        throw new NativeAdapterInstallError(
            `Invalid native adapter version ${JSON.stringify(version)}.`
        );
    }
    return tag;
};

export const nativeAdapterDownloadBaseUrl = (tag: string) =>
    `https://github.com/${DEFAULT_RELEASE_REPOSITORY}/releases/download/${tag}`;

export const nativeAdapterDownloadUrl = (options: {
    assetName: string;
    baseUrl?: string;
    tag: string;
}) => {
    const baseUrl =
        options.baseUrl ?? nativeAdapterDownloadBaseUrl(options.tag);
    return `${baseUrl.replace(/\/$/, "")}/${options.assetName}`;
};

export const defaultNativeAdapterInstallDir = (
    env: NodeJS.ProcessEnv = process.env
) =>
    env.PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR ||
    path.join(os.homedir(), ".peerbit", "shared-fs", "bin");

/**
 * Managed adapters live in one directory per release
 * (`<install dir>/shared-fs-native-v<version>/`), so CLIs of different
 * versions installed side by side each keep their own pinned adapter.
 */
export const defaultNativeAdapterPath = (options: {
    /** Release tag or version. */
    tag: string;
    env?: NodeJS.ProcessEnv;
    installDir?: string;
    platform?: NodeJS.Platform;
}) =>
    path.join(
        options.installDir ??
            defaultNativeAdapterInstallDir(options.env ?? process.env),
        nativeAdapterReleaseTag(options.tag),
        nativeAdapterBinaryName(options.platform ?? process.platform)
    );

const pathExists = async (candidate: string) => {
    try {
        await fsp.access(candidate, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
};

const executablePathExists = async (candidate: string) => {
    try {
        await fsp.access(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return process.platform === "win32" && (await pathExists(candidate));
    }
};

const isPathLikeCommand = (command: string) =>
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");

export const commandExistsOnPath = async (
    command: string,
    options: {
        env?: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
    } = {}
) => {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (isPathLikeCommand(command)) {
        return executablePathExists(command);
    }

    const pathValue = env.PATH;
    if (!pathValue) {
        return false;
    }

    const extensions =
        platform === "win32"
            ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
            : [""];
    const commandNames =
        platform === "win32" && path.extname(command) === ""
            ? [
                  command,
                  ...extensions.map((extension) => `${command}${extension}`),
              ]
            : [command];

    for (const directory of pathValue.split(path.delimiter)) {
        for (const commandName of commandNames) {
            if (await executablePathExists(path.join(directory, commandName))) {
                return true;
            }
        }
    }
    return false;
};

export const resolveNativeAdapter = async (
    explicitCommand?: string,
    options: ResolveNativeAdapterOptions = {}
): Promise<ResolvedNativeAdapter | undefined> => {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const commandExists =
        options.commandExists ??
        ((command: string) => commandExistsOnPath(command, { env, platform }));

    if (explicitCommand?.trim()) {
        return { command: explicitCommand, source: "argument" };
    }

    if (env.PEERBIT_SHARED_FS_NATIVE_ADAPTER?.trim()) {
        return {
            command: env.PEERBIT_SHARED_FS_NATIVE_ADAPTER,
            source: "environment",
        };
    }

    const managedPath = defaultNativeAdapterPath({
        tag: options.cliVersion ?? (await readCliPackageVersion()),
        env,
        installDir: options.installDir,
        platform,
    });
    if (await pathExists(managedPath)) {
        return { command: managedPath, source: "managed" };
    }

    if (await commandExists(DEFAULT_PATH_COMMAND)) {
        return { command: DEFAULT_PATH_COMMAND, source: "path" };
    }

    return undefined;
};

export const resolveExternalNativeAdapter = async (
    explicitCommand?: string,
    options: ResolveNativeAdapterOptions = {}
) => (await resolveNativeAdapter(explicitCommand, options))?.command;

/**
 * Resolve the adapter a mount will launch. The managed install is this CLI's
 * adapter release slot (`shared-fs-native-v<cli version>`) and is refused with
 * a NativeAdapterVersionError when its install record is missing, names
 * another release or target, or no longer matches the binary. Explicit
 * adapters (--native-adapter or PEERBIT_SHARED_FS_NATIVE_ADAPTER) and a PATH
 * command are not checked: an adapter from 0.13.15 or earlier (IPC v1 only)
 * still mounts, but the server rejects every operation it sends.
 */
export const resolveMountNativeAdapter = async (
    explicitCommand?: string,
    options: ResolveNativeAdapterOptions = {}
): Promise<ResolvedNativeAdapter | undefined> => {
    const resolved = await resolveNativeAdapter(explicitCommand, options);
    if (resolved?.source !== "managed") {
        return resolved;
    }
    const cliVersion = options.cliVersion ?? (await readCliPackageVersion());
    const expectedTag = nativeAdapterReleaseTag(cliVersion);
    const expectedTarget = nativeAdapterTargetId(
        options.platform ?? process.platform,
        options.arch ?? process.arch
    );
    const installed = await inspectNativeAdapterInstall(
        resolved.command,
        expectedTag,
        expectedTarget
    );
    if (installed.state !== "current") {
        throw new NativeAdapterVersionError({
            binaryPath: resolved.command,
            cliVersion,
            expectedTag,
            expectedTarget,
            installed,
        });
    }
    return resolved;
};

export const nativeAdapterInstallRecordPath = (binaryPath: string) =>
    path.join(path.dirname(binaryPath), NATIVE_ADAPTER_INSTALL_RECORD);

const sha256File = async (file: string) => {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
};

const isInstallRecord = (
    value: unknown
): value is NativeAdapterInstallRecord => {
    if (value == null || typeof value !== "object") {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        record.schema === INSTALL_RECORD_SCHEMA &&
        record.schemaVersion === 1 &&
        typeof record.tag === "string" &&
        typeof record.target === "string" &&
        typeof record.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(record.sha256)
    );
};

export const readNativeAdapterInstallRecord = async (
    binaryPath: string
): Promise<NativeAdapterInstallRecord | undefined> => {
    try {
        const parsed: unknown = JSON.parse(
            await fsp.readFile(
                nativeAdapterInstallRecordPath(binaryPath),
                "utf8"
            )
        );
        return isInstallRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/** Compare a managed adapter binary with the release it should be. */
export const inspectNativeAdapterInstall = async (
    binaryPath: string,
    expectedTag: string,
    expectedTarget: string
): Promise<NativeAdapterInstallState> => {
    const record = await readNativeAdapterInstallRecord(binaryPath);
    if (!record) {
        return { state: "unrecorded" };
    }
    let digest: string;
    try {
        digest = await sha256File(binaryPath);
    } catch {
        return { state: "unrecorded" };
    }
    if (digest !== record.sha256) {
        return { state: "modified", tag: record.tag };
    }
    if (record.tag !== nativeAdapterReleaseTag(expectedTag)) {
        return { state: "stale", tag: record.tag };
    }
    if (record.target !== expectedTarget) {
        return {
            state: "other-target",
            tag: record.tag,
            target: record.target,
        };
    }
    return { state: "current", tag: record.tag };
};

export const readCliPackageVersion = async () => {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
        const packagePath = path.join(directory, "package.json");
        try {
            const parsed = JSON.parse(
                await fsp.readFile(packagePath, "utf8")
            ) as {
                name?: string;
                version?: string;
            };
            if (parsed.name === CLI_PACKAGE_NAME && parsed.version) {
                return parsed.version;
            }
        } catch {}

        const parent = path.dirname(directory);
        if (parent === directory) {
            throw new NativeAdapterInstallError(
                `Unable to find ${CLI_PACKAGE_NAME} package version.`
            );
        }
        directory = parent;
    }
};

const downloadFile = async (
    url: string,
    destination: string,
    redirectBudget = 5
): Promise<void> => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "http:" ? http : https;
    await new Promise<void>((resolve, reject) => {
        const request = client.get(
            parsedUrl,
            {
                headers: {
                    "user-agent": `${CLI_PACKAGE_NAME} native-adapter-installer`,
                },
                // Socket idle timeout: covers connecting, waiting for the
                // response, and a body that stops arriving.
                timeout: DOWNLOAD_IDLE_TIMEOUT_MS,
            },
            (response) => {
                const statusCode = response.statusCode ?? 0;
                const location = response.headers.location;
                if (
                    statusCode >= 300 &&
                    statusCode < 400 &&
                    location &&
                    redirectBudget > 0
                ) {
                    response.resume();
                    downloadFile(
                        new URL(location, parsedUrl).toString(),
                        destination,
                        redirectBudget - 1
                    ).then(resolve, reject);
                    return;
                }

                if (statusCode !== 200) {
                    response.resume();
                    reject(
                        new NativeAdapterInstallError(
                            `Download failed with HTTP ${statusCode}: ${url}`
                        )
                    );
                    return;
                }

                pipeline(response, fs.createWriteStream(destination)).then(
                    resolve,
                    reject
                );
            }
        );
        request.on("timeout", () => {
            request.destroy(
                new NativeAdapterInstallError(
                    `Download stalled for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s: ${url}`
                )
            );
        });
        request.on("error", reject);
    });
};

const runProcess = async (command: string, args: string[]) => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new NativeAdapterInstallError(
                    `${command} ${args.join(" ")} failed with code=${code} signal=${signal}: ${stderr.trim()}`
                )
            );
        });
    });
};

const extractArchive = async (
    archivePath: string,
    outputDirectory: string,
    target: NativeAdapterTarget
) => {
    if (target.archiveExtension === "zip") {
        const quotePowerShell = (value: string) =>
            `'${value.replace(/'/g, "''")}'`;
        await runProcess("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Expand-Archive -LiteralPath ${quotePowerShell(
                archivePath
            )} -DestinationPath ${quotePowerShell(outputDirectory)} -Force`,
        ]);
        return;
    }
    await runProcess("tar", ["-xzf", archivePath, "-C", outputDirectory]);
};

const findExtractedBinary = async (
    directory: string,
    binaryName: string
): Promise<string | undefined> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (
            entry.isFile() &&
            entry.name.toLowerCase() === binaryName.toLowerCase()
        ) {
            return entryPath;
        }
        if (entry.isDirectory()) {
            const found = await findExtractedBinary(entryPath, binaryName);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
};

/**
 * Rename a staged binary over `destination`. Windows refuses to replace an
 * executable that is running or held by a scanner but usually lets it be
 * renamed, so move the old binary aside first and restore it if the
 * replacement still fails.
 */
const renameBinaryIntoPlace = async (staged: string, destination: string) => {
    if (process.platform !== "win32") {
        await fsp.rename(staged, destination);
        return;
    }
    const aside = `${destination}.${process.pid}.old`;
    const movedAside = await fsp.rename(destination, aside).then(
        () => true,
        () => false
    );
    try {
        await fsp.rename(staged, destination);
    } catch (error) {
        if (movedAside) {
            await fsp.rename(aside, destination).catch(() => {});
        }
        throw error;
    }
    if (movedAside) {
        // Still locked while the old adapter runs; harmless if it stays.
        await fsp.rm(aside, { force: true }).catch(() => {});
    }
};

const writeFileAtomically = async (destination: string, data: string) => {
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
        await fsp.writeFile(temporary, data);
        await fsp.rename(temporary, destination);
    } finally {
        await fsp.rm(temporary, { force: true });
    }
};

/**
 * Install the adapter release for `version` (default: this CLI's version).
 *
 * An existing adapter is kept only when its install record pins it to the
 * requested release and still matches its bytes; a stale, modified, or
 * unrecorded adapter is replaced. `force` replaces even a current adapter,
 * except under `ifNeeded` (the postinstall path), which never forces.
 */
export const installNativeAdapter = async (
    options: InstallNativeAdapterOptions = {}
): Promise<InstallNativeAdapterResult> => {
    const target = getNativeAdapterTarget(options.platform, options.arch);
    const tag = nativeAdapterReleaseTag(
        options.version ?? (await readCliPackageVersion())
    );
    const binaryPath = defaultNativeAdapterPath({
        tag,
        installDir: options.installDir,
        platform: target.platform,
    });
    const assetName = nativeAdapterAssetName(target);
    const url = nativeAdapterDownloadUrl({
        assetName,
        baseUrl:
            options.baseUrl ??
            process.env.PEERBIT_SHARED_FS_NATIVE_RELEASE_BASE_URL,
        tag,
    });

    const replaced = (await pathExists(binaryPath))
        ? await inspectNativeAdapterInstall(binaryPath, tag, target.id)
        : undefined;
    if (replaced?.state === "current" && (options.ifNeeded || !options.force)) {
        return {
            binaryPath,
            installed: false,
            skippedReason: "already-installed",
            tag,
            target,
            assetName,
            url,
        };
    }

    const tempDirectory = await fsp.mkdtemp(
        path.join(os.tmpdir(), "peerbit-shared-fs-native-")
    );
    try {
        const archivePath = path.join(tempDirectory, assetName);
        await downloadFile(url, archivePath);
        await extractArchive(archivePath, tempDirectory, target);
        const extractedBinary = await findExtractedBinary(
            tempDirectory,
            target.binaryName
        );
        if (!extractedBinary) {
            throw new NativeAdapterInstallError(
                `Archive ${assetName} did not contain ${target.binaryName}.`
            );
        }

        await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
        // Hash a staged copy, rename it into place (a running adapter keeps
        // its inode on POSIX, and the managed path never holds a partial
        // binary), then write the record last. Until the record is replaced,
        // it either still matches the old binary (the rename failed) or no
        // longer matches the new one, which mount refuses as modified.
        const stagedBinary = `${binaryPath}.${process.pid}.tmp`;
        let sha256: string;
        try {
            await fsp.copyFile(extractedBinary, stagedBinary);
            if (target.platform !== "win32") {
                await fsp.chmod(stagedBinary, 0o755);
            }
            sha256 = await sha256File(stagedBinary);
            await renameBinaryIntoPlace(stagedBinary, binaryPath);
        } finally {
            await fsp.rm(stagedBinary, { force: true });
        }
        const record: NativeAdapterInstallRecord = {
            schema: INSTALL_RECORD_SCHEMA,
            schemaVersion: 1,
            tag,
            target: target.id,
            sha256,
        };
        await writeFileAtomically(
            nativeAdapterInstallRecordPath(binaryPath),
            `${JSON.stringify(record, null, 4)}\n`
        );

        return {
            binaryPath,
            installed: true,
            tag,
            ...(replaced ? { replaced } : {}),
            target,
            assetName,
            url,
        };
    } finally {
        await fsp.rm(tempDirectory, { recursive: true, force: true });
    }
};

export const describeNativeAdapterInstall = (
    result: InstallNativeAdapterResult
) => {
    if (!result.installed) {
        return `Native adapter ${result.tag} already installed at ${result.binaryPath}`;
    }
    const replaced = result.replaced;
    if (!replaced) {
        return `Installed native adapter ${result.tag} at ${result.binaryPath}`;
    }
    const previous =
        replaced.state === "unrecorded"
            ? "an unrecorded native adapter of unknown version"
            : replaced.state === "modified"
              ? `a modified native adapter (recorded as ${replaced.tag})`
              : `native adapter ${describeInstallState(replaced)}`;
    return `Replaced ${previous} with ${result.tag} at ${result.binaryPath}`;
};
