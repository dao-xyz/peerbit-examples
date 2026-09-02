import {
    access,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const exists = async (path: string) => {
    try {
        await access(path);
        return true;
    } catch (error) {
        if ((error as { code?: string })?.code === "ENOENT") return false;
        throw error;
    }
};

const tokens = (...values: string[]) => {
    const remaining = [...values];
    return () => {
        const token = remaining.shift();
        if (!token) throw new Error("segment-ledger test token exhausted");
        return token;
    };
};

const ownerAt = async (lockPath: string) =>
    JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        token: string;
        pid: number;
        createdAtMs: number;
    };

const emptyLedger = (cid: string) => ({
    v: 1,
    generation: 0,
    current: null,
    retired: [
        {
            cids: [{ cid, bytes: cid.length }],
            retiredAtMs: 1,
            snapshotSeq: cid,
        },
    ],
});

describe("snapshot segment ledger locking", () => {
    const temporaryDirectories = new Set<string>();

    const temporaryLedger = async () => {
        const root = await mkdtemp(join(tmpdir(), "sfs-segment-ledger-lock-"));
        temporaryDirectories.add(root);
        return {
            root,
            ledgerPath: join(root, "ledger.json"),
            lockPath: join(root, "ledger.json.lock"),
        };
    };

    const program = (runtime: Record<string, unknown> = {}) => {
        const value: any = new SharedFileSystem();
        value.setSegmentLedgerRuntimeForTest(runtime);
        return value;
    };

    afterEach(async () => {
        await Promise.all(
            [...temporaryDirectories].map(async (directory) => {
                await rm(directory, {
                    recursive: true,
                    force: true,
                    maxRetries: 5,
                    retryDelay: 100,
                });
                temporaryDirectories.delete(directory);
            })
        );
    });

    it("gives an admitted aborted writer one free claim but aborts a contended claim without touching its owner", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const first = program({
            pid: () => 101,
            nextToken: tokens("owner-a"),
        });
        const releaseFirst = await first.acquireSegmentLedgerLock(ledgerPath);

        const reason = new Error("lifecycle closed");
        const contendedAbort = new AbortController();
        contendedAbort.abort(reason);
        const contender = program({
            pid: () => 202,
            nextToken: tokens("contender-b"),
        });
        await expect(
            contender.acquireSegmentLedgerLock(
                ledgerPath,
                contendedAbort.signal
            )
        ).rejects.toBe(reason);
        expect((await ownerAt(lockPath)).token).toBe("owner-a");
        expect(
            (await readdir(root)).filter((name) => name.includes(".candidate-"))
        ).toEqual([]);
        await releaseFirst();

        const freeAbort = new AbortController();
        freeAbort.abort(reason);
        const free = program({
            pid: () => 303,
            nextToken: tokens("free-c"),
        });
        const releaseFree = await free.acquireSegmentLedgerLock(
            ledgerPath,
            freeAbort.signal
        );
        expect((await ownerAt(lockPath)).token).toBe("free-c");
        await releaseFree();
        expect(await exists(lockPath)).toBe(false);
    });

    it("aborts promptly while waiting on a live owner and removes only its candidate", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const owner = program({
            pid: () => 101,
            nextToken: tokens("waiting-owner"),
        });
        const releaseOwner = await owner.acquireSegmentLedgerLock(ledgerPath);
        const waiting = deferred();
        const controller = new AbortController();
        const reason = new Error("close while contended");
        let observedSignal: AbortSignal | undefined;
        const contender = program({
            pid: () => 202,
            nextToken: tokens("waiting-contender"),
            waitForRetry: async (_delayMs: number, signal?: AbortSignal) => {
                observedSignal = signal;
                waiting.resolve();
                await new Promise<void>((_resolve, reject) => {
                    const onAbort = () => reject(signal?.reason);
                    signal?.addEventListener("abort", onAbort, { once: true });
                    if (signal?.aborted) onAbort();
                });
            },
        });
        const outcome = contender.acquireSegmentLedgerLock(
            ledgerPath,
            controller.signal
        );
        try {
            await waiting.promise;
            expect(observedSignal).toBe(controller.signal);
            controller.abort(reason);
            await expect(outcome).rejects.toBe(reason);
            expect((await ownerAt(lockPath)).token).toBe("waiting-owner");
            expect(
                (await readdir(root)).filter((name) =>
                    name.includes(".candidate-")
                )
            ).toEqual([]);
        } finally {
            controller.abort(reason);
            await Promise.allSettled([outcome]);
            await releaseOwner();
        }
    });

    it("detaches before cleanup so an old releaser cannot delete its successor", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const detached = deferred();
        const allowCleanup = deferred();
        const first = program({
            pid: () => 101,
            nextToken: tokens("owner-a"),
            onStage: async (stage: string) => {
                if (stage === "lock-release-detached") {
                    detached.resolve();
                    await allowCleanup.promise;
                }
            },
        });
        const second = program({
            pid: () => 202,
            nextToken: tokens("owner-b"),
        });
        const releaseFirst = await first.acquireSegmentLedgerLock(ledgerPath);
        const releasingFirst = releaseFirst();
        try {
            await detached.promise;
            expect(await exists(lockPath)).toBe(false);
            expect(
                (await readdir(root)).some((name) =>
                    name.includes(".release-owner-a")
                )
            ).toBe(true);

            const releaseSecond =
                await second.acquireSegmentLedgerLock(ledgerPath);
            expect((await ownerAt(lockPath)).token).toBe("owner-b");
            allowCleanup.resolve();
            await releasingFirst;
            expect((await ownerAt(lockPath)).token).toBe("owner-b");
            await releaseSecond();
        } finally {
            allowCleanup.resolve();
            await Promise.allSettled([releasingFirst]);
        }
        expect(await exists(lockPath)).toBe(false);
        expect(
            (await readdir(root)).filter((name) => name.includes(".release-"))
        ).toEqual([]);
    });

    it("never steals an old-looking live owner and uses a monotonic timeout across wall-clock rollback", async () => {
        const { ledgerPath, lockPath } = await temporaryLedger();
        const owner = program({
            wallClockMs: () => 0,
            pid: () => 101,
            nextToken: tokens("live-owner"),
        });
        await owner.acquireSegmentLedgerLock(ledgerPath);

        const ownerStat = await stat(join(lockPath, "owner.json"));
        let wallNow = ownerStat.mtimeMs + 30_000;
        let monotonicNow = 0;
        let livenessChecks = 0;
        const contender = program({
            wallClockMs: () => wallNow,
            monotonicMs: () => monotonicNow,
            pid: () => 202,
            isProcessAlive: () => {
                livenessChecks++;
                return true;
            },
            waitForRetry: async () => {
                wallNow -= 60_000;
                monotonicNow += 5_000;
            },
            nextToken: tokens("live-contender"),
        });
        await expect(
            contender.acquireSegmentLedgerLock(ledgerPath)
        ).rejects.toMatchObject({ code: "EIO" });
        expect(livenessChecks).toBeGreaterThan(0);
        expect((await ownerAt(lockPath)).token).toBe("live-owner");
    });

    it("recovers a dead owner at the stale threshold and retains its tombstone", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const crashed = program({
            wallClockMs: () => 0,
            pid: () => 101,
            nextToken: tokens("dead-owner"),
        });
        await crashed.acquireSegmentLedgerLock(ledgerPath);
        const ownerStat = await stat(join(lockPath, "owner.json"));
        const now = Math.max(0, ownerStat.mtimeMs) + 30_000;
        const recovered = program({
            wallClockMs: () => now,
            pid: () => 202,
            isProcessAlive: () => false,
            nextToken: tokens("recovered-owner"),
        });
        const releaseRecovered =
            await recovered.acquireSegmentLedgerLock(ledgerPath);
        expect((await ownerAt(lockPath)).token).toBe("recovered-owner");
        expect(
            (await readdir(root)).some((name) =>
                name.endsWith(".stale-dead-owner")
            )
        ).toBe(true);
        await releaseRecovered();
    });

    it("prevents a delayed stale cleaner from detaching a fresh successor", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const crashed = program({
            wallClockMs: () => 0,
            pid: () => 101,
            nextToken: tokens("dead-owner"),
        });
        await crashed.acquireSegmentLedgerLock(ledgerPath);
        const ownerStat = await stat(join(lockPath, "owner.json"));
        const now = ownerStat.mtimeMs + 30_000;

        const firstEligible = deferred();
        const allowFirstCleaner = deferred();
        const firstAbort = new AbortController();
        const firstCleaner = program({
            wallClockMs: () => now,
            pid: () => 202,
            isProcessAlive: () => false,
            nextToken: tokens("cleaner-a"),
            onStage: async (stage: string) => {
                if (stage === "lock-stale-owner-eligible") {
                    firstEligible.resolve();
                    await allowFirstCleaner.promise;
                }
            },
        });
        const firstOutcome = firstCleaner
            .acquireSegmentLedgerLock(ledgerPath, firstAbort.signal)
            .then(
                () => undefined,
                (error: unknown) => error
            );
        try {
            await firstEligible.promise;
            const successor = program({
                wallClockMs: () => now,
                pid: () => 303,
                isProcessAlive: () => false,
                nextToken: tokens("successor"),
            });
            const releaseSuccessor =
                await successor.acquireSegmentLedgerLock(ledgerPath);
            expect((await ownerAt(lockPath)).token).toBe("successor");

            const reason = new Error("stop delayed cleaner");
            firstAbort.abort(reason);
            allowFirstCleaner.resolve();
            expect(await firstOutcome).toBe(reason);
            expect((await ownerAt(lockPath)).token).toBe("successor");
            expect(
                (await readdir(root)).some((name) =>
                    name.endsWith(".stale-dead-owner")
                )
            ).toBe(true);
            await releaseSuccessor();
        } finally {
            firstAbort.abort();
            allowFirstCleaner.resolve();
            await Promise.allSettled([firstOutcome]);
        }
    });

    it("serializes stale-generation CAS writers and preserves their cid union", async () => {
        const { ledgerPath } = await temporaryLedger();
        const firstRead = deferred();
        const allowFirstWrite = deferred();
        const secondContended = deferred();
        const allowSecondRetry = deferred();
        const first = program({
            nextToken: tokens("first-lock", "first-temp"),
            onStage: async (stage: string) => {
                if (stage === "ledger-read") {
                    firstRead.resolve();
                    await allowFirstWrite.promise;
                }
            },
        });
        const second = program({
            nextToken: tokens("second-lock", "second-temp"),
            waitForRetry: async () => {
                secondContended.resolve();
                await allowSecondRetry.promise;
            },
        });
        first.segmentLedgerPath = async () => ledgerPath;
        second.segmentLedgerPath = async () => ledgerPath;

        const firstSave = first.saveSegmentLedgerCas(
            0,
            emptyLedger("cid-first")
        );
        let secondSave: Promise<boolean> | undefined;
        try {
            await firstRead.promise;
            secondSave = second.saveSegmentLedgerCas(
                0,
                emptyLedger("cid-second")
            );
            await secondContended.promise;
            allowFirstWrite.resolve();
            await expect(firstSave).resolves.toBe(true);
            allowSecondRetry.resolve();
            await expect(secondSave).resolves.toBe(true);
        } finally {
            allowFirstWrite.resolve();
            allowSecondRetry.resolve();
            await Promise.allSettled(
                [firstSave, secondSave].filter(
                    (task): task is Promise<boolean> => task !== undefined
                )
            );
        }

        const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
        expect(ledger.generation).toBe(2);
        expect(
            ledger.retired
                .flatMap((generation: any) => generation.cids)
                .map((entry: any) => entry.cid)
                .sort()
        ).toEqual(["cid-first", "cid-second"]);
    });

    it("preserves the old ledger before rename and exposes only complete JSON after rename", async () => {
        const { root, ledgerPath } = await temporaryLedger();
        const oldContents = JSON.stringify({ generation: 7, old: true });
        const nextContents = JSON.stringify({
            generation: 8,
            cids: ["one", "two"],
        });
        await writeFile(ledgerPath, oldContents, "utf8");

        const beforeRename = program({
            nextToken: tokens("before-rename"),
            onStage: (stage: string) => {
                if (stage === "ledger-temp-durable") {
                    throw new Error("before rename");
                }
            },
        });
        await expect(
            beforeRename.replaceSegmentLedger(ledgerPath, nextContents)
        ).rejects.toThrow("before rename");
        expect(await readFile(ledgerPath, "utf8")).toBe(oldContents);
        expect(
            (await readdir(root)).filter((name) => name.includes(".tmp-"))
        ).toEqual([]);

        let observedAfterRename: unknown;
        const afterRename = program({
            nextToken: tokens("after-rename"),
            onStage: async (stage: string) => {
                if (stage === "ledger-replaced") {
                    observedAfterRename = JSON.parse(
                        await readFile(ledgerPath, "utf8")
                    );
                    throw new Error("after rename");
                }
            },
        });
        await expect(
            afterRename.replaceSegmentLedger(ledgerPath, nextContents)
        ).rejects.toThrow("after rename");
        expect(observedAfterRename).toEqual(JSON.parse(nextContents));
        expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toEqual(
            JSON.parse(nextContents)
        );
    });

    it("fails closed when ownership changes before or after detachment", async () => {
        const { root, ledgerPath, lockPath } = await temporaryLedger();
        const before = program({
            nextToken: tokens("before-owner-change"),
        });
        const releaseBefore = await before.acquireSegmentLedgerLock(ledgerPath);
        await writeFile(
            join(lockPath, "owner.json"),
            JSON.stringify({
                token: "intruder",
                pid: 999,
                createdAtMs: Date.now(),
            })
        );
        await expect(releaseBefore()).rejects.toMatchObject({ code: "EIO" });
        expect((await ownerAt(lockPath)).token).toBe("intruder");
        await rm(lockPath, { recursive: true, force: true });

        const missing = program({
            nextToken: tokens("missing-owner"),
        });
        const releaseMissing =
            await missing.acquireSegmentLedgerLock(ledgerPath);
        await rm(join(lockPath, "owner.json"));
        await expect(releaseMissing()).rejects.toMatchObject({ code: "EIO" });
        expect(await exists(lockPath)).toBe(true);
        await rm(lockPath, { recursive: true, force: true });

        const after = program({
            nextToken: tokens("after-owner-change"),
            onStage: async (stage: string, context: any) => {
                if (stage === "lock-release-detached") {
                    await writeFile(
                        join(context.artifactPath, "owner.json"),
                        JSON.stringify({
                            token: "intruder",
                            pid: 999,
                            createdAtMs: Date.now(),
                        })
                    );
                }
            },
        });
        const releaseAfter = await after.acquireSegmentLedgerLock(ledgerPath);
        await expect(releaseAfter()).rejects.toMatchObject({ code: "EIO" });
        expect(await exists(lockPath)).toBe(false);
        expect(
            (await readdir(root)).some((name) =>
                name.includes(".release-after-owner-change")
            )
        ).toBe(true);
    });

    it("leaves missing and malformed ownership untouched", async () => {
        const malformedOwners = [undefined, "not-json", JSON.stringify({})];
        for (const [index, contents] of malformedOwners.entries()) {
            const { ledgerPath, lockPath } = await temporaryLedger();
            await mkdir(lockPath);
            if (contents !== undefined) {
                await writeFile(join(lockPath, "owner.json"), contents);
            }
            const wallNow = 100_000;
            let monotonicNow = 0;
            const contender = program({
                wallClockMs: () => wallNow,
                monotonicMs: () => monotonicNow,
                nextToken: tokens(`malformed-contender-${index}`),
                waitForRetry: async () => {
                    monotonicNow += 5_000;
                },
            });
            await expect(
                contender.acquireSegmentLedgerLock(ledgerPath)
            ).rejects.toMatchObject({ code: "EIO" });
            expect(await exists(lockPath)).toBe(true);
            if (contents !== undefined) {
                expect(
                    await readFile(join(lockPath, "owner.json"), "utf8")
                ).toBe(contents);
            }
        }
    });
});
