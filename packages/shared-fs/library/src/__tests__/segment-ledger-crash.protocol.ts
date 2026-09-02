export type SegmentLedgerCrashScenario =
    | "lock-candidate-durable"
    | "ledger-temp-durable"
    | "ledger-directory-durable"
    | "lock-release-detached";

export type SegmentLedgerCrashCheckpoint = {
    type: "checkpoint";
    scenario: SegmentLedgerCrashScenario;
    ledgerPath: string;
    artifactPath: string;
};

export type SegmentLedgerCrashWorkerMessage =
    | SegmentLedgerCrashCheckpoint
    | {
          type: "fatal";
          message: string;
          stack?: string;
      };
