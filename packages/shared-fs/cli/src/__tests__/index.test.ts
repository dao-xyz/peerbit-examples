import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    FileVersion,
    Peerbit,
    PrepareForDisposalError,
    SharedFileSystem,
    SharedFsError,
    SharedFsHandle,
    SharedFsWritePendingError,
    SharedFsWriteReadyTimeoutError,
    describeReadiness,
    encodePublicSignKey,
    openSharedFs,
    type BootstrapStatus,
    type ReadinessStatus,
} from "@peerbit/shared-fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    assumeCompleteHint,
    conflictScanIsPartial,
    connectMountToNetwork,
    createReadinessProgress,
    normalizeNativeMountpoint,
    openMountProfileFiles,
    readinessProgressLine,
    resolveMountProfileDirectory,
    runCli,
    stopMountSession,
    writeReadyTimeoutMessage,
} from "../index.js";

const stopPeer = async (peer: Peerbit) => {
    await peer.stop();
    await peer.services.blocks.stop();
};

const decode = (bytes: Uint8Array | undefined) =>
    bytes ? new TextDecoder().decode(bytes) : undefined;

const seedConflicts = async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "peerbit-shared-fs-cli-conflicts-")
    );
    const peer = await Peerbit.create({ directory });
    let seeded = false;
    try {
        const shared = await openSharedFs({
            peerbit: peer,
            machineLabel: "cli-conflict-seed",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        await shared.writeFile("/content.txt", "base");
        const baseVersionIds = (await shared.versions("/content.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        const selected = await shared.writeFile("/content.txt", "left", {
            baseVersionIds,
        });
        // A third head with selected's bytes: conflicts() lists only one.
        const twin = await shared.writeFile("/content.txt", "left", {
            baseVersionIds,
            mtime: 7,
        });
        const other = await shared.writeFile("/content.txt", "right", {
            baseVersionIds,
        });

        await shared.writeFile("/duplicate.txt", "first life");
        const first = await shared.stat("/duplicate.txt");
        await shared.rm("/duplicate.txt");
        await shared.writeFile("/duplicate.txt", "second life");
        await shared.resolveNamingConflict(first!.nodeId, {
            type: "restore",
        });
        const duplicate = (await shared.namingConflicts()).find(
            (conflict) => conflict.type === "duplicate-name"
        );
        if (!duplicate?.shadowedNodeIds?.[0]) {
            throw new Error("failed to seed duplicate-name conflict");
        }

        await shared.writeFile("/delete-race.txt", "recoverable delete");
        const deletedEntry = (await shared.stat("/delete-race.txt"))!;
        const [deletedBaseInfo] = await shared.versions("/delete-race.txt");
        const deletedBase = (await shared.program.entries.index.get(
            deletedBaseInfo.id,
            { local: true, remote: false, resolve: true }
        )) as unknown as FileVersion;
        await shared.rm("/delete-race.txt");
        const concurrentDeleteVersion = new FileVersion({
            id: "version:cli-delete-vs-edit",
            nodeId: deletedEntry.nodeId,
            parentVersionIds: [deletedBase.id],
            causalDepth: deletedBase.causalDepth + 1n,
            contentHash: deletedBase.contentHash,
            size: deletedBase.size,
            mode: deletedBase.mode,
            mtime: deletedBase.mtime,
            chunkIds: deletedBase.chunkIds,
            createdAt: deletedBase.createdAt + 1n,
            authorKey: deletedBase.authorKey,
            machineLabel: deletedBase.machineLabel,
        });
        await shared.program.entries.put(concurrentDeleteVersion, {
            unique: true,
        });
        const deleteConflict = (await shared.namingConflicts()).find(
            (conflict) =>
                conflict.type === "delete-vs-edit" &&
                conflict.nodeId === deletedEntry.nodeId
        );
        if (!deleteConflict) {
            throw new Error("failed to seed delete-vs-edit conflict");
        }

        seeded = true;
        return {
            directory,
            address: shared.address,
            selectedVersionId: selected.id,
            twinVersionId: twin.id,
            otherVersionId: other.id,
            duplicate,
            shadowedNodeId: duplicate.shadowedNodeIds[0],
            deleteConflict,
            concurrentDeleteVersionId: concurrentDeleteVersion.id,
        };
    } finally {
        await stopPeer(peer);
        if (!seeded) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
};

const seedDirectoryConflict = async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "peerbit-shared-fs-cli-directory-merge-")
    );
    const peer = await Peerbit.create({ directory });
    let seeded = false;
    try {
        const shared = await openSharedFs({
            peerbit: peer,
            machineLabel: "cli-directory-merge-seed",
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });

        await shared.mkdir("/shared");
        const target = (await shared.stat("/shared"))!;
        await shared.writeFile("/shared/from-target.txt", "target");
        await shared.rename("/shared", "/held");
        await shared.mkdir("/shared");
        const source = (await shared.stat("/shared"))!;
        await shared.writeFile("/shared/from-source.txt", "source");
        const sourceFile = (await shared.stat("/shared/from-source.txt"))!;
        await shared.resolveNamingConflict(target.nodeId, {
            type: "move",
            to: "/shared",
        });
        const duplicate = (await shared.namingConflicts()).find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );
        if (!duplicate) {
            throw new Error("failed to seed directory duplicate conflict");
        }

        seeded = true;
        return {
            directory,
            address: shared.address,
            sourceNodeId: source.nodeId,
            targetNodeId: target.nodeId,
            sourceFileNodeId: sourceFile.nodeId,
        };
    } finally {
        await stopPeer(peer);
        if (!seeded) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
};

const mockCliBootstrap = () => {
    const createPeerbit = Peerbit.create.bind(Peerbit);
    return vi.spyOn(Peerbit, "create").mockImplementation(async (options) => {
        const peer = await createPeerbit(options);
        vi.spyOn(peer, "bootstrap").mockResolvedValue({
            connectedPeerIds: [],
            failures: [],
        });
        return peer;
    });
};

/** A bootstrapStatus().readiness snapshot, as an ETIMEDOUT carries it. */
const readinessSnapshot = (
    status: Partial<ReadinessStatus> & Pick<ReadinessStatus, "state">
): ReadinessStatus => ({
    satisfied: false,
    required: [],
    contained: [],
    excluded: [],
    silent: [],
    inFlight: [],
    busy: [],
    fetchPending: [],
    gaps: [],
    unconfirmed: [],
    ...status,
});

/**
 * waiting-silent names the first silent required peer; another required
 * peer can still be asked, reconciled or busy, and may yet answer.
 */
const silentBesideAnswering = () => [
    readinessSnapshot({
        state: "waiting-silent",
        required: ["peer-a", "peer-b"],
        silent: [{ peer: "peer-a", reachable: true }],
        inFlight: [{ peer: "peer-b", state: "reconciling", scopes: {} }],
    }),
    readinessSnapshot({
        state: "waiting-silent",
        required: ["peer-a", "peer-b"],
        silent: [{ peer: "peer-a", reachable: true, refused: "UNSUPPORTED" }],
        inFlight: [{ peer: "peer-b", state: "asking", scopes: {} }],
    }),
    readinessSnapshot({
        state: "waiting-silent",
        required: ["peer-a", "peer-b"],
        silent: [{ peer: "peer-a", reachable: true, parked: true }],
        busy: ["peer-b"],
    }),
];

/** waiting-silent with every required peer silent, refused or parked. */
const everyRequiredPeerSilent = () =>
    readinessSnapshot({
        state: "waiting-silent",
        required: ["peer-a", "peer-b", "peer-c"],
        silent: [
            { peer: "peer-a", reachable: true },
            { peer: "peer-b", reachable: true, refused: "UNSUPPORTED" },
            { peer: "peer-c", reachable: true, parked: true },
        ],
    });

const WRITE_READY_TIMEOUT_PREFIX =
    "timed out awaiting shared filesystem write readiness: ";

const ASSUME_COMPLETE_HINT =
    " If no write-ready replica will answer and you vouch that this replica's view is complete, rerun with --assume-complete.";

/**
 * How an unsettled snapshot bootstrap phase settles, as the CLI words it:
 * only inside one long run, so a retry or a short status run does not help.
 * An unverified posture is settled: the join's proof or assumeComplete()
 * ends it.
 */
const OVERLAY_SETTLES =
    "a snapshot overlay retires within 15 minutes within one run";
const FETCHING_SETTLES =
    "a snapshot fetch that succeeds installs an overlay, which retires within 15 minutes within one run";

/** The hint while the phase has not settled: assumeComplete() refuses. */
const unsettledHint = (phase: string, settles: string, timeoutMs: number) =>
    ` If no write-ready replica will answer and you vouch that this replica's view is complete, rerun with --assume-complete and --write-ready-timeout-ms ${timeoutMs} or more: it is refused until the snapshot bootstrap settles (phase: ${phase}), and ${settles}.`;

/** Why --assume-complete did not act while the phase has not settled. */
const unsettledNotApplied = (
    phase: string,
    settles: string,
    timeoutMs: number
) =>
    ` --assume-complete was not applied: the snapshot bootstrap has not settled (phase: ${phase}), and assumeComplete() is refused until it does. ${settles[0].toUpperCase()}${settles.slice(1)}, so rerun with --write-ready-timeout-ms ${timeoutMs} or more to keep the command open that long.`;

/**
 * Why --assume-complete did not act on a waiting-silent timeout in which one
 * of two required peers is silent and the other can still answer.
 */
const STILL_ANSWERING_BESIDE_SILENT =
    " --assume-complete was not applied: a required peer is still answering (waiting-silent, with 1 of 2 required peers in flight or busy), so this replica may yet reconcile with it; it applies only once none can (no-peer, no-qualified-donor, or waiting-silent with every required peer silent).";

/** The warning --assume-complete prints once the view was assumed. */
const ASSUMED_WARNING =
    "--assume-complete: assuming this replica's view is complete.";

const SILENT_PEER_ADVICE =
    "A required peer that does not answer blocks while it is reachable, and another replicator does not change that: restart the silent peer or stop it, and retry.";

/** The ETIMEDOUT of a join waiting for one reachable, silent peer. */
const silentPeerTimeout = () =>
    new SharedFsWriteReadyTimeoutError(
        readinessSnapshot({
            state: "waiting-silent",
            required: ["peer-a"],
            silent: [{ peer: "peer-a", reachable: true }],
        })
    );

/**
 * A creator's closed state directory (open mode, so any CLI identity may
 * write): a CLI open of its address from there is warm, writable at once.
 * It holds a file: a reopen of an empty store starts a snapshot bootstrap,
 * and a CLI run that stops before it decides leaves the marker that gates
 * the next open.
 */
const seedCreatorDirectory = async (
    label: string,
    files: Record<string, string> = { "/seeded.txt": "seeded" }
) => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `peerbit-shared-fs-cli-${label}-`)
    );
    const peer = await Peerbit.create({ directory });
    let seeded = false;
    try {
        const shared = await openSharedFs({
            peerbit: peer,
            machineLabel: `cli-${label}-seed`,
            replicate: { factor: 1 },
            bootstrap: false,
            gc: false,
        });
        for (const [file, content] of Object.entries(files)) {
            await shared.writeFile(file, content);
        }
        seeded = true;
        return { directory, address: shared.address };
    } finally {
        await stopPeer(peer);
        if (!seeded) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
};

/**
 * Runs `run` with process.stderr.write captured (the progress line and the
 * --assume-complete warning go there; console output does not) and stderr
 * not a terminal, so progress comes as one line per readiness state, or
 * with `terminal` a terminal that wide, so the line is rewritten in place;
 * and settles with its outcome.
 */
const captureStderr = async (
    run: () => Promise<unknown>,
    terminal?: { columns: number }
) => {
    const chunks: string[] = [];
    const saved = (["isTTY", "columns"] as const).map(
        (key) =>
            [key, Object.getOwnPropertyDescriptor(process.stderr, key)] as const
    );
    Object.defineProperty(process.stderr, "isTTY", {
        value: terminal !== undefined,
        configurable: true,
    });
    if (terminal) {
        Object.defineProperty(process.stderr, "columns", {
            value: terminal.columns,
            configurable: true,
        });
    }
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((
        chunk: unknown
    ) => {
        chunks.push(String(chunk));
        return true;
    }) as never);
    try {
        const error = await run().then(
            () => undefined,
            (error: any) => error
        );
        return {
            error,
            chunks,
            /** The progress lines written. */
            progress: chunks.filter((chunk) =>
                chunk.startsWith("write readiness: ")
            ),
        };
    } finally {
        write.mockRestore();
        for (const [key, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(process.stderr, key, descriptor);
            } else {
                delete (
                    process.stderr as { isTTY?: boolean; columns?: number }
                )[key];
            }
        }
    }
};

/**
 * Makes every SharedFsHandle's awaitWriteReady reject with `timeout` and its
 * assumeComplete settle with `assume`; bootstrapStatus() reports `before`
 * over the real status, and `after` over that once assumeComplete was
 * called.
 */
const mockTimedOutReadiness = (
    timeout: Error,
    assume: () => Promise<void>,
    after: Partial<BootstrapStatus> = {},
    before: Partial<BootstrapStatus> = {}
) => {
    const realStatus = SharedFsHandle.prototype.bootstrapStatus;
    let assumed = false;
    const wait = vi
        .spyOn(SharedFsHandle.prototype, "awaitWriteReady")
        .mockRejectedValue(timeout);
    const assumeComplete = vi
        .spyOn(SharedFsHandle.prototype, "assumeComplete")
        .mockImplementation(() => {
            assumed = true;
            return assume();
        });
    const status = vi
        .spyOn(SharedFsHandle.prototype, "bootstrapStatus")
        .mockImplementation(function (this: SharedFsHandle) {
            const real = { ...realStatus.call(this), ...before };
            return assumed ? { ...real, ...after } : real;
        });
    return {
        wait,
        assumeComplete,
        restore: () => {
            wait.mockRestore();
            assumeComplete.mockRestore();
            status.mockRestore();
        },
    };
};

/**
 * runCli rejected by the parser (yargs strict mode): it reports the error
 * on console.error and exits, so process.exit throws here instead. No
 * command handler runs.
 */
const parseFailure = async (args: string[]) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(((
        code?: number
    ) => {
        throw new Error(`process.exit(${code})`);
    }) as never);
    try {
        const outcome = await runCli(args).then(
            () => undefined,
            (rejection: unknown) => rejection
        );
        return {
            outcome,
            output: error.mock.calls.flat().map(String).join("\n"),
        };
    } finally {
        exit.mockRestore();
        error.mockRestore();
    }
};

describe("mount network connection", () => {
    const fakePeer = (bootstrap: () => Promise<unknown>) => ({
        bootstrap: vi.fn(bootstrap),
        dial: vi.fn(async () => true),
        enableBootstrapRecovery: vi.fn(),
    });

    it("mounts from local state when bootstrap nodes are unreachable", async () => {
        const peer = fakePeer(async () => {
            throw new Error("Failed to succefully dial any bootstrap node");
        });
        const warn = vi.fn();
        await connectMountToNetwork(peer as never, undefined, warn);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(
            "Failed to succefully dial any bootstrap node"
        );
        expect(peer.enableBootstrapRecovery).toHaveBeenCalledTimes(1);
    });

    it("keeps reconnecting after a successful bootstrap", async () => {
        const peer = fakePeer(async () => ({
            connectedPeerIds: [],
            failures: [],
        }));
        const warn = vi.fn();
        await connectMountToNetwork(peer as never, undefined, warn);
        expect(warn).not.toHaveBeenCalled();
        expect(peer.enableBootstrapRecovery).toHaveBeenCalledTimes(1);
    });

    it("dials explicit peers without the public bootstrap network", async () => {
        const peer = fakePeer(async () => {
            throw new Error("unexpected bootstrap");
        });
        const address =
            "/ip4/127.0.0.1/tcp/8002/p2p/12D3KooWKj1J1hHxrYyB37qDDGCi9aU2vcHzDZhtMk7te7dEmqqT";
        await connectMountToNetwork(peer as never, [address], vi.fn());
        expect(peer.dial).toHaveBeenCalledWith(address);
        expect(peer.bootstrap).not.toHaveBeenCalled();
        expect(peer.enableBootstrapRecovery).not.toHaveBeenCalled();
    });
});

describe("write readiness progress line", () => {
    const contained = (peer: string, qualified = true) => ({
        peer,
        qualified,
        source: qualified ? ("creator" as const) : ("none" as const),
        scopes: ["namespace-v1" as const],
        departed: false,
    });
    const reconciling = (inFlight: string[], containedPeers: string[] = []) =>
        readinessSnapshot({
            state: "reconciling",
            required: [...inFlight, ...containedPeers],
            inFlight: inFlight.map((peer) => ({
                peer,
                state: "reconciling" as const,
                scopes: {},
            })),
            contained: containedPeers.map((peer) => contained(peer)),
        });
    const silent = readinessSnapshot({
        state: "waiting-silent",
        required: ["peer-a", "peer-b"],
        silent: [{ peer: "peer-a", reachable: true }],
        contained: [contained("peer-b")],
    });
    const stream = (tty?: { columns?: number }) => {
        const chunks: string[] = [];
        return {
            chunks,
            stream: {
                write: (chunk: string) => chunks.push(chunk),
                ...(tty ? { isTTY: true, columns: tty.columns } : {}),
            },
        };
    };

    it("is the library's reason plus the contained peers it does not count itself", () => {
        expect(readinessProgressLine(silent, describeReadiness)).toBe(
            "write readiness: waiting-silent: 1 of 2 required peers reachable and silent: peer-a (1 contained)"
        );
        expect(
            readinessProgressLine(reconciling(["peer-a"]), describeReadiness)
        ).toBe(
            "write readiness: reconciling: 1 of 1 required peer in flight: peer-a"
        );
        // no-qualified-donor already counts and names its contained peers.
        const noDonor = readinessSnapshot({
            state: "no-qualified-donor",
            contained: [contained("peer-a", false)],
        });
        expect(readinessProgressLine(noDonor, describeReadiness)).toBe(
            `write readiness: ${describeReadiness(noDonor)}`
        );
        expect(
            readinessProgressLine(
                readinessSnapshot({
                    state: "ready",
                    satisfied: true,
                    contained: [contained("peer-a")],
                }),
                describeReadiness
            )
        ).toBe("write readiness: ready");
    });

    it("rewrites one terminal line, cut to its width, and clears it at the end", () => {
        const { chunks, stream: tty } = stream({ columns: 40 });
        const progress = createReadinessProgress(tty, describeReadiness);
        progress.update(reconciling(["peer-a"]));
        // The same text is not written again.
        progress.update(reconciling(["peer-a"]));
        progress.update(silent);
        const first = "write readiness: reconciling: 1 of 1 r…";
        const second = "write readiness: waiting-silent: 1 of …";
        expect(first).toHaveLength(39);
        expect(second).toHaveLength(39);
        expect(chunks).toEqual([`\r\x1b[2K${first}`, `\r\x1b[2K${second}`]);
        progress.end();
        progress.end();
        progress.update(reconciling(["peer-b"]));
        expect(chunks).toEqual([
            `\r\x1b[2K${first}`,
            `\r\x1b[2K${second}`,
            "\r\x1b[2K",
        ]);

        // A line that fits is written whole; without updates end() writes
        // nothing.
        const wide = stream({ columns: 200 });
        const fits = createReadinessProgress(wide.stream, describeReadiness);
        fits.update(silent);
        expect(wide.chunks).toEqual([
            `\r\x1b[2K${readinessProgressLine(silent, describeReadiness)}`,
        ]);
        const idle = stream({ columns: 40 });
        createReadinessProgress(idle.stream, describeReadiness).end();
        expect(idle.chunks).toEqual([]);
    });

    it("prints one line per readiness state when stderr is not a terminal", () => {
        const { chunks, stream: pipe } = stream();
        const progress = createReadinessProgress(pipe, describeReadiness);
        progress.update(reconciling(["peer-a"]));
        // Another peer in the same state is not a new line.
        progress.update(reconciling(["peer-a", "peer-b"], ["peer-c"]));
        progress.update(silent);
        progress.update(reconciling(["peer-a"]));
        progress.end();
        progress.update(silent);
        expect(chunks).toEqual([
            "write readiness: reconciling: 1 of 1 required peer in flight: peer-a\n",
            `${readinessProgressLine(silent, describeReadiness)}\n`,
            "write readiness: reconciling: 1 of 1 required peer in flight: peer-a\n",
        ]);
    });

    it("names --assume-complete only where no answer is coming", () => {
        // assumeComplete() acts in these phases; in `unverified` it ends
        // the posture, as the join's proof does.
        for (const phase of ["off", "converged", "unverified"] as const) {
            for (const readiness of [
                readinessSnapshot({ state: "no-peer" }),
                readinessSnapshot({ state: "no-qualified-donor" }),
                readinessSnapshot({ state: "waiting-silent" }),
                everyRequiredPeerSilent(),
            ]) {
                expect(assumeCompleteHint(readiness, phase)).toBe(
                    ASSUME_COMPLETE_HINT
                );
            }
        }
        for (const phase of [
            "off",
            "converged",
            "fetching",
            "unverified",
            "overlay-active",
        ] as const) {
            for (const state of [
                "reconciling",
                "waiting-fetch",
                "waiting-left",
                "waiting-trust",
                "waiting-phase",
                "ready",
            ] as const) {
                expect(
                    assumeCompleteHint(readinessSnapshot({ state }), phase)
                ).toBe("");
            }
            // waiting-silent while another required peer can still answer.
            // The library lists each required peer in one of silent,
            // inFlight and busy; the hint does not rely on that: a required
            // peer not listed as silent, or a peer in flight or busy not
            // listed as required, can still answer too.
            for (const readiness of [
                ...silentBesideAnswering(),
                readinessSnapshot({
                    state: "waiting-silent",
                    required: ["peer-a", "peer-b"],
                    silent: [{ peer: "peer-a", reachable: true }],
                }),
                readinessSnapshot({
                    state: "waiting-silent",
                    required: ["peer-a"],
                    silent: [{ peer: "peer-a", reachable: true }],
                    inFlight: [{ peer: "peer-b", state: "asking", scopes: {} }],
                }),
                readinessSnapshot({
                    state: "waiting-silent",
                    required: ["peer-a"],
                    silent: [{ peer: "peer-a", reachable: true }],
                    busy: ["peer-b"],
                }),
            ]) {
                expect(
                    assumeCompleteHint(readiness, phase),
                    describeReadiness(readiness)
                ).toBe("");
            }
            expect(assumeCompleteHint(undefined, phase)).toBe("");
        }
    });

    it("qualifies the --assume-complete hint while the snapshot bootstrap has not settled: it settles only inside one long run", () => {
        for (const readiness of [
            readinessSnapshot({ state: "no-peer" }),
            readinessSnapshot({ state: "no-qualified-donor" }),
            readinessSnapshot({ state: "waiting-silent" }),
            everyRequiredPeerSilent(),
        ]) {
            expect(assumeCompleteHint(readiness, "overlay-active")).toBe(
                unsettledHint("overlay-active", OVERLAY_SETTLES, 960_000)
            );
            // assumeComplete() waits out a fetch, and one that succeeds
            // leaves an overlay it refuses: the long wait up front.
            expect(assumeCompleteHint(readiness, "fetching")).toBe(
                unsettledHint("fetching", FETCHING_SETTLES, 960_000)
            );
        }
        // Nothing points at peerbit-fs status: a short run starts from the
        // same persisted phase and never sees it settle.
        expect(
            assumeCompleteHint(
                readinessSnapshot({ state: "no-peer" }),
                "overlay-active"
            )
        ).not.toContain("status");
    });
});

describe("peerbit-fs cli", () => {
    it("exports the CLI entry point", () => {
        expect(runCli).toBeTypeOf("function");
    });

    it("accepts and prints a reproducible benchmark seed", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            await runCli([
                "benchmark",
                "--directory",
                "",
                "--seed",
                "cli-benchmark-seed",
                "--large-size",
                "8",
                "--small-files",
                "1",
                "--small-size",
                "4",
                "--cleanup",
            ]);
            expect(log.mock.calls.flat()).toContain(
                "corpus seed: cli-benchmark-seed"
            );
        } finally {
            log.mockRestore();
        }
    });

    it("keeps Windows drive mountpoints in WinFsp drive form", () => {
        expect(normalizeNativeMountpoint("P:", "win32")).toBe("P:");
        expect(normalizeNativeMountpoint("p:\\", "win32")).toBe("P:");
        expect(normalizeNativeMountpoint("q:/", "win32")).toBe("Q:");
        expect(normalizeNativeMountpoint("C:\\tmp\\peerbit", "win32")).toBe(
            path.win32.resolve("C:\\tmp\\peerbit")
        );
    });

    it("classifies only a stable verified full-replica conflict scan as complete", () => {
        const status = (
            phase:
                | "off"
                | "fetching"
                | "overlay-active"
                | "converged"
                | "unverified",
            snapshotCoverageVerified = false,
            writeReady = false,
            pendingDocs = 0
        ) => ({
            phase,
            snapshotCoverageVerified,
            writeReady,
            pendingDocs,
        });
        const complete = status("converged", true, true);

        expect(conflictScanIsPartial(true, complete, complete)).toBe(false);
        expect(
            conflictScanIsPartial(true, status("fetching"), status("fetching"))
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("overlay-active"),
                status("overlay-active")
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("unverified"),
                status("unverified")
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                true,
                status("converged", false, true),
                status("converged", false, true)
            )
        ).toBe(true);
        expect(
            conflictScanIsPartial(true, status("off", false, true), complete)
        ).toBe(true);
        expect(
            conflictScanIsPartial(
                false,
                status("off", false, true),
                status("off", false, true)
            )
        ).toBe(true);
    });

    it("runs the readiness shadow check on in-process closes", async () => {
        // vitest.setup.ts installs the library's registry; the built
        // library reads the same global.
        const registry = globalThis.__SFS_READINESS_SHADOW__;
        expect(registry).toBeDefined();
        const before = { ...registry!.counts };
        const peer = await Peerbit.create();
        try {
            const shared = await openSharedFs({ peerbit: peer });
            await shared.writeFile("/shadow.txt", "checked at close");
        } finally {
            await stopPeer(peer);
        }
        expect(registry!.counts.compared).toBeGreaterThan(before.compared);
        expect(registry!.counts.failed).toBe(before.failed);
    });

    it("creates an address and exits cleanly", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let reopenedPeer: Peerbit | undefined;

        try {
            await runCli(["create", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);
            const address = String(log.mock.calls[0]?.[0]);

            reopenedPeer = await Peerbit.create({ directory });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address,
                machineLabel: "cli-create-reopen",
            });
            expect(reopened.bootstrapStatus().writeReady).toBe(true);
            await expect(
                reopened.awaitWriteReady({ timeout: 100 })
            ).resolves.toBeUndefined();
            // The still-empty filesystem carries the creator's genesis
            // manifest, which a joiner's snapshot bootstrap discovery reads.
            // Joiners do not need it to become ready: they contain the
            // creator, whose summary lists no rows.
            expect(
                await (reopened.program as any).getDocument(
                    `bootstrap:${encodePublicSignKey(reopenedPeer.identity.publicKey)}`
                )
            ).toBeDefined();
        } finally {
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("fails create when the genesis manifest was not published", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const genesis = vi
            .spyOn(SharedFileSystem.prototype, "snapshotWrite")
            .mockRejectedValueOnce(new Error("genesis put failed"));
        try {
            await expect(runCli(["create", "--directory", ""])).rejects.toThrow(
                "create could not publish the genesis manifest that a joiner's snapshot bootstrap discovery reads"
            );
            expect(genesis).toHaveBeenCalledTimes(1);
            expect(log).not.toHaveBeenCalled();
        } finally {
            genesis.mockRestore();
            log.mockRestore();
        }
    });

    it("creates an access-controlled address by default and prints the local writer key", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-auth-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);

            log.mockClear();
            await runCli(["whoami", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^[A-Za-z0-9+/]+=*$/);
        } finally {
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("allows unauthenticated filesystems as an explicit opt-in", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-no-auth-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        try {
            await runCli(["create", "--no-auth", "--directory", directory]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^zb2/);
        } finally {
            log.mockRestore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("rejects disposal preparation when replication is disabled", async () => {
        await expect(
            runCli([
                "prepare-disposal",
                "zb2rh-not-opened",
                "--no-replicate",
                "--directory",
                "",
            ])
        ).rejects.toThrow(
            "prepare-disposal requires a full replica; --no-replicate is not allowed"
        );
    });

    it("rejects create when replication is disabled", async () => {
        await expect(
            runCli(["create", "--no-replicate", "--directory", ""])
        ).rejects.toThrow(
            "create requires a full replica; --no-replicate is not allowed"
        );
    });

    it("rejects a writable mount when replication is disabled", async () => {
        await expect(
            runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--no-replicate",
                "--directory",
                "",
            ])
        ).rejects.toThrow(
            "mount requires a full replica; --no-replicate is not allowed for a writable mount"
        );
    });

    it.each([
        {
            label: "a reachable silent peer",
            readiness: readinessSnapshot({
                state: "waiting-silent",
                required: ["peer-a", "peer-b"],
                silent: [{ peer: "peer-a", reachable: true }],
            }),
            names: "reachable and silent: peer-a",
            advice: "A required peer that does not answer blocks while it is reachable, and another replicator does not change that: restart the silent peer or stop it, and retry.",
        },
        {
            label: "a silent peer that refused",
            readiness: readinessSnapshot({
                state: "waiting-silent",
                required: ["peer-a"],
                silent: [
                    { peer: "peer-a", reachable: true, refused: "UNSUPPORTED" },
                ],
            }),
            names: "peer-a (refused UNSUPPORTED)",
            advice: "restart the silent peer (run this shared-fs release on one that refused) or stop it, and retry.",
        },
        {
            label: "only peers that are not write-ready",
            readiness: readinessSnapshot({
                state: "no-qualified-donor",
                contained: [
                    {
                        peer: "peer-a",
                        qualified: false,
                        source: "none",
                        scopes: ["namespace-v1"],
                        departed: false,
                    },
                ],
            }),
            names: "none qualified: peer-a (none)",
            advice: "connect a write-ready replica, such as the filesystem's creator, and retry.",
        },
        {
            label: "a peer that left before answering",
            readiness: readinessSnapshot({
                state: "waiting-left",
                required: ["peer-a"],
                inFlight: [
                    { peer: "peer-a", state: "left-unanswered", scopes: {} },
                ],
            }),
            names: "waiting for the attempt in flight: peer-a",
            advice: "reconnect it, or retry.",
        },
        {
            label: "peers still reconciling",
            readiness: readinessSnapshot({
                state: "reconciling",
                required: ["peer-a"],
                inFlight: [
                    {
                        peer: "peer-a",
                        state: "reconciling",
                        scopes: { "namespace-v1": "draining" },
                    },
                ],
            }),
            names: "in flight: peer-a",
            advice: "retry with a longer --write-ready-timeout-ms.",
        },
        {
            label: "this replica's own fault",
            readiness: readinessSnapshot({
                state: "reconciling",
                fault: "cells unavailable",
            }),
            names: "(cells unavailable)",
            advice: "which no peer fixes: rerun the command to reopen the filesystem.",
        },
        {
            label: "no visible peer",
            readiness: readinessSnapshot({ state: "no-peer" }),
            names: "no visible peer",
        },
        {
            label: "an unserved fetch",
            readiness: readinessSnapshot({
                state: "waiting-fetch",
                required: ["peer-a"],
                fetchPending: [{ peer: "peer-a", hashes: 2 }],
            }),
            names: "no peer served, named by 1 of 1 required peer: peer-a",
        },
        {
            label: "the trust graph",
            readiness: readinessSnapshot({
                state: "waiting-trust",
                required: ["peer-a"],
            }),
            names: "trust graph: peer-a",
        },
        {
            label: "the bootstrap phase",
            // Since PR-3 commit 4 the phase clause is part of the predicate
            // (design 4.8): `satisfied` is false while it waits.
            readiness: readinessSnapshot({
                state: "waiting-phase",
                satisfied: false,
            }),
            names: "the bootstrap phase has not settled",
        },
        {
            label: "a readiness proof being persisted",
            // The predicate holds and the decision is persisting its proof,
            // or that write failed and waits for the next trigger (M9): a
            // replicator does not help.
            readiness: readinessSnapshot({
                state: "reconciling",
                satisfied: true,
            }),
            names: "every required peer is accounted for; the write-readiness proof is being persisted",
            advice: "the filesystem was persisting its readiness proof: retry; if this repeats, check that the Peerbit directory is writable.",
        },
    ] as Array<{
        label: string;
        readiness: ReadinessStatus;
        names: string;
        advice?: string;
    }>)(
        "names the readiness reason and advice that fits it on a write-readiness timeout: $label",
        ({ readiness, names, advice }) => {
            const subject =
                "mount did not establish a safe initial write view within 500 ms";
            const error = new SharedFsWriteReadyTimeoutError(readiness);
            expect(error.message.startsWith(WRITE_READY_TIMEOUT_PREFIX)).toBe(
                true
            );
            const reason = error.message.slice(
                WRITE_READY_TIMEOUT_PREFIX.length
            );
            expect(reason.startsWith(`${readiness.state}: `)).toBe(true);
            expect(reason).toContain(names);

            const message = writeReadyTimeoutMessage(subject, error);
            expect(message.startsWith(`${subject}: ${reason}. `)).toBe(true);
            if (advice) {
                // The old advice does not end these gates.
                expect(message.endsWith(advice)).toBe(true);
                expect(message).not.toContain("complete replicator");
                expect(message.includes("on one that refused")).toBe(
                    readiness.silent.some(({ refused }) => refused)
                );
            } else {
                expect(message).toBe(
                    `${subject}: ${reason}. Keep a complete replicator connected and retry.`
                );
            }
        }
    );

    it("keeps the old write-readiness timeout message without a readiness snapshot", () => {
        const subject =
            "mount did not establish a safe initial write view within 500 ms";
        expect(
            writeReadyTimeoutMessage(
                subject,
                new SharedFsWriteReadyTimeoutError()
            )
        ).toBe(`${subject}; keep a complete replicator connected and retry.`);
    });

    it("reports the readiness reason when a mount or resolution times out awaiting write readiness", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-write-ready-")
        );
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let seedPeer: Peerbit | undefined;
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let waitSpy: ReturnType<typeof vi.spyOn> | undefined;
        try {
            seedPeer = await Peerbit.create({ directory });
            const seeded = await openSharedFs({
                peerbit: seedPeer,
                machineLabel: "cli-write-ready-seed",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            // A reopen of an empty store starts a snapshot bootstrap, whose
            // phase the hint names; one that holds a file stays off.
            await seeded.writeFile("/seeded.txt", "seeded");
            const address = seeded.address;
            await stopPeer(seedPeer);
            seedPeer = undefined;

            // Fault injection tests the CLI's report; the library's readiness
            // tests time out real joins and check their snapshots. Every
            // required peer is silent, so no answer is coming and the
            // --assume-complete hint is named.
            const timeout = new SharedFsWriteReadyTimeoutError(
                readinessSnapshot({
                    state: "waiting-silent",
                    required: ["peer-a", "peer-b"],
                    silent: [
                        { peer: "peer-a", reachable: true },
                        { peer: "peer-b", reachable: true },
                    ],
                })
            );
            const reason = timeout.message.slice(
                WRITE_READY_TIMEOUT_PREFIX.length
            );
            expect(reason).toContain("reachable and silent: peer-a");
            const advice =
                "A required peer that does not answer blocks while it is reachable, and another replicator does not change that: restart the silent peer or stop it, and retry.";
            waitSpy = vi
                .spyOn(SharedFsHandle.prototype, "awaitWriteReady")
                .mockRejectedValue(timeout);
            createSpy = mockCliBootstrap();

            const mount = await runCli([
                "mount",
                address,
                path.join(directory, "not-mounted"),
                "--native-adapter",
                path.join(directory, "adapter-never-started"),
                "--directory",
                directory,
                "--write-ready-timeout-ms",
                "750",
            ]).then(
                () => undefined,
                (error) => error
            );
            expect(mount).toBeInstanceOf(Error);
            expect(mount.message).toBe(
                `mount did not establish a safe initial write view within 750 ms: ${reason}. ${advice}${ASSUME_COMPLETE_HINT} --allow-partial-writes is only a session-scoped, data-conflict-risk recovery bypass.`
            );
            expect(mount.cause).toBe(timeout);
            expect(waitSpy).toHaveBeenLastCalledWith({ timeout: 750 });

            for (const args of [
                ["resolve-conflict", address, "/file.txt", "version-missing"],
                ["resolve-naming-conflict", address, "node-missing", "keep"],
            ]) {
                const error = await runCli([
                    ...args,
                    "--directory",
                    directory,
                    "--write-ready-timeout-ms",
                    "750",
                ]).then(
                    () => undefined,
                    (error) => error
                );
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe(
                    `${args[0]} did not establish a safe write view within 750 ms: ${reason}. ${advice}${ASSUME_COMPLETE_HINT}`
                );
                expect(error.cause).toBe(timeout);
            }
            expect(waitSpy).toHaveBeenCalledTimes(3);
            expect(log).not.toHaveBeenCalled();
        } finally {
            createSpy?.mockRestore();
            waitSpy?.mockRestore();
            log.mockRestore();
            if (seedPeer) {
                await stopPeer(seedPeer);
            }
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("takes --assume-complete only on the commands that wait for write readiness", async () => {
        const createSpy = vi.spyOn(Peerbit, "create");
        const args = (line: string) => [...line.split(" "), "--directory", ""];
        try {
            // Accepted: each handler runs and refuses --no-replicate first.
            for (const [line, refusal] of [
                [
                    "mount zb2rh-not-opened /tmp/peerbit-shared-fs-not-mounted",
                    "mount requires a full replica",
                ],
                [
                    "resolve-conflict zb2rh-not-opened /file.txt version-missing",
                    "resolve-conflict requires a full replica",
                ],
                [
                    "resolve-naming-conflict zb2rh-not-opened file:missing keep",
                    "resolve-naming-conflict requires a full replica",
                ],
            ]) {
                await expect(
                    runCli(args(`${line} --assume-complete --no-replicate`))
                ).rejects.toThrow(refusal);
            }
            await expect(
                runCli(
                    args(
                        "mount zb2rh-not-opened /tmp/peerbit-shared-fs-not-mounted --assume-complete --allow-partial-writes"
                    )
                )
            ).rejects.toThrow(
                "--assume-complete cannot be combined with --allow-partial-writes: the override never records a readiness proof, and assumeComplete() is refused under it."
            );
            // snapshot has no --assume-complete (a snapshot from an assumed
            // view would outrank complete ones) and no --settle-seconds.
            for (const [line, unknown] of [
                [
                    "snapshot zb2rh-not-opened --assume-complete",
                    "assume-complete",
                ],
                [
                    "status zb2rh-not-opened --assume-complete",
                    "assume-complete",
                ],
                [
                    "snapshot zb2rh-not-opened --settle-seconds 5",
                    "settle-seconds",
                ],
            ]) {
                const { outcome, output } = await parseFailure(args(line));
                expect(outcome).toBeInstanceOf(Error);
                expect(output).toMatch(
                    new RegExp(`Unknown arguments?: ${unknown}`)
                );
            }
            expect(createSpy).not.toHaveBeenCalled();
        } finally {
            createSpy.mockRestore();
        }
    });

    it("takes --write-ready-timeout-ms only as an integer from 1 to 2147483647, before Peerbit starts", async () => {
        const reached = new Error("Peerbit.create reached");
        const createSpy = vi
            .spyOn(Peerbit, "create")
            .mockRejectedValue(reached);
        const args = (line: string) => [...line.split(" "), "--directory", ""];
        const commands = [
            "mount zb2rh-not-opened /tmp/peerbit-shared-fs-not-mounted --native-adapter /tmp/peerbit-shared-fs-adapter-never-started",
            "resolve-conflict zb2rh-not-opened /file.txt version-missing",
            "resolve-naming-conflict zb2rh-not-opened file:missing keep",
            "snapshot zb2rh-not-opened",
        ];
        // snapshot has no --assume-complete.
        const flag = (command: string) =>
            command.startsWith("snapshot") ? "" : " --assume-complete";
        try {
            // Above 2147483647 Node runs the timer after 1 ms: the wait
            // would time out at once, and --assume-complete would act on it.
            for (const command of commands) {
                for (const [value, got] of [
                    ["2147483648", "2147483648"],
                    ["4294967296", "4294967296"],
                    ["0", "0"],
                    ["-1", "-1"],
                    ["1.5", "1.5"],
                    ["abc", "NaN"],
                ]) {
                    await expect(
                        runCli(
                            args(
                                `${command}${flag(command)} --write-ready-timeout-ms=${value}`
                            )
                        ),
                        `${command} ${value}`
                    ).rejects.toThrow(
                        `--write-ready-timeout-ms must be an integer from 1 to 2147483647 (milliseconds); got ${got}`
                    );
                }
            }
            expect(createSpy).not.toHaveBeenCalled();
            // The bounds pass, up to opening Peerbit.
            for (const command of commands) {
                for (const value of ["1", "2147483647"]) {
                    await expect(
                        runCli(
                            args(`${command} --write-ready-timeout-ms ${value}`)
                        ),
                        `${command} ${value}`
                    ).rejects.toBe(reached);
                }
            }
            expect(createSpy).toHaveBeenCalledTimes(commands.length * 2);
        } finally {
            createSpy.mockRestore();
        }
    });

    it("says in its help what --assume-complete risks and that it persists", async () => {
        const help = async (command: string) => {
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            const exit = vi.spyOn(process, "exit").mockImplementation(((
                code?: number
            ) => {
                throw new Error(`process.exit(${code})`);
            }) as never);
            try {
                await runCli([command, "--help"]).catch(() => {});
                // yargs wraps the description column inside words.
                return log.mock.calls
                    .flat()
                    .map(String)
                    .join("")
                    .replace(/\s+/g, "");
            } finally {
                exit.mockRestore();
                log.mockRestore();
            }
        };
        for (const command of [
            "mount",
            "resolve-conflict",
            "resolve-naming-conflict",
        ]) {
            const text = await help(command);
            expect(text, command).toContain("--assume-complete");
            for (const phrase of [
                "and no required peer can still answer (no peer, none write-ready, or every required peer stays silent)",
                "rows held only by peers it did not reconcile with are missing from its view, and later writes can conflict with them",
                "Unlike --allow-partial-writes, it persists: the replica stays writable on later runs (source operator)",
                "Not applied until a snapshot bootstrap settles",
            ]) {
                expect(text, `${command}: ${phrase}`).toContain(
                    phrase.replace(/\s+/g, "")
                );
            }
        }
    });

    it("assumes the view complete after the wait timed out with --assume-complete, and maps its refusals", async () => {
        const seed = await seedCreatorDirectory("assume");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        const timeout = silentPeerTimeout();
        const reason = timeout.message.slice(WRITE_READY_TIMEOUT_PREFIX.length);
        let mocked: ReturnType<typeof mockTimedOutReadiness> | undefined;
        const run = (args: string[]) =>
            captureStderr(() =>
                runCli([
                    ...args,
                    "--directory",
                    seed.directory,
                    "--write-ready-timeout-ms",
                    "750",
                    "--assume-complete",
                ])
            );
        const resolveArgs = [
            "resolve-conflict",
            seed.address,
            "/file.txt",
            "version-missing",
        ];
        try {
            // Fault injection on a warm open tests the CLI's flow; the end
            // to end case below gates a real join.
            mocked = mockTimedOutReadiness(timeout, async () => {}, {
                writeReadinessSource: "operator",
            });
            const resolved = await run(resolveArgs);
            // resolve-conflict continues past readiness to its own check.
            expect(resolved.error?.message).toBe(
                "Version version-missing is not a current conflict head for /file.txt; rerun peerbit-fs conflicts before retrying"
            );
            expect(mocked.wait).toHaveBeenCalledTimes(1);
            // A warm open shows no progress: the call is exactly { timeout }.
            expect(mocked.wait).toHaveBeenCalledWith({ timeout: 750 });
            expect(mocked.assumeComplete).toHaveBeenCalledTimes(1);
            expect(
                mocked.wait.mock.invocationCallOrder[0] <
                    mocked.assumeComplete.mock.invocationCallOrder[0]
            ).toBe(true);
            expect(resolved.chunks.join("")).toContain(
                `Write readiness was not proven within 750 ms: ${reason}. --assume-complete: assuming this replica's view is complete. Rows held only by peers it did not reconcile with are not in it, and writes made now can conflict with them.`
            );
            expect(resolved.progress).toEqual([]);

            // mount prints the source before it fails at the fake adapter.
            const mounted = await run([
                "mount",
                seed.address,
                path.join(seed.directory, "not-mounted"),
                "--native-adapter",
                path.join(seed.directory, "adapter-never-started"),
            ]);
            expect(mounted.error).toBeInstanceOf(Error);
            expect(mocked.assumeComplete).toHaveBeenCalledTimes(2);
            expect(log).toHaveBeenCalledWith(
                "write readiness: ready (operator)"
            );
            expect(
                log.mock.calls.some(([line]) =>
                    String(line).includes("Mounted")
                )
            ).toBe(false);

            // resolve-naming-conflict passes the flag on too, and continues
            // past readiness to its own check.
            const named = await run([
                "resolve-naming-conflict",
                seed.address,
                "node",
                "keep",
            ]);
            expect(named.error?.message).toBe(
                "Node node is not part of a currently visible naming conflict; rerun peerbit-fs naming-conflicts before retrying"
            );
            expect(mocked.wait).toHaveBeenCalledTimes(3);
            expect(mocked.assumeComplete).toHaveBeenCalledTimes(3);
            expect(
                mocked.wait.mock.invocationCallOrder[2] <
                    mocked.assumeComplete.mock.invocationCallOrder[2]
            ).toBe(true);
            mocked.restore();

            const invalid = new SharedFsError(
                "EINVAL",
                "assumeComplete needs a full replica; an observer or partial replica never becomes writable"
            );
            mocked = mockTimedOutReadiness(timeout, async () => {
                throw invalid;
            });
            const refused = await run(resolveArgs);
            expect(refused.error?.message).toBe(
                `--assume-complete was refused: ${invalid.message}`
            );
            expect(refused.error?.cause).toBe(invalid);
            // The warning comes only once the view was assumed.
            expect(refused.chunks.join("")).not.toContain(ASSUMED_WARNING);
            mocked.restore();

            const pending = new SharedFsWritePendingError(
                "assumeComplete",
                "fetching"
            );
            mocked = mockTimedOutReadiness(
                timeout,
                async () => {
                    throw pending;
                },
                { phase: "fetching" }
            );
            const unsettled = await run(resolveArgs);
            // The phase settles only inside one long run, so the advice is a
            // longer wait, never a status check.
            expect(unsettled.error?.message).toBe(
                `resolve-conflict did not establish a safe write view within 750 ms: ${reason}. ${SILENT_PEER_ADVICE}${unsettledNotApplied("fetching", FETCHING_SETTLES, 960_000)}`
            );
            expect(unsettled.error?.cause).toBe(pending);
            expect(unsettled.chunks.join("")).not.toContain(ASSUMED_WARNING);
            mocked.restore();

            // Anything else (a close) is the command's own error.
            const closed = new SharedFsError(
                "ECLOSED",
                "filesystem lifecycle changed before assumeComplete"
            );
            mocked = mockTimedOutReadiness(timeout, async () => {
                throw closed;
            });
            expect((await run(resolveArgs)).error).toBe(closed);
        } finally {
            mocked?.restore();
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("mount under --allow-partial-writes says partial writes are allowed instead of naming a source", async () => {
        const seed = await seedCreatorDirectory("partial");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        try {
            const error = await runCli([
                "mount",
                seed.address,
                path.join(seed.directory, "not-mounted"),
                "--native-adapter",
                path.join(seed.directory, "adapter-never-started"),
                "--directory",
                seed.directory,
                "--allow-partial-writes",
            ]).then(
                () => undefined,
                (error: unknown) => error
            );
            // Printed before it fails at the fake adapter.
            expect(error).toBeInstanceOf(Error);
            expect(
                log.mock.calls
                    .map(([line]) => String(line))
                    .filter((line) => line.startsWith("write readiness: "))
            ).toEqual([
                "write readiness: partial writes allowed for this session (--allow-partial-writes)",
            ]);
        } finally {
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("names --assume-complete on a timeout only where it applies", async () => {
        const seed = await seedCreatorDirectory("hint");
        const createSpy = mockCliBootstrap();
        const timedOut = async (args: string[], readiness: ReadinessStatus) => {
            const timeout = new SharedFsWriteReadyTimeoutError(readiness);
            const mocked = mockTimedOutReadiness(timeout, async () => {});
            try {
                const error = await runCli([
                    ...args,
                    "--directory",
                    seed.directory,
                    "--write-ready-timeout-ms",
                    "750",
                ]).then(
                    () => undefined,
                    (error) => error
                );
                expect(error?.cause).toBe(timeout);
                // Without the flag the CLI never assumes.
                expect(mocked.assumeComplete).not.toHaveBeenCalled();
                return String(error.message);
            } finally {
                mocked.restore();
            }
        };
        const resolveConflict = [
            "resolve-conflict",
            seed.address,
            "/file.txt",
            "version-missing",
        ];
        const keep = ["resolve-naming-conflict", seed.address, "node", "keep"];
        try {
            const noPeer = await timedOut(
                keep,
                readinessSnapshot({ state: "no-peer" })
            );
            expect(noPeer).toContain(": no-peer: ");
            expect(
                noPeer.endsWith(
                    `. Keep a complete replicator connected and retry.${ASSUME_COMPLETE_HINT}`
                )
            ).toBe(true);
            // A peer still being asked may answer: no hint (the states are
            // covered by the assumeCompleteHint unit test).
            const reconciling = await timedOut(
                resolveConflict,
                readinessSnapshot({
                    state: "reconciling",
                    required: ["peer-a"],
                    inFlight: [
                        { peer: "peer-a", state: "reconciling", scopes: {} },
                    ],
                })
            );
            expect(reconciling).toContain(": reconciling: ");
            expect(reconciling).not.toContain("--assume-complete");
            // snapshot does not take the flag, so it never names it.
            const timeout = silentPeerTimeout();
            expect(
                await timedOut(["snapshot", seed.address], timeout.readiness!)
            ).toBe(
                `snapshot did not establish a proven write view within 750 ms: ${timeout.message.slice(WRITE_READY_TIMEOUT_PREFIX.length)}. ${SILENT_PEER_ADVICE}`
            );
        } finally {
            createSpy.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("applies --assume-complete only where no answer is coming and the snapshot bootstrap has settled, and says why not otherwise", async () => {
        const seed = await seedCreatorDirectory("assume-where");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        const notAHead =
            "Version version-missing is not a current conflict head for /file.txt; rerun peerbit-fs conflicts before retrying";
        const stillAnswering = (state: string) =>
            ` --assume-complete was not applied: a required peer is still answering (${state}), so this replica may yet prove its view; it applies only once none can (no-peer, no-qualified-donor, or waiting-silent with every required peer silent).`;
        const notApplicable =
            " --assume-complete was not applied: it applies only when the wait ends with no required peer that can still answer (no-peer, no-qualified-donor, or waiting-silent with every required peer silent).";
        /** resolve-conflict (or mount) timing out with `readiness`. */
        const timedOut = async (
            readiness: ReadinessStatus | undefined,
            options: {
                flag?: boolean;
                phase?: BootstrapStatus["phase"];
                assume?: () => Promise<void>;
                mount?: boolean;
            } = {}
        ) => {
            const timeout = new SharedFsWriteReadyTimeoutError(readiness);
            const mocked = mockTimedOutReadiness(
                timeout,
                options.assume ?? (async () => {}),
                { writeReadinessSource: "operator" },
                options.phase ? { phase: options.phase } : {}
            );
            const command = options.mount
                ? [
                      "mount",
                      seed.address,
                      path.join(seed.directory, "not-mounted"),
                      "--native-adapter",
                      path.join(seed.directory, "adapter-never-started"),
                  ]
                : [
                      "resolve-conflict",
                      seed.address,
                      "/file.txt",
                      "version-missing",
                  ];
            try {
                const { error, chunks } = await captureStderr(() =>
                    runCli([
                        ...command,
                        "--directory",
                        seed.directory,
                        "--write-ready-timeout-ms",
                        "750",
                        ...(options.flag === false
                            ? []
                            : ["--assume-complete"]),
                    ])
                );
                return {
                    error,
                    timeout,
                    stderr: chunks.join(""),
                    assumed: mocked.assumeComplete.mock.calls.length,
                    /** The timeout message without --assume-complete. */
                    base: writeReadyTimeoutMessage(
                        `${options.mount ? "mount did not establish a safe initial write view" : "resolve-conflict did not establish a safe write view"} within 750 ms`,
                        timeout
                    ),
                };
            } finally {
                mocked.restore();
            }
        };
        try {
            // A required peer can still answer: never assumed, in any phase.
            const inFlight = [
                {
                    peer: "peer-a",
                    state: "reconciling" as const,
                    scopes: {},
                },
            ];
            for (const readiness of [
                readinessSnapshot({
                    state: "reconciling",
                    required: ["peer-a"],
                    inFlight,
                }),
                readinessSnapshot({
                    state: "waiting-left",
                    required: ["peer-a"],
                    inFlight: [
                        {
                            peer: "peer-a",
                            state: "left-unanswered",
                            scopes: {},
                        },
                    ],
                }),
                readinessSnapshot({
                    state: "waiting-fetch",
                    required: ["peer-a"],
                    fetchPending: [{ peer: "peer-a", hashes: 3 }],
                }),
                readinessSnapshot({
                    state: "waiting-trust",
                    required: ["peer-a"],
                }),
            ]) {
                const outcome = await timedOut(readiness);
                expect(outcome.assumed, readiness.state).toBe(0);
                expect(outcome.error?.message).toBe(
                    `${outcome.base}${stillAnswering(readiness.state)}`
                );
                expect(outcome.error?.cause).toBe(outcome.timeout);
                expect(outcome.stderr).not.toContain(ASSUMED_WARNING);
            }
            // waiting-silent names one silent peer while another is still
            // asked, reconciled or busy: never assumed, and the hint is not
            // given without the flag either.
            for (const readiness of silentBesideAnswering()) {
                const label = describeReadiness(readiness);
                const outcome = await timedOut(readiness, { phase: "off" });
                expect(outcome.assumed, label).toBe(0);
                expect(outcome.error?.message, label).toBe(
                    `${outcome.base}${STILL_ANSWERING_BESIDE_SILENT}`
                );
                expect(outcome.error?.cause).toBe(outcome.timeout);
                expect(outcome.stderr).not.toContain(ASSUMED_WARNING);
                const unflagged = await timedOut(readiness, {
                    flag: false,
                    phase: "off",
                });
                expect(unflagged.assumed, label).toBe(0);
                expect(unflagged.error?.message, label).toBe(unflagged.base);
            }
            // mount's note still comes last.
            const mounted = await timedOut(
                readinessSnapshot({
                    state: "reconciling",
                    required: ["peer-a"],
                    inFlight,
                }),
                { mount: true }
            );
            expect(mounted.assumed).toBe(0);
            expect(mounted.error?.message).toBe(
                `${mounted.base}${stillAnswering("reconciling")} --allow-partial-writes is only a session-scoped, data-conflict-risk recovery bypass.`
            );

            // Not a state where a peer answers either: no snapshot, this
            // replica's own fault, a proof being persisted, ready.
            for (const readiness of [
                undefined,
                readinessSnapshot({ state: "reconciling", fault: "lost" }),
                readinessSnapshot({ state: "reconciling", satisfied: true }),
                readinessSnapshot({ state: "ready", satisfied: true }),
            ]) {
                const outcome = await timedOut(readiness);
                expect(outcome.assumed).toBe(0);
                expect(outcome.error?.message).toBe(
                    `${outcome.base}${notApplicable}`
                );
                expect(outcome.error?.cause).toBe(outcome.timeout);
            }

            // Every peer accounted for, the phase not settled: the join
            // turns writable by itself once it settles, within one run.
            for (const [phase, settles, timeoutMs] of [
                ["overlay-active", OVERLAY_SETTLES, 960_000],
                ["fetching", FETCHING_SETTLES, 960_000],
            ] as const) {
                const settling = await timedOut(
                    readinessSnapshot({ state: "waiting-phase" }),
                    { phase }
                );
                expect(settling.assumed).toBe(0);
                expect(settling.error?.message).toBe(
                    `${settling.base} --assume-complete was not applied: every required peer is accounted for, and this replica turns writable by itself once the snapshot bootstrap settles (phase: ${phase}). ${settles[0].toUpperCase()}${settles.slice(1)}, so rerun with --write-ready-timeout-ms ${timeoutMs} or more to keep the command open that long.`
                );
            }

            // No answer is coming, but assumeComplete() refuses the
            // unsettled phase: no warning, and advice that ends the loop.
            const pending = new SharedFsWritePendingError(
                "assumeComplete",
                "overlay-active"
            );
            const refused = await timedOut(
                readinessSnapshot({ state: "no-peer" }),
                {
                    phase: "overlay-active",
                    assume: async () => {
                        throw pending;
                    },
                }
            );
            expect(refused.assumed).toBe(1);
            expect(refused.error?.message).toBe(
                `${refused.base}${unsettledNotApplied("overlay-active", OVERLAY_SETTLES, 960_000)}`
            );
            expect(refused.error?.cause).toBe(pending);
            expect(refused.stderr).not.toContain(ASSUMED_WARNING);

            // Without the flag the hint says the same, and asks for the
            // long wait while a fetch may still leave an overlay.
            for (const [phase, settles, timeoutMs] of [
                ["overlay-active", OVERLAY_SETTLES, 960_000],
                ["fetching", FETCHING_SETTLES, 960_000],
            ] as const) {
                const hinted = await timedOut(
                    readinessSnapshot({ state: "no-peer" }),
                    { flag: false, phase }
                );
                expect(hinted.assumed).toBe(0);
                expect(hinted.error?.message).toBe(
                    `${hinted.base}${unsettledHint(phase, settles, timeoutMs)}`
                );
            }

            // The three states where no answer is coming, with the phase
            // settled: assumed, then warned, and the command goes on.
            for (const [readiness, phase] of [
                [readinessSnapshot({ state: "no-peer" }), "off"],
                [
                    readinessSnapshot({ state: "no-qualified-donor" }),
                    "converged",
                ],
                [readinessSnapshot({ state: "waiting-silent" }), "off"],
                [everyRequiredPeerSilent(), "off"],
                // The unverified posture is settled: assumeComplete() ends it.
                [readinessSnapshot({ state: "no-peer" }), "unverified"],
            ] as const) {
                const assumed = await timedOut(readiness, { phase });
                expect(assumed.assumed, describeReadiness(readiness)).toBe(1);
                expect(assumed.error?.message).toBe(notAHead);
                expect(assumed.stderr).toContain(ASSUMED_WARNING);
            }
        } finally {
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("publishes a snapshot once write readiness holds, without a quiet period", async () => {
        const seed = await seedCreatorDirectory("snapshot");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        const wait = vi.spyOn(SharedFsHandle.prototype, "awaitWriteReady");
        try {
            await runCli([
                "snapshot",
                seed.address,
                "--directory",
                seed.directory,
                "--json",
            ]);
            // A warm creator directory is ready at once; the default
            // timeout is 120 s.
            expect(wait).toHaveBeenCalledTimes(1);
            expect(wait).toHaveBeenCalledWith({ timeout: 120_000 });
            expect(log).toHaveBeenCalledTimes(1);
            expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
                manifestId: expect.any(String),
                docs: expect.stringMatching(/^[1-9]\d*$/),
                snapshotSeq: expect.stringMatching(/^\d+$/),
            });
        } finally {
            wait.mockRestore();
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("prints a creator directory's status with no readiness snapshot", async () => {
        const seed = await seedCreatorDirectory("status-creator");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        try {
            await runCli([
                "status",
                seed.address,
                "--json",
                "--directory",
                seed.directory,
            ]);
            expect(
                JSON.parse(String(log.mock.calls[0]?.[0])).filesystem.bootstrap
            ).toMatchObject({
                writeReady: true,
                writeReadinessSource: "creator",
                readiness: null,
            });
            log.mockClear();
            await runCli([
                "status",
                seed.address,
                "--directory",
                seed.directory,
            ]);
            expect(log).toHaveBeenCalledWith(
                "write readiness: ready (creator)"
            );
        } finally {
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("opens one-shot commands with the on-demand freshness start and mount with the eager one, prints freshness, and keeps a lone warm mount --require-fresh gated (M2 O11, O15)", async () => {
        const seed = await seedCreatorDirectory("freshness");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const createSpy = mockCliBootstrap();
        // What each warm open asked of its freshness check.
        const prototype = SharedFileSystem.prototype as any;
        const startFreshness = prototype.startReadinessFreshness;
        const starts: Array<{ start?: string; requireFresh: boolean }> = [];
        prototype.startReadinessFreshness = function (
            this: any,
            generation: number,
            warm: { start?: string }
        ) {
            starts.push({
                start: warm.start,
                requireFresh: this.requireFreshOnReopen === true,
            });
            return startFreshness.call(this, generation, warm);
        };
        const mount = (...flags: string[]) =>
            captureStderr(() =>
                runCli([
                    "mount",
                    seed.address,
                    path.join(seed.directory, "not-mounted"),
                    "--native-adapter",
                    path.join(seed.directory, "adapter-never-started"),
                    "--directory",
                    seed.directory,
                    ...flags,
                ])
            );
        try {
            await runCli([
                "status",
                seed.address,
                "--json",
                "--directory",
                seed.directory,
            ]);
            expect(
                JSON.parse(String(log.mock.calls[0]?.[0])).filesystem.bootstrap
            ).toMatchObject({
                writeReady: true,
                writeReadinessSource: "creator",
                freshness: { state: "unchecked", requests: 0 },
            });
            log.mockClear();
            await runCli([
                "status",
                seed.address,
                "--directory",
                seed.directory,
            ]);
            expect(log).toHaveBeenCalledWith("freshness: unchecked");
            expect(starts).toEqual([
                { start: "on-demand", requireFresh: false },
                { start: "on-demand", requireFresh: false },
            ]);

            // A mount checks at once, and prints the line before it fails
            // at the fake adapter.
            log.mockClear();
            const mounted = await mount();
            expect(mounted.error).toBeInstanceOf(Error);
            expect(log).toHaveBeenCalledWith(
                "write readiness: ready (creator)"
            );
            expect(log).toHaveBeenCalledWith("freshness: unchecked");
            expect(starts[2]).toEqual({ start: "eager", requireFresh: false });

            // --require-fresh with nobody to compare with: gated until the
            // timeout, whose message names the flag and the way out.
            const gated = await mount(
                "--require-fresh",
                "--write-ready-timeout-ms",
                "500"
            );
            expect(gated.error?.message).toContain(
                "mount did not establish a safe initial write view within 500 ms"
            );
            expect(gated.error?.message).toContain(
                "--require-fresh: this warm replica waits until it has compared its view with a peer of this filesystem; mount without it to write on its own earlier proof."
            );
            expect(starts[3]).toEqual({ start: "eager", requireFresh: true });
            for (const flag of [
                "--assume-complete",
                "--allow-partial-writes",
            ]) {
                const refused = await mount("--require-fresh", flag);
                expect(refused.error?.message).toContain(
                    `--require-fresh cannot be combined with ${flag}`
                );
            }
            expect(starts).toHaveLength(4);
        } finally {
            prototype.startReadinessFreshness = startFreshness;
            createSpy.mockRestore();
            log.mockRestore();
            await fs.rm(seed.directory, { recursive: true, force: true });
        }
    });

    it("requires an output directory for --mount-profile before mounting", async () => {
        await expect(
            runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--mount-profile",
                "--directory",
                "",
            ])
        ).rejects.toThrow("--mount-profile requires an output directory");
        expect(resolveMountProfileDirectory(undefined)).toBeUndefined();
        expect(resolveMountProfileDirectory("profile-out")).toBe(
            path.resolve("profile-out")
        );
    });

    it("reports and refuses a missing or unpinned managed adapter before opening Peerbit", async () => {
        const installDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-adapter-pin-")
        );
        const saved = {
            adapter: process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER,
            installDir: process.env.PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR,
            path: process.env.PATH,
            exitCode: process.exitCode,
        };
        const { version } = JSON.parse(
            await fs.readFile(
                new URL("../../package.json", import.meta.url),
                "utf8"
            )
        ) as { version: string };
        const binaryPath = path.join(
            installDir,
            `shared-fs-native-v${version}`,
            process.platform === "win32"
                ? "peerbit-shared-fs-native.exe"
                : "peerbit-shared-fs-native"
        );
        // An adapter copied into this CLI's slot without an install record.
        await fs.mkdir(path.dirname(binaryPath));
        await fs.writeFile(binaryPath, "adapter from an older CLI");
        const refusal = `Installed native adapter ${binaryPath} is of unknown version: it has no install record (installed before adapter version pinning, copied manually, or left by an interrupted install), but @peerbit/shared-fs-cli ${version} requires shared-fs-native-v${version}. Run \`peerbit-fs install-adapter --force\``;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const createPeerbit = vi.spyOn(Peerbit, "create");
        try {
            delete process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER;
            process.env.PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR = installDir;

            await runCli(["status", "--json"]);
            const { nativeMount } = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(nativeMount).toMatchObject({
                externalAdapter: binaryPath,
                available: false,
                missing: expect.arrayContaining([
                    expect.stringContaining(refusal),
                ]),
            });
            // status must not publish the adapter for a later command.
            expect(
                process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER
            ).toBeUndefined();

            await expect(
                runCli([
                    "mount",
                    "zb2rh-not-opened",
                    "/tmp/peerbit-shared-fs-not-mounted",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(refusal);
            expect(createPeerbit).not.toHaveBeenCalled();

            // Without any adapter, mount points at install-adapter and lists
            // the platform requirements instead of dumping usage.
            await fs.rm(path.dirname(binaryPath), { recursive: true });
            process.env.PATH = "";
            error.mockClear();
            await runCli([
                "mount",
                "zb2rh-not-opened",
                "/tmp/peerbit-shared-fs-not-mounted",
                "--directory",
                "",
            ]);
            expect(process.exitCode).toBe(1);
            expect(error).toHaveBeenCalledTimes(1);
            expect(String(error.mock.calls[0]?.[0])).toContain(
                "No native mount adapter found. Run `peerbit-fs install-adapter`"
            );
            expect(log).toHaveBeenCalledWith(
                "  - peerbit-shared-fs-native adapter binary"
            );
            expect(createPeerbit).not.toHaveBeenCalled();
        } finally {
            process.exitCode = saved.exitCode;
            log.mockRestore();
            error.mockRestore();
            createPeerbit.mockRestore();
            for (const [name, value] of [
                ["PEERBIT_SHARED_FS_NATIVE_ADAPTER", saved.adapter],
                ["PEERBIT_SHARED_FS_NATIVE_INSTALL_DIR", saved.installDir],
                ["PATH", saved.path],
            ] as const) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
            await fs.rm(installDir, { recursive: true, force: true });
        }
    });

    it("never reuses or truncates an existing mount profile", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-cli-profile-")
        );
        try {
            const opened: string[] = [];
            const writer = {
                sink: () => {},
                stats: () => ({}) as any,
                close: async () => ({}) as any,
            };
            const target = path.join(directory, "run");
            const files = await openMountProfileFiles(target, async (file) => {
                opened.push(file);
                await fs.writeFile(file, "started\n", { flag: "wx" });
                return writer;
            });
            expect(opened).toEqual([path.join(target, "node-daemon.ndjson")]);
            expect(files.nativeAdapterFile).toBe(
                path.join(target, "native-adapter.ndjson")
            );

            await expect(
                openMountProfileFiles(target, async () => writer)
            ).rejects.toThrow("--mount-profile output already exists");

            const adapterOnly = path.join(directory, "adapter-only");
            await fs.mkdir(adapterOnly);
            await fs.writeFile(
                path.join(adapterOnly, "native-adapter.ndjson"),
                "old\n"
            );
            await expect(
                openMountProfileFiles(adapterOnly, async () => writer)
            ).rejects.toThrow("native-adapter.ndjson");
            expect(
                await fs.readFile(
                    path.join(adapterOnly, "native-adapter.ndjson"),
                    "utf8"
                )
            ).toBe("old\n");
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("detaches the backend and closes the mount profile before stopping Peerbit", async () => {
        const order: string[] = [];
        const profileWriter = {
            sink: () => {},
            stats: () => ({}) as any,
            close: async () => {
                order.push("profile");
                return {
                    emitted: 0,
                    written: 0,
                    dropped: 0,
                    lost: 0,
                    droppedAfterClose: 0,
                    writeErrors: 0,
                    closeTimedOut: false,
                    maxQueuedEvents: 1,
                    maxQueuedBytes: 1,
                };
            },
        };
        const session = (failures: Partial<Record<string, Error>> = {}) => ({
            mounted: {
                unmount: async () => {
                    order.push("unmount");
                    if (failures.unmount) throw failures.unmount;
                },
            },
            ipc: {
                close: async () => {
                    order.push("ipc");
                },
            },
            backend: {
                dispose: () => {
                    order.push("dispose");
                },
            },
            profileWriter,
            stopPeerbit: async () => {
                order.push("peerbit");
                if (failures.peerbit) throw failures.peerbit;
            },
        });

        await stopMountSession(session());
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);

        // A failing Peerbit shutdown no longer loses the profile summary.
        order.length = 0;
        const stopFailure = new Error("peerbit stop failed");
        await expect(
            stopMountSession(session({ peerbit: stopFailure }))
        ).rejects.toBe(stopFailure);
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);

        // A failing unmount still detaches the backend and closes the
        // profile before rethrowing.
        order.length = 0;
        const unmountFailure = new Error("unmount failed");
        await expect(
            stopMountSession(session({ unmount: unmountFailure }))
        ).rejects.toBe(unmountFailure);
        expect(order).toEqual(["unmount", "dispose", "profile"]);

        // The error path runs every step and swallows failures.
        order.length = 0;
        await stopMountSession(
            session({ unmount: unmountFailure, peerbit: stopFailure }),
            { ignoreErrors: true }
        );
        expect(order).toEqual([
            "unmount",
            "ipc",
            "dispose",
            "profile",
            "peerbit",
        ]);
    });

    it.each([
        {
            label: "success after shutdown",
            preparation: "none",
            shutdown: "none",
        },
        { label: "shutdown only", preparation: "none", shutdown: "error" },
        { label: "preparation only", preparation: "error", shutdown: "none" },
        {
            label: "preparation and shutdown",
            preparation: "error",
            shutdown: "error",
        },
        {
            label: "undefined rejection and shutdown",
            preparation: "undefined",
            shutdown: "error",
        },
        {
            label: "preparation and undefined shutdown",
            preparation: "error",
            shutdown: "undefined",
        },
        {
            label: "unprintable preparation and shutdown",
            preparation: "unprintable",
            shutdown: "error",
        },
    ] as const)(
        "reports disposal correctly for $label",
        async ({ preparation, shutdown }) => {
            const directory = await fs.mkdtemp(
                path.join(os.tmpdir(), "peerbit-shared-fs-cli-disposal-")
            );
            const createPeerbit = Peerbit.create.bind(Peerbit);
            let seedPeer: Peerbit | undefined;
            let cliPeer: Peerbit | undefined;
            let restoreCliStop: (() => void) | undefined;
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            let createSpy: ReturnType<typeof vi.spyOn> | undefined;
            let prepareSpy: ReturnType<typeof vi.spyOn> | undefined;

            try {
                seedPeer = await createPeerbit({ directory });
                const seeded = await openSharedFs({
                    peerbit: seedPeer,
                    machineLabel: "cli-disposal-seed",
                    replicate: { factor: 1 },
                    bootstrap: false,
                    gc: false,
                });
                const address = seeded.address;
                await stopPeer(seedPeer);
                seedPeer = undefined;

                const shutdownFailure =
                    shutdown === "undefined"
                        ? undefined
                        : new Error("simulated shutdown failure");
                // Fault injection tests CLI reporting, not actual remote durability.
                // Library disposal tests separately exercise real receipt failure.
                const receiptFailure = Object.assign(
                    new Error("simulated persisted receipt timeout"),
                    {
                        name: "PersistedDeliveryError",
                        localCommitSucceeded: true,
                        retrySafe: false,
                        committedHashes: ["exact-failed-entry-evidence"],
                    }
                );
                const preparationFailure =
                    preparation === "undefined"
                        ? undefined
                        : new PrepareForDisposalError(receiptFailure, 1);
                const preparationStack = preparationFailure?.stack;
                if (preparation === "unprintable") {
                    Object.defineProperty(preparationFailure, "message", {
                        get() {
                            throw new Error("message getter failed");
                        },
                    });
                }
                if (preparation !== "none") {
                    prepareSpy = vi
                        .spyOn(SharedFsHandle.prototype, "prepareForDisposal")
                        .mockRejectedValueOnce(preparationFailure);
                }
                createSpy = vi
                    .spyOn(Peerbit, "create")
                    .mockImplementation(async (options) => {
                        const peer = await createPeerbit(options);
                        cliPeer = peer;
                        vi.spyOn(peer, "bootstrap").mockResolvedValue({
                            connectedPeerIds: [],
                            failures: [],
                        });
                        const originalStop = peer.stop.bind(peer);
                        const stop = vi.spyOn(peer, "stop");
                        if (shutdown !== "none")
                            stop.mockRejectedValueOnce(shutdownFailure);
                        else
                            stop.mockImplementation(async () => {
                                await originalStop();
                                expect(log).not.toHaveBeenCalled();
                            });
                        restoreCliStop = () => stop.mockRestore();
                        return peer;
                    });

                const result = await runCli([
                    "prepare-disposal",
                    address,
                    "--directory",
                    directory,
                    "--json",
                ]).then(
                    () => ({ ok: true as const }),
                    (error) => ({ ok: false as const, error })
                );
                expect(cliPeer?.stop).toHaveBeenCalledTimes(1);
                if (prepareSpy) expect(prepareSpy).toHaveBeenCalledTimes(1);
                expect((await fs.stat(directory)).isDirectory()).toBe(true);
                if (preparation === "none" && shutdown === "none") {
                    expect(result.ok).toBe(true);
                    expect(log).toHaveBeenCalledTimes(1);
                    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
                        safeToDispose: true,
                        empty: true,
                    });
                    return;
                }
                expect(result.ok).toBe(false);
                if (result.ok)
                    throw new Error("failed disposal unexpectedly succeeded");
                if (preparation !== "none" && shutdown !== "none") {
                    expect(result.error).toBeInstanceOf(AggregateError);
                    const combined = result.error as AggregateError;
                    expect(combined.errors).toHaveLength(2);
                    expect(combined.errors[0]).toBe(preparationFailure);
                    expect(combined.errors[1]).toBe(shutdownFailure);
                    expect(combined.cause).toBe(preparationFailure);
                    expect(combined.message).toContain(
                        "keep the source machine"
                    );
                    expect(combined.message).toContain(
                        shutdownFailure?.message ?? "undefined"
                    );
                    if (preparation === "unprintable") {
                        expect(combined.message).toContain(
                            "unprintable rejection"
                        );
                    } else if (preparationFailure) {
                        expect(combined.message).toContain(
                            preparationFailure.message
                        );
                        expect(preparationFailure.stack).toBe(preparationStack);
                        expect(preparationFailure.cause).toBe(receiptFailure);
                        expect(receiptFailure.committedHashes).toEqual([
                            "exact-failed-entry-evidence",
                        ]);
                        expect(receiptFailure.retrySafe).toBe(false);
                    }
                } else {
                    expect(result.error).toBe(
                        shutdown !== "none"
                            ? shutdownFailure
                            : preparationFailure
                    );
                }
                expect(log).not.toHaveBeenCalled();
            } finally {
                createSpy?.mockRestore();
                prepareSpy?.mockRestore();
                restoreCliStop?.();
                log.mockRestore();
                if (cliPeer) {
                    await stopPeer(cliPeer);
                }
                if (seedPeer) {
                    await stopPeer(seedPeer);
                }
                await fs.rm(directory, { recursive: true, force: true });
            }
        }
    );

    it("validates conflict resolution safety options before opening a peer", async () => {
        const createSpy = vi.spyOn(Peerbit, "create");
        try {
            await expect(
                runCli([
                    "resolve-conflict",
                    "zb2rh-not-opened",
                    "/file.txt",
                    "version-missing",
                    "--no-replicate",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-conflict requires a full replica; --no-replicate is not allowed"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "keep",
                    "--no-replicate",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict requires a full replica; --no-replicate is not allowed"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "move",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict move requires --to <path>"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "file:missing",
                    "keep",
                    "--to",
                    "/elsewhere.txt",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict --to is only valid with the move action"
            );
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    "zb2rh-not-opened",
                    "dir:missing",
                    "merge-directory",
                    "--to",
                    "/elsewhere",
                    "--directory",
                    "",
                ])
            ).rejects.toThrow(
                "resolve-naming-conflict --to is only valid with the move action"
            );
            expect(createSpy).not.toHaveBeenCalled();
        } finally {
            createSpy.mockRestore();
        }
    });

    it("prints stable content, naming, and status JSON from one local view", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            await runCli([
                "conflicts",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const contentResult = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(Object.keys(contentResult).sort()).toEqual([
                "address",
                "conflicts",
                "path",
                "view",
            ]);
            expect(contentResult.view).toEqual({
                fullReplica: false,
                bootstrapPhase: "off",
                snapshotCoverageVerified: false,
            });
            const content = contentResult.conflicts;
            expect(content).toHaveLength(1);
            expect(content[0]).toMatchObject({
                path: "/content.txt",
                versions: expect.arrayContaining([
                    expect.objectContaining({
                        id: expect.toBeOneOf([
                            fixture.selectedVersionId,
                            fixture.twinVersionId,
                        ]),
                        size: expect.stringMatching(/^\d+$/),
                        createdAt: expect.stringMatching(/^\d+$/),
                    }),
                    expect.objectContaining({ id: fixture.otherVersionId }),
                ]),
            });
            expect(content[0].versions).toHaveLength(2);
            expect(
                content[0].versions.map((version: { id: string }) => version.id)
            ).toContain(content[0].visibleVersionId);
            for (const version of content[0].versions) {
                expect(version.parentVersionIds).toEqual(
                    [...version.parentVersionIds].sort()
                );
            }

            log.mockClear();
            await runCli([
                "conflicts",
                fixture.address,
                "--path",
                "/missing",
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(
                JSON.parse(String(log.mock.calls[0]?.[0])).conflicts
            ).toEqual([]);

            log.mockClear();
            await runCli([
                "naming-conflicts",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const namingResult = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(Object.keys(namingResult).sort()).toEqual([
                "address",
                "conflicts",
                "path",
                "view",
            ]);
            expect(namingResult.view).toEqual({
                fullReplica: false,
                bootstrapPhase: "off",
                snapshotCoverageVerified: false,
            });
            const naming = namingResult.conflicts;
            expect(naming).toContainEqual(
                expect.objectContaining({
                    type: "duplicate-name",
                    nodeId: fixture.duplicate.nodeId,
                    eventIds: expect.any(Array),
                    shadowedNodeIds: expect.arrayContaining([
                        fixture.shadowedNodeId,
                    ]),
                })
            );
            for (const conflict of naming) {
                expect(conflict.eventIds).toEqual(
                    [...conflict.eventIds].sort()
                );
                if (conflict.shadowedNodeIds) {
                    expect(conflict.shadowedNodeIds).toEqual(
                        [...conflict.shadowedNodeIds].sort()
                    );
                }
                if (conflict.recoverableVersionIds) {
                    expect(conflict.recoverableVersionIds).toEqual(
                        [...conflict.recoverableVersionIds].sort()
                    );
                }
            }

            log.mockClear();
            await runCli([
                "status",
                fixture.address,
                "--json",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const status = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(status.nativeMount).toMatchObject({
                platform: expect.any(String),
                available: expect.any(Boolean),
            });
            expect(status.filesystem).toMatchObject({
                address: fixture.address,
                conflicts: null,
            });

            log.mockClear();
            await runCli([
                "status",
                fixture.address,
                "--json",
                "--include-conflicts",
                "--no-replicate",
                "--directory",
                fixture.directory,
            ]);
            expect(log).toHaveBeenCalledTimes(1);
            const statusWithConflicts = JSON.parse(
                String(log.mock.calls[0]?.[0])
            );
            expect(statusWithConflicts.filesystem).toMatchObject({
                address: fixture.address,
                conflicts: {
                    partial: true,
                    scope: "local-replica",
                    bootstrapPhaseBefore: "off",
                    bootstrapPhaseAfter: "off",
                    bootstrapStateChangedDuringScan: false,
                    contentCount: 1,
                    namingCount: naming.length,
                    content: expect.any(Array),
                    naming: expect.any(Array),
                },
            });

            log.mockClear();
            await runCli(["status", "--json"]);
            expect(log).toHaveBeenCalledTimes(1);
            expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
                nativeMount: { platform: expect.any(String) },
                filesystem: null,
            });
        } finally {
            log.mockRestore();
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("publishes a selected content resolution and preserves history", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await expect(
                runCli([
                    "resolve-conflict",
                    fixture.address,
                    "/content.txt",
                    "version-not-current",
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                "Version version-not-current is not a current conflict head"
            );
            expect(log).not.toHaveBeenCalled();
            await expect(
                runCli([
                    "resolve-conflict",
                    fixture.address,
                    "/",
                    fixture.selectedVersionId,
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                `Version ${fixture.selectedVersionId} is not a current conflict head for /`
            );
            expect(log).not.toHaveBeenCalled();

            await runCli([
                "resolve-conflict",
                fixture.address,
                "/content.txt",
                fixture.selectedVersionId,
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                path: "/content.txt",
                selectedVersionId: fixture.selectedVersionId,
                observedHeadVersionIds: [
                    fixture.selectedVersionId,
                    fixture.twinVersionId,
                    fixture.otherVersionId,
                ].sort(),
                supersededHeadVersionIds: [
                    fixture.selectedVersionId,
                    fixture.twinVersionId,
                    fixture.otherVersionId,
                ].sort(),
                headSetChangedDuringResolution: false,
                resolution: {
                    size: expect.stringMatching(/^\d+$/),
                    createdAt: expect.stringMatching(/^\d+$/),
                },
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-content-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(await reopened.conflicts("/content.txt")).toEqual([]);
            expect(decode(await reopened.readFile("/content.txt"))).toBe(
                "left"
            );
            expect(
                decode(
                    await reopened.readVersion(
                        "/content.txt",
                        fixture.otherVersionId
                    )
                )
            ).toBe("right");
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("moves a shadowed claimant and preserves both duplicate-name files", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await expect(
                runCli([
                    "resolve-naming-conflict",
                    fixture.address,
                    "file:not-a-conflict",
                    "keep",
                    "--json",
                    "--directory",
                    fixture.directory,
                ])
            ).rejects.toThrow(
                "Node file:not-a-conflict is not part of a currently visible naming conflict"
            );
            expect(log).not.toHaveBeenCalled();

            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.shadowedNodeId,
                "move",
                "--to",
                "temporary/../duplicate-restored.txt",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.shadowedNodeId,
                action: {
                    type: "move",
                    to: "/duplicate-restored.txt",
                },
                observedConflicts: expect.arrayContaining([
                    expect.objectContaining({ type: "duplicate-name" }),
                ]),
                remainingConflicts: [],
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-naming-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(
                (await reopened.namingConflicts()).filter(
                    (conflict) => conflict.type === "duplicate-name"
                )
            ).toEqual([]);
            expect(
                new Set([
                    decode(await reopened.readFile("/duplicate.txt")),
                    decode(await reopened.readFile("/duplicate-restored.txt")),
                ])
            ).toEqual(new Set(["first life", "second life"]));
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("merges a shadowed directory through the CLI and reports the repair", async () => {
        const fixture = await seedDirectoryConflict();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.sourceNodeId,
                "merge-directory",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.sourceNodeId,
                action: { type: "merge-directory" },
                observedConflicts: [
                    expect.objectContaining({ type: "duplicate-name" }),
                ],
                remainingConflicts: [],
                resolution: {
                    type: "directory-merged",
                    sourceNodeId: fixture.sourceNodeId,
                    targetNodeId: fixture.targetNodeId,
                    movedNodeIds: [fixture.sourceFileNodeId],
                    eventIds: expect.any(Array),
                },
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-directory-merge-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(
                decode(await reopened.readFile("/shared/from-target.txt"))
            ).toBe("target");
            expect(
                decode(await reopened.readFile("/shared/from-source.txt"))
            ).toBe("source");
            expect(
                (await reopened.stat("/shared/from-source.txt"))?.nodeId
            ).toBe(fixture.sourceFileNodeId);
            expect(
                (await reopened.namingConflicts()).find(
                    (conflict) =>
                        conflict.type === "duplicate-name" &&
                        conflict.path === "/shared"
                )
            ).toBeUndefined();
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("acknowledges a delete-vs-edit conflict with an event-fenced delete", async () => {
        const fixture = await seedConflicts();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        let createSpy: ReturnType<typeof mockCliBootstrap> | undefined;
        let reopenedPeer: Peerbit | undefined;
        try {
            createSpy = mockCliBootstrap();
            await runCli([
                "resolve-naming-conflict",
                fixture.address,
                fixture.deleteConflict.nodeId,
                "delete",
                "--json",
                "--directory",
                fixture.directory,
            ]);
            createSpy.mockRestore();
            createSpy = undefined;

            expect(log).toHaveBeenCalledTimes(1);
            const result = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(result).toMatchObject({
                address: fixture.address,
                nodeId: fixture.deleteConflict.nodeId,
                action: { type: "delete" },
                expectedEventIds: expect.arrayContaining(
                    fixture.deleteConflict.eventIds
                ),
                observedConflicts: expect.arrayContaining([
                    expect.objectContaining({
                        type: "delete-vs-edit",
                        recoverableVersionIds: [
                            fixture.concurrentDeleteVersionId,
                        ],
                    }),
                ]),
                remainingConflicts: [],
            });

            reopenedPeer = await Peerbit.create({
                directory: fixture.directory,
            });
            const reopened = await openSharedFs({
                peerbit: reopenedPeer,
                address: fixture.address,
                machineLabel: "cli-delete-conflict-verify",
                replicate: { factor: 1 },
                bootstrap: false,
                gc: false,
            });
            expect(await reopened.stat("/delete-race.txt")).toBeUndefined();
            expect(
                (await reopened.namingConflicts()).filter(
                    (conflict) =>
                        conflict.nodeId === fixture.deleteConflict.nodeId
                )
            ).toEqual([]);
        } finally {
            createSpy?.mockRestore();
            log.mockRestore();
            if (reopenedPeer) {
                await stopPeer(reopenedPeer);
            }
            await fs.rm(fixture.directory, { recursive: true, force: true });
        }
    });

    it("opens shared-fs addresses with the CLI dependency graph", async () => {
        const writerPeer = await Peerbit.create();
        const readerPeer = await Peerbit.create();
        try {
            await writerPeer.dial(readerPeer);
            const writer = await openSharedFs({
                peerbit: writerPeer,
                machineLabel: "writer",
                replicate: false,
            });
            const reader = await openSharedFs({
                peerbit: readerPeer,
                address: writer.address,
                machineLabel: "reader",
                replicate: false,
            });
            expect(reader.address).toBe(writer.address);
        } finally {
            await Promise.all([stopPeer(writerPeer), stopPeer(readerPeer)]);
        }
    });
});

describe("write readiness of a join whose only peer never answers", () => {
    type Seed = { peer: Peerbit; address: string; dial: string };
    let seed: Seed | undefined;
    /** Seeds a test started; stopped after all. */
    const extraSeeds: Seed[] = [];
    const directories: string[] = [];
    const freshDirectory = async (label: string) => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), `peerbit-shared-fs-cli-${label}-`)
        );
        directories.push(directory);
        return directory;
    };
    /** The open's persisted readiness state (the sidecar). */
    const stateOf = async (directory: string) => {
        const stateDirectory = path.join(directory, "shared-fs-bootstrap");
        const [name] = await fs.readdir(stateDirectory);
        return JSON.parse(
            await fs.readFile(path.join(stateDirectory, name), "utf8")
        );
    };

    /**
     * A creator in open mode whose readiness responder handles requests
     * with `respond(original)` instead: a reachable peer that holds the
     * filesystem and never proves a join, so a CLI join that reaches only
     * it stays gated. With `of`, a replica of that seed's filesystem
     * instead, dialed to it.
     */
    const startSeed = async (
        label: string,
        respond: (
            original: (message: any, from: unknown) => void
        ) => (message: any, from: unknown) => void,
        of?: Seed
    ): Promise<Seed> => {
        const peer = await Peerbit.create();
        try {
            if (of) await peer.dial(of.dial);
            const shared = await openSharedFs({
                peerbit: peer,
                ...(of ? { address: of.address } : {}),
                machineLabel: `cli-${label}-seed`,
                replicate: { factor: 1 },
                gc: false,
            });
            const responder = (shared.program as any).readinessRuntime
                .responder;
            responder.onMessage = respond(responder.onMessage.bind(responder));
            const addresses = peer.getMultiaddrs().map(String);
            return {
                peer,
                address: shared.address,
                dial:
                    addresses.find(
                        (address) =>
                            address.includes("/tcp/") &&
                            !address.includes("/ws")
                    ) ?? addresses[0],
            };
        } catch (error) {
            await stopPeer(peer);
            throw error;
        }
    };

    /**
     * Answers every request as a peer on another readiness wire version
     * would: refused (UNSUPPORTED).
     */
    const refuseEveryRequest =
        (original: (message: any, from: unknown) => void) =>
        (message: any, from: unknown) =>
            original(
                Object.assign(message, { version: message.version + 1 }),
                from
            );

    beforeAll(async () => {
        // Ignores every request: it never answers a join.
        seed = await startSeed("silent", () => () => {});
    });

    afterAll(async () => {
        if (seed) {
            await stopPeer(seed.peer);
        }
        for (const extra of extraSeeds.splice(0)) {
            await stopPeer(extra.peer);
        }
        for (const directory of directories) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("shows one progress line per readiness state while a fresh open waits", async () => {
        const directory = await freshDirectory("progress");
        const asking = readinessSnapshot({
            state: "reconciling",
            required: ["peer-a"],
            inFlight: [{ peer: "peer-a", state: "reconciling", scopes: {} }],
        });
        const busy = readinessSnapshot({
            state: "reconciling",
            required: ["peer-a"],
            busy: ["peer-a"],
        });
        const silent = silentPeerTimeout().readiness!;
        let updates: ReadinessStatus[] = [];
        const options: unknown[] = [];
        // The library calls onProgress once at the start of the wait and on
        // every readiness:progress event; this stands in for both.
        const wait = vi
            .spyOn(SharedFsHandle.prototype, "awaitWriteReady")
            .mockImplementation(async (request) => {
                options.push(request);
                for (const update of updates) request?.onProgress?.(update);
                throw silentPeerTimeout();
            });
        // The hint names the snapshot bootstrap phase, and a fresh open's
        // background decision may start a fetch at any point: pinned off.
        const realStatus = SharedFsHandle.prototype.bootstrapStatus;
        const status = vi
            .spyOn(SharedFsHandle.prototype, "bootstrapStatus")
            .mockImplementation(function (this: SharedFsHandle) {
                return { ...realStatus.call(this), phase: "off" };
            });
        const run = () =>
            captureStderr(() =>
                runCli([
                    "resolve-conflict",
                    seed!.address,
                    "/file.txt",
                    "version-missing",
                    "--peer",
                    seed!.dial,
                    "--directory",
                    directory,
                    "--write-ready-timeout-ms",
                    "750",
                ])
            );
        const line = (status: ReadinessStatus) =>
            `${readinessProgressLine(status, describeReadiness)}\n`;
        try {
            updates = [asking, silent];
            const changed = await run();
            expect(options).toEqual([
                { timeout: 750, onProgress: expect.any(Function) },
            ]);
            expect(changed.progress).toEqual([line(asking), line(silent)]);
            expect(changed.error?.message).toBe(
                `resolve-conflict did not establish a safe write view within 750 ms: ${silentPeerTimeout().message.slice(WRITE_READY_TIMEOUT_PREFIX.length)}. ${SILENT_PEER_ADVICE}${ASSUME_COMPLETE_HINT}`
            );

            updates = [asking, busy];
            expect((await run()).progress).toEqual([line(asking)]);
        } finally {
            wait.mockRestore();
            status.mockRestore();
        }
    });

    it("in a terminal, clears the progress line once the wait ends: before the timeout error, the --assume-complete warning or the command's own output", async () => {
        const asking = readinessSnapshot({
            state: "reconciling",
            required: ["peer-a"],
            inFlight: [{ peer: "peer-a", state: "reconciling", scopes: {} }],
        });
        const line = `\r\x1b[2K${readinessProgressLine(asking, describeReadiness)}`;
        let ends: "timeout" | "ready" = "timeout";
        const wait = vi
            .spyOn(SharedFsHandle.prototype, "awaitWriteReady")
            .mockImplementation(async (request) => {
                request?.onProgress?.(asking);
                if (ends === "timeout") throw silentPeerTimeout();
            });
        const assumeComplete = vi
            .spyOn(SharedFsHandle.prototype, "assumeComplete")
            .mockResolvedValue(undefined);
        const run = async (label: string, ...flags: string[]) => {
            const directory = await freshDirectory(label);
            const { error, chunks } = await captureStderr(
                () =>
                    runCli([
                        "resolve-conflict",
                        seed!.address,
                        "/file.txt",
                        "version-missing",
                        "--peer",
                        seed!.dial,
                        "--directory",
                        directory,
                        "--write-ready-timeout-ms",
                        "750",
                        ...flags,
                    ]),
                { columns: 400 }
            );
            // One rewrite of the line, then the clear right after it.
            expect(
                chunks.filter((chunk) =>
                    chunk.startsWith("\r\x1b[2Kwrite readiness: ")
                )
            ).toEqual([line]);
            return { error, next: chunks.slice(chunks.indexOf(line) + 1) };
        };
        try {
            const timedOut = await run("tty-timeout");
            expect(timedOut.next[0]).toBe("\r\x1b[2K");
            expect(timedOut.error?.cause).toBeInstanceOf(
                SharedFsWriteReadyTimeoutError
            );

            const assumed = await run("tty-assume", "--assume-complete");
            expect(assumed.next[0]).toBe("\r\x1b[2K");
            expect(assumed.next[1]).toContain(
                "--assume-complete: assuming this replica's view is complete."
            );
            expect(assumeComplete).toHaveBeenCalledTimes(1);

            ends = "ready";
            const ready = await run("tty-ready");
            expect(ready.next[0]).toBe("\r\x1b[2K");
            expect(ready.error?.message).toBe(
                "Version version-missing is not a current conflict head for /file.txt; rerun peerbit-fs conflicts before retrying"
            );
        } finally {
            wait.mockRestore();
            assumeComplete.mockRestore();
        }
    });

    it("leaves a join gated with --assume-complete while its required peer is still being asked", async () => {
        const directory = await freshDirectory("assume-asking");
        // The silent peer's first request attempt lasts 5 s, so at 3 s it is
        // in flight and may still answer.
        const asking = await captureStderr(() =>
            runCli([
                "resolve-conflict",
                seed!.address,
                "/file.txt",
                "version-missing",
                "--peer",
                seed!.dial,
                "--directory",
                directory,
                "--write-ready-timeout-ms",
                "3000",
                "--assume-complete",
            ])
        );
        expect(asking.error?.message).toMatch(
            /^resolve-conflict did not establish a safe write view within 3000 ms: reconciling: 1 of 1 required peer in flight: .+ --assume-complete was not applied: a required peer is still answering \(reconciling\), so this replica may yet prove its view; it applies only once none can \(no-peer, no-qualified-donor, or waiting-silent with every required peer silent\)\.$/
        );
        expect(asking.error?.cause).toBeInstanceOf(
            SharedFsWriteReadyTimeoutError
        );
        expect(asking.chunks.join("")).not.toContain(ASSUMED_WARNING);
        // Nothing made it writable.
        expect(await stateOf(directory)).not.toMatchObject({
            writeReady: true,
        });
    });

    it("leaves a join gated with --assume-complete while one required peer refused and another is still being asked", async () => {
        // A second replica of the silent creator's filesystem refuses every
        // request (UNSUPPORTED): the join is waiting-silent once it refused,
        // while the creator's first 5 s attempt is still in flight at 3 s
        // and may yet answer.
        const refusing = await startSeed(
            "refusing-replica",
            refuseEveryRequest,
            seed!
        );
        try {
            const directory = await freshDirectory("assume-silent-asking");
            const outcome = await captureStderr(() =>
                runCli([
                    "resolve-conflict",
                    seed!.address,
                    "/file.txt",
                    "version-missing",
                    "--peer",
                    seed!.dial,
                    "--peer",
                    refusing.dial,
                    "--directory",
                    directory,
                    "--write-ready-timeout-ms",
                    "3000",
                    "--assume-complete",
                ])
            );
            expect(outcome.chunks.join("")).not.toContain(ASSUMED_WARNING);
            const cause = outcome.error?.cause;
            expect(cause).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
            const creator = seed!.peer.identity.publicKey.hashcode();
            const replica = refusing.peer.identity.publicKey.hashcode();
            expect(cause.readiness).toMatchObject({
                state: "waiting-silent",
                silent: [{ peer: replica, refused: "UNSUPPORTED" }],
                busy: [],
            });
            expect([...cause.readiness.required].sort()).toEqual(
                [creator, replica].sort()
            );
            expect(
                cause.readiness.inFlight.map(
                    ({ peer }: { peer: string }) => peer
                )
            ).toEqual([creator]);
            expect(outcome.error?.message).toBe(
                `${writeReadyTimeoutMessage("resolve-conflict did not establish a safe write view within 3000 ms", cause)}${STILL_ANSWERING_BESIDE_SILENT}`
            );
            // Nothing made it writable.
            expect(await stateOf(directory)).not.toMatchObject({
                writeReady: true,
            });
        } finally {
            await stopPeer(refusing.peer);
        }
    });

    it("makes a gated join writable with --assume-complete once its wait timed out with no answer coming", async () => {
        // A peer on another readiness wire version refuses every request
        // (UNSUPPORTED): the join is waiting-silent as soon as it asked.
        const refusing = await startSeed("refusing", refuseEveryRequest);
        extraSeeds.push(refusing);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
            const directory = await freshDirectory("assume-resolve");
            const resolved = await captureStderr(() =>
                runCli([
                    "resolve-conflict",
                    refusing.address,
                    "/file.txt",
                    "version-missing",
                    "--peer",
                    refusing.dial,
                    "--directory",
                    directory,
                    "--write-ready-timeout-ms",
                    "1500",
                    "--assume-complete",
                ])
            );
            // Past readiness, the command fails at its own check.
            expect(resolved.error?.message).toBe(
                "Version version-missing is not a current conflict head for /file.txt; rerun peerbit-fs conflicts before retrying"
            );
            // The library's first onProgress call is synchronous, so a wait
            // that starts gated always shows the line.
            expect(resolved.progress.length).toBeGreaterThan(0);
            // waiting-silent once it asked, or no-peer before it saw the peer:
            // either way no answer is coming.
            expect(resolved.chunks.join("")).toMatch(
                /Write readiness was not proven within 1500 ms: (waiting-silent: 1 of 1 required peer silent: .+ \(refused UNSUPPORTED\)|no-peer: .+)\. --assume-complete: assuming this replica's view is complete\./
            );
            expect(await stateOf(directory)).toMatchObject({
                writeReady: true,
                writeReadySource: "operator",
            });

            const mountDirectory = await freshDirectory("assume-mount");
            const mounted = await captureStderr(() =>
                runCli([
                    "mount",
                    refusing.address,
                    path.join(mountDirectory, "not-mounted"),
                    "--peer",
                    refusing.dial,
                    "--native-adapter",
                    path.join(mountDirectory, "adapter-never-started"),
                    "--directory",
                    mountDirectory,
                    "--write-ready-timeout-ms",
                    "1500",
                    "--assume-complete",
                ])
            );
            // Writable, it prints the source and fails at the fake adapter.
            expect(mounted.error).toBeInstanceOf(Error);
            expect(mounted.progress.length).toBeGreaterThan(0);
            expect(log).toHaveBeenCalledWith(
                "write readiness: ready (operator)"
            );
            expect(await stateOf(mountDirectory)).toMatchObject({
                writeReady: true,
                writeReadySource: "operator",
            });
        } finally {
            log.mockRestore();
        }
    });

    it("says why a fresh open is pending in status", async () => {
        const directory = await freshDirectory("status-gated");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const args = [
            "status",
            seed!.address,
            "--peer",
            seed!.dial,
            "--directory",
            directory,
        ];
        try {
            await runCli([...args, "--json"]);
            expect(log).toHaveBeenCalledTimes(1);
            const { bootstrap } = JSON.parse(
                String(log.mock.calls[0]?.[0])
            ).filesystem;
            expect(bootstrap).toMatchObject({
                writeReady: false,
                writeReadinessSource: null,
                readiness: { state: expect.any(String), satisfied: false },
            });
            expect(bootstrap.readiness.state).not.toBe("ready");

            log.mockClear();
            await runCli(args);
            expect(
                log.mock.calls
                    .map(([line]) => String(line))
                    .filter((line) => line.startsWith("write readiness: "))
            ).toEqual([
                expect.stringMatching(
                    /^write readiness: pending \((no-peer|no-qualified-donor|reconciling|waiting-[a-z]+): .+\)$/
                ),
            ]);
        } finally {
            log.mockRestore();
        }
    });
});
