#!/usr/bin/env node

import { Files } from "@peerbit/please-lib";
import { Peerbit } from "peerbit";
import fs from "fs";
import * as yargs from "yargs";
import { Argv } from "yargs";
import chalk from "chalk";
import { waitForAsync } from "@peerbit/time";
import path from "path";
import { multiaddr } from "@multiformats/multiaddr";

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

    const peerbit = await Peerbit.create();
    const files = await peerbit.open(new Files({ id: ID }));

    return yargs
        .default(args)
        .command({
            command: "put <path>",
            describe: "Put file",
            builder: (yargs: Argv) => {
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

                const file = fs.readFileSync(args.path);
                const id = await files.add(path.basename(args.path), file);
                console.log(
                    `Id: ${chalk.green(
                        id
                    )}\n\nFile can now be fetched with:\n\nplease get ${id}`
                );
            },
        })
        .command({
            command: "get <id> [path]",
            describe: "Get file",
            builder: (yargs: Argv) => {
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

                // wait for at least 1 replicator
                await waitForAsync(
                    async () => (await files.getReady()).size >= 1
                );

                const file = await files.getById(args.id.trim());

                if (!file) {
                    console.log(chalk.red("ERROR: File not found!"));
                } else {
                    const outPath = path.join(
                        args.path || process.cwd(),
                        file.name
                    );
                    if (fs.existsSync(outPath) && args.force) {
                        console.log(
                            chalk.red(
                                `File path ${outPath} already exist. Please remove this file or use --force argument`
                            )
                        );
                    } else {
                        ensureDirectoryExistence(outPath);
                        fs.writeFileSync(outPath, file.bytes);
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
