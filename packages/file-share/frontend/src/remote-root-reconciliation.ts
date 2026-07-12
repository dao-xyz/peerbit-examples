import type { AbstractFile } from "@peerbit/please-lib";
import type { RemoteRootConfirmation } from "./remote-root-confirmation";

export type RemoteRootVersion = {
    head: string;
    modified: bigint;
};

type VersionedRootReference = Pick<AbstractFile, "id"> & {
    __context?: {
        head?: unknown;
        modified?: unknown;
    };
};

type RemoteRootSuppression = {
    version?: RemoteRootVersion;
};

export type RemoteRootReconciliationState = {
    localRootIds: Set<string>;
    remoteOnlyIds: Set<string>;
    suppressedIds: Map<string, RemoteRootSuppression>;
    observedVersions: Map<string, RemoteRootVersion>;
};

export const createRemoteRootReconciliationState =
    (): RemoteRootReconciliationState => ({
        localRootIds: new Set(),
        remoteOnlyIds: new Set(),
        suppressedIds: new Map(),
        observedVersions: new Map(),
    });

const getRootVersion = (
    root: VersionedRootReference
): RemoteRootVersion | undefined => {
    const head = root.__context?.head;
    const modified = root.__context?.modified;
    if (typeof head !== "string" || typeof modified !== "bigint") {
        return undefined;
    }
    return { head, modified };
};

const rememberRootVersion = (
    state: RemoteRootReconciliationState,
    root: VersionedRootReference
) => {
    const candidate = getRootVersion(root);
    if (!candidate) {
        return;
    }
    const current = state.observedVersions.get(root.id);
    if (!current || candidate.modified > current.modified) {
        state.observedVersions.set(root.id, candidate);
    }
};

const setObservedRootVersion = (
    state: RemoteRootReconciliationState,
    root: VersionedRootReference
) => {
    const version = getRootVersion(root);
    if (version) {
        state.observedVersions.set(root.id, version);
    } else {
        state.observedVersions.delete(root.id);
    }
};

const isCausallyNewer = (
    candidate: RemoteRootVersion | undefined,
    previous: RemoteRootVersion | undefined
) =>
    candidate != null &&
    previous != null &&
    candidate.head !== previous.head &&
    candidate.modified > previous.modified;

export const recordExplicitRootChange = (
    state: RemoteRootReconciliationState,
    change: {
        removed: Iterable<VersionedRootReference>;
        added: Iterable<VersionedRootReference>;
    }
) => {
    const changedIds = new Set<string>();
    for (const root of change.removed) {
        const id = root.id;
        changedIds.add(id);
        state.localRootIds.delete(id);
        state.remoteOnlyIds.delete(id);
        const version = getRootVersion(root) ?? state.observedVersions.get(id);
        state.suppressedIds.set(id, { version });
        if (version) {
            state.observedVersions.set(id, version);
        }
    }
    // Additions are processed second so remove+add recreation wins.
    for (const root of change.added) {
        const id = root.id;
        changedIds.add(id);
        state.suppressedIds.delete(id);
        state.remoteOnlyIds.delete(id);
        state.localRootIds.add(id);
        setObservedRootVersion(state, root);
    }
    return changedIds;
};

export const observeLocalRootSnapshot = <
    TRoot extends Pick<AbstractFile, "id">,
>(
    state: RemoteRootReconciliationState,
    roots: TRoot[]
) => {
    const visibleRoots = roots.filter(
        (root) => !state.suppressedIds.has(root.id)
    );
    const nextLocalIds = new Set(visibleRoots.map((root) => root.id));
    for (const id of state.localRootIds) {
        if (!nextLocalIds.has(id) && !state.suppressedIds.has(id)) {
            state.remoteOnlyIds.add(id);
        }
    }
    state.localRootIds.clear();
    for (const root of visibleRoots) {
        state.localRootIds.add(root.id);
        state.remoteOnlyIds.delete(root.id);
        setObservedRootVersion(state, root);
    }
    return visibleRoots;
};

export const observeRemoteRootSnapshot = (
    state: RemoteRootReconciliationState,
    roots: AbstractFile[]
) => {
    const seenIds = new Set(roots.map((root) => root.id));
    const confirmationIds = new Set<string>();
    for (const id of state.remoteOnlyIds) {
        if (!seenIds.has(id)) {
            confirmationIds.add(id);
        }
    }
    for (const id of state.suppressedIds.keys()) {
        if (seenIds.has(id)) {
            confirmationIds.add(id);
        }
    }

    const visibleRoots = roots.filter(
        (root) => !state.suppressedIds.has(root.id)
    );
    for (const root of visibleRoots) {
        if (state.localRootIds.has(root.id)) {
            state.remoteOnlyIds.delete(root.id);
        } else {
            state.remoteOnlyIds.add(root.id);
        }
        rememberRootVersion(state, root);
    }
    return { visibleRoots, confirmationIds: [...confirmationIds] };
};

export type RemoteRootConfirmationAction =
    | { type: "merge"; root: AbstractFile; retry: false }
    | { type: "remove"; retry: false }
    | { type: "retain"; retry: boolean };

export const applyRemoteRootConfirmation = (
    state: RemoteRootReconciliationState,
    id: string,
    confirmation: RemoteRootConfirmation
): RemoteRootConfirmationAction => {
    if (confirmation.status === "unknown") {
        return { type: "retain", retry: true };
    }
    if (confirmation.status === "present") {
        const suppression = state.suppressedIds.get(id);
        if (
            suppression &&
            !isCausallyNewer(
                getRootVersion(confirmation.root),
                suppression.version
            )
        ) {
            return { type: "retain", retry: true };
        }
        state.suppressedIds.delete(id);
        setObservedRootVersion(state, confirmation.root);
        if (state.localRootIds.has(id)) {
            state.remoteOnlyIds.delete(id);
        } else {
            state.remoteOnlyIds.add(id);
        }
        return { type: "merge", root: confirmation.root, retry: false };
    }

    const wasTrackedRemoteOnly = state.remoteOnlyIds.delete(id);
    if (wasTrackedRemoteOnly) {
        state.suppressedIds.set(id, {
            version: state.observedVersions.get(id),
        });
        return { type: "remove", retry: false };
    }
    return { type: "retain", retry: false };
};

export type RemoteRootObservation<TProgram> = {
    generation: number;
    program: TProgram;
    rootRevision: number;
};

export const isRemoteRootObservationCurrent = <TProgram>(
    current: RemoteRootObservation<TProgram | null>,
    expected: RemoteRootObservation<TProgram>
) =>
    current.generation === expected.generation &&
    current.program === expected.program &&
    current.rootRevision === expected.rootRevision;

type ConfirmationDisposition = "complete" | "retry";

export type RemoteRootConfirmationScheduler<TContext> = {
    readonly inFlightSize: number;
    readonly queuedSize: number;
    isPending(id: string): boolean;
    schedule(
        ids: Iterable<string>,
        context: TContext,
        run?: boolean
    ): Promise<void>;
    forget(id: string): void;
    reset(): void;
};

export const invalidateRemoteRootAbsenceForVisibleRoots = (
    scheduler: Pick<RemoteRootConfirmationScheduler<unknown>, "forget">,
    roots: Iterable<Pick<AbstractFile, "id">>
) => {
    for (const root of roots) {
        scheduler.forget(root.id);
    }
};

export const createRemoteRootConfirmationScheduler = <
    TContext,
    TResult,
>(options: {
    confirm: (id: string, signal: AbortSignal) => Promise<TResult>;
    onResult: (
        id: string,
        result: TResult,
        context: TContext
    ) => ConfirmationDisposition | Promise<ConfirmationDisposition>;
    maxCandidatesPerRun?: number;
    concurrency?: number;
}): RemoteRootConfirmationScheduler<TContext> => {
    const maxCandidatesPerRun = Math.max(1, options.maxCandidatesPerRun ?? 8);
    const concurrency = Math.max(1, options.concurrency ?? 2);
    const queue: string[] = [];
    const queued = new Set<string>();
    const deferred = new Set<string>();
    const inFlight = new Map<string, { epoch: number; version: number }>();
    const contexts = new Map<string, TContext>();
    const versions = new Map<string, number>();
    let controller = new AbortController();
    let epoch = 0;
    let requestedRuns = 0;
    let drainPromise: Promise<void> | null = null;

    const enqueue = (id: string) => {
        if (queued.has(id)) {
            return;
        }
        const active = inFlight.get(id);
        if (active) {
            if (
                active.epoch !== epoch ||
                active.version !== (versions.get(id) ?? 0)
            ) {
                deferred.add(id);
            }
            return;
        }
        queued.add(id);
        queue.push(id);
    };

    const runBatch = async (runEpoch: number) => {
        const signal = controller.signal;
        const batch: Array<{
            id: string;
            context: TContext;
            version: number;
        }> = [];
        while (queue.length > 0 && batch.length < maxCandidatesPerRun) {
            const id = queue.shift()!;
            queued.delete(id);
            const context = contexts.get(id);
            if (context == null || inFlight.has(id)) {
                continue;
            }
            const version = versions.get(id) ?? 0;
            inFlight.set(id, { epoch: runEpoch, version });
            batch.push({ id, context, version });
        }

        let cursor = 0;
        const worker = async () => {
            while (cursor < batch.length) {
                if (runEpoch !== epoch || signal.aborted) {
                    return;
                }
                const entry = batch[cursor++];
                let retry = false;
                try {
                    const result = await options.confirm(entry.id, signal);
                    if (
                        runEpoch !== epoch ||
                        signal.aborted ||
                        entry.version !== (versions.get(entry.id) ?? 0)
                    ) {
                        continue;
                    }
                    retry =
                        (await options.onResult(
                            entry.id,
                            result,
                            entry.context
                        )) === "retry";
                } catch {
                    retry = true;
                } finally {
                    const active = inFlight.get(entry.id);
                    const ownsFlight =
                        active?.epoch === runEpoch &&
                        active.version === entry.version;
                    if (ownsFlight) {
                        inFlight.delete(entry.id);
                    }
                    const isCurrent =
                        runEpoch === epoch &&
                        entry.version === (versions.get(entry.id) ?? 0);
                    const hasDeferredReplacement =
                        ownsFlight && deferred.delete(entry.id);
                    if (isCurrent || hasDeferredReplacement) {
                        if (retry || hasDeferredReplacement) {
                            enqueue(entry.id);
                        } else {
                            contexts.delete(entry.id);
                        }
                    }
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, batch.length) }, () =>
                worker()
            )
        );
    };

    const ensureDrain = () => {
        if (!drainPromise) {
            const runEpoch = epoch;
            const nextDrain = Promise.resolve()
                .then(async () => {
                    while (requestedRuns > 0 && runEpoch === epoch) {
                        requestedRuns -= 1;
                        await runBatch(runEpoch);
                    }
                })
                .finally(() => {
                    if (drainPromise === nextDrain) {
                        drainPromise = null;
                        if (requestedRuns > 0) {
                            void ensureDrain();
                        }
                    }
                });
            drainPromise = nextDrain;
        }
        return drainPromise;
    };

    return {
        get inFlightSize() {
            return inFlight.size;
        },
        get queuedSize() {
            return queue.length + deferred.size;
        },
        isPending(id) {
            return queued.has(id) || deferred.has(id) || inFlight.has(id);
        },
        schedule(ids, context, run = true) {
            for (const id of queue) {
                contexts.set(id, context);
            }
            for (const id of ids) {
                contexts.set(id, context);
                enqueue(id);
            }
            if (!run) {
                return drainPromise ?? Promise.resolve();
            }
            requestedRuns += 1;
            return ensureDrain();
        },
        forget(id) {
            versions.set(id, (versions.get(id) ?? 0) + 1);
            contexts.delete(id);
            deferred.delete(id);
            if (queued.delete(id)) {
                const index = queue.indexOf(id);
                if (index >= 0) {
                    queue.splice(index, 1);
                }
            }
        },
        reset() {
            epoch += 1;
            controller.abort();
            controller = new AbortController();
            requestedRuns = 0;
            drainPromise = null;
            queue.length = 0;
            queued.clear();
            deferred.clear();
            inFlight.clear();
            contexts.clear();
            versions.clear();
        },
    };
};
