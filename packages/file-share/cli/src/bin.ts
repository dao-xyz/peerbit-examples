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

const FILE_LOOKUP_TIMEOUT_MS = 2 * 60 * 1000;
const FILE_LOOKUP_ATTEMPT_TIMEOUT_MS = 2 * 1000;
const FILE_LOOKUP_POLL_INTERVAL_MS = 1 * 1000;
const DEFAULT_DIRECTORY_NAME = "peerbit-file-share";

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
    console.log(
        "Starting file-share CLI" +
            (directory ? ` in directory ${directory}` : "")
    );

    const peerbit = await Peerbit.create({ directory });
    const files = await peerbit.open(new Files({ id: ID }));

    // TODO fix types
    return yargs
        .default(args)
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
                yargs.option("relay", {
                    type: "string",
                    describe: "Relay address",
                    defaultDescription: "?",
                    default: undefined,
                });
                return yargs;
            },

            handler: async (args) => {
                if (args.relay) {
                    await Promise.all(
                        coerceAddresses(args.relay).map((x) => peerbit.dial(x))
                    );
                } else {
                    await peerbit.bootstrap();
                }

                const source = await createPathSource(args.path);
                const id = await files.addSource(path.basename(args.path), source);
                console.log(
                    `Id: ${chalk.green(
                        id
                    )}\n\nFile can now be fetched with:\n\nplease get ${id}\n\nThis process will keep seeding until you stop it.`
                );
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
                yargs.option("relay", {
                    type: "string",
                    describe: "Relay address",
                    defaultDescription:
                        "Bootstrap addresses for testing purposes",
                    default: undefined,
                });
                return yargs;
            },

            handler: async (args) => {
                if (args.relay) {
                    await Promise.all(
                        coerceAddresses(args.relay).map((x) => peerbit.dial(x))
                    );
                } else {
                    await peerbit.bootstrap();
                }

                console.log("Fetching file with id: " + args.id);

                const selfHash = peerbit.identity.publicKey.hashcode();
                await waitFor(
                    async () =>
                        [...(await files.getReady())].some(
                            ([hash]) => hash !== selfHash
                        ),
                    {
                        timeout: FILE_LOOKUP_TIMEOUT_MS,
                        delayInterval: FILE_LOOKUP_POLL_INTERVAL_MS,
                        timeoutMessage:
                            "waiting for a remote peer to join the file network",
                    }
                );

                let file;
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
                                "waiting for file metadata to replicate",
                        }
                    );
                } catch (error) {
                    if (error instanceof TimeoutError) {
                        file = undefined;
                    } else {
                        throw error;
                    }
                }

                if (!file) {
                    console.log(
                        chalk.red(
                            `ERROR: File not found after waiting ${Math.round(
                                FILE_LOOKUP_TIMEOUT_MS / 1000
                            )} seconds!`
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
                        const writer = await createPathWriter(outPath);
                        await file.writeFile(files, writer);
                        console.log(
                            chalk.greenBright(
                                "File successfully saved at path: " + outPath
                            )
                        );
                    }
                }
                await peerbit.stop();
            },
        })
        .help()
        .strict()
        .demandCommand().argv;
};

cli();
