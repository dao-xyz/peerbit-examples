#!/usr/bin/env node

import { Files } from "@peerbit/please-lib";
import { Peerbit } from "peerbit";
import fs from "fs";
import * as yargs from "yargs";
import { Argv } from "yargs";
import chalk from "chalk";
import { waitForAsync } from "@peerbit/time";
import path from "path";
import { resolveBootstrapAddresses } from "@peerbit/network-utils";
import { multiaddr } from "@multiformats/multiaddr";

function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

const remoteRelayAddress = await resolveBootstrapAddresses("remote");

const coerceAddresses = (addrs: string | string[]) => {
    return (Array.isArray(addrs) ? addrs : [addrs]).map(multiaddr);
};
const cli = async (args?: string[]) => {
    if (!args) {
        const { hideBin } = await import("yargs/helpers");
        args = hideBin(process.argv);
    }

    const peerbit = await Peerbit.create();
    const files = await peerbit.open(new Files(new Uint8Array(32)));

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
                    default: remoteRelayAddress,
                });
                return yargs;
            },

            handler: async (args) => {
                await peerbit.dial(coerceAddresses(args.relay));

                const file = fs.readFileSync(args.path);
                const id = await files.create(path.basename(args.path), file);
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
                yargs.option("relay", {
                    type: "string",
                    describe: "Relay address",
                    defaultDescription: "?",
                    default:
                        "/ip4/127.0.0.1/tcp/8001/p2p/12D3KooWA796xdXd4CuAMxB9CNgmxLDpivbmQu8kusqSFFJ7qrqp",
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
                    default: remoteRelayAddress,
                });
                return yargs;
            },

            handler: async (args) => {
                await peerbit.dial(coerceAddresses(args.relay));

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
