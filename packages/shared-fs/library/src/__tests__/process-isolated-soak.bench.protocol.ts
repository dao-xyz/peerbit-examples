import type { BootstrapStatus, BootstrapTelemetryEvent } from "../index.js";

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

export type ProcessSoakProcessIdentity = {
    worker: number;
    generation: number;
    pid: number;
    identity: string;
    networkMode: "online" | "offline";
};

export type ProcessSoakRuntimeMetrics = {
    process: ProcessSoakProcessIdentity;
    rssBytes: number;
    maxRssBytes: number;
    heapTotalBytes: number;
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

export type ProcessSoakBootstrapStatus = Omit<
    BootstrapStatus,
    "manifest" | "msSinceLastArrival"
> & {
    manifest?: {
        authorKey: string;
        snapshotSeq: string;
        createdAtWallMs: string;
        ageMs: number;
        docs: string;
    };
    /** `null` serializes BootstrapStatus's initial positive infinity. */
    msSinceLastArrival: number | null;
};

export type ProcessSoakGcOptions = {
    keepVersions?: number;
    retentionMs?: number;
    graceMs?: number;
    chunkGraceMs?: number;
    namingGraceMs?: number;
    settleMs?: number;
    minOrphanSpanMs?: number;
    nowMs?: number;
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
          type: "set-clock-offset";
          offsetMs: number;
      })
    | (ProcessSoakRequestBase & {
          type: "open";
          address?: string;
          machineLabel: string;
          timeoutMs: number;
          bootstrap?: false | "auto" | "require";
          remoteChunkFetch?: boolean;
          gcSchedule?: boolean;
          captureBootstrapTelemetry?: boolean;
          awaitBootstrapConverged?: boolean;
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
    | (ProcessSoakRequestBase & { type: "snapshot-write" })
    | (ProcessSoakRequestBase & {
          type: "editor-save";
          tempPath: string;
          path: string;
          content: string;
      })
    | (ProcessSoakRequestBase & {
          type: "editor-fsync-checkpoint";
          tempPath: string;
          path: string;
          content: string;
      })
    | (ProcessSoakRequestBase & {
          type: "mount-rename";
          fromPath: string;
          toPath: string;
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
    | (ProcessSoakRequestBase & {
          type: "collect-garbage";
          options?: ProcessSoakGcOptions;
      })
    | (ProcessSoakRequestBase & { type: "network-status" })
    | (ProcessSoakRequestBase & { type: "runtime-metrics" })
    | (ProcessSoakRequestBase & { type: "requested-gc-runtime-metrics" })
    | (ProcessSoakRequestBase & { type: "metrics" })
    | (ProcessSoakRequestBase & {
          type: "shutdown";
          captureMetrics?: boolean;
          requestGcAfterStop?: boolean;
      });

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
    bootstrapStatus: ProcessSoakBootstrapStatus;
    bootstrapConvergence?: { verified: boolean };
    bootstrapTelemetry: BootstrapTelemetryEvent[];
};

export type ProcessSoakClockOffsetResult = {
    offsetMs: number;
    logicalNowMs: number;
};

export type ProcessSoakBatchResult = {
    localCommitMs: number;
    changeset: ProcessSoakChangesetRef;
    versionIds: Array<string | undefined>;
};

export type ProcessSoakSnapshotWriteResult = {
    durationMs: number;
    snapshotSeq: string;
    createdAtWallMs: string;
    nodes: string;
    docs: string;
    bytes: string;
    segments: number;
    manifestId: string;
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

export type ProcessSoakEditorFsyncCheckpointResult = {
    writeMs: number;
    fsyncMs: number;
    totalMs: number;
    tempNodeId: string;
    targetNodeId: string;
};

export type ProcessSoakMountRenameResult = {
    renameMs: number;
    sourceNodeId: string;
    replacedNodeId: string | null;
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

export type ProcessSoakRequestedGcMetricsResult = {
    settleWallMs: number;
    metrics: ProcessSoakRuntimeMetrics;
};

export type ProcessSoakShutdownResult =
    | { captured: false }
    | {
          captured: true;
          beforeClose: ProcessSoakRuntimeMetrics;
          afterFsClose: ProcessSoakRuntimeMetrics;
          afterPeerStop: ProcessSoakRuntimeMetrics;
          afterStopRequestedGc?: ProcessSoakRuntimeMetrics;
          gcSettleWallMs?: number;
      };
