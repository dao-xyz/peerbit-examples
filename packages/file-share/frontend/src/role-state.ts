import type { ReplicationOptions } from "@peerbit/shared-log";
import type { Files } from "@peerbit/please-lib";

export const FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS = 5 * 60 * 1000;
export const FILE_SHARE_STORAGE_BYTES_PER_MB = 1_000_000;

export const parseFileShareStorageMegabytes = (megabytes: string) =>
    Number(megabytes) * FILE_SHARE_STORAGE_BYTES_PER_MB;

export const formatFileShareStorageMegabytes = (bytes: number) =>
    String(bytes / FILE_SHARE_STORAGE_BYTES_PER_MB);

export const DEFAULT_REPLICATION_ROLE: ReplicationOptions = {
    limits: {
        interval: FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
        cpu: { max: 1, monitor: undefined },
    },
};

type AdaptiveRole = {
    limits?: {
        interval?: number;
        storage?: number;
        cpu?: number | { max: number; monitor?: unknown };
    };
};

type AdaptiveCpuLimit = number | { max: number; monitor?: unknown };

const getAdaptiveRole = (role: ReplicationOptions) =>
    role != null &&
    role !== false &&
    typeof role === "object" &&
    !Array.isArray(role) &&
    !("factor" in role)
        ? (role as AdaptiveRole)
        : undefined;

const getCpuMax = (cpu: AdaptiveCpuLimit | undefined) =>
    typeof cpu === "number" ? cpu : cpu?.max;

export const shouldUseQuietFileShareRebalancing = (
    role: ReplicationOptions
) => {
    const adaptiveRole = getAdaptiveRole(role);
    if (!adaptiveRole) {
        return false;
    }
    const limits = adaptiveRole.limits;
    const cpuMax = getCpuMax(limits?.cpu);
    return limits?.storage == null && (cpuMax == null || cpuMax === 1);
};

export const normalizeFileShareReplicationRole = (
    role: ReplicationOptions
): ReplicationOptions => {
    const adaptiveRole = getAdaptiveRole(role);
    if (
        !shouldUseQuietFileShareRebalancing(role) ||
        !adaptiveRole ||
        adaptiveRole.limits?.interval != null
    ) {
        return role;
    }
    return {
        ...adaptiveRole,
        limits: {
            ...adaptiveRole.limits,
            interval: FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
        },
    } as ReplicationOptions;
};

export const createFileShareReplicationRole = (properties: {
    cpuMax?: number;
    storage?: number;
}): ReplicationOptions =>
    normalizeFileShareReplicationRole({
        limits: {
            cpu:
                properties.cpuMax == null
                    ? undefined
                    : { max: properties.cpuMax },
            storage: properties.storage,
        },
    });

export const parseStoredRole = (
    serializedRole: string | null
): ReplicationOptions | undefined =>
    serializedRole == null
        ? undefined
        : normalizeFileShareReplicationRole(JSON.parse(serializedRole));

export const getInitialReplicationRole = (serializedRole: string | null) =>
    parseStoredRole(serializedRole) ?? DEFAULT_REPLICATION_ROLE;

type ReplicationRoleGuard = {
    expectedRevision: number;
    getCurrentRevision: () => number;
    getCurrentRole: () => ReplicationOptions;
    isContextActive: () => boolean;
};

type ReplicationRoleState = Omit<ReplicationRoleGuard, "expectedRevision">;

export const applyReplicationRoleGuarded = async (
    program: Files,
    role: ReplicationOptions,
    guard: ReplicationRoleGuard
) => {
    program.persistChunkReads = role !== false;
    await program.files.log.replicate(false);

    if (role === false) {
        return true;
    }
    if (
        program.closed ||
        !guard.isContextActive() ||
        guard.getCurrentRevision() !== guard.expectedRevision ||
        guard.getCurrentRole() !== role
    ) {
        return false;
    }

    await program.files.log.replicate(role);
    return true;
};

export const applyReplicationRoleUntilStable = async (
    program: Files,
    initialRevision: number,
    state: ReplicationRoleState
) => {
    let revision = initialRevision;
    while (!program.closed && state.isContextActive()) {
        const role = state.getCurrentRole();
        await applyReplicationRoleGuarded(program, role, {
            ...state,
            expectedRevision: revision,
        });
        if (program.closed || !state.isContextActive()) {
            return revision;
        }
        const currentRevision = state.getCurrentRevision();
        if (currentRevision === revision && state.getCurrentRole() === role) {
            return revision;
        }
        revision = currentRevision;
    }
    return revision;
};
