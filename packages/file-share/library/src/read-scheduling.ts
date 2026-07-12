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
