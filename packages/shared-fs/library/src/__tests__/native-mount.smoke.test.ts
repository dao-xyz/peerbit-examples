import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    NativeMountUnavailableError,
    mountNativeSharedFs,
    openSharedFs,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const intervalMs = options.intervalMs ?? 100;
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

const runNativeSmoke = process.env.PEERBIT_SHARED_FS_NATIVE_SMOKE === "1";

(runNativeSmoke ? describe : describe.skip)(
    "shared fs native mount smoke",
    () => {
        let peer: Peerbit | undefined;
        let mountpoint: string | undefined;

        afterEach(async () => {
            await peer?.stop();
            if (mountpoint) {
                await rm(mountpoint, { force: true, recursive: true });
            }
        });

        it("mounts, writes with native fs calls, reads back, and unmounts", async () => {
            peer = await Peerbit.create();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "native-smoke",
            });
            mountpoint = await mkdtemp(
                path.join(tmpdir(), "peerbit-shared-fs-")
            );

            let session:
                | Awaited<ReturnType<typeof mountNativeSharedFs>>
                | undefined;
            try {
                session = await mountNativeSharedFs(fs, { mountpoint });
                await writeFile(
                    path.join(mountpoint, "hello.txt"),
                    "hello native"
                );

                await waitUntil(async () => {
                    expect(decode(await fs.readFile("/hello.txt"))).toBe(
                        "hello native"
                    );
                });
                expect(
                    await readFile(path.join(mountpoint, "hello.txt"), "utf8")
                ).toBe("hello native");
            } catch (error) {
                if (error instanceof NativeMountUnavailableError) {
                    throw new Error(
                        `Native smoke requested but adapter is unavailable: ${error.message}`
                    );
                }
                throw error;
            } finally {
                await session?.unmount();
            }
        });
    }
);
