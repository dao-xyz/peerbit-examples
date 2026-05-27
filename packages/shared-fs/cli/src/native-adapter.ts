import { spawn } from "node:child_process";
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
    target: NativeAdapterTarget;
    assetName: string;
    url: string;
};

export class NativeAdapterInstallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeAdapterInstallError";
    }
}

export const nativeAdapterBinaryName = (
    platform: NodeJS.Platform = process.platform
) =>
    platform === "win32" ? `${DEFAULT_PATH_COMMAND}.exe` : DEFAULT_PATH_COMMAND;

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
        id: `${platform}-${arch}`,
        platform,
        arch,
        archiveExtension: platform === "win32" ? "zip" : "tar.gz",
        binaryName: nativeAdapterBinaryName(platform),
    };
};

export const nativeAdapterAssetName = (target: NativeAdapterTarget) =>
    `peerbit-shared-fs-native-${target.id}.${target.archiveExtension}`;

export const nativeAdapterReleaseTag = (version: string) =>
    version.startsWith("shared-fs-native-v")
        ? version
        : `shared-fs-native-v${version.replace(/^v/, "")}`;

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

export const defaultNativeAdapterPath = (
    options: {
        env?: NodeJS.ProcessEnv;
        installDir?: string;
        platform?: NodeJS.Platform;
    } = {}
) =>
    path.join(
        options.installDir ??
            defaultNativeAdapterInstallDir(options.env ?? process.env),
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

export const resolveExternalNativeAdapter = async (
    explicitCommand?: string,
    options: ResolveNativeAdapterOptions = {}
) => {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const commandExists =
        options.commandExists ??
        ((command: string) => commandExistsOnPath(command, { env, platform }));

    if (explicitCommand?.trim()) {
        return explicitCommand;
    }

    if (env.PEERBIT_SHARED_FS_NATIVE_ADAPTER?.trim()) {
        return env.PEERBIT_SHARED_FS_NATIVE_ADAPTER;
    }

    const managedPath = defaultNativeAdapterPath({
        env,
        installDir: options.installDir,
        platform,
    });
    if (await pathExists(managedPath)) {
        return managedPath;
    }

    if (await commandExists(DEFAULT_PATH_COMMAND)) {
        return DEFAULT_PATH_COMMAND;
    }

    return undefined;
};

const readCliPackageVersion = async () => {
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
        await runProcess("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
            archivePath,
            outputDirectory,
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

export const installNativeAdapter = async (
    options: InstallNativeAdapterOptions = {}
): Promise<InstallNativeAdapterResult> => {
    const target = getNativeAdapterTarget(options.platform, options.arch);
    const installDir =
        options.installDir ?? defaultNativeAdapterInstallDir(process.env);
    const binaryPath = path.join(installDir, target.binaryName);
    const existing = await pathExists(binaryPath);
    const version =
        options.version ??
        process.env.PEERBIT_SHARED_FS_NATIVE_VERSION ??
        (await readCliPackageVersion());
    const tag = nativeAdapterReleaseTag(version);
    const assetName = nativeAdapterAssetName(target);
    const url = nativeAdapterDownloadUrl({
        assetName,
        baseUrl:
            options.baseUrl ??
            process.env.PEERBIT_SHARED_FS_NATIVE_RELEASE_BASE_URL,
        tag,
    });

    if (existing && (options.ifNeeded || !options.force)) {
        return {
            binaryPath,
            installed: false,
            skippedReason: "already-installed",
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

        await fsp.mkdir(installDir, { recursive: true });
        await fsp.copyFile(extractedBinary, binaryPath);
        if (target.platform !== "win32") {
            await fsp.chmod(binaryPath, 0o755);
        }

        return {
            binaryPath,
            installed: true,
            target,
            assetName,
            url,
        };
    } finally {
        await fsp.rm(tempDirectory, { recursive: true, force: true });
    }
};
