import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ProcessSoakStorageUsage = {
    /** Sum of regular-file logical lengths. */
    apparentRegularFileBytes: number;
    /** Regular-file blocks in 512-byte units, or null when the platform omits them. */
    allocatedBytes: number | null;
    regularFileCount: number;
    /** Descendant directories; the scanned root itself is not counted. */
    directoryCount: number;
};

export type ProcessSoakStorageSnapshot = ProcessSoakStorageUsage & {
    /** One recursively aggregated bucket per immediate child of the state root. */
    topLevel: Record<string, ProcessSoakStorageUsage>;
};

type MutableStorageUsage = Omit<ProcessSoakStorageUsage, "allocatedBytes"> & {
    allocatedBytes: number;
    allocatedBytesSupported: boolean;
};

const emptyMutableUsage = (): MutableStorageUsage => ({
    apparentRegularFileBytes: 0,
    allocatedBytes: 0,
    allocatedBytesSupported: true,
    regularFileCount: 0,
    directoryCount: 0,
});

const emptyUsage = (): ProcessSoakStorageUsage => ({
    apparentRegularFileBytes: 0,
    allocatedBytes: 0,
    regularFileCount: 0,
    directoryCount: 0,
});

const isMissing = (error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const addAllocatedBytes = (usage: MutableStorageUsage, blocks: unknown) => {
    if (typeof blocks !== "number" || !Number.isFinite(blocks) || blocks < 0) {
        usage.allocatedBytesSupported = false;
        return;
    }
    usage.allocatedBytes += blocks * 512;
};

const scanEntry = async (
    path: string,
    usage: MutableStorageUsage
): Promise<void> => {
    let stat;
    try {
        stat = await lstat(path);
    } catch (error) {
        if (isMissing(error)) return;
        throw error;
    }
    // lstat is deliberate: symbolic links (including directory links and
    // Windows junctions) are never followed or charged to the state root.
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
        usage.regularFileCount++;
        usage.apparentRegularFileBytes += stat.size;
        addAllocatedBytes(usage, stat.blocks);
        return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try {
        entries = await readdir(path);
    } catch (error) {
        if (isMissing(error)) return;
        throw error;
    }
    usage.directoryCount++;
    for (const entry of entries) {
        await scanEntry(join(path, entry), usage);
    }
};

const finishUsage = (usage: MutableStorageUsage): ProcessSoakStorageUsage => ({
    apparentRegularFileBytes: usage.apparentRegularFileBytes,
    allocatedBytes: usage.allocatedBytesSupported ? usage.allocatedBytes : null,
    regularFileCount: usage.regularFileCount,
    directoryCount: usage.directoryCount,
});

/**
 * Scan one Peerbit state directory without following symbolic links.
 * Concurrently removed paths are ignored so a diagnostic sample cannot fail a
 * workload merely because a store rotated an entry while it was being read.
 */
export const scanProcessSoakStateDirectory = async (
    path: string
): Promise<ProcessSoakStorageSnapshot> => {
    let root;
    try {
        root = await lstat(path);
    } catch (error) {
        if (isMissing(error)) return { ...emptyUsage(), topLevel: {} };
        throw error;
    }
    if (!root.isDirectory() || root.isSymbolicLink()) {
        return { ...emptyUsage(), topLevel: {} };
    }
    let entries;
    try {
        entries = await readdir(path);
    } catch (error) {
        if (isMissing(error)) return { ...emptyUsage(), topLevel: {} };
        throw error;
    }
    const topLevelEntries: Array<readonly [string, ProcessSoakStorageUsage]> =
        [];
    for (const entry of entries.sort()) {
        const usage = emptyMutableUsage();
        await scanEntry(join(path, entry), usage);
        topLevelEntries.push([entry, finishUsage(usage)]);
    }
    const topLevel = Object.fromEntries(
        topLevelEntries.filter(
            ([, usage]) =>
                usage.regularFileCount > 0 || usage.directoryCount > 0
        )
    );
    return {
        ...aggregateProcessSoakStorageUsage(Object.values(topLevel)),
        topLevel,
    };
};

export const aggregateProcessSoakStorageUsage = (
    samples: ProcessSoakStorageUsage[]
): ProcessSoakStorageUsage => ({
    apparentRegularFileBytes: samples.reduce(
        (total, sample) => total + sample.apparentRegularFileBytes,
        0
    ),
    allocatedBytes: samples.every((sample) => sample.allocatedBytes !== null)
        ? samples.reduce(
              (total, sample) => total + (sample.allocatedBytes ?? 0),
              0
          )
        : null,
    regularFileCount: samples.reduce(
        (total, sample) => total + sample.regularFileCount,
        0
    ),
    directoryCount: samples.reduce(
        (total, sample) => total + sample.directoryCount,
        0
    ),
});

export const aggregateProcessSoakStorageSnapshots = (
    snapshots: ProcessSoakStorageSnapshot[]
): ProcessSoakStorageSnapshot => {
    const componentNames = [
        ...new Set(
            snapshots.flatMap((snapshot) => Object.keys(snapshot.topLevel))
        ),
    ].sort();
    return {
        ...aggregateProcessSoakStorageUsage(snapshots),
        topLevel: Object.fromEntries(
            componentNames.map((name) => [
                name,
                aggregateProcessSoakStorageUsage(
                    snapshots.flatMap((snapshot) =>
                        snapshot.topLevel[name] ? [snapshot.topLevel[name]] : []
                    )
                ),
            ])
        ),
    };
};
