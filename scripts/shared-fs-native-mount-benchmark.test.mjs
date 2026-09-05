import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createNativeMountBenchmarkPayload,
    expectedNativeMountBenchmarkScenarioNames,
    formatNativeMountBenchmarkSummary,
    hashNativeMountBenchmarkInputs,
    nativeMountBenchmarkCorpus,
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
    assert.equal(options.overwriteBaseBytes, 8192);
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
        "0",
        "--small-files",
        "2",
        "--readdir-entries",
        "3",
        "--overwrite-base-bytes",
        "8192",
        "--timeout-ms",
        "30000",
    ]);
    try {
        const report = await runNativeMountBenchmark(options);
        assert.deepEqual(
            report.scenarios.map(({ name }) => name),
            expectedNativeMountBenchmarkScenarioNames(options)
        );
        assert.equal(report.scope.performanceGate, false);
        assert.equal(report.schemaVersion, 2);
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
        assert.equal(report.inputs.files.length, 5);
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
        for (const scenario of report.scenarios) {
            assert.equal(scenario.samples.length, 2);
            assert.ok(scenario.summary.p50Ns > 0);
            assert.ok(scenario.summary.p95Ns > 0);
        }
        const tampered = structuredClone(report);
        tampered.scenarios[0].summary.p50Ns += 1;
        assert.throws(
            () => validateNativeMountBenchmarkReport(tampered, options),
            /invalid p50Ns summary/u
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
