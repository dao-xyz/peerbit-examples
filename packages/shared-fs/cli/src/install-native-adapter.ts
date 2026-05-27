#!/usr/bin/env node

import chalk from "chalk";
import { installNativeAdapter } from "./native-adapter.js";

const takeValue = (args: string[], name: string) => {
    const index = args.indexOf(name);
    if (index === -1) {
        return undefined;
    }
    return args[index + 1];
};

const hasFlag = (args: string[], name: string) => args.includes(name);

const args = process.argv.slice(2);

installNativeAdapter({
    installDir: takeValue(args, "--prefix"),
    version: takeValue(args, "--version"),
    baseUrl: takeValue(args, "--base-url"),
    force: hasFlag(args, "--force"),
    ifNeeded: hasFlag(args, "--if-needed"),
})
    .then((result) => {
        if (hasFlag(args, "--print-path")) {
            console.log(result.binaryPath);
            return;
        }
        if (hasFlag(args, "--quiet")) {
            return;
        }
        if (result.installed) {
            console.log(
                chalk.green(`Installed native adapter at ${result.binaryPath}`)
            );
            return;
        }
        console.log(
            chalk.gray(
                `Native adapter already installed at ${result.binaryPath}`
            )
        );
    })
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
