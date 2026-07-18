export const REMOTE_PERSISTED_READ_AHEAD_MIN = 2;
const REMOTE_PERSISTED_READ_AHEAD_MAX = 8;
const REMOTE_PERSISTED_READ_AHEAD_BYTE_BUDGET = 4 * 1024 * 1024;
const REMOTE_PERSISTED_READ_AHEAD_GROW_WAIT_MS = 25;

export const getRemotePersistedReadAheadLimit = (
    size: number | bigint,
    chunkCount: number
) => {
    if (chunkCount <= 0) {
        return 0;
    }
    const estimatedChunkBytes = Math.max(
        1,
        Math.ceil(Number(size) / chunkCount)
    );
    const byteBudgetLimit = Math.max(
        1,
        Math.floor(
            REMOTE_PERSISTED_READ_AHEAD_BYTE_BUDGET / estimatedChunkBytes
        )
    );
    return Math.min(
        chunkCount,
        REMOTE_PERSISTED_READ_AHEAD_MAX,
        byteBudgetLimit
    );
};

export const adaptRemotePersistedReadAhead = (
    current: number,
    limit: number,
    observation: { demandWaitMs: number; attempts: number }
) => {
    if (observation.attempts > 1) {
        return Math.max(
            Math.min(REMOTE_PERSISTED_READ_AHEAD_MIN, limit),
            Math.floor(current / 2)
        );
    }
    if (observation.demandWaitMs >= REMOTE_PERSISTED_READ_AHEAD_GROW_WAIT_MS) {
        return Math.min(limit, current + 1);
    }
    return current;
};

export type ManifestHeadBatchCircuitState =
    | "enabled"
    | "zero-open"
    | "half-open-ready"
    | "half-open-inflight"
    | "permanent-zero"
    | "permanent-error";

export type ManifestHeadBatchAttempt =
    | {
          epoch: number;
          kind: "normal";
      }
    | {
          epoch: number;
          kind: "recovery";
          token: number;
      };

export type ManifestHeadBatchZeroResult =
    | "opened"
    | "extended"
    | "permanent-zero"
    | "stale";

/**
 * Serializes manifest-head batch circuit transitions without serializing the
 * batches themselves. Attempts retain the epoch in which they were admitted,
 * and a half-open attempt additionally owns a unique token. This makes late
 * normal zero results harmless after recovery while preserving the rule that
 * any batch error is terminal.
 */
export class ManifestHeadBatchCircuit {
    state: ManifestHeadBatchCircuitState = "enabled";
    epoch = 0;
    recoveryEligibleAfterIndex = -1;
    private recoveryAvailable = true;
    private activeRecoveryToken: number | undefined;
    private nextRecoveryToken = 0;

    tryStart(
        startIndex: number,
        fetchRemotelyMissing: boolean
    ): ManifestHeadBatchAttempt | undefined {
        if (this.state === "enabled") {
            return { epoch: this.epoch, kind: "normal" };
        }
        if (
            this.state !== "half-open-ready" ||
            !fetchRemotelyMissing ||
            startIndex <= this.recoveryEligibleAfterIndex
        ) {
            return;
        }

        this.epoch += 1;
        const token = ++this.nextRecoveryToken;
        this.activeRecoveryToken = token;
        this.state = "half-open-inflight";
        return { epoch: this.epoch, kind: "recovery", token };
    }

    noteManifestHeadResolution(index: number): "armed" | "counted" | "ignored" {
        if (
            this.state !== "zero-open" &&
            this.state !== "half-open-ready" &&
            this.state !== "half-open-inflight"
        ) {
            return "ignored";
        }
        if (this.state !== "zero-open") {
            return "counted";
        }

        this.recoveryAvailable = false;
        this.recoveryEligibleAfterIndex = Math.max(
            this.recoveryEligibleAfterIndex,
            index
        );
        this.state = "half-open-ready";
        return "armed";
    }

    observeZero(
        attempt: ManifestHeadBatchAttempt,
        lastIndex: number
    ): ManifestHeadBatchZeroResult {
        if (attempt.kind === "recovery") {
            if (!this.isCurrentRecovery(attempt)) {
                return "stale";
            }
            this.enterPermanent("permanent-zero");
            return "permanent-zero";
        }
        if (attempt.epoch !== this.epoch) {
            return "stale";
        }
        if (this.state === "enabled") {
            if (!this.recoveryAvailable) {
                this.enterPermanent("permanent-zero");
                return "permanent-zero";
            }
            this.recoveryEligibleAfterIndex = Math.max(
                this.recoveryEligibleAfterIndex,
                lastIndex
            );
            this.state = "zero-open";
            return "opened";
        }
        if (this.state === "zero-open") {
            this.recoveryEligibleAfterIndex = Math.max(
                this.recoveryEligibleAfterIndex,
                lastIndex
            );
            return "extended";
        }
        return "stale";
    }

    observeRecoverySuccess(attempt: ManifestHeadBatchAttempt) {
        if (attempt.kind !== "recovery" || !this.isCurrentRecovery(attempt)) {
            return false;
        }
        this.activeRecoveryToken = undefined;
        this.recoveryAvailable = true;
        this.state = "enabled";
        return true;
    }

    observeError(_attempt: ManifestHeadBatchAttempt) {
        this.enterPermanent("permanent-error");
    }

    private isCurrentRecovery(
        attempt: Extract<ManifestHeadBatchAttempt, { kind: "recovery" }>
    ) {
        return (
            this.state === "half-open-inflight" &&
            attempt.epoch === this.epoch &&
            attempt.token === this.activeRecoveryToken
        );
    }

    private enterPermanent(
        state: Extract<
            ManifestHeadBatchCircuitState,
            "permanent-zero" | "permanent-error"
        >
    ) {
        if (this.state !== state) {
            this.epoch += 1;
        }
        this.activeRecoveryToken = undefined;
        this.state = state;
    }
}
