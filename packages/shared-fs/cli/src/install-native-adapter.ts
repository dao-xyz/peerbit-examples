#!/usr/bin/env node

import chalk from "chalk";
import {
    describeNativeAdapterInstall,
    installNativeAdapter,
} from "./native-adapter.js";

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
        const message = describeNativeAdapterInstall(result);
        console.log(
            result.installed ? chalk.green(message) : chalk.gray(message)
        );
    })
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
