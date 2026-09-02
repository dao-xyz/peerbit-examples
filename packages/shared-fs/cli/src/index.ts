import {
    NativeMountUnavailableError,
    Peerbit,
    type BootstrapStatus,
    type PrepareForDisposalResult,
    type ResolveNamingAction,
    type SharedFsConflict,
    type SharedFsNamingConflict,
    type SharedFsVersionInfo,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    decodePublicSignKey,
    encodePublicSignKey,
    getNativeMountSupport,
    mountNativeSharedFs,
    normalizeFsPath,
    openSharedFs,
    runSharedFsBenchmark,
    unmountNativeMountpoint,
} from "@peerbit/shared-fs";
import { multiaddr } from "@multiformats/multiaddr";
import chalk from "chalk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mountExternalNativeAdapter } from "./external-native-adapter.js";
import {
    installNativeAdapter,
    resolveExternalNativeAdapter,
} from "./native-adapter.js";

const DEFAULT_DIRECTORY_NAME = "peerbit-shared-fs";
// Every syncing machine keeps a full replica: a mount must be able to serve
// the entire namespace from its local index, and a writer must never see its
// own files pruned because it stopped being a leader for them. (The previous
// cpu limit was a no-op and left the adaptive replicator free to shard the
// filesystem across peers, which fragments the mounted view.)
const CLI_REPLICATION_ARGS = {
    replicate: {
        factor: 1,
    },
} as const;

type CliProgramArgs =
    | typeof CLI_REPLICATION_ARGS
    | {
          replicate: false;
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
    return (Array.isArray(addrs) ? addrs : [addrs]).map((address) => {
        multiaddr(address); // validate early with a clear error
        return address;
    });
};

const connectToNetwork = async (
    peerbit: Peerbit,
    peer?: string | string[],
    options?: { bootstrap?: boolean }
) => {
    if (peer) {
        // Dial plain strings so no foreign Multiaddr instances cross module
        // graphs; the client parses them with its own multiaddr copy.
        for (const address of coerceAddresses(peer)) {
            await peerbit.dial(address);
        }
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

const configureExternalNativeAdapterEnv = async () => {
    const adapter = await resolveExternalNativeAdapter();
    if (adapter && !process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER) {
        process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER = adapter;
    }
    return adapter;
};

const readNativeStatus = async () => {
    const externalAdapter = await configureExternalNativeAdapterEnv();
    const support = await getNativeMountSupport();
    return {
        platform: support.platform,
        adapter: support.adapter,
        externalAdapter: externalAdapter ?? null,
        available: support.available,
        missing: [...support.missing],
        notes: [...support.notes],
    };
};

type NativeStatus = Awaited<ReturnType<typeof readNativeStatus>>;

const printNativeRequirements = async (status?: NativeStatus) => {
    const native = status ?? (await readNativeStatus());
    console.log(chalk.bold("Native mount status"));
    console.log(`platform: ${native.platform}`);
    console.log(`adapter: ${native.adapter}`);
    console.log(`external adapter: ${native.externalAdapter ?? "not found"}`);
    console.log(`available: ${native.available ? "yes" : "no"}`);
    if (native.missing.length > 0) {
        console.log("missing:");
        for (const item of native.missing) {
            console.log(`  - ${item}`);
        }
    }
    for (const note of native.notes) {
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

const versionForJson = (version: SharedFsVersionInfo) => ({
    ...version,
    size: version.size.toString(),
    createdAt: version.createdAt.toString(),
    parentVersionIds: [...version.parentVersionIds].sort(),
});

const contentConflictForJson = (conflict: SharedFsConflict) => ({
    path: conflict.path,
    nodeId: conflict.nodeId,
    visibleVersionId: conflict.versions[0]?.id ?? null,
    versions: conflict.versions.map(versionForJson),
});

const namingConflictForJson = (conflict: SharedFsNamingConflict) => ({
    type: conflict.type,
    nodeId: conflict.nodeId,
    path: conflict.path,
    eventIds: [...conflict.eventIds].sort(),
    ...(conflict.shadowedNodeIds
        ? { shadowedNodeIds: [...conflict.shadowedNodeIds].sort() }
        : {}),
    ...(conflict.recoverableVersionIds
        ? {
              recoverableVersionIds: [...conflict.recoverableVersionIds].sort(),
          }
        : {}),
});

const printJson = (value: unknown) => {
    console.log(
        JSON.stringify(
            value,
            (_key, nested) =>
                typeof nested === "bigint" ? nested.toString() : nested,
            2
        )
    );
};

const conflictsInvolvingNode = (
    conflicts: SharedFsNamingConflict[],
    nodeId: string
) =>
    conflicts.filter(
        (conflict) =>
            conflict.nodeId === nodeId ||
            conflict.shadowedNodeIds?.includes(nodeId)
    );

export const conflictScanIsPartial = (
    fullReplica: boolean,
    before: Pick<
        BootstrapStatus,
        "phase" | "pendingDocs" | "snapshotCoverageVerified" | "writeReady"
    >,
    after: Pick<
        BootstrapStatus,
        "phase" | "pendingDocs" | "snapshotCoverageVerified" | "writeReady"
    >
) =>
    !fullReplica ||
    before.phase !== "converged" ||
    after.phase !== "converged" ||
    !before.snapshotCoverageVerified ||
    !after.snapshotCoverageVerified ||
    before.writeReady !== true ||
    after.writeReady !== true ||
    before.phase !== after.phase ||
    before.pendingDocs !== after.pendingDocs ||
    before.snapshotCoverageVerified !== after.snapshotCoverageVerified ||
    before.writeReady !== after.writeReady;

const namingActionFromCli = (
    action: string,
    to: string | undefined
): ResolveNamingAction => {
    if (action === "move") {
        if (!to) {
            throw new Error(
                "resolve-naming-conflict move requires --to <path>"
            );
        }
        return { type: "move", to: normalizeFsPath(to) };
    }
    if (to !== undefined) {
        throw new Error(
            "resolve-naming-conflict --to is only valid with the move action"
        );
    }
    if (action === "keep" || action === "restore" || action === "delete") {
        return { type: action };
    }
    throw new Error(`Unknown naming conflict action: ${action}`);
};

const assertResolutionReplica = (
    command: "resolve-conflict" | "resolve-naming-conflict",
    replicate: boolean
) => {
    if (!replicate) {
        throw new Error(
            `${command} requires a full replica; --no-replicate is not allowed`
        );
    }
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

const printPrepareForDisposalResult = (result: PrepareForDisposalResult) => {
    console.log(`guarantee: ${result.guarantee}`);
    console.log(
        `minimum acknowledgements per entry: ${result.minAcksPerEntry}`
    );
    console.log(
        `entries fenced: ${result.entryCount} (${result.entries.chunks} chunks, ${result.entries.versions} version heads, ${result.entries.naming} naming heads, ${result.entries.trust} trusted-writer entries)`
    );
    console.log(`receipt batches: ${result.receiptBatches}`);
    if (result.empty) {
        console.log(
            chalk.yellow(
                "empty filesystem: this is a vacuous success and does not prove that a remote replica exists"
            )
        );
    }
    console.log(chalk.bold.green("safe-to-dispose: true"));
};

const openCliFs = async (
    peerbit: Peerbit,
    options: {
        address?: string;
        machineLabel?: string;
        replicate?: boolean;
        allowPartialWrites?: boolean;
        gc?: false;
        rootKey?: Peerbit["identity"]["publicKey"];
    }
) => {
    const programArgs: CliProgramArgs =
        options.replicate === false
            ? { replicate: false }
            : CLI_REPLICATION_ARGS;
    const open = () =>
        openSharedFs({
            peerbit,
            address: options.address,
            machineLabel: options.machineLabel || os.hostname(),
            rootKey: options.rootKey,
            allowPartialWrites: options.allowPartialWrites,
            gc: options.gc,
            ...programArgs,
        });
    if (!options.address) {
        return open();
    }
    // Opening by address right after connecting can race the network:
    // the program manifest may not be fetchable for a few seconds.
    // Transient resolution failures are retried within a bounded window;
    // auth/config errors stay fail-fast.
    const deadline = Date.now() + 20_000;
    for (;;) {
        try {
            return await open();
        } catch (error: any) {
            const transient =
                /not found|timed? ?out|resolve|missing|abort/i.test(
                    String(error?.message ?? "")
                );
            if (!transient || Date.now() >= deadline) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
};

const awaitConflictResolutionReady = async (
    fsHandle: Awaited<ReturnType<typeof openCliFs>>,
    peerbit: Peerbit,
    timeout: number
) => {
    await fsHandle.awaitWriteReady({ timeout });
    await fsHandle.awaitBootstrapConverged();
    if (
        fsHandle.accessControlled &&
        !(await fsHandle.isTrustedWriter(peerbit.identity.publicKey))
    ) {
        throw new Error(
            `Local writer ${fsHandle.localPublicKey} is not trusted for this filesystem; authorize it with peerbit-fs trust before resolving conflicts`
        );
    }
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
                if (argv.replicate === false) {
                    throw new Error(
                        "create requires a full replica; --no-replicate is not allowed"
                    );
                }
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    const fsHandle = await openCliFs(peerbit, {
                        machineLabel: argv.machine,
                        // A creator is the authoritative empty/full initial
                        // replica. Persist that continuity proof so the normal
                        // create -> mount flow in this same state directory is
                        // immediately writable even before any namespace row
                        // exists.
                        replicate: true,
                        rootKey: argv.auth
                            ? peerbit.identity.publicKey
                            : undefined,
                    });
                    // Publish an authenticated zero-document frontier. The
                    // normal empty create -> local mount path uses persisted
                    // creator continuity; once that mount is online, remote
                    // peers can use this manifest as positive empty-state
                    // bootstrap evidence instead of waiting forever for a
                    // namespace event that does not exist.
                    await fsHandle.snapshotWrite();
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
            "revoke <address> <public-key>",
            "revoke this identity's trust edge to a writer key",
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
                    const key = decodePublicSignKey(String(argv.publicKey));
                    await fsHandle.revokeWriter(key);
                    const stillTrusted = await fsHandle.isTrustedWriter(key);
                    console.log(
                        stillTrusted
                            ? chalk.yellow(
                                  "Edge revoked, but the key is STILL trusted through another path — revoke the remaining grants (only each truster can revoke its own edge)"
                              )
                            : chalk.green("Writer revoked")
                    );
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
            "trust-legacy-replica <address>",
            "persist a one-time operator trust assertion for an eligible pre-marker local replica",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("assume-local-replica-complete", {
                        type: "boolean",
                        demandOption: true,
                        description:
                            "Required assertion that this exact local directory was cleanly shut down as a complete full replica.",
                    })
                    .option("timeout-ms", {
                        type: "number",
                        default: 30_000,
                        description:
                            "Maximum time to wait for local synchronization activity to become idle.",
                    }),
            async (argv) => {
                if (argv.replicate === false) {
                    throw new Error(
                        "trust-legacy-replica requires a full replica; --no-replicate is not allowed"
                    );
                }
                if (argv.assumeLocalReplicaComplete !== true) {
                    throw new Error(
                        "trust-legacy-replica requires --assume-local-replica-complete"
                    );
                }
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: true,
                        gc: false,
                    });
                    await fsHandle.trustLegacyLocalReplica({
                        assumeComplete: true,
                        timeout: argv.timeoutMs,
                    });
                    console.log(
                        chalk.green(
                            "Legacy local replica trusted by explicit operator assertion; durable write readiness is now enabled for this directory and address."
                        )
                    );
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "mount <address> <mountpoint>",
            "mount a writable shared filesystem using a full replica",
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
                    .option("write-ready-timeout-ms", {
                        type: "number",
                        default: 120_000,
                        description:
                            "Fail the mount if a safe initial write view is not established within this time.",
                    })
                    .option("allow-partial-writes", {
                        type: "boolean",
                        default: false,
                        description:
                            "UNSAFE session-only recovery override: expose namespace writes without a proven settled full-replica view.",
                    }),
            async (argv) => {
                if (argv.replicate === false) {
                    throw new Error(
                        "mount requires a full replica; --no-replicate is not allowed for a writable mount"
                    );
                }
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
                        replicate: true,
                        allowPartialWrites: argv.allowPartialWrites,
                    });
                    // A fresh address-open can serve bootstrap-overlay reads
                    // before its namespace is safe to mutate. Do not expose a
                    // writable OS mount until the full-replica readiness fence
                    // has settled (warm reopens resolve immediately).
                    try {
                        await fsHandle.awaitWriteReady({
                            timeout: argv.writeReadyTimeoutMs,
                        });
                    } catch (error: any) {
                        if (error?.code === "ETIMEDOUT") {
                            throw new Error(
                                `mount did not establish a safe initial write view within ${argv.writeReadyTimeoutMs} ms; keep a complete replicator connected and retry. If status reports legacy promotion eligibility, independently verify this exact local replica and run: peerbit-fs trust-legacy-replica ${argv.address} --assume-local-replica-complete. --allow-partial-writes is only a session-scoped, data-conflict-risk recovery bypass.`,
                                { cause: error }
                            );
                        }
                        throw error;
                    }
                    const backend = createSharedFsMountBackend(fsHandle, {
                        // SharedFileSystem treats chunk input as immutable and
                        // may retain its views, so the backend transfers a
                        // stable COW snapshot instead of copying on release.
                        writeFileInput: "immutable-borrowed",
                    });
                    const externalAdapter = await resolveExternalNativeAdapter(
                        argv.nativeAdapter
                    );
                    const mountpoint = normalizeNativeMountpoint(
                        String(argv.mountpoint)
                    );
                    if (externalAdapter) {
                        ipc = await createSharedFsIpcServer(
                            backend,
                            "tcp://127.0.0.1:0"
                        );
                        mounted = await mountExternalNativeAdapter(
                            externalAdapter,
                            ipc.endpoint,
                            mountpoint
                        );
                    } else {
                        // In-process fuse-native mounts talk to the backend
                        // directly; a loopback JSON hop would only add
                        // latency and base64 CPU.
                        mounted = await mountNativeSharedFs(backend, {
                            mountpoint,
                        });
                    }
                    console.log(
                        chalk.green(
                            `Mounted ${fsHandle.address} at ${mounted.mountpoint}`
                        )
                    );
                    if (ipc) {
                        console.log(`IPC endpoint: ${ipc.endpoint}`);
                    }
                    const gcSchedule = fsHandle.gcStatus();
                    console.log(
                        gcSchedule.scheduled
                            ? `gc schedule: on${gcSchedule.nextRunAtMs ? ` (first run in ~${Math.max(0, Math.round((gcSchedule.nextRunAtMs - Date.now()) / 60000))}m)` : ""}`
                            : "gc schedule: off"
                    );
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
                command
                    .positional("address", {
                        type: "string",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print one machine-readable JSON object.",
                    })
                    .option("include-conflicts", {
                        type: "boolean",
                        default: false,
                        description:
                            "Run whole-store content and naming conflict scans and include their results.",
                    }),
            async (argv) => {
                const nativeMount = await readNativeStatus();
                if (!argv.address) {
                    if (argv.json) {
                        printJson({ nativeMount, filesystem: null });
                    } else {
                        await printNativeRequirements(nativeMount);
                    }
                    return;
                }
                if (!argv.json) {
                    await printNativeRequirements(nativeMount);
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
                    const bootstrapBefore = fsHandle.bootstrapStatus();
                    const rootEntries = await fsHandle.list("/");
                    // Whole-store conflict scans are intentionally opt-in:
                    // they scale with retained metadata and can dominate a
                    // routine readiness/status check on a large workspace.
                    const conflictStatus = argv.includeConflicts
                        ? {
                              content: await fsHandle.conflicts(undefined, {
                                  allowPartial: true,
                              }),
                              naming: await fsHandle.namingConflicts(
                                  undefined,
                                  {
                                      allowPartial: true,
                                  }
                              ),
                          }
                        : undefined;
                    const bootstrapAfter = fsHandle.bootstrapStatus();
                    const bootstrapStateChangedDuringScan =
                        bootstrapBefore.phase !== bootstrapAfter.phase ||
                        bootstrapBefore.pendingDocs !==
                            bootstrapAfter.pendingDocs ||
                        bootstrapBefore.snapshotCoverageVerified !==
                            bootstrapAfter.snapshotCoverageVerified ||
                        bootstrapBefore.writeReady !==
                            bootstrapAfter.writeReady;
                    const conflictViewPartial = conflictScanIsPartial(
                        argv.replicate !== false,
                        bootstrapBefore,
                        bootstrapAfter
                    );
                    const gc = fsHandle.gcStatus();
                    if (argv.json) {
                        printJson({
                            nativeMount,
                            filesystem: {
                                address: fsHandle.address,
                                bootstrap: {
                                    phase: bootstrapAfter.phase,
                                    pendingDocs: bootstrapAfter.pendingDocs,
                                    snapshotCoverageVerified:
                                        bootstrapAfter.snapshotCoverageVerified,
                                    writeReady: bootstrapAfter.writeReady,
                                    writeReadinessSource:
                                        bootstrapAfter.writeReadinessSource ??
                                        null,
                                    legacyPromotionEligible:
                                        bootstrapAfter.legacyPromotionEligible,
                                },
                                localPublicKey: fsHandle.localPublicKey,
                                accessControlled: fsHandle.accessControlled,
                                rootKey: fsHandle.rootKey ?? null,
                                rootEntries: rootEntries.length,
                                conflicts: conflictStatus
                                    ? {
                                          partial: conflictViewPartial,
                                          scope: "local-replica",
                                          bootstrapPhaseBefore:
                                              bootstrapBefore.phase,
                                          bootstrapPhaseAfter:
                                              bootstrapAfter.phase,
                                          bootstrapStateChangedDuringScan,
                                          contentCount:
                                              conflictStatus.content.length,
                                          namingCount:
                                              conflictStatus.naming.length,
                                          content: conflictStatus.content.map(
                                              contentConflictForJson
                                          ),
                                          naming: conflictStatus.naming.map(
                                              namingConflictForJson
                                          ),
                                      }
                                    : null,
                                gc: {
                                    scheduled: gc.scheduled,
                                    nextRunAtMs: gc.nextRunAtMs ?? null,
                                    consecutiveFailures: gc.consecutiveFailures,
                                },
                            },
                        });
                        return;
                    }
                    console.log(`address: ${fsHandle.address}`);
                    if (bootstrapAfter.phase !== "off") {
                        console.log(
                            `bootstrap: ${bootstrapAfter.phase} (${bootstrapAfter.pendingDocs} documents pending)`
                        );
                    }
                    console.log(
                        `write readiness: ${bootstrapAfter.writeReady ? "ready" : "pending"}${bootstrapAfter.writeReadinessSource ? ` (${bootstrapAfter.writeReadinessSource})` : ""}`
                    );
                    console.log(
                        `legacy promotion eligible: ${bootstrapAfter.legacyPromotionEligible ? "yes" : "no"}`
                    );
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
                    if (conflictStatus) {
                        const partial = conflictViewPartial
                            ? " (partial bootstrap view)"
                            : "";
                        console.log(
                            `conflicts: ${conflictStatus.content.length}${partial}`
                        );
                        console.log(
                            `naming conflicts: ${conflictStatus.naming.length}${partial}`
                        );
                    } else {
                        console.log(
                            "conflicts: not scanned (use --include-conflicts)"
                        );
                        console.log(
                            "naming conflicts: not scanned (use --include-conflicts)"
                        );
                    }
                    const nextIn = gc.nextRunAtMs
                        ? ` (next run in ${Math.max(0, Math.round((gc.nextRunAtMs - Date.now()) / 1000))}s)`
                        : "";
                    console.log(
                        `gc schedule: ${gc.scheduled ? `on${nextIn}` : "off"}`
                    );
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "conflicts <address>",
            "list visible conflict versions",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("path", {
                        type: "string",
                        description:
                            "Limit results to an exact file or path prefix.",
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
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    // Conflict listings need the converged view.
                    const convergence =
                        await fsHandle.awaitBootstrapConverged();
                    const bootstrap = fsHandle.bootstrapStatus();
                    const snapshotCoverageVerified =
                        argv.replicate !== false &&
                        convergence.verified &&
                        bootstrap.phase === "converged" &&
                        bootstrap.snapshotCoverageVerified;
                    const conflicts = await fsHandle.conflicts(argv.path);
                    if (argv.json) {
                        printJson({
                            address: fsHandle.address,
                            path: argv.path ? normalizeFsPath(argv.path) : null,
                            view: {
                                fullReplica: argv.replicate !== false,
                                bootstrapPhase: bootstrap.phase,
                                snapshotCoverageVerified,
                            },
                            conflicts: conflicts.map(contentConflictForJson),
                        });
                        return;
                    }
                    if (!snapshotCoverageVerified) {
                        console.warn(
                            chalk.yellow(
                                "Conflict results reflect a settled local view without a verified full-replica bootstrap; do not treat absence as proof of no remote conflict."
                            )
                        );
                    }
                    if (conflicts.length === 0) {
                        console.log("No conflicts");
                        return;
                    }
                    for (const conflict of conflicts) {
                        console.log(chalk.bold(conflict.path));
                        console.log(`  node: ${conflict.nodeId}`);
                        for (const [
                            index,
                            version,
                        ] of conflict.versions.entries()) {
                            console.log(
                                `  ${version.id} ${version.size} bytes ${version.machineLabel} ${version.authorKey}${index === 0 ? " (visible)" : ""}`
                            );
                        }
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "naming-conflicts <address>",
            "list visible namespace conflicts and their actionable node ids",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("path", {
                        type: "string",
                        description: "Limit results to a path prefix.",
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
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: argv.replicate !== false,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: argv.replicate,
                    });
                    const convergence =
                        await fsHandle.awaitBootstrapConverged();
                    const bootstrap = fsHandle.bootstrapStatus();
                    const snapshotCoverageVerified =
                        argv.replicate !== false &&
                        convergence.verified &&
                        bootstrap.phase === "converged" &&
                        bootstrap.snapshotCoverageVerified;
                    const conflicts = await fsHandle.namingConflicts(argv.path);
                    if (argv.json) {
                        printJson({
                            address: fsHandle.address,
                            path: argv.path ? normalizeFsPath(argv.path) : null,
                            view: {
                                fullReplica: argv.replicate !== false,
                                bootstrapPhase: bootstrap.phase,
                                snapshotCoverageVerified,
                            },
                            conflicts: conflicts.map(namingConflictForJson),
                        });
                        return;
                    }
                    if (!snapshotCoverageVerified) {
                        console.warn(
                            chalk.yellow(
                                "Naming conflict results reflect a settled local view without a verified full-replica bootstrap; do not treat absence as proof of no remote conflict."
                            )
                        );
                    }
                    if (conflicts.length === 0) {
                        console.log("No naming conflicts");
                        return;
                    }
                    for (const conflict of conflicts) {
                        console.log(
                            chalk.bold(`${conflict.type} ${conflict.path}`)
                        );
                        console.log(`  node: ${conflict.nodeId}`);
                        console.log(
                            `  events: ${[...conflict.eventIds].sort().join(", ")}`
                        );
                        if (conflict.shadowedNodeIds?.length) {
                            console.log(
                                `  shadowed nodes: ${[...conflict.shadowedNodeIds].sort().join(", ")}`
                            );
                        }
                        if (conflict.recoverableVersionIds?.length) {
                            console.log(
                                `  recoverable versions: ${[...conflict.recoverableVersionIds].sort().join(", ")}`
                            );
                        }
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "resolve-conflict <address> <path> <version-id>",
            "publish a selected content version over the currently visible conflict heads",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("path", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("version-id", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("write-ready-timeout-ms", {
                        type: "number",
                        default: 120_000,
                        description:
                            "Fail if a safe write view is not established within this time.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                assertResolutionReplica("resolve-conflict", argv.replicate);
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer);
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: true,
                    });
                    await awaitConflictResolutionReady(
                        fsHandle,
                        peerbit,
                        argv.writeReadyTimeoutMs
                    );
                    const normalizedPath = normalizeFsPath(argv.path);
                    const visible = await fsHandle.conflicts(normalizedPath);
                    const selectedConflict = visible.find(
                        (conflict) =>
                            conflict.path === normalizedPath &&
                            conflict.versions.some(
                                (version) => version.id === argv.versionId
                            )
                    );
                    if (!selectedConflict) {
                        throw new Error(
                            `Version ${argv.versionId} is not a current conflict head for ${normalizedPath}; rerun peerbit-fs conflicts before retrying`
                        );
                    }
                    const observedHeadVersionIds = selectedConflict.versions
                        .map((version) => version.id)
                        .sort();
                    const resolution = await fsHandle.resolveConflict(
                        normalizedPath,
                        argv.versionId
                    );
                    const supersededHeadVersionIds = [
                        ...resolution.parentVersionIds,
                    ].sort();
                    const headSetChangedDuringResolution =
                        observedHeadVersionIds.join("\0") !==
                        supersededHeadVersionIds.join("\0");
                    const result = {
                        address: fsHandle.address,
                        path: resolution.path,
                        nodeId: resolution.nodeId,
                        selectedVersionId: argv.versionId,
                        observedHeadVersionIds,
                        supersededHeadVersionIds,
                        headSetChangedDuringResolution,
                        resolution: versionForJson(resolution),
                    };
                    if (argv.json) {
                        printJson(result);
                        return;
                    }
                    console.log(
                        chalk.green(
                            `Published content resolution for ${resolution.path}`
                        )
                    );
                    console.log(`selected version: ${argv.versionId}`);
                    console.log(`resolution version: ${resolution.id}`);
                    console.log(
                        `superseded heads: ${supersededHeadVersionIds.join(", ")}`
                    );
                    if (headSetChangedDuringResolution) {
                        console.log(
                            chalk.yellow(
                                "The visible head set changed during resolution; inspect conflicts again."
                            )
                        );
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "resolve-naming-conflict <address> <node-id> <action>",
            "apply an explicit keep, restore, delete, or move action to a visible naming conflict",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("node-id", {
                        type: "string",
                        demandOption: true,
                    })
                    .positional("action", {
                        type: "string",
                        choices: ["keep", "restore", "delete", "move"],
                        demandOption: true,
                    })
                    .option("to", {
                        type: "string",
                        description:
                            "Destination path; required only for the move action.",
                    })
                    .option("write-ready-timeout-ms", {
                        type: "number",
                        default: 120_000,
                        description:
                            "Fail if a safe write view is not established within this time.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                const action = namingActionFromCli(argv.action, argv.to);
                assertResolutionReplica(
                    "resolve-naming-conflict",
                    argv.replicate
                );
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer);
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: true,
                    });
                    await awaitConflictResolutionReady(
                        fsHandle,
                        peerbit,
                        argv.writeReadyTimeoutMs
                    );
                    const observedConflicts = conflictsInvolvingNode(
                        await fsHandle.namingConflicts(),
                        argv.nodeId
                    );
                    if (observedConflicts.length === 0) {
                        throw new Error(
                            `Node ${argv.nodeId} is not part of a currently visible naming conflict; rerun peerbit-fs naming-conflicts before retrying`
                        );
                    }
                    const expectedEventIds = [
                        ...new Set(
                            observedConflicts.flatMap(
                                (conflict) => conflict.eventIds
                            )
                        ),
                    ].sort();
                    await fsHandle.resolveNamingConflict(argv.nodeId, action, {
                        expectedConflicts: observedConflicts,
                    });
                    const remainingConflicts = conflictsInvolvingNode(
                        await fsHandle.namingConflicts(),
                        argv.nodeId
                    );
                    const result = {
                        address: fsHandle.address,
                        nodeId: argv.nodeId,
                        action,
                        expectedEventIds,
                        observedConflicts: observedConflicts.map(
                            namingConflictForJson
                        ),
                        remainingConflicts: remainingConflicts.map(
                            namingConflictForJson
                        ),
                    };
                    if (argv.json) {
                        printJson(result);
                        return;
                    }
                    console.log(
                        chalk.green(
                            `Processed naming action ${action.type} for ${argv.nodeId}`
                        )
                    );
                    if (action.type === "move") {
                        console.log(`destination: ${action.to}`);
                    }
                    console.log(
                        `remaining visible conflicts involving node: ${remainingConflicts.length}`
                    );
                    if (remainingConflicts.length > 0) {
                        console.log(
                            chalk.yellow(
                                "The action did not clear every visible naming conflict; inspect naming-conflicts again."
                            )
                        );
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
            "prepare-disposal <address>",
            "persist the current recoverable head closure on remote replicas before disposing this machine",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("min-acks", {
                        type: "number",
                        default: 1,
                        description:
                            "Distinct capable remote leaders required for every fenced entry.",
                    })
                    .option("timeout-ms", {
                        type: "number",
                        description:
                            "Overall disposal-barrier deadline in milliseconds.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                if (argv.replicate === false) {
                    throw new Error(
                        "prepare-disposal requires a full replica; --no-replicate is not allowed."
                    );
                }
                const result = await (async () => {
                    const directory = resolveDirectory(argv.directory);
                    const peerbit = await Peerbit.create({ directory });
                    try {
                        await connectToNetwork(peerbit, argv.peer, {
                            bootstrap: true,
                        });
                        const fsHandle = await openCliFs(peerbit, {
                            address: argv.address,
                            machineLabel: argv.machine,
                            replicate: true,
                            gc: false,
                        });
                        return await fsHandle.prepareForDisposal({
                            minAcks: argv.minAcks,
                            timeout: argv.timeoutMs,
                        });
                    } finally {
                        // Unlike ordinary read/write commands, disposal must
                        // fail closed: even a shutdown error prevents the
                        // success report from being emitted.
                        await peerbit.stop();
                    }
                })();
                if (argv.json) {
                    console.log(JSON.stringify(result, null, 2));
                } else {
                    printPrepareForDisposalResult(result);
                }
            }
        )
        .command(
            "gc <address>",
            "reclaim storage: retire old versions, compact naming history, delete unreferenced chunks",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("keep-versions", {
                        type: "number",
                        description: "Newest versions always kept per file.",
                    })
                    .option("retention-days", {
                        type: "number",
                        description:
                            "Versions younger than this are always kept.",
                    })
                    .option("grace-days", {
                        type: "number",
                        description:
                            "Nothing is retired unless superseded for this long.",
                    })
                    .option("chunk-grace-hours", {
                        type: "number",
                        description:
                            "Unreferenced chunks must be at least this old.",
                    })
                    .option("naming-grace-days", {
                        type: "number",
                        description:
                            "Naming history compacts only when settled this long.",
                    })
                    .option("settle-seconds", {
                        type: "number",
                        description:
                            "Settle wait before re-validating the plan.",
                    })
                    .option("min-orphan-span-minutes", {
                        type: "number",
                        description:
                            "Span between recording and executing chunk/purge candidates.",
                    })
                    .option("scope", {
                        type: "string",
                        description:
                            "Restrict version/naming retirement to this path prefix.",
                    })
                    .option("immediate-sweep", {
                        type: "boolean",
                        default: false,
                        description:
                            "Collapse the two-run safety barrier. Only when this replica is known warm.",
                    })
                    .option("dry-run", {
                        type: "boolean",
                        default: false,
                        description:
                            "Plan and report without deleting anything.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                if (argv.replicate === false) {
                    console.error(
                        chalk.red(
                            "gc requires a full replica; --no-replicate is not allowed."
                        )
                    );
                    process.exitCode = 1;
                    return;
                }
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: true,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: true,
                    });
                    const report = await fsHandle.collectGarbage({
                        keepVersions: argv.keepVersions,
                        retentionMs: argv.retentionDays
                            ? argv.retentionDays * 24 * 60 * 60 * 1000
                            : undefined,
                        graceMs: argv.graceDays
                            ? argv.graceDays * 24 * 60 * 60 * 1000
                            : undefined,
                        chunkGraceMs: argv.chunkGraceHours
                            ? argv.chunkGraceHours * 60 * 60 * 1000
                            : undefined,
                        namingGraceMs: argv.namingGraceDays
                            ? argv.namingGraceDays * 24 * 60 * 60 * 1000
                            : undefined,
                        settleMs: argv.settleSeconds
                            ? argv.settleSeconds * 1000
                            : undefined,
                        minOrphanSpanMs: argv.minOrphanSpanMinutes
                            ? argv.minOrphanSpanMinutes * 60 * 1000
                            : undefined,
                        scope: argv.scope,
                        chunkSweep: argv.immediateSweep
                            ? "immediate"
                            : "ledger",
                        dryRun: argv.dryRun,
                    });
                    if (argv.json) {
                        console.log(
                            JSON.stringify(
                                report,
                                (key, value) =>
                                    typeof value === "bigint"
                                        ? value.toString()
                                        : value,
                                2
                            )
                        );
                    } else {
                        const mode = report.dryRun ? " (dry run)" : "";
                        console.log(chalk.bold(`gc report${mode}`));
                        console.log(
                            `retired versions:        ${report.retiredVersions}`
                        );
                        console.log(
                            `compacted naming events: ${report.compactedNamingEvents}`
                        );
                        console.log(
                            `purged nodes:            ${report.purgedNodes}`
                        );
                        console.log(
                            `deleted chunks:          ${report.deletedChunks} (${report.reclaimedChunkBytes} bytes)`
                        );
                        console.log(
                            `reclaimed segments:      ${report.segmentBlocksDeleted} (${report.reclaimedSegmentBytes} bytes)`
                        );
                        console.log(
                            `healed chunks:           ${report.healedChunks}`
                        );
                        console.log(
                            `conflicted nodes kept:   ${report.conflictedNodes}`
                        );
                        if (
                            report.chunkCandidatesRecorded > 0 ||
                            report.purgeCandidatesRecorded > 0
                        ) {
                            console.log(
                                chalk.yellow(
                                    `candidates recorded: ${report.chunkCandidatesRecorded} chunk(s), ${report.purgeCandidatesRecorded} purge(s) — run gc again after the span to reclaim them.`
                                )
                            );
                        }
                        for (const warning of report.warnings) {
                            console.log(chalk.yellow(`warning: ${warning}`));
                        }
                    }
                    if (report.damagedNodeIds.length > 0) {
                        console.error(
                            chalk.red(
                                `damaged nodes (missing unrecoverable chunks): ${report.damagedNodeIds.join(", ")}`
                            )
                        );
                        process.exitCode = 1;
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "snapshot <address>",
            "materialize and publish a cold-start snapshot from a fully synced replica",
            (command) =>
                command
                    .positional("address", {
                        type: "string",
                        demandOption: true,
                    })
                    .option("settle-seconds", {
                        type: "number",
                        default: 5,
                        description:
                            "Quiet period with no document arrivals required before materializing.",
                    })
                    .option("json", {
                        type: "boolean",
                        default: false,
                        description: "Print machine-readable JSON.",
                    }),
            async (argv) => {
                if (argv.replicate === false) {
                    console.error(
                        chalk.red(
                            "snapshot requires a full replica; --no-replicate is not allowed."
                        )
                    );
                    process.exitCode = 1;
                    return;
                }
                const directory = resolveDirectory(argv.directory);
                const peerbit = await Peerbit.create({ directory });
                try {
                    await connectToNetwork(peerbit, argv.peer, {
                        bootstrap: true,
                    });
                    const fsHandle = await openCliFs(peerbit, {
                        address: argv.address,
                        machineLabel: argv.machine,
                        replicate: true,
                    });
                    // A one-shot CLI peer starts empty: wait for its own
                    // bootstrap/sync to settle before materializing, or the
                    // snapshot would describe a lagging view as current.
                    // Settle = no document ARRIVALS for the settle window,
                    // observed twice — root-listing size is not a
                    // convergence signal.
                    await fsHandle.awaitBootstrapConverged();
                    const settleMs = Math.max(
                        1000,
                        (argv.settleSeconds ?? 5) * 1000
                    );
                    let quietChecks = 0;
                    while (quietChecks < 2) {
                        const status = fsHandle.bootstrapStatus();
                        // Infinity (nothing ever arrived) counts as quiet;
                        // the empty-tree refusal below catches dead links.
                        if (status.msSinceLastArrival > settleMs) {
                            quietChecks++;
                        } else {
                            quietChecks = 0;
                        }
                        await new Promise((resolve) =>
                            setTimeout(resolve, Math.min(settleMs, 2000))
                        );
                    }
                    if ((await fsHandle.list("/")).length === 0) {
                        console.error(
                            chalk.red(
                                "refusing to publish a snapshot of an empty tree — is the network reachable?"
                            )
                        );
                        process.exitCode = 1;
                        return;
                    }
                    const result = await fsHandle.snapshotWrite();
                    if (argv.json) {
                        console.log(
                            JSON.stringify(
                                result,
                                (key, value) =>
                                    typeof value === "bigint"
                                        ? value.toString()
                                        : value,
                                2
                            )
                        );
                    } else {
                        console.log(chalk.bold("snapshot published"));
                        console.log(`manifest:  ${result.manifestId}`);
                        console.log(`sequence:  ${result.snapshotSeq}`);
                        console.log(
                            `contents:  ${result.docs} documents over ${result.nodes} nodes in ${result.segments} segments (${result.bytes} bytes)`
                        );
                    }
                } finally {
                    await stopPeerbitForCli(peerbit);
                }
            }
        )
        .command(
            "unmount <mountpoint>",
            "detach a native mountpoint (does not stop a separate mount process)",
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
                console.log(
                    chalk.yellow(
                        "If peerbit-fs mount is still running, terminate that process separately and wait for it to exit."
                    )
                );
            }
        )
        .demandCommand(1)
        .strict()
        .help()
        .parseAsync();
};
