#!/usr/bin/env node

import { Files } from "@peerbit/please-lib";
import { Peerbit } from "peerbit";
import fs from "fs";
import * as yargs from "yargs";
import { Argv } from "yargs";
import chalk from "chalk";
import { TimeoutError, waitFor } from "@peerbit/time";
import path from "path";
import os from "os";
import { multiaddr } from "@multiformats/multiaddr";
import { createPathSource, createPathWriter } from "./io.js";

function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

const coerceAddresses = (addrs: string | string[]) => {
    return (Array.isArray(addrs) ? addrs : [addrs]).map((x) => multiaddr(x));
};

const connectToNetwork = async (
    peerbit: Peerbit,
    peer?: string | string[]
) => {
    if (peer) {
        await peerbit.dial(coerceAddresses(peer));
        return;
    }
    await peerbit.bootstrap();
};

const FILE_LOOKUP_TIMEOUT_MS = 2 * 60 * 1000;
const FILE_LOOKUP_ATTEMPT_TIMEOUT_MS = 2 * 1000;
const FILE_LOOKUP_POLL_INTERVAL_MS = 1 * 1000;
const DEFAULT_DIRECTORY_NAME = "peerbit-file-share";
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

const formatDuration = (ms: number) => {
    if (ms < 1_000) {
        return `${ms}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1_000).toFixed(2)}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = ((ms % 60_000) / 1_000).toFixed(1);
    return `${minutes}m${seconds}s`;
};

const formatMbps = (bytes: bigint, ms: number) => {
    if (ms <= 0) {
        return "n/a";
    }
    const megabits = (Number(bytes) * 8) / 1_000_000;
    return `${(megabits / (ms / 1_000)).toFixed(2)} Mbps`;
};

const getDirectoryArg = (args: string[]) => {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--directory" || arg === "--dir") {
            return args[i + 1];
        }
        if (arg.startsWith("--directory=")) {
            return arg.slice("--directory=".length);
        }
        if (arg.startsWith("--dir=")) {
            return arg.slice("--dir=".length);
        }
    }
    return undefined;
};

const stripDirectoryArgs = (args: string[]) => {
    const nextArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--directory" || arg === "--dir") {
            i++;
            continue;
        }
        if (
            arg.startsWith("--directory=") ||
            arg.startsWith("--dir=")
        ) {
            continue;
        }
        nextArgs.push(arg);
    }
    return nextArgs;
};

const resolveDirectory = (directoryArg?: string) => {
    if (directoryArg === undefined) {
        const directory = path.join(os.homedir(), DEFAULT_DIRECTORY_NAME);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        return directory;
    }
    if (directoryArg === "" || directoryArg === "null") {
        return undefined;
    }
    if (!fs.existsSync(directoryArg)) {
        fs.mkdirSync(directoryArg, { recursive: true });
    }
    return directoryArg;
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

const stopPeerbitForCli = async (
    peerbit: Peerbit,
    options?: { timeoutMs?: number }
) => {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
        console.warn(
            chalk.yellow(
                `Peer shutdown exceeded ${Math.round(
                    timeoutMs / 1000
                )} seconds, forcing CLI exit.`
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

// A random ID, but unique for this app
const ID = new Uint8Array([
    30, 221, 227, 76, 164, 10, 61, 8, 21, 176, 122, 5, 79, 110, 115, 255, 233,
    253, 92, 76, 146, 158, 46, 212, 14, 162, 30, 94, 1, 134, 99, 174,
]);

const cli = async (args?: string[]) => {
    if (!args) {
        const { hideBin } = await import("yargs/helpers");
        args = hideBin(process.argv);
    }

    const directory = resolveDirectory(getDirectoryArg(args));
    const parsedArgs = stripDirectoryArgs(args);
    console.log(
        "Starting file-share CLI" +
            (directory ? ` in directory ${directory}` : "")
    );

    const peerbit = await Peerbit.create({ directory });
    let files: Files | undefined;
    const openFiles = async (
        programArgs:
            | typeof CLI_REPLICATION_ARGS
            | {
                  replicate: false;
              } = CLI_REPLICATION_ARGS
    ) => {
        if (!files) {
            files = await peerbit.open(new Files({ id: ID }), {
                args: programArgs,
            });
        }
        return files;
    };

    // TODO fix types
    return yargs
        .default(parsedArgs)
        .option("directory", {
            alias: "dir",
            type: "string",
            describe:
                "Peerbit persistence directory. Defaults to ~/peerbit-file-share. Pass --directory=null for ephemeral mode.",
        })
        .command<any>({
            command: "put <path>",
            describe: "Put file",
            builder: (yargs) => {
                yargs.positional("path", {
                    type: "string",
                    describe: "Where to save it",
                    defaultDescription: "Current directory",
                });
                yargs.option("peer", {
                    alias: ["bootstrap", "relay"],
                    type: "string",
                    describe:
                        "Peer address to dial. Shard roots are discovered automatically after connecting. --bootstrap and --relay remain accepted as aliases.",
                    defaultDescription: "Peerbit bootstrap addresses",
                    default: undefined,
                });
                return yargs;
            },

            handler: async (args) => {
                await connectToNetwork(peerbit, args.peer);

                const files = await openFiles();
                const source = await createPathSource(args.path);
                const id = await files.addSource(path.basename(args.path), source);
                console.log(
                    `Id: ${chalk.green(
                        id
                    )}\n\nFile can now be fetched with:\n\nplease get ${id}\n\nThis process will keep seeding until you stop it.`
                );
                await waitForTermination(async () => {
                    await stopPeerbitForCli(peerbit);
                });
            },
        })
        .command<any>({
            command: "get <id> [path]",
            describe: "Get file",
            builder: (yargs) => {
                yargs.positional("id", {
                    type: "string",
                    describe: "The file id. Obtained when putting the file",
                });
                yargs.positional("path", {
                    type: "string",
                    describe: "Folder to save it in",
                    defaultDescription: "Current directory",
                    demandOption: false,
                });
                yargs.option("force", {
                    alias: "f",
                    describe: "Overwrite existing files",
                    type: "boolean",
                    default: false,
                });
                yargs.option("peer", {
                    alias: ["bootstrap", "relay"],
                    type: "string",
                    describe:
                        "Peer address to dial. Shard roots are discovered automatically after connecting. --bootstrap and --relay remain accepted as aliases.",
                    defaultDescription:
                        "Peerbit bootstrap addresses",
                    default: undefined,
                });
                yargs.option("replicate", {
                    type: "boolean",
                    describe:
                        "Open the file-share as a replicator before fetching, so chunk reads are persisted locally like the browser app's default mode.",
                    default: false,
                });
                return yargs;
            },

            handler: async (args) => {
                await connectToNetwork(peerbit, args.peer);

                const files = await openFiles(
                    args.replicate ? CLI_REPLICATION_ARGS : { replicate: false }
                );
                console.log(
                    `Fetching file with id: ${args.id} (${args.replicate ? "replicator" : "observer"} mode)`
                );
                let file;
                const lookupStartedAt = Date.now();
                try {
                    file = await waitFor(
                        () =>
                            files.resolveById(args.id.trim(), {
                                replicate: true,
                                timeout: FILE_LOOKUP_ATTEMPT_TIMEOUT_MS,
                            }),
                        {
                            timeout: FILE_LOOKUP_TIMEOUT_MS,
                            delayInterval: FILE_LOOKUP_POLL_INTERVAL_MS,
                            timeoutMessage:
                                "waiting for the requested file to become discoverable",
                        }
                    );
                } catch (error) {
                    if (error instanceof TimeoutError) {
                        file = undefined;
                    } else {
                        throw error;
                    }
                }
                const lookupFinishedAt = Date.now();

                if (!file) {
                    console.log(
                        chalk.red(
                            `ERROR: File not found after waiting ${Math.round(
                                FILE_LOOKUP_TIMEOUT_MS / 1000
                            )} seconds! Ensure the seeder is still running and that both peers are connected to the same network. If you pass --peer, the CLI now uses Peerbit.dial(...) and discovers shard roots automatically.`
                        )
                    );
                } else {
                    const outPath = path.join(
                        args.path || process.cwd(),
                        file.name
                    );
                    if (fs.existsSync(outPath) && !args.force) {
                        console.log(
                            chalk.red(
                                `File path ${outPath} already exist. Please remove this file or use --force argument`
                            )
                        );
                    } else {
                        ensureDirectoryExistence(outPath);
                        const downloadStartedAt = Date.now();
                        const writer = await createPathWriter(outPath);
                        await file.writeFile(files, writer);
                        const downloadFinishedAt = Date.now();
                        const sizeBytes = file.size;
                        const lookupMs = lookupFinishedAt - lookupStartedAt;
                        const downloadMs = downloadFinishedAt - downloadStartedAt;
                        const totalMs = downloadFinishedAt - lookupStartedAt;
                        console.log(
                            chalk.greenBright(
                                "File successfully saved at path: " + outPath
                            )
                        );
                        console.log(
                            [
                                `Lookup: ${formatDuration(lookupMs)}`,
                                `Download: ${formatDuration(downloadMs)}`,
                                `Total: ${formatDuration(totalMs)}`,
                                `Size: ${sizeBytes} bytes`,
                                `Throughput: ${formatMbps(sizeBytes, downloadMs)}`,
                            ].join("\n")
                        );
                    }
                }
                await stopPeerbitForCli(peerbit);
            },
        })
        .help()
        .strict()
        .demandCommand()
        .parseAsync();
};

await cli();
