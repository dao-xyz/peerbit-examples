import { IsNull, SearchRequest } from "@peerbit/document";
import type { Files } from "@peerbit/please-lib";
import type { ReplicationOptions } from "@peerbit/shared-log";

export const REMOTE_ROOT_RECONCILIATION_INTERVAL_MS = 30_000;

const createRootSearchRequest = () =>
    new SearchRequest({
        query: new IsNull({ key: "parentId" }),
        fetch: 0xffffffff,
    });

export const getRootListRefreshSource = (
    sourceOrEvent?: string | Pick<Event, "type">
) => {
    if (typeof sourceOrEvent === "string") {
        return sourceOrEvent;
    }
    if (sourceOrEvent == null) {
        return "refresh";
    }
    return sourceOrEvent.type || "event";
};

const isImmediateRemoteReconciliationSource = (source: string) =>
    source === "initial-open" || source === "join" || source === "role-change";

export const coalesceRootListRefreshSource = (
    current: string | null,
    next: string
) => {
    if (
        current != null &&
        isImmediateRemoteReconciliationSource(current) &&
        !isImmediateRemoteReconciliationSource(next)
    ) {
        return current;
    }
    return next;
};

export const listRootFilesForRole = (
    program: Files,
    role: ReplicationOptions
) => {
    if (role === false) {
        // Chunk persistence is independent from the observer's replication
        // role. Keep root-list refreshes non-replicating even while a download
        // is intentionally caching chunk blocks.
        return program.list({ replicate: false });
    }
    return program.files.index.search(createRootSearchRequest(), {
        local: true,
        remote: false,
    });
};

export const listRemoteRootFilesForReconciliation = async (program: Files) => {
    const from = await program.getReadPeerHints();
    return program.files.index.search(createRootSearchRequest(), {
        local: false,
        remote: {
            throwOnMissing: false,
            replicate: false,
            from,
        },
    } as any);
};

export const shouldReconcileRemoteRootFiles = (properties: {
    role: ReplicationOptions;
    source: string;
    now: number;
    lastStartedAt: number | null;
    intervalMs?: number;
}) => {
    if (properties.role === false) {
        return false;
    }
    if (isImmediateRemoteReconciliationSource(properties.source)) {
        return true;
    }
    if (properties.source !== "refresh") {
        return false;
    }
    return (
        properties.lastStartedAt == null ||
        properties.now - properties.lastStartedAt >=
            (properties.intervalMs ?? REMOTE_ROOT_RECONCILIATION_INTERVAL_MS)
    );
};
