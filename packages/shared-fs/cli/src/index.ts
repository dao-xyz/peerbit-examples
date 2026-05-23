import {
    NativeMountUnavailableError,
    createSharedFsIpcClient,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
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

const DEFAULT_DIRECTORY_NAME = "peerbit-shared-fs";
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

const coerceAddresses = (addrs: string | string[]) => {
    return (Array.isArray(addrs) ? addrs : [addrs]).map((address) =>
        multiaddr(address)
    );
};

const connectToNetwork = async (peerbit: Peerbit, peer?: string | string[]) => {
    if (peer) {
        await peerbit.dial(coerceAddresses(peer));
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
    } finally {
        clearTimeout(timer);
    }
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
    const child = spawn(
        command,
        ["--endpoint", endpoint, "--mountpoint", mountpoint],
        {
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
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

const printNativeRequirements = async () => {
    const support = await getNativeMountSupport();
    console.log(chalk.bold("Native mount status"));
    console.log(`platform: ${support.platform}`);
    console.log(`adapter: ${support.adapter}`);
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
    console.log("linux: libfuse/FUSE plus the optional fuse-native package");
    console.log("macOS: macFUSE plus the optional fuse-native package");
    console.log("windows: WinFsp adapter binary is required");
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
        ...programArgs,
    });
};

export const runCli = async (args = hideBin(process.argv)) => {
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
            (command) => command,
            async (argv) => {
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    const fsHandle = await openCliFs(peerbit, {
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    console.log(fsHandle.address);
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
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
                    await connectToNetwork(peerbit, argv.peer);
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const backend = createSharedFsMountBackend(fsHandle);
                    const externalAdapter =
                        argv.nativeAdapter ||
                        process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER;
                    const mountpoint = path.resolve(String(argv.mountpoint));
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
                    await connectToNetwork(peerbit, argv.peer);
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const rootEntries = await fsHandle.list("/");
                    const conflicts = await fsHandle.conflicts();
                    console.log(`address: ${fsHandle.address}`);
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
                    await connectToNetwork(peerbit, argv.peer);
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
                        await connectToNetwork(peerbit, argv.peer);
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
                    path.resolve(String(argv.mountpoint))
                );
                console.log(chalk.green(`Unmounted ${argv.mountpoint}`));
            }
        )
        .demandCommand(1)
        .strict()
        .help()
        .parseAsync();
};
