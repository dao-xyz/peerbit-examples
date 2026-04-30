import { AbstractFile, LargeFile } from "@peerbit/please-lib";

type FileChangeRoot = Pick<AbstractFile, "id" | "parentId">;

type FileChangeDetail = {
    added?: AbstractFile[];
    removed?: FileChangeRoot[];
};

export type RootFileChange = {
    added: AbstractFile[];
    removed: FileChangeRoot[];
};

const isRootFile = <T extends Pick<AbstractFile, "parentId">>(
    file: T | undefined | null
): file is T => Boolean(file) && file.parentId == null;

const hasChangedFiles = (detail: FileChangeDetail) =>
    (detail.added?.length ?? 0) > 0 || (detail.removed?.length ?? 0) > 0;

const isReadyLargeFile = (file: AbstractFile): file is LargeFile =>
    file instanceof LargeFile && file.ready;

const hasFinalLargeFileHash = (file: AbstractFile) =>
    file instanceof LargeFile && !!file.finalHash;

const shouldPreferRootCandidate = (
    candidate: AbstractFile,
    current: AbstractFile
) => {
    if (isReadyLargeFile(current) && !isReadyLargeFile(candidate)) {
        return false;
    }
    if (isReadyLargeFile(candidate) && !isReadyLargeFile(current)) {
        return true;
    }
    if (hasFinalLargeFileHash(current) && !hasFinalLargeFileHash(candidate)) {
        return false;
    }
    return true;
};

export const sortRootFilesForDisplay = (files: AbstractFile[]) =>
    [...files].sort((a, b) => a.name.localeCompare(b.name));

export const getReadyLargeFileSignature = (files: AbstractFile[]) => {
    const readyFiles = files
        .filter(
            (file): file is LargeFile =>
                file instanceof LargeFile && file.ready && !!file.finalHash
        )
        .map(
            (file) =>
                `${file.id}:${file.size.toString()}:${file.chunkCount}:${file.finalHash}`
        )
        .sort();
    return readyFiles.length > 0 ? readyFiles.join("|") : null;
};

export const getRootFileChange = (event: Event): RootFileChange => {
    const detail = (event as CustomEvent<FileChangeDetail>).detail;
    if (!detail) {
        return { added: [], removed: [] };
    }
    return {
        added: (detail.added ?? []).filter(isRootFile),
        removed: (detail.removed ?? []).filter(isRootFile),
    };
};

export const shouldRefreshRootListForFileChange = (event: Event) => {
    const detail = (event as CustomEvent<FileChangeDetail>).detail;
    if (!detail) {
        return true;
    }
    if (!hasChangedFiles(detail)) {
        return false;
    }
    return (
        (detail.added ?? []).some(isRootFile) ||
        (detail.removed ?? []).some(isRootFile)
    );
};

export const applyRootFileChangeToList = (
    current: AbstractFile[],
    change: RootFileChange
) => {
    const removedIds = new Set(
        change.removed
            .map((file) => file.id)
            .filter((id): id is string => typeof id === "string")
    );
    const byId = new Map<string, AbstractFile>();

    for (const file of current) {
        if (!removedIds.has(file.id)) {
            byId.set(file.id, file);
        }
    }

    for (const file of change.added) {
        if (removedIds.has(file.id)) {
            continue;
        }
        const existing = byId.get(file.id);
        if (!existing || shouldPreferRootCandidate(file, existing)) {
            byId.set(file.id, file);
        }
    }

    return sortRootFilesForDisplay([...byId.values()]);
};
