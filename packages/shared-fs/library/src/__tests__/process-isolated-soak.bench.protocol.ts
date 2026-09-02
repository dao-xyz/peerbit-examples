export type ProcessSoakContentExpectation =
    | string
    | {
          generator: "xorshift32-ascii-v1";
          prefix: string;
          seed: number;
          bytes: number;
          sha256: string;
      };

export type ProcessSoakFileExpectation = {
    path: string;
    content: ProcessSoakContentExpectation;
};

export type ProcessSoakTreeExpectation = {
    path: string;
    kind: "directory" | "file";
};

export type ProcessSoakChangesetRef = {
    id: string;
    manifestId: string;
    memberCount: number;
};

export type ProcessSoakConflictExpectation =
    | {
          mode: "heads";
          path: string;
          heads: Array<{
              versionId: string;
              content: ProcessSoakContentExpectation;
              parentVersionIds?: string[];
          }>;
      }
    | {
          /** Exact current content heads, including the valid one-head case. */
          mode: "version-heads";
          path: string;
          heads: Array<{
              versionId: string;
              content: ProcessSoakContentExpectation;
              parentVersionIds?: string[];
          }>;
      }
    | { mode: "resolved"; path: string };

export type ProcessSoakRuntimeMetrics = {
    rssBytes: number;
    maxRssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    userCpuMicros: number;
    systemCpuMicros: number;
    fsReadOps: number;
    fsWriteOps: number;
};

export type ProcessSoakMetrics = ProcessSoakRuntimeMetrics & {
    storageBytes: number;
};

export type ProcessSoakNetworkStatus = {
    connectionCount: number;
    remotePeers: string[];
};

export type ProcessSoakReadyMessage = {
    type: "ready";
    worker: number;
    identity: string;
    publicKey: string;
    addresses: string[];
    peerCreateMs: number;
};

type ProcessSoakRequestBase = {
    requestId: string;
};

export type ProcessSoakWorkerCommand =
    | (ProcessSoakRequestBase & {
          type: "dial";
          addresses: string[];
      })
    | (ProcessSoakRequestBase & {
          type: "open";
          address?: string;
          machineLabel: string;
          timeoutMs: number;
      })
    | (ProcessSoakRequestBase & {
          type: "authorize";
          publicKeys: string[];
      })
    | (ProcessSoakRequestBase & {
          type: "write-batch";
          changesetId: string;
          entries: Array<
              { path: string; content: string } | { path: string; delete: true }
          >;
      })
    | (ProcessSoakRequestBase & {
          type: "editor-save";
          tempPath: string;
          path: string;
          content: string;
      })
    | (ProcessSoakRequestBase & {
          type: "write-conflict";
          path: string;
          content: string;
          baseVersionIds: string[];
      })
    | (ProcessSoakRequestBase & {
          type: "resolve-conflict";
          path: string;
          versionId: string;
      })
    | (ProcessSoakRequestBase & {
          type: "verify";
          changesets?: ProcessSoakChangesetRef[];
          files?: ProcessSoakFileExpectation[];
          absentPaths?: string[];
          trustedPublicKeys?: string[];
          noNamingConflicts?: string[];
          exactTree?: ProcessSoakTreeExpectation[];
          conflict?: ProcessSoakConflictExpectation;
          timeoutMs: number;
      })
    | (ProcessSoakRequestBase & { type: "collect-garbage" })
    | (ProcessSoakRequestBase & { type: "network-status" })
    | (ProcessSoakRequestBase & { type: "runtime-metrics" })
    | (ProcessSoakRequestBase & { type: "metrics" })
    | (ProcessSoakRequestBase & { type: "shutdown" });

export type ProcessSoakResponseMessage =
    | {
          type: "response";
          requestId: string;
          ok: true;
          value: unknown;
      }
    | {
          type: "response";
          requestId: string;
          ok: false;
          error: { message: string; stack?: string };
      };

export type ProcessSoakWorkerMessage =
    | ProcessSoakReadyMessage
    | ProcessSoakResponseMessage
    | {
          type: "fatal";
          message: string;
          stack?: string;
      };

export type ProcessSoakOpenResult = {
    address: string;
    identity: string;
    openMs: number;
    writeReadyMs: number;
    writeReadinessSource?: string;
    gcScheduled: boolean;
};

export type ProcessSoakBatchResult = {
    localCommitMs: number;
    changeset: ProcessSoakChangesetRef;
    versionIds: Array<string | undefined>;
};

export type ProcessSoakEditorResult = {
    fsyncMs: number;
    releaseMs: number;
    renameMs: number;
    totalMs: number;
    replacedNodeId: string;
    tempNodeId: string;
    targetNodeId: string;
};

export type ProcessSoakConflictWriteResult = {
    versionId: string;
    localCommitMs: number;
};

export type ProcessSoakVerifyResult = {
    durationMs: number;
    visibleConflictHash?: string;
};

export type ProcessSoakGcResult = {
    durationMs: number;
    report: {
        dryRun: boolean;
        healedChunks: number;
        damagedNodeIds: string[];
        retiredVersions: number;
        compactedNamingEvents: number;
        purgedNodes: number;
        deletedChunks: number;
        reclaimedChunkBytes: string;
        chunkCandidatesRecorded: number;
        purgeCandidatesRecorded: number;
        conflictedNodes: number;
        cutRecoveries: number;
        manifestsRetired: number;
        segmentBlocksDeleted: number;
        reclaimedSegmentBytes: string;
        warnings: string[];
    };
};
