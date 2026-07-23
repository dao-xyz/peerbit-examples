import {
    NativeMountUnavailableError,
    createSharedFsIpcClient,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    decodePublicSignKey,
    encodePublicSignKey,
    getNativeMountSupport,
    mountNativeSharedFs,
    openSharedFs,
    runSharedFsBenchmark,
    unmountNativeMountpoint,
} from "@peerbit/shared-fs";
import { multiaddr } from "@multiformats/multiaddr";
import chalk from "chalk";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
    installNativeAdapter,
    resolveExternalNativeAdapter,
} from "./native-adapter.js";

const DEFAULT_DIRECTORY_NAME = "peerbit-shared-fs";
const DEFAULT_ADDRESS_RESOLVE_TIMEOUT_MS = 60_000;
const DEFAULT_ADDRESS_RESOLVE_RETRY_INTERVAL_MS = 2_000;
const CLI_REPLICATION_ARGS = {
    replicate: {
        limits: {
            cpu: {
                max: 1,
                monitor: undefined,
            },
        },
    },
} as const;

type CliProgramArgs =
    | typeof CLI_REPLICATION_ARGS
    | {
          replicate: false;
      };

type AddressResolveRetryOptions = {
    address?: string;
    timeoutMs?: number;
    retryIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (event: {
        attempt: number;
        elapsedMs: number;
        retryInMs: number;
        error: Error;
    }) => void;
};

let peerbitRejectionGuardInstalled = false;

const isPeerbitSelfReceiverError = (error: unknown) => {
    return (
        error instanceof Error &&
        error.message.includes(
            "Unexpected to create a message with self as the only receiver"
        ) &&
        error.stack?.includes("@peerbit/stream")
    );
};

const isPeerbitFanoutJoinTimeout = (error: unknown) => {
    return (
        error instanceof Error &&
        error.message.includes("fanout join timed out") &&
        error.stack?.includes("@peerbit/pubsub")
    );
};

const installPeerbitRejectionGuard = () => {
    if (peerbitRejectionGuardInstalled) {
        return;
    }
    peerbitRejectionGuardInstalled = true;
    process.on("unhandledRejection", (reason) => {
        if (isPeerbitSelfReceiverError(reason)) {
            console.warn(
                chalk.yellow(
                    "Peerbit emitted a known self-addressed RPC during local shared-fs operation; continuing."
                )
            );
            return;
        }
        if (isPeerbitFanoutJoinTimeout(reason)) {
            console.warn(
                chalk.yellow(
                    "Peerbit fanout bootstrap timed out during shared-fs operation; continuing while replication retries."
                )
            );
            return;
        }
        throw reason instanceof Error ? reason : new Error(String(reason));
    });
};

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

const normalizeDurationMs = (
    value: number | undefined,
    fallback: number,
    minimum: number
) => {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(minimum, value);
};

export const isRetryableSharedFsAddressOpenError = (
    error: unknown
): error is Error => {
    return (
        error instanceof Error &&
        (error.message.includes("Failed to load program") ||
            error.message.includes("Failed to resolve program with address"))
    );
};

export const openWithSharedFsAddressResolveRetry = async <T>(
    open: () => Promise<T>,
    options: AddressResolveRetryOptions = {}
) => {
    const timeoutMs = normalizeDurationMs(
        options.timeoutMs,
        DEFAULT_ADDRESS_RESOLVE_TIMEOUT_MS,
        0
    );
    if (!options.address || timeoutMs === 0) {
        return open();
    }

    const retryIntervalMs = normalizeDurationMs(
        options.retryIntervalMs,
        DEFAULT_ADDRESS_RESOLVE_RETRY_INTERVAL_MS,
        1
    );
    const now = options.now ?? Date.now;
    const wait = options.sleep ?? sleep;
    const startedAt = now();
    let attempt = 0;

    while (true) {
        attempt += 1;
        try {
            return await open();
        } catch (error) {
            if (!isRetryableSharedFsAddressOpenError(error)) {
                throw error;
            }

            const elapsedMs = now() - startedAt;
            if (elapsedMs >= timeoutMs) {
                throw new Error(
                    `Timed out resolving shared filesystem address after ${timeoutMs}ms`,
                    { cause: error }
                );
            }

            const retryInMs = Math.min(retryIntervalMs, timeoutMs - elapsedMs);
            options.onRetry?.({
                attempt,
                elapsedMs,
                retryInMs,
                error,
            });
            await wait(retryInMs);
        }
    }
};

const resolveDirectory = (directoryArg?: string) => {
    if (directoryArg === undefined) {
        const directory = path.join(os.homedir(), DEFAULT_DIRECTORY_NAME);
        fs.mkdirSync(directory, { recursive: true });
        return directory;
    }
    if (directoryArg === "" || directoryArg === "null") {
        return undefined;
    }
    fs.mkdirSync(directoryArg, { recursive: true });
    return directoryArg;
};

export const normalizeNativeMountpoint = (
    mountpoint: string,
    platform: NodeJS.Platform = process.platform
) => {
    if (platform === "win32") {
        const driveRoot = /^([a-zA-Z]):[\\/]?$/.exec(mountpoint);
        if (driveRoot) {
            return `${driveRoot[1].toUpperCase()}:`;
        }
        return path.win32.resolve(mountpoint);
    }
    return path.resolve(mountpoint);
};

const coerceAddresses = (addrs: string | string[]) => {
    return (Array.isArray(addrs) ? addrs : [addrs]).map((address) =>
        multiaddr(address)
    );
};

const connectToNetwork = async (
    peerbit: Peerbit,
    peer?: string | string[],
    options?: { bootstrap?: boolean }
) => {
    if (peer) {
        await peerbit.dial(coerceAddresses(peer));
        return;
    }
    if (options?.bootstrap === false) {
        return;
    }
    await peerbit.bootstrap();
};

const stopPeerbitForCli = async (
    peerbit: Peerbit,
    options?: { timeoutMs?: number }
) => {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
        console.warn(
            chalk.yellow(
                `Peer shutdown exceeded ${Math.round(timeoutMs / 1000)} seconds, forcing CLI exit.`
            )
        );
        process.exit(process.exitCode ?? 0);
    }, timeoutMs);
    timer.unref?.();

    try {
        await peerbit.stop();
    } catch (error) {
        if (!isPeerbitIndexCloseError(error)) {
            throw error;
        }
        console.warn(
            chalk.yellow(
                "Peer shutdown hit a known document-index close race; continuing after successful CLI work."
            )
        );
    } finally {
        clearTimeout(timer);
    }
};

const isPeerbitIndexCloseError = (error: unknown) => {
    if (!(error instanceof TypeError)) {
        return false;
    }
    return (
        error.message.includes("clearAll") &&
        error.stack?.includes("DocumentIndex.close")
    );
};

const waitForTermination = async (stop: () => Promise<void>) => {
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const keepAlive = setInterval(() => {}, 1 << 30);
        const finish = async () => {
            if (settled) {
                return;
            }
            settled = true;
            clearInterval(keepAlive);
            try {
                await stop();
                resolve();
            } catch (error) {
                reject(error);
            }
        };
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
    });
};

const waitForChildExit = async (child: ChildProcess, timeoutMs = 5_000) => {
    if (child.exitCode != null || child.signalCode != null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
};

const mountExternalNativeAdapter = async (
    command: string,
    endpoint: string,
    mountpoint: string
) => {
    const args = ["--endpoint", endpoint, "--mountpoint", mountpoint];
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG === "1") {
        args.push("--debug");
    }
    const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    await new Promise<void>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    `Native adapter did not report readiness within 15 seconds: ${command}`
                )
            );
        }, 15_000);
        const cleanup = () => {
            clearTimeout(timeout);
            child.stdout.off("data", onStdout);
            child.off("error", onError);
            child.off("exit", onExit);
        };
        const onStdout = (chunk: Buffer) => {
            output += chunk.toString("utf8");
            process.stdout.write(chunk);
            if (output.includes("peerbit-shared-fs-native ready")) {
                cleanup();
                resolve();
            }
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(
                new Error(
                    `Native adapter exited before mount readiness: code=${code} signal=${signal}`
                )
            );
        };
        child.stdout.on("data", onStdout);
        child.once("error", onError);
        child.once("exit", onExit);
    });

    return {
        mountpoint,
        async unmount() {
            if (child.exitCode != null || child.signalCode != null) {
                return;
            }
            child.kill("SIGINT");
            await waitForChildExit(child);
            if (child.exitCode == null && child.signalCode == null) {
                child.kill("SIGTERM");
                await waitForChildExit(child);
            }
        },
    };
};

const configureExternalNativeAdapterEnv = async () => {
    const adapter = await resolveExternalNativeAdapter();
    if (adapter && !process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER) {
        process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER = adapter;
    }
    return adapter;
};

const printNativeRequirements = async () => {
    const externalAdapter = await configureExternalNativeAdapterEnv();
    const support = await getNativeMountSupport();
    console.log(chalk.bold("Native mount status"));
    console.log(`platform: ${support.platform}`);
    console.log(`adapter: ${support.adapter}`);
    console.log(`external adapter: ${externalAdapter ?? "not found"}`);
    console.log(`available: ${support.available ? "yes" : "no"}`);
    if (support.missing.length > 0) {
        console.log("missing:");
        for (const item of support.missing) {
            console.log(`  - ${item}`);
        }
    }
    for (const note of support.notes) {
        console.log(`note: ${note}`);
    }
    console.log("");
    console.log(chalk.bold("Native mount requirements"));
    console.log(
        "linux: libfuse/FUSE plus fuse-native or the peerbit-shared-fs-native adapter"
    );
    console.log(
        "macOS: macFUSE plus fuse-native or the peerbit-shared-fs-native adapter"
    );
    console.log(
        "windows: WinFsp runtime plus the peerbit-shared-fs-native adapter"
    );
};

const printBenchmarkResult = (
    result: Awaited<ReturnType<typeof runSharedFsBenchmark>>
) => {
    console.log(chalk.bold(`benchmark root: ${result.root}`));
    console.log(
        `large write: ${result.largeFile.writeMs}ms ${result.largeFile.writeMbps.toFixed(2)} Mbps`
    );
    console.log(
        `large read:  ${result.largeFile.readMs}ms ${result.largeFile.readMbps.toFixed(2)} Mbps`
    );
    console.log(
        `small write: ${result.smallFiles.writeMs}ms ${result.smallFiles.filesPerSecondWrite.toFixed(2)} files/s`
    );
    console.log(`small list:  ${result.smallFiles.listMs}ms`);
    console.log(
        `small read:  ${result.smallFiles.readMs}ms ${result.smallFiles.filesPerSecondRead.toFixed(2)} files/s`
    );
};

const openCliFs = async (
    peerbit: Peerbit,
    options: {
        address?: string;
        machineLabel?: string;
        replicate?: boolean;
        rootKey?: Peerbit["identity"]["publicKey"];
    }
) => {
    const programArgs: CliProgramArgs =
        options.replicate === false
            ? { replicate: false }
            : CLI_REPLICATION_ARGS;
    return openSharedFs({
        peerbit,
        address: options.address,
        machineLabel: options.machineLabel || os.hostname(),
        rootKey: options.rootKey,
        ...programArgs,
    });
};

export const runCli = async (args = hideBin(process.argv)) => {
    installPeerbitRejectionGuard();
    await yargs(args)
        .scriptName("peerbit-fs")
        .option("directory", {
            alias: "d",
            type: "string",
            description:
                "Peerbit state directory. Use an empty string for in-memory state.",
        })
        .option("machine", {
            type: "string",
            description: "Machine label stored on every signed file version.",
        })
        .option("peer", {
            type: "string",
            array: true,
            description:
                "Multiaddr peer to dial before opening a shared filesystem.",
        })
        .option("replicate", {
            type: "boolean",
            default: true,
            description:
                "Help replicate remote data. Disable with --no-replicate.",
        })
        .command(
            "create",
            "create a new experimental shared filesystem",
            (command) =>
                command.option("auth", {
                    type: "boolean",
                    default: true,
                    description:
                        "Create with trusted-writer access control rooted at this peer identity. Disable with --no-auth.",
                }),
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    const fsHandle = await openCliFs(peerbit, {
                        machineLabel: argv.machine,
                        replicate: false,
                        rootKey: argv.auth
                            ? peerbit.identity.publicKey
                            : undefined,
                    });
                    console.log(fsHandle.address);
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "whoami",
            "print the local Peerbit writer public key",
            (command) => command,
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    console.log(
                        encodePublicSignKey(peerbit.identity.publicKey)
                    );
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "trust <address> <public-key>",
            "authorize a writer key on an access-controlled shared filesystem",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("public-key", {
                        type: "string",
                        demandOption: true,
                        description:
                            "Base64 public key printed by peerbit-fs whoami.",
                    }),
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    await fsHandle.authorizeWriter(
                        decodePublicSignKey(String(argv.publicKey))
                    );
                    console.log(chalk.green("Writer trusted"));
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "install-adapter",
            "download and install the prebuilt native mount adapter",
            (command) =>
                command
                    .option("prefix", {
                        type: "string",
                        description:
                            "Install directory. Defaults to ~/.peerbit/shared-fs/bin.",
                    })
                    .option("adapter-version", {
                        type: "string",
                        description:
                            "Adapter release version. Defaults to this CLI package version.",
                    })
                    .option("base-url", {
                        type: "string",
                        description:
                            "Release asset base URL override for mirrors or test builds.",
                    })
                    .option("force", {
                        type: "boolean",
                        default: false,
                        description: "Replace an existing installed adapter.",
                    })
                    .option("print-path", {
                        type: "boolean",
                        default: false,
                        description:
                            "Print the installed adapter path after resolving/installing.",
                    })
                    .option("if-needed", {
                        type: "boolean",
                        default: false,
                        hidden: true,
                    }),
            async (argv) => {
                const result = await installNativeAdapter({
                    installDir: argv.prefix,
                    version: argv.adapterVersion,
                    baseUrl: argv.baseUrl,
                    force: argv.force,
                    ifNeeded: argv.ifNeeded,
                });
                if (argv.printPath) {
                    console.log(result.binaryPath);
                    return;
                }
                if (result.installed) {
                    console.log(
                        chalk.green(
                            `Installed native adapter ${result.assetName} at ${result.binaryPath}`
                        )
                    );
                    return;
                }
                console.log(
                    chalk.gray(
                        `Native adapter already installed at ${result.binaryPath}`
                    )
                );
            }
        )
        .command(
            "mount <address> <mountpoint>",
            "mount a shared filesystem using the native adapter",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("mountpoint", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("native-adapter", {
                        type: "string",
                        description:
                            "External native adapter command. Can also be set with PEERBIT_SHARED_FS_NATIVE_ADAPTER.",
                    })
                    .option("resolve-timeout", {
                        type: "number",
                        default: DEFAULT_ADDRESS_RESOLVE_TIMEOUT_MS,
                        description:
                            "Milliseconds to wait for a remote filesystem address to become loadable before mounting.",
                    })
                    .option("resolve-retry-interval", {
                        type: "number",
                        default: DEFAULT_ADDRESS_RESOLVE_RETRY_INTERVAL_MS,
                        description:
                            "Milliseconds between remote filesystem address resolve attempts.",
                    }),
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                let ipc:
                    | Awaited<ReturnType<typeof createSharedFsIpcServer>>
                    | undefined;
                let mounted:
                    | Awaited<ReturnType<typeof mountNativeSharedFs>>
                    | Awaited<ReturnType<typeof mountExternalNativeAdapter>>
                    | undefined;
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openWithSharedFsAddressResolveRetry(
                        () =>
                            openCliFs(peerbit, {
                                address: argv.address,
                                machineLabel: argv.machine,
                                replicate: argv.replicate,
                            }),
                        {
                            address: argv.address,
                            timeoutMs: argv.resolveTimeout,
                            retryIntervalMs: argv.resolveRetryInterval,
                            onRetry: ({ attempt, retryInMs, error }) => {
                                console.warn(
                                    chalk.yellow(
                                        `Shared filesystem address is not loadable yet (${error.message}); retrying in ${retryInMs}ms, attempt ${attempt}.`
                                    )
                                );
                            },
                        }
                    );
                    const backend = createSharedFsMountBackend(fsHandle);
                    const externalAdapter = await resolveExternalNativeAdapter(
                        argv.nativeAdapter
                    );
                    const mountpoint = normalizeNativeMountpoint(
                        String(argv.mountpoint)
                    );
                    ipc = await createSharedFsIpcServer(
                        backend,
                        externalAdapter ? "tcp://127.0.0.1:0" : undefined
                    );
                    mounted = externalAdapter
                        ? await mountExternalNativeAdapter(
                              externalAdapter,
                              ipc.endpoint,
                              mountpoint
                          )
                        : await mountNativeSharedFs(
                              createSharedFsIpcClient(ipc.endpoint),
                              {
                                  mountpoint,
                              }
                          );
                    console.log(
                        chalk.green(
                            `Mounted ${fsHandle.address} at ${mounted.mountpoint}`
                        )
                    );
                    console.log(`IPC endpoint: ${ipc.endpoint}`);
                    await waitForTermination(async () => {
                        await mounted?.unmount();
                        await ipc?.close();
                        await stopPeerbitForCli(peerbit);
                    });
                } catch (error) {
                    await mounted?.unmount().catch(() => {});
                    await ipc?.close().catch(() => {});
                    await stopPeerbitForCli(peerbit).catch(() => {});
                    if (error instanceof NativeMountUnavailableError) {
                        console.error(chalk.red(error.message));
                        await printNativeRequirements();
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
            }
        )
        .command(
            "status [address]",
            "show local adapter requirements and optional filesystem status",
            (command) =>
                command.positional("address", {
                    type: "string",
                }),
            async (argv) => {
                await printNativeRequirements();
                if (!argv.address) {
                    return;
                }
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const rootEntries = await fsHandle.list("/");
                    const conflicts = await fsHandle.conflicts();
                    console.log(`address: ${fsHandle.address}`);
                    console.log(`local public key: ${fsHandle.localPublicKey}`);
                    console.log(
                        `access controlled: ${
                            fsHandle.accessControlled ? "yes" : "no"
                        }`
                    );
                    if (fsHandle.rootKey) {
                        console.log(`root key: ${fsHandle.rootKey}`);
                    }
                    console.log(`root entries: ${rootEntries.length}`);
                    console.log(`conflicts: ${conflicts.length}`);
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "conflicts <address>",
            "list visible conflict versions",
            (command) =>
                command.positional("address", {
                    type: "string",
                    demandOption: true,
                }),
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const conflicts = await fsHandle.conflicts();
                    if (conflicts.length === 0) {
                        console.log("No conflicts");
                        return;
                    }
                    for (const conflict of conflicts) {
                        console.log(chalk.bold(conflict.path));
                        for (const version of conflict.versions) {
                            console.log(
                                `  ${version.id} ${version.size} bytes ${version.machineLabel} ${version.authorKey}`
                            );
                        }
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "benchmark [address]",
            "run a baseline large-file and many-small-files workload",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                    })
                    .option("large-size", {
                        type: "number",
                        default: 16 * 1024 * 1024,
                        description: "Large file size in bytes.",
                    })
                    .option("small-files", {
                        type: "number",
                        default: 200,
                        description: "Number of small files to write and read.",
                    })
                    .option("small-size", {
                        type: "number",
                        default: 1024,
                        description: "Small file size in bytes.",
                    })
                    .option("root", {
                        type: "string",
                        description:
                            "Benchmark root path inside the shared filesystem.",
                    })
                    .option("cleanup", {
                        type: "boolean",
                        default: false,
                        description:
                            "Delete benchmark files after metrics are collected.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    if (argv.address) {
                        await connectToNetwork(peerbit, argv.peer, {
                            bootstrap: argv.replicate !== false,
                        });
                    }
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const result = await runSharedFsBenchmark(fsHandle, {
                        root: argv.root,
                        largeFileSize: argv.largeSize,
                        smallFileCount: argv.smallFiles,
                        smallFileSize: argv.smallSize,
                        cleanup: argv.cleanup,
                    });
                    if (argv.json) {
                        console.log(JSON.stringify(result, null, 2));
                    } else {
                        printBenchmarkResult(result);
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "unmount <mountpoint>",
            "unmount a native shared filesystem mountpoint",
            (command) =>
                command.positional("mountpoint", {
                    type: "string",
                    demandOption: true,
                }),
            async (argv) => {
                await unmountNativeMountpoint(
                    normalizeNativeMountpoint(String(argv.mountpoint))
                );
                console.log(chalk.green(`Unmounted ${argv.mountpoint}`));
            }
        )
        .demandCommand(1)
        .strict()
        .help()
        .parseAsync();
};
