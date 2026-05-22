#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openSharedFs } from "@peerbit/shared-fs";
import { Peerbit } from "peerbit";

type Options = {
    role: "seed" | "join";
    machine: string;
    expected: string[];
    addressFile: string;
    timeoutMs: number;
    directory?: string;
};

const parseArgs = (args: string[]): Options => {
    const value = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
    };
    const role = value("--role");
    if (role !== "seed" && role !== "join") {
        throw new Error("--role must be seed or join");
    }
    const machine = value("--machine");
    if (!machine) {
        throw new Error("--machine is required");
    }
    const addressFile = value("--address-file");
    if (!addressFile) {
        throw new Error("--address-file is required");
    }
    return {
        role,
        machine,
        expected: (value("--expected") ?? "linux,macos,windows")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        addressFile,
        timeoutMs: Number(value("--timeout-ms") ?? 10 * 60 * 1000),
        directory: value("--directory"),
    };
};

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs: number,
    intervalMs = 2_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

const filePathForMachine = (machine: string) => `/${machine}.txt`;

const waitForAllMachines = async (
    fs: Awaited<ReturnType<typeof openSharedFs>>,
    expected: string[],
    timeoutMs: number
) => {
    await waitUntil(async () => {
        const missing: string[] = [];
        for (const machine of expected) {
            const contents = decode(
                await fs.readFile(filePathForMachine(machine))
            );
            if (contents !== `hello from ${machine}`) {
                missing.push(machine);
            }
        }
        if (missing.length > 0) {
            throw new Error(`Missing files from: ${missing.join(", ")}`);
        }
    }, timeoutMs);
};

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const peer = await Peerbit.create({ directory: options.directory });
    try {
        await peer.bootstrap();
        const address =
            options.role === "join"
                ? (await readFile(options.addressFile, "utf8")).trim()
                : undefined;
        const fs = await openSharedFs({
            peerbit: peer,
            address,
            machineLabel: options.machine,
        });

        if (options.role === "seed") {
            await mkdir(path.dirname(options.addressFile), { recursive: true });
            await writeFile(options.addressFile, fs.address ?? "", "utf8");
            console.log(`seed address: ${fs.address}`);
        } else {
            console.log(`joining address: ${address}`);
        }

        await fs.writeFile(
            filePathForMachine(options.machine),
            `hello from ${options.machine}`
        );
        await waitForAllMachines(fs, options.expected, options.timeoutMs);
        console.log(
            `read files from all machines: ${options.expected.join(", ")}`
        );
    } finally {
        await peer.stop();
    }
};

main().catch((error) => {
    console.error(
        error instanceof Error ? error.stack || error.message : error
    );
    process.exitCode = 1;
});
