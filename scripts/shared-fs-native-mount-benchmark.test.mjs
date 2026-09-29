import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { mock } from "node:test";
import {
    createNativeMountBenchmarkPayload,
    expectedNativeMountBenchmarkScenarioNames,
    formatNativeMountBenchmarkSummary,
    hashNativeMountBenchmarkInputs,
    nativeMountBenchmarkCorpus,
    nativeMountBenchmarkOverwriteOffset,
    parseNativeMountBenchmarkArguments,
    runNativeMountBenchmark,
    validateNativeMountBenchmarkReport,
    writeNativeMountBenchmarkReport,
} from "./shared-fs-native-mount-benchmark.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("native-mount benchmark validates bounded CLI arguments", () => {
    const options = parseNativeMountBenchmarkArguments([
        "--mount",
        ".",
        "--samples",
        "2",
        "--warmups",
        "0",
        "--small-files",
        "3",
        "--readdir-entries",
        "5",
        "--overwrite-base-bytes",
        "8192",
        "--target-kind",
        "local-filesystem-control",
        "--implementation-detail",
        "adapter.buildTags=native_mount test",
    ]);
    assert.equal(options.samples, 2);
    assert.deepEqual(options.overwriteBaseBytes, [8192]);
    assert.deepEqual(
        parseNativeMountBenchmarkArguments([
            "--mount",
            ".",
            "--overwrite-base-bytes",
            "33554432,4194304,4194304",
        ]).overwriteBaseBytes,
        [4 << 20, 32 << 20]
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--overwrite-base-bytes",
                "4194304,4095",
            ]),
        /--overwrite-base-bytes must be a comma-separated list of integers/u
    );
    assert.equal(options.targetKind, "local-filesystem-control");
    assert.deepEqual(options.mountOptions, []);
    assert.deepEqual(options.implementationDetails, [
        { key: "adapter.buildTags", value: "native_mount test" },
    ]);
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--samples",
                "0",
            ]),
        /--samples must be an integer/
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--implementation-detail",
                "missing-value=",
            ]),
        /--implementation-detail requires key=value/u
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--implementation-detail",
                "mount.runtime=one",
                "--implementation-detail",
                "mount.runtime=two",
            ]),
        /duplicate --implementation-detail key/u
    );
    assert.throws(
        () =>
            parseNativeMountBenchmarkArguments([
                "--mount",
                ".",
                "--target-kind",
                "local-filesystem-control",
                "--mount-option",
                "-s",
            ]),
        /--mount-option cannot be used/u
    );
});

test("native-mount corpus is reproducible and unique across 512 KiB chunks", () => {
    const payload = createNativeMountBenchmarkPayload(1 << 20, 1 << 20);
    assert.deepEqual(
        payload,
        createNativeMountBenchmarkPayload(1 << 20, 1 << 20)
    );
    assert.notDeepEqual(
        payload,
        createNativeMountBenchmarkPayload(1 << 20, (1 << 20) + 1)
    );
    const chunkHashes = [
        sha256(payload.subarray(0, 1 << 19)),
        sha256(payload.subarray(1 << 19)),
    ];
    assert.equal(new Set(chunkHashes).size, 2);
    const overwriteBase = createNativeMountBenchmarkPayload(4 << 20, 40_000);
    const overwriteChunkHashes = Array.from({ length: 8 }, (_, index) =>
        sha256(
            overwriteBase.subarray(index * (1 << 19), (index + 1) * (1 << 19))
        )
    );
    assert.equal(new Set(overwriteChunkHashes).size, 8);
    assert.equal(
        sha256(payload),
        "0143c4f94e80796b402e639c7c728eea75fa1ad4e9031713980c2436ef2eca2e"
    );
    assert.deepEqual(nativeMountBenchmarkCorpus, {
        id: "counter-mix32-v1",
        seedUint32: 1831565813,
        wordStepUint32: 2654435769,
        wordByteOrder: "little-endian",
    });
});

test("overwrite offsets are seeded, 4 KiB aligned and spread across the base", () => {
    // Pinned: reports stay comparable only while the offsets do.
    assert.deepEqual(
        [0, 1, 2].map((index) =>
            nativeMountBenchmarkOverwriteOffset(32 << 20, index)
        ),
        [19566592, 3104768, 10354688]
    );
    for (const [baseBytes, leaves] of [
        [4096, 1],
        [(3 << 12) + 100, 1],
        [4 << 20, 8],
        [32 << 20, 24],
    ]) {
        const offsets = Array.from({ length: 33 }, (_, index) =>
            nativeMountBenchmarkOverwriteOffset(baseBytes, index)
        );
        for (const offset of offsets) {
            assert.equal(offset % 4096, 0);
            assert.ok(offset >= 0 && offset + 4096 <= baseBytes);
        }
        // CI's 30 samples after 3 warmups, in distinct 512 KiB leaves.
        const touched = offsets
            .slice(3)
            .map((offset) => Math.floor(offset / (512 << 10)));
        assert.equal(new Set(touched).size, leaves);
    }
});

test("native-mount provenance recursively fingerprints built inputs", async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-native-mount-input-test-")
    );
    const implementation = join(temporary, "implementation");
    const nested = join(implementation, "nested");
    const first = join(implementation, "a.js");
    const second = join(nested, "b.js");
    try {
        await mkdir(nested, { recursive: true });
        await writeFile(first, "first\n");
        await writeFile(second, "second-a\n");
        for (let index = 0; index < 96; index += 1) {
            await writeFile(
                join(nested, `many-${String(index).padStart(3, "0")}.txt`),
                `${index}\n`
            );
        }
        await mkdir(join(implementation, "node_modules"));
        await writeFile(
            join(implementation, "node_modules", "ignored.js"),
            "ignored\n"
        );
        const before = await hashNativeMountBenchmarkInputs([
            implementation,
            first,
        ]);
        assert.equal(before.hashConcurrency, 1);
        assert.equal(
            before.files.filter(({ path }) => path.endsWith("/a.js")).length,
            1
        );
        assert.equal(
            before.files.filter(({ path }) => path.endsWith("/nested/b.js"))
                .length,
            1
        );
        assert.equal(
            before.files.some(({ path }) => path.endsWith("/ignored.js")),
            false
        );
        assert.deepEqual(
            before.files.map(({ path }) => path),
            before.files.map(({ path }) => path).sort()
        );
        const repeated = await hashNativeMountBenchmarkInputs([implementation]);
        assert.equal(before.combinedSha256, repeated.combinedSha256);

        await writeFile(second, "second-b\n");
        const after = await hashNativeMountBenchmarkInputs([implementation]);
        assert.notEqual(before.combinedSha256, after.combinedSha256);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("POSIX smoke unmounts before removing an empty mountpoint", async () => {
    const source = await readFile(
        new URL("./shared-fs-external-native-smoke.sh", import.meta.url),
        "utf8"
    );
    const removePath = source.match(/^remove_path\(\) \{([\s\S]*?)^\}/mu)?.[1];
    assert.ok(removePath, "remove_path helper is present");
    assert.doesNotMatch(removePath, /rm\s+-rf/u);
    assert.ok(
        removePath.indexOf("unmount_path") < removePath.indexOf("rmdir"),
        "unmount must be attempted before rmdir"
    );
    assert.match(
        source,
        /assert_mount_ready[\s\S]*node "\$\{benchmark_args\[@\]\}"[\s\S]*assert_mount_ready/u
    );
});

test("native smoke wrappers pass bounded benchmark provenance and sample defaults", async () => {
    const [posix, powershell] = await Promise.all([
        readFile(
            new URL("./shared-fs-external-native-smoke.sh", import.meta.url),
            "utf8"
        ),
        readFile(
            new URL("./shared-fs-external-native-smoke.ps1", import.meta.url),
            "utf8"
        ),
    ]);
    for (const source of [posix, powershell]) {
        for (const key of [
            "adapter.buildTags",
            "adapter.goVersion",
            "mount.runtime",
        ]) {
            assert.match(source, new RegExp(`${key}=`, "u"));
        }
        assert.match(source, /600000/u);
        assert.match(source, /NATIVE_CONTROL_BENCH_OUTPUT/u);
        assert.match(source, /local filesystem control/u);
    }
    assert.match(posix, /MOUNT_BENCH_SAMPLES:-30/u);
    assert.match(posix, /MOUNT_BENCH_WARMUPS:-3/u);
    assert.match(powershell, /MOUNT_BENCH_SAMPLES[\s\S]*"30"/u);
    assert.match(powershell, /MOUNT_BENCH_WARMUPS[\s\S]*"3"/u);
});

test("native smoke wrappers plumb opt-in mount profiling, the overwrite base and the developer workload", async () => {
    // Windows checkouts may use CRLF (core.autocrlf); match on LF text.
    const readLf = async (relative) =>
        (await readFile(new URL(relative, import.meta.url), "utf8")).replace(
            /\r\n/gu,
            "\n"
        );
    const [posix, powershell, workflow] = await Promise.all([
        readLf("./shared-fs-external-native-smoke.sh"),
        readLf("./shared-fs-external-native-smoke.ps1"),
        readLf("../.github/workflows/shared-fs-native-smoke.yml"),
    ]);
    for (const source of [posix, powershell]) {
        assert.match(
            source,
            /PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR[\s\S]*--mount-profile/u
        );
        assert.match(
            source,
            /PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES[\s\S]*--overwrite-base-bytes/u
        );
    }
    // Profiling and the developer workload stay opt-in: without the variable
    // the argv is unchanged.
    assert.match(
        posix,
        /if \[ -n "\$\{PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR:-\}" \]; then\n\s+mount_args\+=/u
    );
    assert.match(
        posix,
        /if \[ "\$\{PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD:-\}" = "1" \]; then\n\s+benchmark_common_args\+=\(--dev-workload\)/u
    );
    assert.match(
        powershell,
        /\$DevWorkload = \$env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD\n[\s\S]*if \(\$DevWorkload -eq "1"\) \{\n\s+\$BenchmarkCommonArgs \+= @\("--dev-workload"\)/u
    );
    assert.match(workflow, /mount_profile:[\s\S]*default: false/u);
    assert.match(workflow, /dev_workload:[\s\S]*default: false/u);
    assert.match(
        workflow,
        /overwrite_base_bytes:[\s\S]*default: "4194304"[\s\S]*- "4194304"\n\s+- "33554432"\n\s+- "4194304,33554432"/u
    );
    assert.match(
        workflow,
        /A1:unprofiled B1:profiled B2:profiled A2:unprofiled/u
    );
});

test("native-mount cooperative timeout cleans its owned root", async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-native-mount-timeout-test-")
    );
    const mount = join(temporary, "mount");
    await mkdir(mount);
    const options = parseNativeMountBenchmarkArguments([
        "--mount",
        mount,
        "--samples",
        "1",
        "--warmups",
        "0",
        "--small-files",
        "1",
        "--readdir-entries",
        "1",
        "--overwrite-base-bytes",
        "4096",
    ]);
    options.timeoutMs = 0;
    try {
        await assert.rejects(
            runNativeMountBenchmark(options),
            /benchmark exceeded 0 ms/u
        );
        assert.deepEqual(await readdir(mount), []);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("native-mount workload labels a local filesystem control honestly", async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-native-mount-control-test-")
    );
    const options = parseNativeMountBenchmarkArguments([
        "--mount",
        temporary,
        "--target-kind",
        "local-filesystem-control",
        "--target-label",
        "local filesystem control (test)",
        "--samples",
        "1",
        "--warmups",
        "0",
        "--small-files",
        "1",
        "--readdir-entries",
        "1",
        "--overwrite-base-bytes",
        "4096",
        "--timeout-ms",
        "30000",
    ]);
    try {
        const report = await runNativeMountBenchmark(options);
        assert.equal(report.target.kind, "local-filesystem-control");
        assert.deepEqual(report.target.mountOptions, []);
        assert.match(
            report.scope.implementationDetailSemantics,
            /not on the timed local-control path/u
        );
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /Target: local filesystem control \(test\)/u
        );
        assert.deepEqual(await readdir(temporary), []);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("native-mount benchmark emits a validated report and cleans its owned root", async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-native-mount-test-")
    );
    const mount = join(temporary, "mount");
    const implementation = join(temporary, "built-runtime");
    const output = join(temporary, "report.json");
    await mkdir(mount);
    await mkdir(implementation);
    await writeFile(join(implementation, "index.js"), "export {};\n");
    const options = parseNativeMountBenchmarkArguments([
        "--mount",
        mount,
        "--target-label",
        "portable temporary-directory structural test",
        "--mount-option",
        "-s",
        "--implementation-input",
        implementation,
        "--implementation-detail",
        "adapter.buildTags=native_mount test",
        "--implementation-detail",
        "adapter.goVersion=go version go1.24.5 test/amd64",
        "--implementation-detail",
        "mount.runtime=test-fuse 1.2.3",
        "--samples",
        "2",
        "--warmups",
        "1",
        "--small-files",
        "2",
        "--readdir-entries",
        "3",
        "--overwrite-base-bytes",
        "65536,8192",
        "--timeout-ms",
        "30000",
    ]);
    try {
        // Spy on the harness's whole-file reads and handle opens.
        const readFileSpy = mock.method(fsPromises, "readFile");
        const openSpy = mock.method(fsPromises, "open");
        syncBuiltinESMExports();
        let report;
        try {
            report = await runNativeMountBenchmark(options);
        } finally {
            readFileSpy.mock.restore();
            openSpy.mock.restore();
            syncBuiltinESMExports();
        }
        const overwriteFiles = (calls) =>
            calls
                .map(({ arguments: [path] }) => basename(String(path)))
                .filter((name) => name.startsWith("overwrite-"));
        // After each of the 3 runs an overwrite opens its base to read back
        // the range it wrote; it reads the whole base once, after the last.
        assert.deepEqual(
            overwriteFiles(
                openSpy.mock.calls.filter(
                    ({ arguments: [, flags] }) => flags === "r"
                )
            ),
            [
                ...Array(3).fill("overwrite-8192.bin"),
                ...Array(3).fill("overwrite-65536.bin"),
            ]
        );
        assert.deepEqual(overwriteFiles(readFileSpy.mock.calls), [
            "overwrite-8192.bin",
            "overwrite-65536.bin",
        ]);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name),
            expectedNativeMountBenchmarkScenarioNames(options)
        );
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /- overwrite-4096-in-65536: offsets from seed 1327217884 touched 1 of 1 512 KiB leaves\./u
        );
        assert.equal(report.scope.performanceGate, false);
        assert.equal(report.schemaVersion, 5);
        assert.equal(report.run.warmupsPerScenario, 1);
        // Default runs are unchanged: the developer workload is opt-in.
        assert.equal(report.run.devWorkload, false);
        assert.equal(report.devWorkload, null);
        assert.doesNotMatch(
            formatNativeMountBenchmarkSummary(report),
            /Developer workload/u
        );
        assert.equal(report.target.kind, "shared-fs-mount");
        assert.equal(
            report.scope.cacheSemantics.mode,
            "warm/default-platform-caches"
        );
        assert.deepEqual(report.target.mountOptions, ["-s"]);
        assert.deepEqual(report.implementation.details, [
            { key: "adapter.buildTags", value: "native_mount test" },
            {
                key: "adapter.goVersion",
                value: "go version go1.24.5 test/amd64",
            },
            { key: "mount.runtime", value: "test-fuse 1.2.3" },
        ]);
        // The harness, its developer-workload module, the lockfile, two
        // package manifests and the built implementation input.
        assert.equal(report.inputs.files.length, 6);
        assert.deepEqual(report.inputs.roots, [...report.inputs.roots].sort());
        assert.match(report.inputs.combinedSha256, /^[0-9a-f]{64}$/u);
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /Implementation: tags=native_mount test; go version go1\.24\.5 test\/amd64; mount=test-fuse 1\.2\.3/u
        );
        assert.match(
            formatNativeMountBenchmarkSummary(report),
            /Report-only: no performance threshold was applied/u
        );
        let previousEnd = 0n;
        for (const scenario of report.scenarios) {
            assert.equal(scenario.samples.length, 2);
            assert.equal(scenario.warmupSamples.length, 1);
            assert.ok(scenario.summary.p50Ns > 0);
            assert.ok(scenario.summary.p95Ns > 0);
            for (const sample of [
                ...scenario.warmupSamples,
                ...scenario.samples,
            ]) {
                assert.equal(
                    sample.warmup,
                    scenario.warmupSamples.includes(sample)
                );
                const start = BigInt(sample.startedAtUnixNs);
                const end = BigInt(sample.endedAtUnixNs);
                assert.equal(end - start, BigInt(sample.durationNs));
                assert.ok(start >= previousEnd, "sample windows overlap");
                previousEnd = end;
            }
        }
        // A warmup window may not overlap the measured samples after it.
        const overlapping = structuredClone(report);
        const [warmup] = overlapping.scenarios[0].warmupSamples;
        const overlapEnd =
            BigInt(overlapping.scenarios[0].samples[0].startedAtUnixNs) + 1n;
        warmup.endedAtUnixNs = overlapEnd.toString();
        warmup.durationNs = Number(overlapEnd - BigInt(warmup.startedAtUnixNs));
        assert.throws(
            () => validateNativeMountBenchmarkReport(overlapping, options),
            /invalid sample window/u
        );
        const flipped = structuredClone(report);
        flipped.scenarios[1].samples[0].warmup = true;
        assert.throws(
            () => validateNativeMountBenchmarkReport(flipped, options),
            /invalid sample window/u
        );
        const stretched = structuredClone(report);
        stretched.scenarios[2].samples[1].endedAtUnixNs = (
            BigInt(stretched.scenarios[2].samples[1].endedAtUnixNs) + 1n
        ).toString();
        assert.throws(
            () => validateNativeMountBenchmarkReport(stretched, options),
            /invalid sample window/u
        );
        const reordered = structuredClone(report);
        reordered.scenarios[3].samples.reverse();
        assert.throws(
            () => validateNativeMountBenchmarkReport(reordered, options),
            /invalid sample window|invalid .* summary/u
        );
        const missingWarmups = structuredClone(report);
        delete missingWarmups.scenarios[0].warmupSamples;
        assert.throws(
            () => validateNativeMountBenchmarkReport(missingWarmups, options),
            /incomplete sample set/u
        );
        const oldSchema = structuredClone(report);
        oldSchema.schemaVersion = 4;
        assert.throws(
            () => validateNativeMountBenchmarkReport(oldSchema),
            /envelope is invalid/u
        );
        const tampered = structuredClone(report);
        tampered.scenarios[0].summary.p50Ns += 1;
        assert.throws(
            () => validateNativeMountBenchmarkReport(tampered, options),
            /invalid p50Ns summary/u
        );
        const shifted = structuredClone(report);
        shifted.scenarios.at(-1).samples[0].offset ^= 4096;
        assert.throws(
            () => validateNativeMountBenchmarkReport(shifted, options),
            /overwrite-4096-in-65536 has invalid overwrite offsets/u
        );
        const provenanceTampered = structuredClone(report);
        provenanceTampered.implementation.details[0].value = "other-tags";
        assert.throws(
            () =>
                validateNativeMountBenchmarkReport(provenanceTampered, options),
            /implementation details do not match/u
        );

        await writeNativeMountBenchmarkReport(output, report, options);
        assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
        assert.deepEqual((await readdir(temporary)).sort(), [
            "built-runtime",
            "mount",
            "report.json",
        ]);
        assert.deepEqual(await readdir(mount), []);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
