import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    CONFLICTS_DIR,
    NativeMountUnavailableError,
    mountNativeSharedFs,
    openSharedFs,
    type SharedFsHandle,
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

const stopPeer = async (peer: Peerbit) => {
    try {
        await peer.stop();
    } catch (error) {
        if (
            !(
                error instanceof TypeError &&
                error.message.includes("clearAll") &&
                error.stack?.includes("DocumentIndex.close")
            )
        ) {
            throw error;
        }
    }
};

const expectNativeMountAvailable = (error: unknown) => {
    if (error instanceof NativeMountUnavailableError) {
        throw new Error(
            `Native smoke requested but adapter is unavailable: ${error.message}`
        );
    }
    throw error;
};

(runNativeSmoke ? describe : describe.skip)(
    "shared fs native mount smoke",
    () => {
        const peers: Peerbit[] = [];
        const mountpoints: string[] = [];
        const sessions: Awaited<ReturnType<typeof mountNativeSharedFs>>[] = [];

        afterEach(async () => {
            await Promise.allSettled(
                sessions.splice(0).map((session) => session.unmount())
            );
            await Promise.all(peers.splice(0).map((peer) => stopPeer(peer)));
            for (const mountpoint of mountpoints.splice(0)) {
                await rm(mountpoint, { force: true, recursive: true });
            }
        });

        const createPeer = async () => {
            const peer = await Peerbit.create();
            peers.push(peer);
            return peer;
        };

        const createMountpoint = async () => {
            const mountpoint = await mkdtemp(
                path.join(tmpdir(), "peerbit-shared-fs-")
            );
            mountpoints.push(mountpoint);
            return mountpoint;
        };

        const mount = async (fs: SharedFsHandle, mountpoint: string) => {
            const session = await mountNativeSharedFs(fs, { mountpoint });
            sessions.push(session);
            return session;
        };

        it("mounts, writes with native fs calls, reads back, and unmounts", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                machineLabel: "native-smoke",
            });
            const mountpoint = await createMountpoint();

            try {
                await mount(fs, mountpoint);
                await mkdir(path.join(mountpoint, "docs"));
                await writeFile(
                    path.join(mountpoint, "docs", "hello.txt"),
                    "hello native"
                );

                await waitUntil(async () => {
                    expect(decode(await fs.readFile("/docs/hello.txt"))).toBe(
                        "hello native"
                    );
                });
                expect(
                    await readFile(
                        path.join(mountpoint, "docs", "hello.txt"),
                        "utf8"
                    )
                ).toBe("hello native");

                await rename(
                    path.join(mountpoint, "docs", "hello.txt"),
                    path.join(mountpoint, "docs", "renamed.txt")
                );
                await waitUntil(async () => {
                    expect(
                        await fs.readFile("/docs/hello.txt")
                    ).toBeUndefined();
                    expect(decode(await fs.readFile("/docs/renamed.txt"))).toBe(
                        "hello native"
                    );
                });

                await rm(path.join(mountpoint, "docs", "renamed.txt"));
                await waitUntil(async () => {
                    expect(
                        await fs.readFile("/docs/renamed.txt")
                    ).toBeUndefined();
                });
            } catch (error) {
                expectNativeMountAvailable(error);
            }
        });

        it("syncs writes between mounted peers and exposes conflict metadata", async () => {
            const peerA = await createPeer();
            const peerB = await createPeer();
            await peerA.dial(peerB);

            const fsA = await openSharedFs({
                peerbit: peerA,
                machineLabel: "native-peer-a",
            });
            const fsB = await openSharedFs({
                peerbit: peerB,
                address: fsA.address,
                machineLabel: "native-peer-b",
            });
            const mountA = await createMountpoint();
            const mountB = await createMountpoint();

            try {
                await mount(fsA, mountA);
                await mount(fsB, mountB);

                await mkdir(path.join(mountA, "shared"));
                await writeFile(
                    path.join(mountA, "shared", "from-a.txt"),
                    "hello from mount a"
                );

                await waitUntil(async () => {
                    expect(
                        await readFile(
                            path.join(mountB, "shared", "from-a.txt"),
                            "utf8"
                        )
                    ).toBe("hello from mount a");
                });

                await writeFile(
                    path.join(mountB, "shared", "from-b.txt"),
                    "hello from mount b"
                );
                await waitUntil(async () => {
                    expect(
                        await readFile(
                            path.join(mountA, "shared", "from-b.txt"),
                            "utf8"
                        )
                    ).toBe("hello from mount b");
                });

                await fsA.writeFile("/conflict.txt", "base");
                await waitUntil(async () => {
                    expect(decode(await fsB.readFile("/conflict.txt"))).toBe(
                        "base"
                    );
                });
                const baseVersionIds = (await fsA.versions("/conflict.txt"))
                    .filter((version) => version.head)
                    .map((version) => version.id);
                const left = await fsA.writeFile("/conflict.txt", "left", {
                    baseVersionIds,
                });
                const right = await fsB.writeFile("/conflict.txt", "right", {
                    baseVersionIds,
                });

                await waitUntil(async () => {
                    expect(await fsA.conflicts("/conflict.txt")).toHaveLength(
                        1
                    );
                    expect(await fsB.conflicts("/conflict.txt")).toHaveLength(
                        1
                    );
                });

                const conflictRoots = await readdir(
                    path.join(mountA, CONFLICTS_DIR)
                );
                expect(conflictRoots).toHaveLength(1);
                const conflictVersions = await readdir(
                    path.join(mountA, CONFLICTS_DIR, conflictRoots[0])
                );
                expect(conflictVersions.sort()).toEqual(
                    [left.id, right.id].sort()
                );
                await expect(
                    readFile(
                        path.join(
                            mountA,
                            CONFLICTS_DIR,
                            conflictRoots[0],
                            left.id
                        ),
                        "utf8"
                    )
                ).resolves.toBe("left");
                await expect(
                    readFile(
                        path.join(
                            mountB,
                            CONFLICTS_DIR,
                            conflictRoots[0],
                            right.id
                        ),
                        "utf8"
                    )
                ).resolves.toBe("right");
            } catch (error) {
                expectNativeMountAvailable(error);
            }
        });

        it("propagates native renames and deletes between mounted peers", async () => {
            const peerA = await createPeer();
            const peerB = await createPeer();
            await peerA.dial(peerB);

            const fsA = await openSharedFs({
                peerbit: peerA,
                machineLabel: "native-peer-a",
            });
            const fsB = await openSharedFs({
                peerbit: peerB,
                address: fsA.address,
                machineLabel: "native-peer-b",
            });
            const mountA = await createMountpoint();
            const mountB = await createMountpoint();

            try {
                await mount(fsA, mountA);
                await mount(fsB, mountB);

                await mkdir(path.join(mountA, "docs"));
                await writeFile(
                    path.join(mountA, "docs", "draft.txt"),
                    "rename me"
                );

                await waitUntil(async () => {
                    expect(
                        await readFile(
                            path.join(mountB, "docs", "draft.txt"),
                            "utf8"
                        )
                    ).toBe("rename me");
                });

                await rename(
                    path.join(mountA, "docs", "draft.txt"),
                    path.join(mountA, "docs", "final.txt")
                );

                await waitUntil(async () => {
                    await expect(
                        readFile(path.join(mountB, "docs", "draft.txt"))
                    ).rejects.toMatchObject({ code: "ENOENT" });
                    expect(
                        await readFile(
                            path.join(mountB, "docs", "final.txt"),
                            "utf8"
                        )
                    ).toBe("rename me");
                });

                await rm(path.join(mountB, "docs", "final.txt"));

                await waitUntil(async () => {
                    await expect(
                        readFile(path.join(mountA, "docs", "final.txt"))
                    ).rejects.toMatchObject({ code: "ENOENT" });
                    expect(
                        await fsA.readFile("/docs/final.txt")
                    ).toBeUndefined();
                    expect(
                        await fsB.readFile("/docs/final.txt")
                    ).toBeUndefined();
                });
            } catch (error) {
                expectNativeMountAvailable(error);
            }
        });
    }
);
