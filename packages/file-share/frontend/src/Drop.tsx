import { usePeer, useProgram } from "@peerbit/react";
import { useNavigate, useParams } from "react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { Files, AbstractFile, isLargeFileLike } from "@peerbit/please-lib";
import * as Toggle from "@radix-ui/react-toggle";
import { MdArrowBack, MdUploadFile, MdClose, MdSettings } from "react-icons/md";
import { FaSeedling } from "react-icons/fa";
import { File } from "./File";
import { Spinner } from "./Spinner";
import * as Switch from "@radix-ui/react-switch";
import * as Slider from "@radix-ui/react-slider";
import { IsNull, SearchRequest } from "@peerbit/document";
import * as Popover from "@radix-ui/react-popover";
import { useStorageUsage } from "./MemoryUsage";
import { useNetworkUsage } from "./NetworkUsage";
import { GraphExplorer } from "./Graphs";
import * as Progress from "@radix-ui/react-progress";
import { ReplicationOptions } from "@peerbit/shared-log";
import {
    applyRootFileChangeToList,
    getPendingReadyRootReconciliation,
    getReadyLargeFileSignature,
    getRootFileChange,
    shouldRefreshRootListForFileChange,
    sortRootFilesForDisplay,
} from "./root-list";
import { getPeerDialAddresses, withSharePeerHints } from "./share-url";
import {
    bindRefreshContext,
    callEvenInterval,
    createRefreshContextGuard,
    drainCoalescedRefreshQueue,
    isRefreshContextActive,
    queueCoalescedRefresh,
    type RefreshContext,
} from "./refresh-scheduler";
import {
    applyReplicationRoleGuarded,
    createFileShareReplicationRole,
    DEFAULT_REPLICATION_ROLE,
    formatFileShareStorageMegabytes,
    getInitialReplicationRole,
    parseFileShareStorageMegabytes,
    parseStoredRole,
} from "./role-state";
import {
    coalesceRootListRefreshSource,
    getRootListRefreshSource,
    listRemoteRootFilesForReconciliation,
    listRootFilesForRole,
    REMOTE_ROOT_RECONCILIATION_INTERVAL_MS,
    shouldReconcileRemoteRootFiles,
} from "./file-list-loader";
import {
    createPendingReadyResolver,
    resolveRemoteReadyRoot,
    type PendingReadyResolver,
} from "./pending-ready-resolver";
import { confirmRemoteRoot } from "./remote-root-confirmation";
import {
    applyRemoteRootConfirmation,
    createRemoteRootConfirmationScheduler,
    createRemoteRootReconciliationState,
    invalidateRemoteRootAbsenceForVisibleRoots,
    isRemoteRootObservationCurrent,
    observeLocalRootSnapshot,
    observeRemoteRootSnapshot,
    recordExplicitRootChange,
    type RemoteRootConfirmationScheduler,
    type RemoteRootObservation,
} from "./remote-root-reconciliation";
import { settleUploadBatch } from "./upload-lifecycle";

const saveRoleLocalStorage = (files: Files, role: string) => {
    localStorage.setItem(files.address + "-role", role); // Save role in localstorage for next time
};
const getRoleFromLocalStorage = (files: Files) => {
    return localStorage.getItem(files.address + "-role"); // Save role in localstorage for next time
};

const STREAMING_DOWNLOAD_THRESHOLD_BYTES = 250_000_000n;

type BrowserFileWriter = {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
};

type ListingDiagnostics = {
    mountedAt: number;
    shareAddress: string | null;
    initialRole: "replicator" | "replicator-default" | "observer";
    firstPeerReadyAt: number | null;
    firstProgramHookReadyAt: number | null;
    programHookStatus: string | null;
    programHookLoading: boolean;
    programHookError: string | null;
    onOpenStartedAt: number | null;
    trustCheckStartedAt: number | null;
    trustCheckFinishedAt: number | null;
    firstListSource: string | null;
    firstListStartedAt: number | null;
    firstListFinishedAt: number | null;
    firstListDurationMs: number | null;
    firstMetadataRefreshFinishedAt: number | null;
    updateRoleCount: number;
    lastUpdateRoleStartedAt: number | null;
    lastUpdateRoleFinishedAt: number | null;
    lastAppliedRole: "replicator" | "observer" | null;
    listCallCount: number;
    coalescedListRefreshCount: number;
    listRefreshInFlight: boolean;
    lastCoalescedListSource: string | null;
    staleListResultIgnoredCount: number;
    adaptiveRefreshCount: number;
    adaptiveRefreshInFlight: boolean;
    lastAdaptiveRefreshReason: string | null;
    lastAdaptiveRefreshStartedAt: number | null;
    lastAdaptiveRefreshFinishedAt: number | null;
    lastAdaptiveRefreshError: string | null;
    fileChangeEventCount: number;
    rootFileChangeEventCount: number;
    rootChangeDirectAddCount: number;
    rootChangeDirectRemoveCount: number;
    rootChangeAvoidedListRefreshCount: number;
    skippedChildFileChangeEventCount: number;
    pendingReadyResolverStartCount: number;
    pendingReadyResolverResolvedCount: number;
    pendingReadyResolverExpiredCount: number;
    pendingReadyResolverErrorCount: number;
    pendingReadyResolverActiveCount: number;
    lastPendingReadyResolverError: string | null;
    activeTransferCount: number;
    skippedActiveTransferRefreshCount: number;
    sharePeerAddressCount: number;
    lastShareUrlWithPeerHintsAt: number | null;
};

type SaveFilePickerWindow = Window & {
    showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
        createWritable(): Promise<BrowserFileWriter>;
    }>;
    __peerbitStreamingDownloadThresholdBytes?: number;
};

const isUserCancelledDownload = (error: unknown) =>
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "NotAllowedError");

const getProgramHookErrorMessage = (error: unknown) => {
    if (error == null) {
        return null;
    }
    if (error instanceof Error) {
        return error.message;
    }
    if (
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
    ) {
        return error.message;
    }
    return String(error);
};

const getStreamingDownloadThresholdBytes = () => {
    const override = (window as SaveFilePickerWindow)
        .__peerbitStreamingDownloadThresholdBytes;
    if (typeof override === "number" && Number.isFinite(override)) {
        return BigInt(Math.max(0, Math.floor(override)));
    }
    return STREAMING_DOWNLOAD_THRESHOLD_BYTES;
};

const getFileSizeBigInt = (file: AbstractFile) =>
    typeof file.size === "bigint" ? file.size : BigInt(file.size);

const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 10_000;
const LARGE_FILE_DOWNLOAD_MIN_TIMEOUT_MS = 5 * 60_000;
const LARGE_FILE_DOWNLOAD_TIMEOUT_PER_MB_MS = 1_000;

const getDownloadTimeout = (file: AbstractFile) =>
    isLargeFileLike(file)
        ? Math.max(
              LARGE_FILE_DOWNLOAD_MIN_TIMEOUT_MS,
              Math.ceil(Number(file.size) / 1e6) *
                  LARGE_FILE_DOWNLOAD_TIMEOUT_PER_MB_MS
          )
        : DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS;

const createListingDiagnostics = (
    shareAddress: string | undefined,
    storedRole: ReplicationOptions | undefined
): ListingDiagnostics => ({
    mountedAt: Date.now(),
    shareAddress: shareAddress ?? null,
    initialRole:
        storedRole === false
            ? "observer"
            : storedRole
              ? "replicator"
              : "replicator-default",
    firstPeerReadyAt: null,
    firstProgramHookReadyAt: null,
    programHookStatus: null,
    programHookLoading: false,
    programHookError: null,
    onOpenStartedAt: null,
    trustCheckStartedAt: null,
    trustCheckFinishedAt: null,
    firstListSource: null,
    firstListStartedAt: null,
    firstListFinishedAt: null,
    firstListDurationMs: null,
    firstMetadataRefreshFinishedAt: null,
    updateRoleCount: 0,
    lastUpdateRoleStartedAt: null,
    lastUpdateRoleFinishedAt: null,
    lastAppliedRole: null,
    listCallCount: 0,
    coalescedListRefreshCount: 0,
    listRefreshInFlight: false,
    lastCoalescedListSource: null,
    staleListResultIgnoredCount: 0,
    adaptiveRefreshCount: 0,
    adaptiveRefreshInFlight: false,
    lastAdaptiveRefreshReason: null,
    lastAdaptiveRefreshStartedAt: null,
    lastAdaptiveRefreshFinishedAt: null,
    lastAdaptiveRefreshError: null,
    fileChangeEventCount: 0,
    rootFileChangeEventCount: 0,
    rootChangeDirectAddCount: 0,
    rootChangeDirectRemoveCount: 0,
    rootChangeAvoidedListRefreshCount: 0,
    skippedChildFileChangeEventCount: 0,
    pendingReadyResolverStartCount: 0,
    pendingReadyResolverResolvedCount: 0,
    pendingReadyResolverExpiredCount: 0,
    pendingReadyResolverErrorCount: 0,
    pendingReadyResolverActiveCount: 0,
    lastPendingReadyResolverError: null,
    activeTransferCount: 0,
    skippedActiveTransferRefreshCount: 0,
    sharePeerAddressCount: 0,
    lastShareUrlWithPeerHintsAt: null,
});

export const useDebouncedEffect = (effect, deps, delay) => {
    useEffect(() => {
        const handler = setTimeout(() => effect(), delay);

        return () => clearTimeout(handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...(deps || []), delay]);
};

export const Drop = () => {
    const navigate = useNavigate();

    const { peer, loading: peerLoading, status: peerStatus } = usePeer();

    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const [list, setListState] = useState<AbstractFile[]>([]);
    const listRef = useRef<AbstractFile[]>([]);
    const setRootList = (rootFiles: AbstractFile[]) => {
        listRef.current = rootFiles;
        setListState(rootFiles);
    };

    const [replicationSet, setReplicationSet] = useState<Set<string>>(
        new Set()
    );
    const [isHost, setIsHost] = useState<boolean>();
    const isHostRef = useRef<boolean | undefined>(isHost);
    isHostRef.current = isHost;
    const [replicatorCount, setReplicatorCount] = useState(0);
    const [left, setLeft] = useState(false);
    const shareAddress = params.address && decodeURIComponent(params.address);
    const storedRole = parseStoredRole(
        typeof window === "undefined" || !shareAddress
            ? null
            : window.localStorage.getItem(`${shareAddress}-role`)
    );
    const [currentRole, setCurrentRole] = useState<ReplicationOptions>(
        storedRole ?? DEFAULT_REPLICATION_ROLE
    );
    const currentRoleRef = useRef<ReplicationOptions>(currentRole);
    const roleRevisionRef = useRef(0);
    const diagnosticsRef = useRef<ListingDiagnostics>(
        createListingDiagnostics(shareAddress, storedRole)
    );
    const adaptiveRefreshRef = useRef<
        (RefreshContext<Files> & { promise: Promise<void> }) | null
    >(null);
    const adaptiveRefreshSignatureRef = useRef<
        (RefreshContext<Files> & { signature: string }) | null
    >(null);
    const listRefreshRef = useRef<Promise<void> | null>(null);
    const queuedListRefreshSourceRef = useRef<string | null>(null);
    const listRefreshGenerationRef = useRef(0);
    const rootListRevisionRef = useRef(0);
    const remoteRootReconciliationStartedAtRef = useRef<number | null>(null);
    const remoteRootConfirmationRunStartedAtRef = useRef<number | null>(null);
    const remoteRootReconciliationStateRef = useRef(
        createRemoteRootReconciliationState()
    );
    const remoteRootConfirmationSchedulerRef = useRef<{
        generation: number;
        program: Files;
        scheduler: RemoteRootConfirmationScheduler<
            RemoteRootObservation<Files>
        >;
    } | null>(null);
    const listRefreshProgramRef = useRef<Files | null>(null);
    const pendingReadyResolverRef = useRef<{
        program: Files;
        resolver: PendingReadyResolver<Files>;
    } | null>(null);
    useEffect(() => {
        diagnosticsRef.current = createListingDiagnostics(
            shareAddress,
            storedRole
        );
        setRootList([]);
        setReplicationSet(new Set());
        const nextRole = storedRole ?? DEFAULT_REPLICATION_ROLE;
        currentRoleRef.current = nextRole;
        roleRevisionRef.current += 1;
        setCurrentRole(nextRole);
        adaptiveRefreshRef.current = null;
        adaptiveRefreshSignatureRef.current = null;
        listRefreshGenerationRef.current += 1;
        listRefreshRef.current = null;
        queuedListRefreshSourceRef.current = null;
        rootListRevisionRef.current += 1;
        remoteRootReconciliationStartedAtRef.current = null;
        remoteRootConfirmationRunStartedAtRef.current = null;
        remoteRootConfirmationSchedulerRef.current?.scheduler.reset();
        remoteRootConfirmationSchedulerRef.current = null;
        remoteRootReconciliationStateRef.current =
            createRemoteRootReconciliationState();
        // Reset diagnostics only when we enter a different share. Role changes
        // inside the same share are part of the same session we want to measure.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shareAddress]);

    const files = useProgram<Files>(peer, shareAddress, {
        existing: "reuse",
        args: {
            replicate: storedRole ?? DEFAULT_REPLICATION_ROLE,
        },
    });
    listRefreshProgramRef.current = files.program ?? null;

    useEffect(() => {
        if (peer && diagnosticsRef.current.firstPeerReadyAt == null) {
            diagnosticsRef.current.firstPeerReadyAt = Date.now();
        }
    }, [peer]);

    useEffect(() => {
        diagnosticsRef.current.programHookStatus = files.status;
        diagnosticsRef.current.programHookLoading = files.loading;
        diagnosticsRef.current.programHookError = getProgramHookErrorMessage(
            files.error
        );
        if (
            files.program &&
            diagnosticsRef.current.firstProgramHookReadyAt == null
        ) {
            diagnosticsRef.current.firstProgramHookReadyAt = Date.now();
        }
    }, [files.error, files.loading, files.program, files.status]);

    const { memory } = useStorageUsage(files.program?.files.log);
    const { up, down } = useNetworkUsage();
    const [limitStorageString, setLimitStorageString] = useState<string>("0");
    const [limitStorage, setLimitStorage] = useState<boolean>(false);

    const [role, setRole] = useState<"replicator" | "observer">(
        storedRole === false ? "observer" : "replicator"
    );
    const [limitCPU, setLimitCPU] = useState<number | undefined>(1);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    const activeTransferCountRef = useRef(0);

    const selectRole = (nextRole: "replicator" | "observer") => {
        setRole(nextRole);
        if (nextRole === "observer" && currentRoleRef.current !== false) {
            currentRoleRef.current = false;
            roleRevisionRef.current += 1;
            pendingReadyResolverRef.current?.resolver.cancelAll();
            if (listRefreshProgramRef.current) {
                listRefreshProgramRef.current.persistChunkReads = false;
            }
            void updateList("role-change");
        }
    };

    const startActiveTransfer = () => {
        activeTransferCountRef.current += 1;
        diagnosticsRef.current.activeTransferCount =
            activeTransferCountRef.current;
    };

    const finishActiveTransfer = () => {
        activeTransferCountRef.current = Math.max(
            0,
            activeTransferCountRef.current - 1
        );
        diagnosticsRef.current.activeTransferCount =
            activeTransferCountRef.current;
    };

    const getCurrentRefreshContext = (): RefreshContext<Files | null> => ({
        generation: listRefreshGenerationRef.current,
        program: listRefreshProgramRef.current,
    });

    const reconcilePendingReadyRoots = (
        program: Files,
        context: RefreshContext<Files>,
        rootFiles: AbstractFile[]
    ) => {
        const activeResolver = pendingReadyResolverRef.current;
        if (
            !activeResolver ||
            activeResolver.program !== program ||
            !isRefreshContextActive(getCurrentRefreshContext(), context)
        ) {
            return;
        }
        const reconciliation = getPendingReadyRootReconciliation(rootFiles);
        for (const id of reconciliation.readyIds) {
            activeResolver.resolver.cancel(id, program);
        }
        if (currentRoleRef.current === false || isHostRef.current === true) {
            diagnosticsRef.current.pendingReadyResolverActiveCount =
                activeResolver.resolver.size;
            return;
        }
        for (const file of reconciliation.pending) {
            const start = activeResolver.resolver.start(file.id, program);
            if (start.status !== "started") {
                continue;
            }
            diagnosticsRef.current.pendingReadyResolverStartCount += 1;
            diagnosticsRef.current.lastPendingReadyResolverError = null;
            void start.promise.finally(() => {
                if (
                    pendingReadyResolverRef.current === activeResolver &&
                    isRefreshContextActive(getCurrentRefreshContext(), context)
                ) {
                    diagnosticsRef.current.pendingReadyResolverActiveCount =
                        activeResolver.resolver.size;
                }
            });
        }
        diagnosticsRef.current.pendingReadyResolverActiveCount =
            activeResolver.resolver.size;
    };

    const applyReplicationRole = async (
        program: Files,
        roleOptions: ReplicationOptions,
        revision: number,
        context: RefreshContext<Files>
    ) =>
        applyReplicationRoleGuarded(program, roleOptions, {
            expectedRevision: revision,
            getCurrentRevision: () => roleRevisionRef.current,
            getCurrentRole: () => currentRoleRef.current,
            isContextActive: () =>
                isRefreshContextActive(getCurrentRefreshContext(), context),
        });

    // we exclude the string type 'replicator' | 'observer' from the roleOptions so that we can easily serialize it with JSON
    const updateRole = async (
        roleOptions?: ReplicationOptions,
        targetProgram = files.program
    ) => {
        if (roleOptions == null || !targetProgram || targetProgram.closed) {
            return;
        }

        const roleModeChanged =
            (currentRoleRef.current === false) !== (roleOptions === false);

        const context: RefreshContext<Files> = {
            generation: listRefreshGenerationRef.current,
            program: targetProgram,
        };
        if (!isRefreshContextActive(getCurrentRefreshContext(), context)) {
            return;
        }
        let appliedRoleRevision = ++roleRevisionRef.current;
        currentRoleRef.current = roleOptions;
        if (roleOptions === false) {
            pendingReadyResolverRef.current?.resolver.cancelAll();
        }

        diagnosticsRef.current.updateRoleCount += 1;
        diagnosticsRef.current.lastAppliedRole =
            roleOptions === false ? "observer" : "replicator";
        diagnosticsRef.current.lastUpdateRoleStartedAt = Date.now();

        setCurrentRole(roleOptions);

        // console.log("X", files.program.files.log["_roleOptions"]?.["limits"]?.["cpu"]?.max)
        saveRoleLocalStorage(targetProgram, JSON.stringify(roleOptions)); // Save role in localstorage for next time
        await applyReplicationRole(
            targetProgram,
            roleOptions,
            appliedRoleRevision,
            context
        );
        while (
            isRefreshContextActive(getCurrentRefreshContext(), context) &&
            appliedRoleRevision !== roleRevisionRef.current
        ) {
            appliedRoleRevision = roleRevisionRef.current;
            await applyReplicationRole(
                targetProgram,
                currentRoleRef.current,
                appliedRoleRevision,
                context
            );
        }
        if (
            appliedRoleRevision === roleRevisionRef.current &&
            isRefreshContextActive(getCurrentRefreshContext(), context)
        ) {
            diagnosticsRef.current.lastUpdateRoleFinishedAt = Date.now();
            if (roleModeChanged) {
                await updateList("role-change", context);
            }
        }
    };

    const refreshAdaptiveReplication = async (
        reason: string,
        context: RefreshContext<Files>
    ) => {
        if (
            !isRefreshContextActive(
                getCurrentRefreshContext(),
                context,
                currentRoleRef.current !== false
            ) ||
            context.program.closed
        ) {
            return;
        }
        const existing = adaptiveRefreshRef.current;
        if (
            existing &&
            existing.generation === context.generation &&
            existing.program === context.program
        ) {
            return existing.promise;
        }

        const program = context.program;
        const roleOptions = currentRoleRef.current;
        if (roleOptions === false) {
            return;
        }
        let appliedRoleRevision = roleRevisionRef.current;
        diagnosticsRef.current.adaptiveRefreshCount += 1;
        diagnosticsRef.current.adaptiveRefreshInFlight = true;
        diagnosticsRef.current.lastAdaptiveRefreshReason = reason;
        diagnosticsRef.current.lastAdaptiveRefreshStartedAt = Date.now();
        diagnosticsRef.current.lastAdaptiveRefreshFinishedAt = null;
        diagnosticsRef.current.lastAdaptiveRefreshError = null;

        const refresh = (async () => {
            program.persistChunkReads = true;
            await program.files.log.replicate(roleOptions, {
                rebalance: true,
            });
            while (
                isRefreshContextActive(getCurrentRefreshContext(), context) &&
                appliedRoleRevision !== roleRevisionRef.current
            ) {
                appliedRoleRevision = roleRevisionRef.current;
                await applyReplicationRole(
                    program,
                    currentRoleRef.current,
                    appliedRoleRevision,
                    context
                );
            }
        })();

        const operation = { ...context, promise: refresh };
        adaptiveRefreshRef.current = operation;
        try {
            await refresh;
        } catch (error) {
            if (isRefreshContextActive(getCurrentRefreshContext(), context)) {
                diagnosticsRef.current.lastAdaptiveRefreshError =
                    error instanceof Error ? error.message : String(error);
            }
            throw error;
        } finally {
            if (adaptiveRefreshRef.current === operation) {
                adaptiveRefreshRef.current = null;
            }
            if (isRefreshContextActive(getCurrentRefreshContext(), context)) {
                diagnosticsRef.current.adaptiveRefreshInFlight = false;
                diagnosticsRef.current.lastAdaptiveRefreshFinishedAt =
                    Date.now();
            }
        }
    };

    const scheduleAdaptiveRefresh = (
        reason: string,
        signature?: string | null,
        requestedContext?: RefreshContext<Files>
    ) => {
        const currentContext = getCurrentRefreshContext();
        const context =
            requestedContext ??
            (currentContext.program
                ? {
                      generation: currentContext.generation,
                      program: currentContext.program,
                  }
                : undefined);
        if (
            !context ||
            context.program.closed ||
            !isRefreshContextActive(
                currentContext,
                context,
                currentRoleRef.current !== false
            )
        ) {
            return;
        }
        if (activeTransferCountRef.current > 0) {
            diagnosticsRef.current.skippedActiveTransferRefreshCount += 1;
            return;
        }
        let signatureToken:
            | (RefreshContext<Files> & { signature: string })
            | undefined;
        if (signature) {
            const existing = adaptiveRefreshSignatureRef.current;
            if (
                existing?.signature === signature &&
                existing.generation === context.generation &&
                existing.program === context.program
            ) {
                return;
            }
            signatureToken = { ...context, signature };
            adaptiveRefreshSignatureRef.current = signatureToken;
        }
        void refreshAdaptiveReplication(reason, context).catch((error) => {
            if (
                signatureToken &&
                adaptiveRefreshSignatureRef.current === signatureToken
            ) {
                adaptiveRefreshSignatureRef.current = null;
            }
            console.warn(
                "Failed to refresh adaptive replication: " +
                    (error instanceof Error ? error.message : String(error))
            );
        });
    };

    useEffect(() => {
        const testWindow = window as Window & {
            __peerbitFileShareTestHooks?: {
                setReplicationRole: (
                    roleOptions: ReplicationOptions
                ) => Promise<void>;
                setPersistChunkReads: (persist: boolean) => boolean;
                getLightweightSnapshot: () => Record<string, unknown>;
                getTopologySnapshot: () => Promise<Record<string, unknown>>;
                getDiagnostics: () => Promise<Record<string, unknown>>;
            };
            __peerbitFileShareBenchmarkStats?: {
                updateListCalls?: Array<Record<string, unknown>>;
            };
        };
        const program = files.program;
        const testHooks = {
            setReplicationRole: async (roleOptions) => {
                if (!program || program.closed) {
                    throw new Error("Program is not ready");
                }
                saveRoleLocalStorage(program, JSON.stringify(roleOptions));
                setRole(roleOptions ? "replicator" : "observer");
                await updateRole(roleOptions);
            },
            setPersistChunkReads: (persist) => {
                if (!program || program.closed) {
                    throw new Error("Program is not ready");
                }
                program.persistChunkReads = persist;
                return program.persistChunkReads;
            },
            getLightweightSnapshot: () => ({
                capturedAt: Date.now(),
                programAddress: program?.address ?? null,
                programClosed: program?.closed ?? null,
                programHookStatus: files.status,
                programHookError: getProgramHookErrorMessage(files.error),
                persistChunkReads: program?.persistChunkReads ?? null,
                listCount: listRef.current.length,
                listedFiles: listRef.current.map((file) => ({
                    id: file.id,
                    name: file.name,
                    type: isLargeFileLike(file) ? "large" : "tiny",
                    size: file.size.toString(),
                    ready: isLargeFileLike(file) ? file.ready : undefined,
                    finalHash: isLargeFileLike(file)
                        ? file.finalHash
                        : undefined,
                })),
            }),
            getTopologySnapshot: async () => {
                const activeProgram =
                    program && !program.closed ? program : undefined;
                const replicators = activeProgram
                    ? await activeProgram.files.log
                          .getReplicators()
                          .catch(() => undefined)
                    : undefined;
                const peerHash =
                    peer?.identity?.publicKey?.hashcode?.() ?? null;
                const replicatorHashes = replicators
                    ? [...replicators]
                          .map(
                              (
                                  replicator:
                                      | string
                                      | { hashcode?: () => string }
                              ) =>
                                  typeof replicator === "string"
                                      ? replicator
                                      : replicator.hashcode?.()
                          )
                          .filter((hash): hash is string => hash != null)
                    : undefined;
                const appDiagnostics = (
                    window as Window & {
                        __peerbitFileShareAppDiagnostics?: () => {
                            peersProvided?: boolean;
                            peerHintSource?: string | null;
                            peerAddressCount?: number;
                            connectionState?: string;
                            dialStartedAt?: number | null;
                            dialFinishedAt?: number | null;
                        };
                    }
                ).__peerbitFileShareAppDiagnostics?.();
                const connections =
                    (peer as any)?.libp2p?.getConnections?.() ?? [];

                return {
                    capturedAt: Date.now(),
                    peersProvided: appDiagnostics?.peersProvided ?? null,
                    peerHintSource: appDiagnostics?.peerHintSource ?? null,
                    peerAddressCount: appDiagnostics?.peerAddressCount ?? null,
                    appConnectionState: appDiagnostics?.connectionState ?? null,
                    appDialStartedAt: appDiagnostics?.dialStartedAt ?? null,
                    appDialFinishedAt: appDiagnostics?.dialFinishedAt ?? null,
                    connectionCount: connections.length,
                    peerHash,
                    replicatorCount:
                        replicators && typeof replicators.size === "number"
                            ? replicators.size
                            : null,
                    selfInReplicatorSet:
                        peerHash && replicatorHashes
                            ? replicatorHashes.includes(peerHash)
                            : null,
                };
            },
            getDiagnostics: async () => {
                const activeProgram =
                    program && !program.closed ? program : undefined;
                const replicators = activeProgram
                    ? await activeProgram.files.log
                          .getReplicators()
                          .catch(() => undefined)
                    : undefined;
                const connections = (
                    (peer as any)?.libp2p?.getConnections?.() ?? []
                ).map(
                    (connection) =>
                        connection?.remotePeer?.toString?.() ?? "unknown"
                );
                const peerAddresses = getPeerDialAddresses(peer);
                const listedFiles = await Promise.all(
                    list.map(async (file) => ({
                        id: file.id,
                        name: file.name,
                        type: isLargeFileLike(file) ? "large" : "tiny",
                        size: file.size.toString(),
                        ready: isLargeFileLike(file) ? file.ready : undefined,
                        finalHash: isLargeFileLike(file)
                            ? file.finalHash
                            : undefined,
                        chunkCount: isLargeFileLike(file)
                            ? file.chunkCount
                            : undefined,
                        localChunkCount:
                            activeProgram && isLargeFileLike(file)
                                ? await activeProgram
                                      .countLocalChunks(file)
                                      .catch(() => null)
                                : undefined,
                        localChunkBlockCount:
                            activeProgram && isLargeFileLike(file)
                                ? await activeProgram
                                      .countLocalChunkBlocks(file)
                                      .catch(() => null)
                                : undefined,
                    }))
                );
                return {
                    programAddress: program?.address ?? null,
                    programClosed: program?.closed ?? null,
                    shareUrl: window.location.href,
                    persistChunkReads: program?.persistChunkReads ?? null,
                    runtimeOpenProfileSamples:
                        (
                            window as Window & {
                                __peerbitFileShareRuntimeOpenProfiler?: {
                                    samples?: Record<string, unknown>[];
                                };
                            }
                        ).__peerbitFileShareRuntimeOpenProfiler?.samples ??
                        null,
                    peerHash: peer?.identity?.publicKey?.hashcode?.() ?? null,
                    peerAddresses,
                    peerStatus,
                    peerLoading,
                    programHookError: getProgramHookErrorMessage(files.error),
                    connectionCount: connections.length,
                    connectionPeers: connections,
                    programOpenDiagnostics: program?.openDiagnostics ?? null,
                    lastUploadDiagnostics:
                        program?.lastUploadDiagnostics ?? null,
                    lastReadDiagnostics: program?.lastReadDiagnostics ?? null,
                    replicatorCount:
                        replicators && typeof replicators.size === "number"
                            ? replicators.size
                            : null,
                    listCount: list.length,
                    listedFiles,
                    replicationSetSize: replicationSet.size,
                    isHost: isHost ?? null,
                    left,
                    benchmarkStats:
                        testWindow.__peerbitFileShareBenchmarkStats ?? null,
                    timings: diagnosticsRef.current,
                };
            },
        };
        testWindow.__peerbitFileShareTestHooks = testHooks;
        return () => {
            if (testWindow.__peerbitFileShareTestHooks === testHooks) {
                delete testWindow.__peerbitFileShareTestHooks;
            }
        };
    }, [
        files.program,
        files.program?.address,
        files.program?.closed,
        files.error,
        files.loading,
        files.status,
        isHost,
        left,
        list,
        peer,
        peer?.identity?.publicKey,
        peerLoading,
        peerStatus,
        replicationSet.size,
    ]);

    useEffect(() => {
        if (!isHost || !shareAddress || !peer || left) {
            return;
        }

        let stopped = false;
        let interval: ReturnType<typeof setInterval> | undefined;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        const syncShareUrlPeerHints = () => {
            if (stopped) {
                return;
            }
            const peerAddresses = getPeerDialAddresses(peer);
            diagnosticsRef.current.sharePeerAddressCount = peerAddresses.length;
            const nextHref = withSharePeerHints(
                window.location.href,
                peerAddresses,
                { skipWhenBootstrapPresent: true }
            );
            if (nextHref !== window.location.href) {
                window.history.replaceState(window.history.state, "", nextHref);
                diagnosticsRef.current.lastShareUrlWithPeerHintsAt = Date.now();
            }
        };

        syncShareUrlPeerHints();
        interval = setInterval(syncShareUrlPeerHints, 2000);
        stopTimer = setTimeout(() => {
            if (interval) {
                clearInterval(interval);
            }
        }, 30_000);

        return () => {
            stopped = true;
            if (interval) {
                clearInterval(interval);
            }
            if (stopTimer) {
                clearTimeout(stopTimer);
            }
        };
    }, [isHost, left, peer, shareAddress]);

    useDebouncedEffect(
        () => {
            const sizeBytes =
                parseFileShareStorageMegabytes(limitStorageString);

            updateRole(
                role === "replicator"
                    ? createFileShareReplicationRole({
                          cpuMax: limitCPU,
                          storage: limitStorage ? sizeBytes : undefined,
                      })
                    : false
            );
        },
        [limitCPU, limitStorage, role, limitStorageString],
        30
    ); // we debounce because of the many changes the CPU slider will do

    // console.log(files?.program?.files.log?.["cpuUsage"].value())
    useEffect(() => {
        if (!files.program?.address || files.program.closed) {
            return;
        }

        listRefreshGenerationRef.current += 1;
        listRefreshRef.current = null;
        queuedListRefreshSourceRef.current = null;
        adaptiveRefreshRef.current = null;
        adaptiveRefreshSignatureRef.current = null;
        remoteRootReconciliationStartedAtRef.current = null;
        remoteRootConfirmationRunStartedAtRef.current = null;
        remoteRootConfirmationSchedulerRef.current?.scheduler.reset();
        remoteRootConfirmationSchedulerRef.current = null;
        const remoteRootReconciliationState =
            createRemoteRootReconciliationState();
        remoteRootReconciliationStateRef.current =
            remoteRootReconciliationState;
        diagnosticsRef.current.adaptiveRefreshInFlight = false;

        const program = files.program;
        const refreshContext: RefreshContext<Files> = {
            generation: listRefreshGenerationRef.current,
            program,
        };
        let disposed = false;
        const hasCurrentContext = createRefreshContextGuard(
            getCurrentRefreshContext,
            refreshContext
        );
        const isContextCurrent = () => !disposed && hasCurrentContext();
        const pendingReadyResolver = createPendingReadyResolver<
            Files,
            AbstractFile
        >({
            attemptTimeoutMs: 1_500,
            retryDelayMs: 350,
            maxEntries: 64,
            maxLifetimeMs: 5 * 60_000,
            resolve: (id, targetProgram, signal, attemptTimeoutMs) =>
                resolveRemoteReadyRoot(
                    targetProgram,
                    id,
                    signal,
                    attemptTimeoutMs
                ),
            isActive: (id, targetProgram) => {
                if (
                    targetProgram !== program ||
                    targetProgram.closed ||
                    currentRoleRef.current === false ||
                    isHostRef.current === true ||
                    !isContextCurrent()
                ) {
                    return false;
                }
                const listed = listRef.current.find((file) => file.id === id);
                return Boolean(
                    listed && isLargeFileLike(listed) && !listed.ready
                );
            },
            onReady: (id, targetProgram, readyFile) => {
                if (
                    targetProgram !== program ||
                    readyFile.id !== id ||
                    targetProgram.closed ||
                    currentRoleRef.current === false ||
                    !isContextCurrent()
                ) {
                    return;
                }
                const listed = listRef.current.find((file) => file.id === id);
                if (!listed || !isLargeFileLike(listed) || listed.ready) {
                    return;
                }

                diagnosticsRef.current.pendingReadyResolverResolvedCount += 1;
                rootListRevisionRef.current += 1;
                const nextList = applyRootFileChangeToList(listRef.current, {
                    added: [readyFile],
                    removed: [],
                });
                setRootList(nextList);
                forceUpdate();
            },
            onError: (_id, _targetProgram, error) => {
                if (!isContextCurrent()) {
                    return;
                }
                diagnosticsRef.current.pendingReadyResolverErrorCount += 1;
                diagnosticsRef.current.lastPendingReadyResolverError =
                    error instanceof Error ? error.message : String(error);
            },
            onExpired: () => {
                if (isContextCurrent()) {
                    diagnosticsRef.current.pendingReadyResolverExpiredCount += 1;
                }
            },
        });
        pendingReadyResolverRef.current = {
            program,
            resolver: pendingReadyResolver,
        };
        const remoteRootConfirmationScheduler =
            createRemoteRootConfirmationScheduler<
                RemoteRootObservation<Files>,
                Awaited<ReturnType<typeof confirmRemoteRoot>>
            >({
                maxCandidatesPerRun: 8,
                concurrency: 2,
                confirm: (id, signal) => confirmRemoteRoot(program, id, signal),
                onResult: (id, result, observation) => {
                    if (
                        !isContextCurrent() ||
                        !isRemoteRootObservationCurrent(
                            {
                                generation: listRefreshGenerationRef.current,
                                program: listRefreshProgramRef.current,
                                rootRevision: rootListRevisionRef.current,
                            },
                            observation
                        )
                    ) {
                        return "retry";
                    }
                    const action = applyRemoteRootConfirmation(
                        remoteRootReconciliationState,
                        id,
                        result
                    );
                    if (action.type === "merge") {
                        const nextList = applyRootFileChangeToList(
                            listRef.current,
                            { added: [action.root], removed: [] }
                        );
                        setRootList(nextList);
                        reconcilePendingReadyRoots(
                            program,
                            refreshContext,
                            nextList
                        );
                        const readyLargeFileSignature =
                            getReadyLargeFileSignature(nextList);
                        if (readyLargeFileSignature) {
                            scheduleAdaptiveRefresh(
                                "ready-exact-remote-root",
                                readyLargeFileSignature,
                                refreshContext
                            );
                        }
                        forceUpdate();
                    } else if (action.type === "remove") {
                        const nextList = applyRootFileChangeToList(
                            listRef.current,
                            {
                                added: [],
                                removed: [{ id, parentId: undefined }],
                            }
                        );
                        setRootList(nextList);
                        pendingReadyResolver.cancel(id, program);
                        diagnosticsRef.current.pendingReadyResolverActiveCount =
                            pendingReadyResolver.size;
                        setReplicationSet((current) => {
                            const next = new Set(current);
                            next.delete(id);
                            return next;
                        });
                        forceUpdate();
                    }
                    return action.retry ? "retry" : "complete";
                },
            });
        remoteRootConfirmationSchedulerRef.current = {
            ...refreshContext,
            scheduler: remoteRootConfirmationScheduler,
        };
        const cancelPendingReadyResolver = (id: string) => {
            if (pendingReadyResolver.cancel(id, program)) {
                diagnosticsRef.current.pendingReadyResolverActiveCount =
                    pendingReadyResolver.size;
            }
        };
        const startPendingReadyResolver = (file: AbstractFile) => {
            if (
                !isLargeFileLike(file) ||
                file.ready ||
                currentRoleRef.current === false ||
                isHostRef.current === true ||
                !isContextCurrent()
            ) {
                return;
            }
            const start = pendingReadyResolver.start(file.id, program);
            if (start.status !== "started") {
                diagnosticsRef.current.pendingReadyResolverActiveCount =
                    pendingReadyResolver.size;
                return;
            }
            diagnosticsRef.current.pendingReadyResolverStartCount += 1;
            diagnosticsRef.current.lastPendingReadyResolverError = null;
            diagnosticsRef.current.pendingReadyResolverActiveCount =
                pendingReadyResolver.size;
            void start.promise.finally(() => {
                if (isContextCurrent()) {
                    diagnosticsRef.current.pendingReadyResolverActiveCount =
                        pendingReadyResolver.size;
                }
            });
        };
        const updateListForProgram = bindRefreshContext<Files, string | Event>(
            () => ({
                generation: listRefreshGenerationRef.current,
                program: listRefreshProgramRef.current,
            }),
            refreshContext,
            (sourceOrEvent, context) => updateList(sourceOrEvent, context)
        );
        const updateListDebounced = callEvenInterval(updateListForProgram, 500);
        const refresh = setInterval(() => {
            if (activeTransferCountRef.current > 0) {
                diagnosticsRef.current.skippedActiveTransferRefreshCount += 1;
                return;
            }
            updateListDebounced();
        }, 5000);
        program.files.log.events.addEventListener("join", updateListForProgram);
        program.files.log.events.addEventListener("leave", updateListDebounced);
        const filesChangeListener = (event: Event) => {
            if (!isContextCurrent()) {
                return;
            }
            diagnosticsRef.current.fileChangeEventCount += 1;
            if (!shouldRefreshRootListForFileChange(event)) {
                diagnosticsRef.current.skippedChildFileChangeEventCount += 1;
                return;
            }

            diagnosticsRef.current.rootFileChangeEventCount += 1;
            const rootChange = getRootFileChange(event);
            if (rootChange.added.length > 0 || rootChange.removed.length > 0) {
                diagnosticsRef.current.rootChangeDirectAddCount +=
                    rootChange.added.length;
                diagnosticsRef.current.rootChangeDirectRemoveCount +=
                    rootChange.removed.length;
                rootListRevisionRef.current += 1;
                const changedRemoteRootIds = recordExplicitRootChange(
                    remoteRootReconciliationState,
                    {
                        removed: rootChange.removed,
                        added: rootChange.added,
                    }
                );
                for (const id of changedRemoteRootIds) {
                    remoteRootConfirmationScheduler.forget(id);
                }
                const nextList = applyRootFileChangeToList(
                    listRef.current,
                    rootChange
                );
                setRootList(nextList);
                for (const removed of rootChange.removed) {
                    cancelPendingReadyResolver(removed.id);
                }
                for (const added of rootChange.added) {
                    if (isLargeFileLike(added) && added.ready) {
                        cancelPendingReadyResolver(added.id);
                    } else {
                        startPendingReadyResolver(added);
                    }
                }
                setReplicationSet((current) => {
                    const next = new Set(current);
                    for (const removed of rootChange.removed) {
                        next.delete(removed.id);
                    }
                    for (const added of rootChange.added) {
                        next.add(added.id);
                    }
                    return next;
                });
                const readyLargeFileSignature =
                    getReadyLargeFileSignature(nextList);
                if (readyLargeFileSignature) {
                    scheduleAdaptiveRefresh(
                        "ready-change:event",
                        readyLargeFileSignature,
                        refreshContext
                    );
                }
                forceUpdate();
                diagnosticsRef.current.rootChangeAvoidedListRefreshCount += 1;
                return;
            }
            updateListDebounced(event);
        };

        program.files.events.addEventListener("change", filesChangeListener);

        const replicatorsChangeListener = async () => {
            try {
                const replicators = await program.files.log.getReplicators();
                if (isContextCurrent()) {
                    setReplicatorCount(replicators.size);
                }
            } catch (error) {
                if (isContextCurrent()) {
                    console.warn(
                        "Failed to refresh replicator count: " +
                            (error instanceof Error
                                ? error.message
                                : String(error))
                    );
                }
            }

            //  setCurrentRole(ev.detail.replicate); TODO this should be somewhere else
        };

        program.files.log.events.addEventListener(
            "replication:change",
            replicatorsChangeListener
        );

        const onOpen = async () => {
            if (!isContextCurrent()) {
                return;
            }
            diagnosticsRef.current.onOpenStartedAt = Date.now();

            const serializedRoleFromStorage = getRoleFromLocalStorage(program);
            const hasStoredRole = serializedRoleFromStorage != null;
            const desiredRole = getInitialReplicationRole(
                serializedRoleFromStorage
            );

            program.persistChunkReads = desiredRole !== false;
            currentRoleRef.current = desiredRole;
            roleRevisionRef.current += 1;
            if (desiredRole === false) {
                pendingReadyResolver.cancelAll();
            }
            setCurrentRole(desiredRole);
            setRole(desiredRole === false ? "observer" : "replicator");
            void updateListForProgram("initial-open");

            diagnosticsRef.current.trustCheckStartedAt = Date.now();
            const isTrusted =
                !program.trustGraph ||
                (await program.trustGraph.isTrusted(peer.identity.publicKey));
            if (!isContextCurrent()) {
                return;
            }
            diagnosticsRef.current.trustCheckFinishedAt = Date.now();
            setIsHost(isTrusted);

            if (isTrusted && hasStoredRole) {
                setLimitCPU(
                    program.files.log["_roleOptions"]?.["limits"]?.["cpu"]?.max
                ); // TODO export types
                const limitStorageLoaded =
                    program.files.log["_roleOptions"]?.["limits"]?.storage;
                setLimitStorage(limitStorageLoaded != null); // TODO export types
                setLimitStorageString(
                    limitStorageLoaded != null
                        ? formatFileShareStorageMegabytes(limitStorageLoaded)
                        : "0"
                ); // TODO export types
            }

            const replicators = await program.files.log.getReplicators();
            if (isContextCurrent()) {
                setReplicatorCount(replicators.size);
            }
        };

        void onOpen().catch((error) => {
            if (isContextCurrent()) {
                console.warn(
                    "Failed to initialize file-share view: " +
                        (error instanceof Error ? error.message : String(error))
                );
            }
        });

        return () => {
            disposed = true;
            pendingReadyResolver.cancelAll();
            if (
                pendingReadyResolverRef.current?.program === program &&
                pendingReadyResolverRef.current.resolver ===
                    pendingReadyResolver
            ) {
                pendingReadyResolverRef.current = null;
            }
            clearInterval(refresh);
            updateListDebounced.cancel();
            remoteRootConfirmationScheduler.reset();
            if (
                remoteRootConfirmationSchedulerRef.current?.scheduler ===
                remoteRootConfirmationScheduler
            ) {
                remoteRootConfirmationSchedulerRef.current = null;
            }
            if (
                remoteRootReconciliationStateRef.current ===
                remoteRootReconciliationState
            ) {
                remoteRootReconciliationStateRef.current =
                    createRemoteRootReconciliationState();
            }
            listRefreshGenerationRef.current += 1;
            listRefreshRef.current = null;
            queuedListRefreshSourceRef.current = null;
            if (
                adaptiveRefreshRef.current?.generation ===
                    refreshContext.generation &&
                adaptiveRefreshRef.current.program === program
            ) {
                adaptiveRefreshRef.current = null;
            }
            if (
                adaptiveRefreshSignatureRef.current?.generation ===
                    refreshContext.generation &&
                adaptiveRefreshSignatureRef.current.program === program
            ) {
                adaptiveRefreshSignatureRef.current = null;
            }

            program.files.log.events.removeEventListener(
                "join",
                updateListForProgram
            );
            program.files.log.events.removeEventListener(
                "leave",
                updateListDebounced
            );
            program.files.events.removeEventListener(
                "change",
                filesChangeListener
            );
            program.files.log.events.removeEventListener(
                "replication:change",
                replicatorsChangeListener
            );
        };
    }, [files.program, files.program?.closed]);

    const refreshList = async (
        source: string,
        generation: number,
        program: Files
    ) => {
        const refreshContext = { generation, program };
        const isContextCurrent = createRefreshContextGuard(
            getCurrentRefreshContext,
            refreshContext
        );
        if (program.files.log.closed || !isContextCurrent()) {
            return;
        }

        const benchmarkWindow = window as Window & {
            __peerbitFileShareBenchmarkStats?: {
                updateListCalls?: Array<Record<string, unknown>>;
            };
        };
        const updateListStartedAt = performance.now();
        const updateListStats: Record<string, unknown> = {
            source,
            startedAt: Date.now(),
        };
        const remoteRootReconciliationState =
            remoteRootReconciliationStateRef.current;
        const scheduleRemoteRootConfirmations = (
            ids: Iterable<string>,
            rateLimited: boolean
        ) => {
            const confirmationScheduler =
                remoteRootConfirmationSchedulerRef.current;
            if (
                confirmationScheduler?.generation !== generation ||
                confirmationScheduler.program !== program
            ) {
                return;
            }
            let run = activeTransferCountRef.current === 0;
            if (run && rateLimited) {
                const now = Date.now();
                const lastStartedAt =
                    remoteRootConfirmationRunStartedAtRef.current;
                run =
                    lastStartedAt == null ||
                    now - lastStartedAt >=
                        REMOTE_ROOT_RECONCILIATION_INTERVAL_MS;
                if (run) {
                    remoteRootConfirmationRunStartedAtRef.current = now;
                }
            }
            void confirmationScheduler.scheduler
                .schedule(
                    ids,
                    {
                        generation,
                        program,
                        rootRevision: rootListRevisionRef.current,
                    },
                    run
                )
                .catch((error) => {
                    if (isContextCurrent()) {
                        console.warn(
                            "Failed to confirm remote roots: " +
                                (error instanceof Error
                                    ? error.message
                                    : String(error))
                        );
                    }
                });
        };
        const listLocalRootMetadata = () =>
            program.files.index.search(
                new SearchRequest({
                    query: new IsNull({ key: "parentId" }),
                    fetch: 0xffffffff,
                }),
                {
                    local: true,
                    remote: false,
                }
            );
        const queueRefreshAfterStaleRootRevision = () => {
            diagnosticsRef.current.staleListResultIgnoredCount += 1;
            updateListStats.staleListResultIgnored = true;
            updateListStats.displayListCount = listRef.current.length;
            queueCoalescedRefresh(
                queuedListRefreshSourceRef,
                coalesceRootListRefreshSource(
                    queuedListRefreshSourceRef.current,
                    "stale-root-revision"
                )
            );
        };

        // TODO don't reload the whole list, just add the new elements..
        try {
            diagnosticsRef.current.listCallCount += 1;
            const startedAt = Date.now();
            if (diagnosticsRef.current.firstListStartedAt == null) {
                diagnosticsRef.current.firstListStartedAt = startedAt;
                diagnosticsRef.current.firstListSource = source;
            }
            const listStartedAt = performance.now();
            const rootListRevision = rootListRevisionRef.current;
            const listRole = currentRoleRef.current;
            const [list, observerLocalRootFiles] = await Promise.all([
                listRootFilesForRole(program, listRole),
                listRole === false
                    ? listLocalRootMetadata().catch((error) => {
                          if (isContextCurrent()) {
                              console.warn(
                                  "Failed to distinguish local observer roots: " +
                                      (error instanceof Error
                                          ? error.message
                                          : String(error))
                              );
                          }
                          return undefined;
                      })
                    : Promise.resolve(undefined),
            ]);
            updateListStats.listMs = performance.now() - listStartedAt;
            updateListStats.listCount = list.length;
            updateListStats.listMode =
                listRole === false ? "observer-remote" : "replicator-local";
            if (!isContextCurrent()) {
                return;
            }
            const finishedAt = Date.now();
            if (diagnosticsRef.current.firstListFinishedAt == null) {
                diagnosticsRef.current.firstListFinishedAt = finishedAt;
                diagnosticsRef.current.firstListDurationMs =
                    finishedAt - startedAt;
            }
            const rootFiles = sortRootFilesForDisplay(
                list.filter((x) => !x.parentId)
            );
            if (rootListRevision === rootListRevisionRef.current) {
                let observerRemoteRootObservation:
                    | ReturnType<typeof observeRemoteRootSnapshot>
                    | undefined;
                const visibleRootFiles = (() => {
                    if (listRole !== false) {
                        return observeLocalRootSnapshot(
                            remoteRootReconciliationState,
                            rootFiles
                        );
                    }
                    if (observerLocalRootFiles == null) {
                        return rootFiles.filter(
                            (file) =>
                                !remoteRootReconciliationState.suppressedIds.has(
                                    file.id
                                )
                        );
                    }
                    observeLocalRootSnapshot(
                        remoteRootReconciliationState,
                        observerLocalRootFiles ?? []
                    );
                    observerRemoteRootObservation = observeRemoteRootSnapshot(
                        remoteRootReconciliationState,
                        rootFiles
                    );
                    const confirmationScheduler =
                        remoteRootConfirmationSchedulerRef.current;
                    if (
                        confirmationScheduler?.generation === generation &&
                        confirmationScheduler.program === program
                    ) {
                        invalidateRemoteRootAbsenceForVisibleRoots(
                            confirmationScheduler.scheduler,
                            observerRemoteRootObservation.visibleRoots
                        );
                    }
                    return observerRemoteRootObservation.visibleRoots;
                })();
                const displayRootFiles = applyRootFileChangeToList(
                    listRef.current,
                    { added: visibleRootFiles, removed: [] }
                );
                updateListStats.displayListCount = displayRootFiles.length;
                setRootList(displayRootFiles);
                reconcilePendingReadyRoots(
                    program,
                    refreshContext,
                    displayRootFiles
                );
                const readyLargeFileSignature =
                    getReadyLargeFileSignature(displayRootFiles);
                if (readyLargeFileSignature) {
                    scheduleAdaptiveRefresh(
                        `ready-list:${source}`,
                        readyLargeFileSignature,
                        refreshContext
                    );
                }
                forceUpdate();
                if (observerRemoteRootObservation) {
                    scheduleRemoteRootConfirmations(
                        observerRemoteRootObservation.confirmationIds,
                        true
                    );
                }
            } else {
                queueRefreshAfterStaleRootRevision();
                return;
            }
            const remoteReconciliationStartedAt = Date.now();
            if (
                shouldReconcileRemoteRootFiles({
                    role: listRole,
                    source,
                    now: remoteReconciliationStartedAt,
                    lastStartedAt: remoteRootReconciliationStartedAtRef.current,
                })
            ) {
                remoteRootReconciliationStartedAtRef.current =
                    remoteReconciliationStartedAt;
                const remoteRootListRevision = rootListRevisionRef.current;
                const remoteListStartedAt = performance.now();
                try {
                    const remoteList =
                        await listRemoteRootFilesForReconciliation(program);
                    updateListStats.remoteReconciliationMs =
                        performance.now() - remoteListStartedAt;
                    updateListStats.remoteReconciliationCount =
                        remoteList.length;
                    updateListStats.remoteReconciliationMode =
                        "partial-remote-merge";
                    if (!isContextCurrent()) {
                        return;
                    }
                    if (
                        remoteRootListRevision !== rootListRevisionRef.current
                    ) {
                        queueRefreshAfterStaleRootRevision();
                        return;
                    }
                    const remoteRootFiles = sortRootFilesForDisplay(
                        remoteList.filter((file) => !file.parentId)
                    );
                    const remoteRootObservation = observeRemoteRootSnapshot(
                        remoteRootReconciliationState,
                        remoteRootFiles
                    );
                    const confirmationScheduler =
                        remoteRootConfirmationSchedulerRef.current;
                    if (
                        confirmationScheduler?.generation === generation &&
                        confirmationScheduler.program === program
                    ) {
                        invalidateRemoteRootAbsenceForVisibleRoots(
                            confirmationScheduler.scheduler,
                            remoteRootObservation.visibleRoots
                        );
                    }
                    const displayRootFiles = applyRootFileChangeToList(
                        listRef.current,
                        {
                            added: remoteRootObservation.visibleRoots,
                            removed: [],
                        }
                    );
                    updateListStats.displayListCount = displayRootFiles.length;
                    setRootList(displayRootFiles);
                    reconcilePendingReadyRoots(
                        program,
                        refreshContext,
                        displayRootFiles
                    );
                    const readyLargeFileSignature =
                        getReadyLargeFileSignature(displayRootFiles);
                    if (readyLargeFileSignature) {
                        scheduleAdaptiveRefresh(
                            `ready-remote-list:${source}`,
                            readyLargeFileSignature,
                            refreshContext
                        );
                    }
                    forceUpdate();
                    scheduleRemoteRootConfirmations(
                        remoteRootObservation.confirmationIds,
                        false
                    );
                } catch (error) {
                    if (isContextCurrent()) {
                        updateListStats.remoteReconciliationError =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        console.warn(
                            "Failed to reconcile remote root list: " +
                                (error instanceof Error
                                    ? error.message
                                    : String(error))
                        );
                    }
                }
            }
            try {
                const metadataStartedAt = performance.now();
                const [localRootFiles, replicators] = await Promise.all([
                    observerLocalRootFiles ?? listLocalRootMetadata(),
                    program.files.log.getReplicators(),
                ]);
                if (!isContextCurrent()) {
                    return;
                }
                updateListStats.metadataMs =
                    performance.now() - metadataStartedAt;
                updateListStats.replicationSetSize = localRootFiles.length;
                updateListStats.replicatorCount = replicators.size;
                updateListStats.totalMs =
                    performance.now() - updateListStartedAt;
                const updateListCalls =
                    benchmarkWindow.__peerbitFileShareBenchmarkStats
                        ?.updateListCalls ?? [];
                updateListCalls.push(updateListStats);
                benchmarkWindow.__peerbitFileShareBenchmarkStats = {
                    updateListCalls,
                };
                setReplicationSet(
                    new Set(localRootFiles.map((file) => file.id))
                );
                setReplicatorCount(replicators.size);
                if (
                    diagnosticsRef.current.firstMetadataRefreshFinishedAt ==
                    null
                ) {
                    diagnosticsRef.current.firstMetadataRefreshFinishedAt =
                        Date.now();
                }
                forceUpdate();
            } catch (error) {
                if (isContextCurrent()) {
                    console.warn(
                        "Failed to refresh replication metadata: " +
                            (error instanceof Error
                                ? error.message
                                : String(error))
                    );
                }
            }
        } catch (error) {
            if (isContextCurrent()) {
                console.warn(
                    "Failed to resolve complete file list: " +
                        (error instanceof Error ? error.message : String(error))
                );
            }
        }
    };

    const updateList = (
        sourceOrEvent: string | Event = "refresh",
        context?: RefreshContext<Files>
    ) => {
        const program = context?.program ?? files.program;
        const generation =
            context?.generation ?? listRefreshGenerationRef.current;
        const refreshContext = program ? { generation, program } : undefined;
        const isContextCurrent = refreshContext
            ? createRefreshContextGuard(
                  getCurrentRefreshContext,
                  refreshContext
              )
            : () => false;
        if (!program || program.files.log.closed || !isContextCurrent()) {
            return Promise.resolve();
        }

        const source = getRootListRefreshSource(sourceOrEvent);
        queueCoalescedRefresh(
            queuedListRefreshSourceRef,
            coalesceRootListRefreshSource(
                queuedListRefreshSourceRef.current,
                source
            )
        );
        if (listRefreshRef.current) {
            diagnosticsRef.current.coalescedListRefreshCount += 1;
            diagnosticsRef.current.lastCoalescedListSource = source;
            return listRefreshRef.current;
        }

        const refresh = (async () => {
            diagnosticsRef.current.listRefreshInFlight = true;
            try {
                await drainCoalescedRefreshQueue(
                    queuedListRefreshSourceRef,
                    isContextCurrent,
                    (queuedSource) =>
                        refreshList(queuedSource, generation, program)
                );
            } finally {
                if (listRefreshRef.current === refresh) {
                    listRefreshRef.current = null;
                }
                if (isContextCurrent()) {
                    diagnosticsRef.current.listRefreshInFlight = false;
                }
            }
        })();
        listRefreshRef.current = refresh;
        return refresh;
    };

    const download = async (
        file: AbstractFile,
        progress: (progress: number | null) => void
    ) => {
        const program = files.program;
        if (!program || program.closed) {
            progress(null);
            return;
        }
        const timeout = getDownloadTimeout(file);
        startActiveTransfer();
        try {
            if (isLargeFileLike(file)) {
                program.retainFileRead(file);
            }

            // Do not change the replication role around a download. Switching a
            // live reader to observer mode can detach the fanout route that a
            // partially-local file still needs for its missing chunk queries.

            const saveFilePicker = (window as SaveFilePickerWindow)
                .showSaveFilePicker;

            if (
                saveFilePicker &&
                getFileSizeBigInt(file) >= getStreamingDownloadThresholdBytes()
            ) {
                const handle = await saveFilePicker({
                    suggestedName: file.name,
                }).catch((error) => {
                    if (isUserCancelledDownload(error)) {
                        return undefined;
                    }
                    throw error;
                });
                if (handle) {
                    const writable = await handle.createWritable();
                    await file.writeFile(program, writable, {
                        timeout,
                        progress: (value) => {
                            progress(value);
                        },
                    });
                    return;
                }
                return;
            }

            const bytes = await file.getFile(program, {
                as: "chunks",
                timeout,
                progress,
            });
            const blob = new Blob(bytes as BlobPart[]);
            const link = document.createElement("a");
            const url = window.URL.createObjectURL(blob);
            link.href = url;
            link.download = file.name;
            link.click();
            setTimeout(() => {
                window.URL.revokeObjectURL(url);
            }, 60_000);
        } finally {
            finishActiveTransfer();
            scheduleAdaptiveRefresh("download-finished");
            progress(null);
        }
    };

    const reportUploadFailure = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        alert("Failed to upload: " + message);
    };

    function dropHandler(ev) {
        console.log("File(s) dropped");

        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        if (!isHost) {
            alert("Not host!");
            ev.stopPropagation();
            return;
        }

        let promises: Promise<any>[] = [];
        setUploadProgress(0);
        if (ev.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            [...ev.dataTransfer.items].forEach((item, i) => {
                // If dropped items aren't files, reject them
                if (item.kind === "file") {
                    const file: File = item.getAsFile();
                    promises.push(addFile([file], false));
                }
            });
        } else {
            // Use DataTransfer interface to access the file(s)
            [...ev.dataTransfer.files].forEach((file, i) => {
                promises.push(addFile([file], false));
            });
        }
        void settleUploadBatch(promises, reportUploadFailure)
            .finally(() => {
                setUploadProgress(null);
            })
            .catch((error) => {
                console.warn("Failed to finish upload batch", error);
            });
    }

    const addFile = async (
        filesToAdd: FileList | File[] | null | undefined,
        endProgress = true
    ) => {
        const uploadFiles = filesToAdd ? [...filesToAdd] : [];
        const transferStarted = uploadFiles.length > 0;
        if (transferStarted) {
            startActiveTransfer();
        }

        try {
            await Promise.all(
                uploadFiles.map((file) =>
                    files.program.addBlob(
                        file.name,
                        file,
                        undefined,
                        (progress) => {
                            setUploadProgress((current) =>
                                current == null
                                    ? progress
                                    : Math.max(progress, current)
                            );
                        }
                    )
                )
            );
            scheduleAdaptiveRefresh("upload-complete");
            void updateList();
        } finally {
            if (endProgress) {
                setUploadProgress(null);
            }
            if (transferStarted) {
                finishActiveTransfer();
            }
        }
    };

    const goBack = () => (
        <button
            className="w-fit btn btn-elevated flex flex-row items-center p-2"
            onClick={() => {
                setLeft(true);
                navigate("/");
            }}
        >
            <MdArrowBack size={20} className="mr-2" /> <span>Create space</span>
        </button>
    );

    function dragOverHandler(ev) {
        // Prevent default behavior (Prevent file from being opened)
        ev.preventDefault();

        if (!isHost) {
            return;
        }
    }

    return (
        <>
            {files.loading ? (
                <div className="flex flex-col items-center justify-center content-center h-full gap-4">
                    <div className="flex flex-row gap-4 items-center justify-center">
                        <span className="italic">Loading</span> <Spinner />
                    </div>{" "}
                    {goBack()}
                </div>
            ) : (
                <div
                    onDrop={dropHandler}
                    onDragOver={dragOverHandler}
                    className="flex flex-col h-[calc(100% - 40px)] items-center w-screen h-full  "
                >
                    <div className="max-w-3xl w-full flex flex-col p-4 gap-4 ">
                        <div className="flex flex-row gap-4 items-center">
                            <div className="flex flex-col ">
                                <h1 className="text-3xl italic">
                                    {files.program?.name}
                                </h1>
                                <span className="font-mono text-xs">
                                    Seeders:{" "}
                                    <span
                                        className="!text-green-400"
                                        data-testid="seeder-count"
                                    >
                                        {replicatorCount}
                                    </span>
                                </span>
                                <span className="italic text-xs">
                                    Copy the URL to share all files
                                </span>
                                <span className="text-xs ">
                                    Used storage: {memory} kB
                                </span>
                                <span className="text-xs ">
                                    ↑ {up} kb/s ↓ {down} kb/s
                                </span>
                            </div>

                            <div className="ml-auto flex flex-row items-end gap-2 align-items: center">
                                {isHost && (
                                    <>
                                        <input
                                            type="file"
                                            id="imgupload"
                                            data-testid="upload-input"
                                            className="hidden"
                                            onChange={(e) => {
                                                void addFile(
                                                    e.target?.files
                                                ).catch(reportUploadFailure);
                                            }}
                                        />
                                        <button
                                            className="w-fit btn btn-elevated flex flex-row items-center gap-2"
                                            onClick={() => {
                                                document
                                                    .getElementById("imgupload")
                                                    .click();
                                            }}
                                        >
                                            <span className="hidden sm:block">
                                                Upload
                                            </span>{" "}
                                            <MdUploadFile size={20} />
                                        </button>
                                    </>
                                )}
                                {!isHost && goBack()}
                            </div>
                            <Toggle.Root
                                data-testid="seed-toggle"
                                onPressedChange={(e) => {
                                    selectRole(e ? "replicator" : "observer");
                                }}
                                disabled={!files.program}
                                pressed={role === "replicator"}
                                className="w-fit btn-icon btn-toggle flex flex-row items-center gap-2"
                                aria-label="Toggle italic"
                            >
                                <span className="hidden sm:block">Seed</span>
                                <FaSeedling
                                    className="text-green-400"
                                    size={20}
                                />
                            </Toggle.Root>

                            <Popover.Root>
                                <Popover.Trigger asChild>
                                    <button className="w-fit btn-icon btn-toggle flex flex-row items-center gap-2">
                                        <span className="hidden sm:block">
                                            Settings
                                        </span>
                                        <MdSettings size={20} />
                                    </button>
                                </Popover.Trigger>
                                <Popover.Portal>
                                    <Popover.Content
                                        className="popover-content"
                                        sideOffset={5}
                                    >
                                        <div className="flex flex-col gap-2">
                                            <fieldset className="flex flex-row gap-4">
                                                <label
                                                    className="Label"
                                                    htmlFor="seed"
                                                >
                                                    Seed
                                                </label>
                                                <Switch.Root
                                                    className="SwitchRoot"
                                                    id="seed"
                                                    onCheckedChange={(e) => {
                                                        selectRole(
                                                            e
                                                                ? "replicator"
                                                                : "observer"
                                                        );
                                                    }}
                                                    disabled={!files.program}
                                                    checked={
                                                        role === "replicator"
                                                    }
                                                >
                                                    <Switch.Thumb className="SwitchThumb" />
                                                </Switch.Root>
                                            </fieldset>
                                            {role === "replicator" && (
                                                <div className="flex flex-col gap-4 mt-4">
                                                    <span>Limit</span>
                                                    <fieldset className="flex flex-col gap-2">
                                                        <div className="flex flex-row gap-4">
                                                            <label htmlFor="limit-storage">
                                                                Storage
                                                            </label>
                                                            <Switch.Root
                                                                className="SwitchRoot"
                                                                id="limit-storage"
                                                                onCheckedChange={(
                                                                    e
                                                                ) => {
                                                                    setLimitStorage(
                                                                        e
                                                                    );
                                                                }}
                                                                disabled={
                                                                    !files.program
                                                                }
                                                                checked={
                                                                    limitStorage
                                                                }
                                                            >
                                                                <Switch.Thumb className="SwitchThumb" />
                                                            </Switch.Root>
                                                        </div>
                                                        <div className="pl-4 flex flex-col gap-2">
                                                            <span className="text-xs italic">
                                                                Limit how much
                                                                data you want to
                                                                replicate (MB).
                                                                This is an
                                                                approximation of
                                                                real usage
                                                            </span>

                                                            {limitStorage && (
                                                                <input
                                                                    className="p-2"
                                                                    onChange={(
                                                                        v
                                                                    ) => {
                                                                        setLimitStorageString(
                                                                            v
                                                                                .target
                                                                                .value
                                                                        );
                                                                    }}
                                                                    id="storage"
                                                                    type="number"
                                                                    value={
                                                                        limitStorageString ||
                                                                        ""
                                                                    }
                                                                    placeholder="(Mb)"
                                                                ></input>
                                                            )}
                                                        </div>
                                                    </fieldset>
                                                    <fieldset className="flex flex-col gap-2">
                                                        <div className="flex flex-row gap-4">
                                                            <label htmlFor="limit-cpu">
                                                                CPU
                                                            </label>
                                                            <Switch.Root
                                                                className="SwitchRoot"
                                                                id="limit-cpu"
                                                                onCheckedChange={(
                                                                    e
                                                                ) => {
                                                                    setLimitCPU(
                                                                        e
                                                                            ? (limitCPU ??
                                                                                  0)
                                                                            : undefined
                                                                    );
                                                                }}
                                                                disabled={
                                                                    !files.program
                                                                }
                                                                checked={
                                                                    limitCPU !=
                                                                    null
                                                                }
                                                            >
                                                                <Switch.Thumb className="SwitchThumb" />
                                                            </Switch.Root>
                                                        </div>
                                                        <div className="pl-4 flex flex-col gap-2">
                                                            <span className="text-xs italic">
                                                                By limiting
                                                                replication by
                                                                CPU usage, you
                                                                allow the
                                                                replication
                                                                degree to be
                                                                reduced when the
                                                                page gets
                                                                minimized (and
                                                                throttled)
                                                            </span>
                                                            {limitCPU !=
                                                                null && (
                                                                <div className="flex flex-row gap-2">
                                                                    <span className="text-sm">
                                                                        Limited
                                                                    </span>
                                                                    <Slider.Root
                                                                        className="slider-root"
                                                                        defaultValue={[
                                                                            0,
                                                                        ]}
                                                                        value={[
                                                                            limitCPU,
                                                                        ]}
                                                                        max={1}
                                                                        min={0}
                                                                        step={
                                                                            0.01
                                                                        }
                                                                        onValueChange={(
                                                                            v
                                                                        ) => {
                                                                            setLimitCPU(
                                                                                v[0]
                                                                            );
                                                                        }}
                                                                    >
                                                                        <Slider.Track className="slider-track">
                                                                            <Slider.Range className="slider-range" />
                                                                        </Slider.Track>
                                                                        <Slider.Thumb
                                                                            className="slider-thumb"
                                                                            aria-label="Max utilization"
                                                                        />
                                                                    </Slider.Root>
                                                                    <span className="text-sm">
                                                                        Unlimited
                                                                    </span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </fieldset>

                                                    {/* TODO  <fieldset className="flex flex-col gap-2">
                                                    <label className="Label" htmlFor="bandwidth">
                                                        Limit upload
                                                    </label>
                                                    <input
                                                        className="p-2"
                                                        onChange={(v) => {


                                                        }}
                                                        id="bandwidth"
                                                        type="number"
                                                        placeholder="(MB/s)"
                                                    ></input>
                                                </fieldset> */}
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-4">
                                            <GraphExplorer
                                                log={files.program?.files.log}
                                            />
                                        </div>

                                        <Popover.Close
                                            className="popover-close"
                                            aria-label="Close"
                                        >
                                            <MdClose />
                                        </Popover.Close>
                                        <Popover.Arrow className="popover-arrow" />
                                    </Popover.Content>
                                </Popover.Portal>
                            </Popover.Root>
                        </div>
                        <br />
                        {uploadProgress != null && (
                            <Progress.Root
                                data-testid="upload-progress"
                                className="progress-root w-full h-3"
                                value={uploadProgress}
                            >
                                <Progress.Indicator
                                    className="progress-indicator"
                                    style={{
                                        transform: `translateX(-${
                                            100 - uploadProgress * 100
                                        }%)`,
                                    }}
                                />
                            </Progress.Root>
                        )}
                        {list?.length > 0 ? (
                            <div className="flex justify-start flex-col">
                                <h1 className="text-xl">
                                    Files ({list.length}):
                                </h1>
                                <ul data-testid="file-list">
                                    {list.map((x) => {
                                        return (
                                            <li key={x.id}>
                                                <File
                                                    isHost={isHost}
                                                    delete={() => {
                                                        files.program
                                                            .removeById(x.id)
                                                            .then(() => {
                                                                updateList();
                                                            })
                                                            .catch((error) => {
                                                                alert(
                                                                    "Failed to delete: " +
                                                                        error.message
                                                                );
                                                            });
                                                    }}
                                                    download={(progress) =>
                                                        download(x, progress)
                                                    }
                                                    files={files.program}
                                                    file={x}
                                                    replicated={
                                                        role === "replicator" &&
                                                        replicationSet.has(x.id)
                                                    }
                                                />
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ) : (
                            <span className="italic">No files available</span>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};
