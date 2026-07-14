export type TransferLane = "default" | "local" | "remote";

export class TransferCancelledError extends Error {
    constructor(message = "File transfer cancelled", options?: ErrorOptions) {
        super(message, options);
        this.name = "AbortError";
    }
}

export const getAbortReason = (
    signal: AbortSignal | undefined,
    fallback = "File transfer cancelled"
) => {
    if (signal?.reason instanceof Error) {
        return signal.reason;
    }
    return new TransferCancelledError(fallback, {
        cause: signal?.reason,
    });
};

export const throwIfAborted = (
    signal: AbortSignal | undefined,
    fallback?: string
) => {
    if (signal?.aborted) {
        throw getAbortReason(signal, fallback);
    }
};

export const raceWithSignal = <T>(
    value: PromiseLike<T> | T,
    signal: AbortSignal | undefined,
    fallback?: string
): Promise<T> => {
    if (!signal) {
        return Promise.resolve(value);
    }
    if (signal.aborted) {
        return Promise.reject(getAbortReason(signal, fallback));
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            settle();
        };
        const onAbort = () =>
            finish(() => reject(getAbortReason(signal, fallback)));
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(value).then(
            (result) => finish(() => resolve(result)),
            (error) => finish(() => reject(error))
        );
    });
};

export type TransferSchedulerSnapshot = {
    activeCount: number;
    activeBytes: number;
    peakCount: number;
    peakBytes: number;
    queuedCount: number;
    activeByLane: Readonly<Record<string, number>>;
};

export type TransferPermit = {
    readonly count: number;
    readonly bytes: number;
    readonly lane: TransferLane;
    readonly released: boolean;
    release(count?: number, bytes?: number): void;
};

type PendingPermit = {
    ownerId: string;
    count: number;
    bytes: number;
    lane: TransferLane;
    signal?: AbortSignal;
    onAbort?: () => void;
    settled: boolean;
    resolve: (permit: TransferPermit) => void;
    reject: (error: unknown) => void;
};

type OwnerQueue = {
    requests: PendingPermit[];
    scheduled: boolean;
};

/**
 * A byte-and-count permit scheduler that rotates owners after every grant.
 *
 * Tasks are intentionally not owned by the scheduler. A failed owner can
 * cancel only its queued permits while other owners continue to make progress.
 */
export class FairTransferScheduler {
    private readonly owners = new Map<string, OwnerQueue>();
    private readonly rotation: string[] = [];
    private readonly activeLaneCounts = new Map<TransferLane, number>();
    private activePermitCount = 0;
    private activePermitBytes = 0;
    private peakPermitCount = 0;
    private peakPermitBytes = 0;
    private pendingPermitCount = 0;
    private closedReason: unknown;
    private reservedRequest?: PendingPermit;
    private lastGrantedOwnerId?: string;

    constructor(
        readonly countLimit: number,
        readonly byteLimit: number,
        private readonly laneCountLimits: Partial<
            Record<TransferLane, number>
        > = {}
    ) {
        if (!Number.isSafeInteger(countLimit) || countLimit <= 0) {
            throw new RangeError("Transfer count limit must be positive");
        }
        if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
            throw new RangeError("Transfer byte limit must be positive");
        }
    }

    get snapshot(): TransferSchedulerSnapshot {
        return {
            activeCount: this.activePermitCount,
            activeBytes: this.activePermitBytes,
            peakCount: this.peakPermitCount,
            peakBytes: this.peakPermitBytes,
            queuedCount: this.pendingPermitCount,
            activeByLane: Object.fromEntries(this.activeLaneCounts),
        };
    }

    private hasSharedCapacity(request: PendingPermit) {
        return (
            this.activePermitCount + request.count <= this.countLimit &&
            (this.activePermitBytes === 0 ||
                this.activePermitBytes + request.bytes <= this.byteLimit)
        );
    }

    private hasLaneCapacity(request: PendingPermit) {
        const laneLimit = this.laneCountLimits[request.lane];
        const laneCount = this.activeLaneCounts.get(request.lane) ?? 0;
        return laneLimit == null || laneCount + request.count <= laneLimit;
    }

    private canGrant(request: PendingPermit) {
        return this.hasSharedCapacity(request) && this.hasLaneCapacity(request);
    }

    private unscheduleOwner(ownerId: string) {
        for (let index = this.rotation.length - 1; index >= 0; index--) {
            if (this.rotation[index] === ownerId) {
                this.rotation.splice(index, 1);
            }
        }
        const owner = this.owners.get(ownerId);
        if (owner) {
            owner.scheduled = false;
        }
    }

    private removePending(request: PendingPermit, reason: unknown) {
        if (request.settled) {
            return;
        }
        const owner = this.owners.get(request.ownerId);
        const index = owner?.requests.indexOf(request) ?? -1;
        if (!owner || index < 0) {
            return;
        }
        owner.requests.splice(index, 1);
        if (this.reservedRequest === request) {
            this.reservedRequest = undefined;
        }
        request.settled = true;
        this.pendingPermitCount -= 1;
        if (request.onAbort) {
            request.signal?.removeEventListener("abort", request.onAbort);
        }
        if (owner.requests.length === 0) {
            this.unscheduleOwner(request.ownerId);
            this.owners.delete(request.ownerId);
        }
        request.reject(reason);
        this.pump();
    }

    private grant(request: PendingPermit) {
        request.settled = true;
        this.pendingPermitCount -= 1;
        if (request.onAbort) {
            request.signal?.removeEventListener("abort", request.onAbort);
        }
        this.activePermitCount += request.count;
        this.lastGrantedOwnerId = request.ownerId;
        this.activePermitBytes += request.bytes;
        this.activeLaneCounts.set(
            request.lane,
            (this.activeLaneCounts.get(request.lane) ?? 0) + request.count
        );
        this.peakPermitCount = Math.max(
            this.peakPermitCount,
            this.activePermitCount
        );
        this.peakPermitBytes = Math.max(
            this.peakPermitBytes,
            this.activePermitBytes
        );

        let remainingCount = request.count;
        let remainingBytes = request.bytes;
        const permit: TransferPermit = {
            get count() {
                return remainingCount;
            },
            get bytes() {
                return remainingBytes;
            },
            lane: request.lane,
            get released() {
                return remainingCount === 0 && remainingBytes === 0;
            },
            release: (count = remainingCount, bytes = remainingBytes) => {
                if (remainingCount === 0 && remainingBytes === 0) {
                    return;
                }
                if (
                    !Number.isSafeInteger(count) ||
                    count < 0 ||
                    count > remainingCount ||
                    !Number.isSafeInteger(bytes) ||
                    bytes < 0 ||
                    bytes > remainingBytes ||
                    (count === 0 && bytes === 0)
                ) {
                    throw new RangeError("Invalid partial permit release");
                }
                remainingCount -= count;
                remainingBytes -= bytes;
                this.activePermitCount -= count;
                this.activePermitBytes -= bytes;
                const laneCount =
                    (this.activeLaneCounts.get(request.lane) ?? count) - count;
                if (laneCount === 0) {
                    this.activeLaneCounts.delete(request.lane);
                } else {
                    this.activeLaneCounts.set(request.lane, laneCount);
                }
                this.pump();
            },
        };
        request.resolve(permit);
    }

    private pump() {
        if (this.closedReason != null || this.rotation.length === 0) {
            return;
        }

        if (this.reservedRequest) {
            const request = this.reservedRequest;
            const owner = this.owners.get(request.ownerId);
            if (!owner || owner.requests[0] !== request) {
                this.reservedRequest = undefined;
            } else if (!this.hasSharedCapacity(request)) {
                return;
            } else if (!this.hasLaneCapacity(request)) {
                // The shared-capacity condition that created the reservation
                // has cleared, but the lane remains saturated. Stop reserving
                // globally and let the normal rotation admit other lanes.
                this.reservedRequest = undefined;
            } else {
                this.reservedRequest = undefined;
                this.unscheduleOwner(request.ownerId);
                owner.requests.shift();
                if (owner.requests.length > 0) {
                    owner.scheduled = true;
                    this.rotation.push(request.ownerId);
                } else {
                    this.owners.delete(request.ownerId);
                }
                this.grant(request);
            }
        }

        let examinedWithoutGrant = 0;
        while (
            this.rotation.length > 0 &&
            examinedWithoutGrant < this.rotation.length
        ) {
            const ownerId = this.rotation.shift()!;
            const owner = this.owners.get(ownerId);
            if (!owner || owner.requests.length === 0) {
                if (owner) {
                    owner.scheduled = false;
                    this.owners.delete(ownerId);
                }
                continue;
            }

            owner.scheduled = false;
            const request = owner.requests[0]!;
            if (!this.canGrant(request)) {
                owner.scheduled = true;
                this.rotation.push(ownerId);
                if (
                    !this.hasSharedCapacity(request) &&
                    this.hasLaneCapacity(request)
                ) {
                    // Stop admitting younger/smaller work until this head
                    // request fits the shared count/byte budget. Existing work
                    // drains, after which this owner receives the next grant;
                    // mixed request sizes therefore cannot starve.
                    this.reservedRequest = request;
                    return;
                }

                // A saturated lane must not reserve otherwise-free shared
                // capacity. Rotate past it so independent lanes can progress.
                examinedWithoutGrant += 1;
                continue;
            }

            owner.requests.shift();
            if (owner.requests.length > 0) {
                owner.scheduled = true;
                this.rotation.push(ownerId);
            } else {
                this.owners.delete(ownerId);
            }
            this.grant(request);
            examinedWithoutGrant = 0;
        }
    }

    acquire(
        ownerId: string,
        bytes: number,
        lane: TransferLane = "default",
        signal?: AbortSignal,
        count = 1
    ): Promise<TransferPermit> {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            return Promise.reject(
                new RangeError(
                    "Transfer reservation bytes must be non-negative"
                )
            );
        }
        if (bytes > this.byteLimit) {
            return Promise.reject(
                new RangeError("Transfer reservation bytes exceed the limit")
            );
        }
        if (!Number.isSafeInteger(count) || count <= 0) {
            return Promise.reject(
                new RangeError("Transfer reservation count must be positive")
            );
        }
        const laneLimit = this.laneCountLimits[lane];
        if (
            count > this.countLimit ||
            (laneLimit != null && count > laneLimit)
        ) {
            return Promise.reject(
                new RangeError("Transfer reservation count exceeds its limit")
            );
        }
        if (this.closedReason != null) {
            return Promise.reject(this.closedReason);
        }
        if (signal?.aborted) {
            return Promise.reject(getAbortReason(signal));
        }

        return new Promise<TransferPermit>((resolve, reject) => {
            const request: PendingPermit = {
                ownerId,
                count,
                bytes,
                lane,
                signal,
                settled: false,
                resolve,
                reject,
            };
            if (signal) {
                request.onAbort = () =>
                    this.removePending(request, getAbortReason(signal));
                signal.addEventListener("abort", request.onAbort, {
                    once: true,
                });
            }
            let owner = this.owners.get(ownerId);
            if (!owner) {
                owner = { requests: [], scheduled: false };
                this.owners.set(ownerId, owner);
            }
            owner.requests.push(request);
            this.pendingPermitCount += 1;
            if (!owner.scheduled) {
                owner.scheduled = true;
                this.rotation.push(ownerId);
                if (
                    this.lastGrantedOwnerId != null &&
                    ownerId !== this.lastGrantedOwnerId &&
                    this.rotation[0] === this.lastGrantedOwnerId
                ) {
                    this.rotation.push(this.rotation.shift()!);
                    if (
                        this.reservedRequest?.ownerId ===
                        this.lastGrantedOwnerId
                    ) {
                        this.reservedRequest = undefined;
                    }
                }
            }
            this.pump();
        });
    }

    cancelOwner(ownerId: string, reason: unknown) {
        const owner = this.owners.get(ownerId);
        if (!owner) {
            return;
        }
        this.unscheduleOwner(ownerId);
        this.owners.delete(ownerId);
        if (this.reservedRequest?.ownerId === ownerId) {
            this.reservedRequest = undefined;
        }
        for (const request of owner.requests.splice(0)) {
            if (request.settled) {
                continue;
            }
            request.settled = true;
            this.pendingPermitCount -= 1;
            if (request.onAbort) {
                request.signal?.removeEventListener("abort", request.onAbort);
            }
            request.reject(reason);
        }
        this.pump();
    }

    close(reason: unknown = new TransferCancelledError()) {
        if (this.closedReason != null) {
            return;
        }
        this.closedReason = reason;
        for (const ownerId of [...this.owners.keys()]) {
            this.cancelOwner(ownerId, reason);
        }
    }

    /**
     * Re-enable admissions after a store lifecycle close. Active permits are
     * deliberately retained: they may belong to decoder/source operations
     * that ignored cancellation and must keep consuming the same hard budget
     * until their original promises settle.
     */
    reopen() {
        if (this.pendingPermitCount !== 0 || this.owners.size !== 0) {
            throw new Error("Cannot reopen a scheduler with queued transfers");
        }
        this.closedReason = undefined;
        this.reservedRequest = undefined;
    }
}

export class FairTransferOwner {
    private readonly abortController = new AbortController();
    private readonly tasks = new Set<Promise<void>>();
    private readonly leases = new Set<TransferPermit>();
    private readonly deferredTaskLeases = new Set<TransferPermit>();
    private readonly cancellationCleanups = new Set<
        (reason: unknown) => void
    >();
    private readonly idleWaiters = new Set<() => void>();
    private hasFailure = false;
    private failure: unknown;
    private activePermitCount = 0;
    private activePermitBytes = 0;
    private peakPermitCount = 0;
    private peakPermitBytes = 0;
    private rejectFailure!: (error: unknown) => void;
    private readonly removeExternalAbort?: () => void;
    readonly failureSignal: Promise<never>;

    constructor(
        private readonly scheduler: FairTransferScheduler,
        readonly id: string,
        externalSignal?: AbortSignal
    ) {
        this.failureSignal = new Promise<never>((_resolve, reject) => {
            this.rejectFailure = reject;
        });
        void this.failureSignal.catch(() => undefined);
        if (externalSignal) {
            const onAbort = () => this.cancel(getAbortReason(externalSignal));
            externalSignal.addEventListener("abort", onAbort, { once: true });
            this.removeExternalAbort = () =>
                externalSignal.removeEventListener("abort", onAbort);
            if (externalSignal.aborted) {
                onAbort();
            }
        }
    }

    get signal() {
        return this.abortController.signal;
    }

    get taskCount() {
        return this.tasks.size;
    }

    get leaseCount() {
        return this.leases.size;
    }

    get snapshot() {
        return {
            activeCount: this.activePermitCount,
            activeBytes: this.activePermitBytes,
            peakCount: this.peakPermitCount,
            peakBytes: this.peakPermitBytes,
        };
    }

    private notifyIdle() {
        if (this.tasks.size !== 0 || this.leases.size !== 0) {
            return;
        }
        for (const resolve of [...this.idleWaiters]) {
            resolve();
        }
        this.idleWaiters.clear();
    }

    private releaseDeferredTaskLeasesIfIdle() {
        if (this.tasks.size !== 0) {
            return;
        }
        for (const lease of [...this.deferredTaskLeases]) {
            this.deferredTaskLeases.delete(lease);
            lease.release();
        }
    }

    throwIfFailed() {
        if (this.hasFailure) {
            throw this.failure;
        }
        throwIfAborted(this.signal);
    }

    private fail(error: unknown) {
        if (this.hasFailure) {
            return;
        }
        this.hasFailure = true;
        this.failure = error;
        this.scheduler.cancelOwner(this.id, error);
        for (const cleanup of [...this.cancellationCleanups]) {
            try {
                cleanup(error);
            } catch {
                // Cancellation must still abort tasks and release sibling
                // cleanup registrations if one best-effort hook fails.
            }
        }
        this.cancellationCleanups.clear();
        if (!this.abortController.signal.aborted) {
            this.abortController.abort(error);
        }
        this.rejectFailure(error);
        this.notifyIdle();
    }

    cancel(reason: unknown = new TransferCancelledError()) {
        this.fail(reason);
    }

    addCancellationCleanup(cleanup: (reason: unknown) => void) {
        if (this.hasFailure) {
            try {
                cleanup(this.failure);
            } catch {
                // The owner is already cancelled; registration remains a
                // best-effort opportunity to discard transfer-owned state.
            }
            return () => undefined;
        }
        this.cancellationCleanups.add(cleanup);
        return () => this.cancellationCleanups.delete(cleanup);
    }

    releaseLeaseAfterTasksSettle(lease: TransferPermit) {
        if (!this.leases.has(lease) || lease.released) {
            return;
        }
        if (this.tasks.size === 0) {
            lease.release();
            return;
        }
        this.deferredTaskLeases.add(lease);
    }

    detachLeaseUntilSettled(
        lease: TransferPermit,
        value: PromiseLike<unknown> | unknown
    ) {
        if (!this.leases.delete(lease) || lease.released) {
            return;
        }
        this.deferredTaskLeases.delete(lease);
        const original = Promise.resolve(value);
        void original.finally(() => lease.release()).catch(() => undefined);
        this.notifyIdle();
    }

    async acquire(
        bytes: number,
        lane: TransferLane = "default"
    ): Promise<TransferPermit> {
        return (await this.acquireBatch(bytes, 1, lane))[0]!;
    }

    async acquireBatch(
        bytesPerPermit: number,
        count: number,
        lane: TransferLane = "default"
    ): Promise<TransferPermit[]> {
        this.throwIfFailed();
        if (!Number.isSafeInteger(bytesPerPermit) || bytesPerPermit < 0) {
            throw new RangeError(
                "Transfer reservation bytes must be non-negative"
            );
        }
        if (!Number.isSafeInteger(count) || count <= 0) {
            throw new RangeError("Transfer reservation count must be positive");
        }
        const totalBytes = bytesPerPermit * count;
        if (!Number.isSafeInteger(totalBytes)) {
            throw new RangeError("Transfer reservation bytes are unsafe");
        }
        const permit = await this.scheduler.acquire(
            this.id,
            totalBytes,
            lane,
            this.signal,
            count
        );
        if (this.hasFailure || this.signal.aborted) {
            permit.release();
            this.throwIfFailed();
        }
        this.activePermitCount += permit.count;
        this.activePermitBytes += permit.bytes;
        this.peakPermitCount = Math.max(
            this.peakPermitCount,
            this.activePermitCount
        );
        this.peakPermitBytes = Math.max(
            this.peakPermitBytes,
            this.activePermitBytes
        );
        return Array.from({ length: count }, () => {
            let remainingCount = 1;
            let remainingBytes = bytesPerPermit;
            const ownedPermit: TransferPermit = {
                get count() {
                    return remainingCount;
                },
                get bytes() {
                    return remainingBytes;
                },
                lane: permit.lane,
                get released() {
                    return remainingCount === 0 && remainingBytes === 0;
                },
                release: (
                    releasedCount = remainingCount,
                    releasedBytes = remainingBytes
                ) => {
                    if (remainingCount === 0 && remainingBytes === 0) {
                        return;
                    }
                    if (
                        !Number.isSafeInteger(releasedCount) ||
                        releasedCount < 0 ||
                        releasedCount > remainingCount ||
                        !Number.isSafeInteger(releasedBytes) ||
                        releasedBytes < 0 ||
                        releasedBytes > remainingBytes ||
                        (releasedCount === 0 && releasedBytes === 0)
                    ) {
                        throw new RangeError("Invalid partial permit release");
                    }
                    remainingCount -= releasedCount;
                    remainingBytes -= releasedBytes;
                    this.activePermitCount -= releasedCount;
                    this.activePermitBytes -= releasedBytes;
                    permit.release(releasedCount, releasedBytes);
                    if (remainingCount === 0 && remainingBytes === 0) {
                        this.leases.delete(ownedPermit);
                        this.deferredTaskLeases.delete(ownedPermit);
                    }
                    this.notifyIdle();
                },
            };
            this.leases.add(ownedPermit);
            return ownedPermit;
        });
    }

    track<T>(value: PromiseLike<T> | T, failOnReject = true): Promise<T> {
        const original = Promise.resolve(value);
        const tracked: Promise<void> = original
            .then(
                () => undefined,
                (error) => {
                    if (failOnReject) {
                        this.fail(error);
                    }
                }
            )
            .finally(() => {
                this.tasks.delete(tracked);
                this.releaseDeferredTaskLeasesIfIdle();
                this.notifyIdle();
            });
        this.tasks.add(tracked);
        void tracked.catch(() => undefined);
        return original;
    }

    async enqueue(
        bytes: number,
        task: () => Promise<void> | void,
        lane: TransferLane = "default"
    ) {
        const permit = await this.acquire(bytes, lane);
        this.enqueueWithPermit(permit, task);
    }

    enqueueWithPermit(
        permit: TransferPermit,
        task: () => Promise<void> | void
    ) {
        let taskPromise: Promise<void>;
        try {
            this.throwIfFailed();
            // Invoke immediately after the grant. Stable copies allocated by
            // the callback are therefore covered by the byte reservation.
            taskPromise = Promise.resolve(task());
        } catch (error) {
            taskPromise = Promise.reject(error);
        }
        const tracked = taskPromise
            .catch((error) => {
                this.fail(error);
                throw error;
            })
            .finally(() => {
                this.tasks.delete(tracked);
                permit.release();
                this.releaseDeferredTaskLeasesIfIdle();
                this.notifyIdle();
            });
        this.tasks.add(tracked);
        void tracked.catch(() => undefined);
    }

    async settle() {
        while (this.tasks.size > 0) {
            await Promise.allSettled([...this.tasks]);
        }
    }

    async waitForIdle() {
        await this.settle();
        if (this.leases.size === 0) {
            return;
        }
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }

    async drain() {
        await this.waitForIdle();
        this.throwIfFailed();
    }

    finish() {
        this.removeExternalAbort?.();
        this.scheduler.cancelOwner(
            this.id,
            new TransferCancelledError("Transfer owner finished")
        );
        for (const lease of [...this.leases]) {
            lease.release();
        }
        this.leases.clear();
        this.deferredTaskLeases.clear();
        this.cancellationCleanups.clear();
        this.notifyIdle();
    }
}
