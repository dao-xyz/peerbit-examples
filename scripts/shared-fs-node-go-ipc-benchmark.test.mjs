import assert from "node:assert/strict";
import test from "node:test";
import {
    parseNodeGoIPCAdapterWidths,
    parseNodeGoIPCArguments,
    summarizeNodeGoIPCSamples,
    validateNodeGoIPCReport,
} from "./shared-fs-node-go-ipc-benchmark.mjs";

const scope = {
    boundary: "real Go ipcClient pool to real Node createSharedFsIpcServer",
    transport:
        "serialized TCP loopback per retained client connection; concurrent across independent lanes",
    backend:
        "deterministic immediate in-memory benchmark backend with per-handle write state",
    measurement:
        "wall-clock concurrent batch: Go scheduling/encode/write/wait/decode plus Node decode/backend/encode/write",
    verification:
        "distinct paths/handles and complete read/result checks after timers; per-handle write bytes checked by untimed fsync",
    scheduling:
        "work item i uses retained adapter lane i modulo adapterWidth; all lanes negotiate before any warmup or sample",
    excludes: [
        "FUSE/macFUSE/WinFsp",
        "Peerbit and network replication",
        "storage and persistence",
        "durable acknowledgements",
        "mount syscall overhead",
    ],
};

const definitions = [
    ["getattr", "getattr", "metadata-response", 0],
    ["read-4096", "read", "node-to-go", 4096],
    ["write-4096", "write", "go-to-node", 4096],
    ["read-1048576", "read", "node-to-go", 1 << 20],
    ["write-1048576", "write", "go-to-node", 1 << 20],
];

const options = {
    samples: 3,
    warmups: 0,
    timeoutMs: 10_000,
    adapterWidths: [1, 2],
    parallelism: 2,
};

const createValidReport = () => ({
    schemaVersion: 2,
    benchmark: "shared-fs-node-go-ipc-concurrency",
    protocol: "binary-v2-raw-bytes",
    corpus: "linear-handle-v2:(index*131+size*17+handle*31+29)%256",
    scope: structuredClone(scope),
    run: {
        warmupsPerScenario: options.warmups,
        samplesPerScenario: options.samples,
        adapterWidths: [...options.adapterWidths],
        workloadParallelism: options.parallelism,
        clock: "Go monotonic time.Now/time.Since",
        percentiles: "nearest-rank",
    },
    runtime: {
        goVersion: "go1.test",
        goOs: "test",
        goArch: "test",
        goMaxProcs: 8,
        goLogicalCpus: 8,
        nodeVersion: "v24.test",
        nodePlatform: "test",
        nodeArch: "test",
        nodeUvThreadpoolSize: "default",
        cpuModel: "test cpu",
    },
    widths: options.adapterWidths.map((adapterWidth) => ({
        adapterWidth,
        workloadParallelism: options.parallelism,
        scenarios: definitions.map(
            ([name, operation, direction, logicalBytesPerItem], index) => {
                const samples = [
                    {
                        durationNs: 100 + adapterWidth + index,
                        goAllocBytes: 10,
                        goMallocs: 1,
                    },
                    {
                        durationNs: 300 + adapterWidth + index,
                        goAllocBytes: 30,
                        goMallocs: 3,
                    },
                    {
                        durationNs: 200 + adapterWidth + index,
                        goAllocBytes: 20,
                        goMallocs: 2,
                    },
                ];
                const batchLogicalBytes =
                    logicalBytesPerItem * options.parallelism;
                return {
                    name,
                    operation,
                    direction,
                    ...(logicalBytesPerItem > 0
                        ? { logicalBytesPerItem, batchLogicalBytes }
                        : {}),
                    batchItems: options.parallelism,
                    samples,
                    summary: summarizeNodeGoIPCSamples(
                        samples,
                        options.parallelism,
                        batchLogicalBytes
                    ),
                };
            }
        ),
    })),
});

test("Node-Go IPC sweep parses two bounded concurrency axes", () => {
    assert.deepEqual(parseNodeGoIPCAdapterWidths("1,2,4,8"), [1, 2, 4, 8]);
    assert.deepEqual(
        parseNodeGoIPCArguments([
            "--adapter-widths",
            "1,2,4,8",
            "--parallelism",
            "8",
            "--samples",
            "100",
            "--warmups",
            "0",
            "--timeout-ms",
            "600000",
        ]),
        {
            adapterWidths: [1, 2, 4, 8],
            parallelism: 8,
            samples: 100,
            warmups: 0,
            timeoutMs: 600_000,
        }
    );
    for (const widths of ["", "0", "17", "1,1", "1, 2", "1,"]) {
        assert.throws(() => parseNodeGoIPCAdapterWidths(widths));
    }
    assert.throws(
        () =>
            parseNodeGoIPCArguments([
                "--adapter-widths",
                "1,2,4",
                "--parallelism",
                "2",
            ]),
        /no greater than --parallelism/u
    );
    assert.throws(
        () => parseNodeGoIPCArguments(["--samples", "1", "--samples", "2"]),
        /cannot be specified more than once/u
    );
});

test("Node-Go IPC sweep derives nearest-rank batch latency and throughput", () => {
    const samples = [
        { durationNs: 300, goAllocBytes: 30, goMallocs: 3 },
        { durationNs: 100, goAllocBytes: 10, goMallocs: 1 },
        { durationNs: 200, goAllocBytes: 20, goMallocs: 2 },
    ];
    assert.deepEqual(summarizeNodeGoIPCSamples(samples, 8, 8 << 20), {
        count: 3,
        minNs: 100,
        p50Ns: 200,
        p95Ns: 300,
        maxNs: 300,
        meanNs: 200,
        meanGoAllocBytes: 20,
        meanGoMallocs: 2,
        p50AggregateItemsPerSecond: 40_000_000,
        p50AggregateLogicalMiBPerSecond: 40_000_000,
    });
});

test("Node-Go IPC sweep validator binds widths, workload, raw samples, and summaries", () => {
    const report = createValidReport();
    assert.equal(validateNodeGoIPCReport(report, options), report);

    const corruptions = [
        (candidate) => candidate.run.adapterWidths.reverse(),
        (candidate) => (candidate.widths[1].adapterWidth = 4),
        (candidate) => (candidate.widths[0].workloadParallelism = 1),
        (candidate) => (candidate.widths[0].scenarios[0].batchItems = 1),
        (candidate) =>
            (candidate.widths[0].scenarios[1].samples[0].durationNs = 0),
        (candidate) => (candidate.widths[0].scenarios[2].summary.p50Ns += 1),
        (candidate) => (candidate.runtime.goMaxProcs = 0),
        (candidate) => candidate.scope.excludes.pop(),
    ];
    for (const corrupt of corruptions) {
        const candidate = createValidReport();
        corrupt(candidate);
        assert.throws(() => validateNodeGoIPCReport(candidate, options));
    }
});
