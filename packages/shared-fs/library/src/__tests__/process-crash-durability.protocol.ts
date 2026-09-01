export type ExpectedFile = {
    path: string;
    seed: number;
    length: number;
};

export const patternedBytes = (seed: number, length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = (index * 29 + seed * 67 + (index >>> 8)) % 251;
    }
    return bytes;
};

export type FsyncProcessCrashCheckpoint = {
    type: "checkpoint";
    scenario: "fsync";
    address: string;
    identity: string;
    publicKey: string;
    file: ExpectedFile;
    fsyncMs: number;
};

export type MultiWriterProcessCrashCheckpoint = {
    type: "checkpoint";
    scenario: "multi-writer-disposal";
    address: string;
    identities: string[];
    publicKeys: string[];
    files: ExpectedFile[];
    changeset: {
        id: string;
        manifestId: string;
        memberCount: number;
    };
    conflict: {
        path: string;
        heads: Array<{
            versionId: string;
            seed: number;
            length: number;
        }>;
    };
    disposal: {
        safeToDispose: true;
        guarantee: "persisted-per-entry";
        minAcksPerEntry: number;
        empty: boolean;
        entryCount: number;
        receiptBatches: number;
        entries: {
            chunks: number;
            versions: number;
            naming: number;
            trust: number;
        };
    };
    timings: {
        mountedFsyncMs: number;
        disposalBarrierMs: number;
    };
};

export type ProcessCrashCheckpoint =
    | FsyncProcessCrashCheckpoint
    | MultiWriterProcessCrashCheckpoint;

export type ProcessCrashWorkerMessage =
    | ProcessCrashCheckpoint
    | {
          type: "fatal";
          message: string;
          stack?: string;
      };
