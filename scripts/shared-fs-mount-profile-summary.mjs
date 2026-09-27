#!/usr/bin/env node

// Summarize opt-in Shared FS mount profiles (`peerbit-fs mount --mount-profile
// <dir>`). Reads the Node daemon and native adapter NDJSON files, joins the
// adapter's IPC round trips with the daemon's backend service records, and
// optionally attributes records to mounted-benchmark sample windows.
//
// Phases overlap by design (a native callback contains its IPC round trip,
// which contains the daemon's service time, which can contain a local commit
// fence, which contains its target write). This tool reports each phase on its
// own and derives only explicitly nested differences; it never adds phases.

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { validateNativeMountBenchmarkReport } from "./shared-fs-native-mount-benchmark.mjs";

export const MOUNT_PROFILE_SCHEMA = "peerbit.shared-fs.mount-profile";
export const MOUNT_PROFILE_SCHEMA_VERSION = 1;
export const MOUNT_PROFILE_SUMMARY_SCHEMA =
    "peerbit.shared-fs.mount-profile-summary";
export const MOUNT_PROFILE_SUMMARY_SCHEMA_VERSION = 1;
export const DEFAULT_JOIN_TOLERANCE_NS = 1_000_000;

const SOURCES = new Set(["fuse-native", "native-adapter", "node-daemon"]);
const META_PHASES = new Set(["profile.start", "profile.summary"]);
const UNIX_NS = /^[1-9][0-9]{0,18}$/u;
const ABSENT_CODES = new Set(["ENOENT"]);
// Failures that mean "not available right now" rather than a caller error:
// readiness gating, transport or storage failure, and shutdown.
const UNAVAILABLE_CODES = new Set([
    "EAGAIN",
    "EIO",
    "EBUSY",
    "ENOLCK",
    "ETIMEDOUT",
    "ECLOSED",
]);

/** absent (ENOENT), unavailable (EAGAIN/EIO/...), or error (anything else). */
export const classifyMountProfileFailure = (code) =>
    ABSENT_CODES.has(code)
        ? "absent"
        : UNAVAILABLE_CODES.has(code) || code === undefined
          ? "unavailable"
          : "error";

const isDetail = (value) =>
    value === undefined ||
    (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) =>
            ["string", "number", "boolean"].includes(typeof entry)
        ));

/**
 * Parse one NDJSON line. Returns `{ record }` for a valid record or
 * `{ ignored: reason }` so callers can report exactly what they skipped.
 */
export const parseMountProfileLine = (line) => {
    if (line.trim() === "") return { ignored: "blank" };
    let value;
    try {
        value = JSON.parse(line);
    } catch {
        return { ignored: "nonJson" };
    }
    if (value?.schema !== MOUNT_PROFILE_SCHEMA) {
        return { ignored: "foreignSchema" };
    }
    if (value.schemaVersion !== MOUNT_PROFILE_SCHEMA_VERSION) {
        return { ignored: "unsupportedVersion" };
    }
    if (
        !SOURCES.has(value.source) ||
        typeof value.phase !== "string" ||
        typeof value.operation !== "string" ||
        typeof value.startUnixNs !== "string" ||
        !UNIX_NS.test(value.startUnixNs) ||
        !Number.isSafeInteger(value.durationNs) ||
        value.durationNs < 0 ||
        typeof value.ok !== "boolean" ||
        !isDetail(value.detail)
    ) {
        return { ignored: "invalid" };
    }
    const start = BigInt(value.startUnixNs);
    return {
        record: {
            ...value,
            detail: value.detail ?? {},
            start,
            end: start + BigInt(value.durationNs),
        },
    };
};

const emptyIgnored = () => ({
    blank: 0,
    nonJson: 0,
    foreignSchema: 0,
    unsupportedVersion: 0,
    invalid: 0,
});

export const parseMountProfileText = (text, file = "<memory>") => {
    const ignored = emptyIgnored();
    const records = [];
    for (const line of text.split("\n")) {
        const parsed = parseMountProfileLine(line);
        if (parsed.record) records.push({ ...parsed.record, file });
        // The empty string after a final newline is not a skipped line.
        else if (line.length > 0) ignored[parsed.ignored]++;
    }
    return { file, records, ignored };
};

/** Stream a (possibly large) profile file line by line. */
export const readMountProfileFile = async (file) => {
    const ignored = emptyIgnored();
    const records = [];
    const lines = createInterface({
        input: createReadStream(file),
        crlfDelay: Infinity,
    });
    for await (const line of lines) {
        const parsed = parseMountProfileLine(line);
        if (parsed.record) records.push({ ...parsed.record, file });
        else ignored[parsed.ignored]++;
    }
    return { file, records, ignored };
};

/** The profile files written by `peerbit-fs mount --mount-profile <dir>`. */
export const listMountProfileFiles = async (directory) =>
    (await readdir(directory))
        .filter((name) => name.endsWith(".ndjson"))
        .sort()
        .map((name) => join(directory, name));

/** Nearest-rank percentiles, matching the mounted benchmark. */
export const durationStats = (values) => {
    if (values.length === 0) return { count: 0 };
    const sorted = Float64Array.from(values).sort();
    const rank = (fraction) =>
        sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    let total = 0;
    for (const value of sorted) total += value;
    return {
        count: sorted.length,
        totalNs: total,
        minNs: sorted[0],
        p50Ns: rank(0.5),
        p95Ns: rank(0.95),
        p99Ns: rank(0.99),
        maxNs: sorted[sorted.length - 1],
        meanNs: total / sorted.length,
    };
};

const groupKey = (record) =>
    `${record.source}\u0000${record.phase}\u0000${record.operation}`;

const summarizePhases = (records) => {
    const groups = new Map();
    for (const record of records) {
        const key = groupKey(record);
        let group = groups.get(key);
        if (!group) {
            group = {
                source: record.source,
                phase: record.phase,
                operation: record.operation,
                ok: 0,
                failures: { absent: 0, unavailable: 0, error: 0 },
                codes: {},
                durations: [],
            };
            groups.set(key, group);
        }
        group.durations.push(record.durationNs);
        if (record.ok) {
            group.ok++;
        } else {
            const code =
                typeof record.detail.code === "string"
                    ? record.detail.code
                    : undefined;
            group.failures[classifyMountProfileFailure(code)]++;
            const label = code ?? "UNKNOWN";
            group.codes[label] = (group.codes[label] ?? 0) + 1;
        }
    }
    return [...groups.values()]
        .map(({ durations, ...group }) => ({
            ...group,
            ...durationStats(durations),
        }))
        .sort(
            (left, right) =>
                right.totalNs - left.totalNs ||
                (left.source + left.phase + left.operation <
                right.source + right.phase + right.operation
                    ? -1
                    : 1)
        );
};

const summarizeSessions = (records) => {
    const sessions = [];
    const bySource = new Map();
    for (const record of records) {
        if (record.phase === "profile.start") {
            const session = {
                file: record.file,
                source: record.source,
                pid: record.detail.pid,
                startUnixNs: record.startUnixNs,
                complete: false,
            };
            sessions.push(session);
            const key = `${record.file}\u0000${record.source}`;
            bySource.set(key, [...(bySource.get(key) ?? []), session]);
        }
    }
    for (const record of records) {
        if (record.phase !== "profile.summary") continue;
        const candidates =
            bySource.get(`${record.file}\u0000${record.source}`) ?? [];
        const session =
            candidates.find(
                (candidate) =>
                    !candidate.complete &&
                    candidate.pid === record.detail.pid &&
                    candidate.startUnixNs === record.startUnixNs
            ) ??
            (() => {
                const orphan = {
                    file: record.file,
                    source: record.source,
                    pid: record.detail.pid,
                    startUnixNs: record.startUnixNs,
                    complete: false,
                };
                sessions.push(orphan);
                return orphan;
            })();
        Object.assign(session, {
            complete: true,
            durationNs: record.durationNs,
            emitted: record.detail.emitted ?? 0,
            written: record.detail.written ?? 0,
            dropped: record.detail.dropped ?? 0,
            lost: record.detail.lost ?? 0,
            droppedAfterClose: record.detail.droppedAfterClose ?? 0,
            writeErrors: record.detail.writeErrors ?? 0,
        });
    }
    const totals = {
        sessions: sessions.length,
        incompleteSessions: sessions.filter((session) => !session.complete)
            .length,
        dropped: 0,
        lost: 0,
        writeErrors: 0,
    };
    for (const session of sessions) {
        totals.dropped += session.dropped ?? 0;
        totals.lost += session.lost ?? 0;
        totals.writeErrors += session.writeErrors ?? 0;
    }
    return { sessions, totals };
};

const connectionKey = (port, requestId) =>
    typeof port === "number" ? `${port}:${requestId}` : undefined;

const contains = (outer, inner, toleranceNs) => {
    const tolerance = BigInt(toleranceNs);
    return (
        inner.start >= outer.start - tolerance &&
        inner.end <= outer.end + tolerance
    );
};

/**
 * Join adapter `ipc.roundTrip` with daemon `ipc.service` records. The primary
 * key is (adapter local TCP port, request id) = (daemon remote port, request
 * id); without ports (unix sockets) the request id plus time containment is
 * used. Containment is also checked on keyed joins to expose clock skew.
 */
export const joinIpcRecords = (records, toleranceNs) => {
    const roundTrips = records.filter(
        (record) =>
            record.source === "native-adapter" &&
            record.phase === "ipc.roundTrip"
    );
    const queues = records.filter(
        (record) =>
            record.source === "native-adapter" && record.phase === "ipc.queue"
    );
    const services = records.filter(
        (record) =>
            record.source === "node-daemon" && record.phase === "ipc.service"
    );
    const byKey = new Map();
    const byRequestId = new Map();
    for (const roundTrip of roundTrips) {
        const key = connectionKey(
            roundTrip.detail.localPort,
            roundTrip.detail.requestId
        );
        if (key) byKey.set(key, [...(byKey.get(key) ?? []), roundTrip]);
        const id = roundTrip.detail.requestId;
        byRequestId.set(id, [...(byRequestId.get(id) ?? []), roundTrip]);
    }
    const used = new Set();
    const pairs = [];
    let unmatchedServices = 0;
    let keyedJoins = 0;
    let timeJoins = 0;
    let containmentViolations = 0;
    for (const service of services) {
        const key = connectionKey(
            service.detail.remotePort,
            service.detail.requestId
        );
        const keyed = key ? byKey.get(key) : undefined;
        const candidates = (
            keyed ??
            byRequestId.get(service.detail.requestId) ??
            []
        ).filter(
            (candidate) =>
                !used.has(candidate) &&
                candidate.operation === service.operation &&
                (keyed || contains(candidate, service, toleranceNs))
        );
        if (candidates.length === 0) {
            unmatchedServices++;
            continue;
        }
        const nearest = candidates.reduce((best, candidate) => {
            const distance = (value) =>
                value.start > service.start
                    ? value.start - service.start
                    : service.start - value.start;
            return distance(candidate) < distance(best) ? candidate : best;
        });
        used.add(nearest);
        if (keyed) keyedJoins++;
        else timeJoins++;
        if (!contains(nearest, service, toleranceNs)) containmentViolations++;
        pairs.push({ roundTrip: nearest, service });
    }
    const transport = [];
    const offsets = [];
    let negativeTransport = 0;
    for (const { roundTrip, service } of pairs) {
        const difference = roundTrip.durationNs - service.durationNs;
        if (difference < 0) negativeTransport++;
        else transport.push(difference);
        offsets.push(Number(service.start - roundTrip.start));
    }
    const queueNs = queues.map((record) => record.durationNs);
    const roundTripNs = roundTrips.map((record) => record.durationNs);
    const totalQueue = queueNs.reduce((sum, value) => sum + value, 0);
    const totalRoundTrip = roundTripNs.reduce((sum, value) => sum + value, 0);
    return {
        roundTrips: roundTrips.length,
        services: services.length,
        joined: pairs.length,
        keyedJoins,
        timeJoins,
        unmatchedRoundTrips: roundTrips.length - pairs.length,
        unmatchedServices,
        connectionSetupSamples: roundTrips.filter(
            (record) => record.detail.connected === true
        ).length,
        containmentViolations,
        negativeTransport,
        toleranceNs,
        queueNs: durationStats(queueNs),
        roundTripNs: durationStats(roundTripNs),
        serviceNs: durationStats(services.map((record) => record.durationNs)),
        joinedServiceNs: durationStats(
            pairs.map(({ service }) => service.durationNs)
        ),
        transportNs: durationStats(transport),
        serviceStartOffsetNs: durationStats(offsets),
        queueShareOfLane:
            totalQueue + totalRoundTrip === 0
                ? null
                : totalQueue / (totalQueue + totalRoundTrip),
    };
};

/**
 * Adapter overhead per native callback: callback duration minus the IPC round
 * trips it contains (same process, same clock). With the default
 * single-threaded mount callbacks never overlap; overlapping callbacks make
 * attribution ambiguous and are reported instead of guessed.
 */
export const summarizeAdapterCallbacks = (records) => {
    const callbacks = records
        .filter(
            (record) =>
                record.source === "native-adapter" &&
                record.phase === "native.callback"
        )
        .sort((left, right) => (left.start < right.start ? -1 : 1));
    const roundTrips = records.filter(
        (record) =>
            record.source === "native-adapter" &&
            record.phase === "ipc.roundTrip"
    );
    let overlappingCallbacks = 0;
    for (let index = 1; index < callbacks.length; index++) {
        if (callbacks[index].start < callbacks[index - 1].end) {
            overlappingCallbacks++;
        }
    }
    const contained = callbacks.map(() => ({ count: 0, ns: 0 }));
    let orphanRoundTrips = 0;
    for (const roundTrip of roundTrips) {
        let low = 0;
        let high = callbacks.length - 1;
        let found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (callbacks[middle].start <= roundTrip.start) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (found >= 0 && roundTrip.end <= callbacks[found].end) {
            contained[found].count++;
            contained[found].ns += roundTrip.durationNs;
        } else {
            orphanRoundTrips++;
        }
    }
    const overhead = [];
    const roundTripsPerCallback = [];
    let withoutIpc = 0;
    callbacks.forEach((callback, index) => {
        if (contained[index].count === 0) {
            withoutIpc++;
            return;
        }
        roundTripsPerCallback.push(contained[index].count);
        overhead.push(Math.max(0, callback.durationNs - contained[index].ns));
    });
    return {
        callbacks: callbacks.length,
        callbacksWithIpc: callbacks.length - withoutIpc,
        callbacksWithoutIpc: withoutIpc,
        orphanRoundTrips,
        overlappingCallbacks,
        attribution:
            overlappingCallbacks === 0
                ? "exact (callbacks are serialized)"
                : "ambiguous: callbacks overlap, so containment may misattribute round trips",
        adapterOverheadNs: durationStats(overhead),
        roundTripsPerCallback: durationStats(roundTripsPerCallback),
    };
};

/** mount.localCommit per trigger, with nested target-write time removed. */
export const summarizeLocalCommits = (records) => {
    const byTrigger = new Map();
    for (const record of records) {
        if (
            record.source !== "node-daemon" ||
            record.phase !== "mount.localCommit"
        ) {
            continue;
        }
        const trigger = String(record.detail.trigger ?? record.operation);
        let group = byTrigger.get(trigger);
        if (!group) {
            group = {
                trigger,
                fences: [],
                exclusive: [],
                requiredCommit: 0,
                joinedInFlight: 0,
                failed: 0,
            };
            byTrigger.set(trigger, group);
        }
        group.fences.push(record.durationNs);
        if (record.detail.requiredCommit === true) group.requiredCommit++;
        if (!record.ok) group.failed++;
        const writeFileNs = Number(record.detail.writeFileNs ?? 0);
        if (Number(record.detail.commitsJoined ?? 0) > 0) {
            group.joinedInFlight++;
        } else {
            group.exclusive.push(Math.max(0, record.durationNs - writeFileNs));
        }
    }
    return [...byTrigger.values()]
        .sort((left, right) => (left.trigger < right.trigger ? -1 : 1))
        .map((group) => ({
            trigger: group.trigger,
            requiredCommit: group.requiredCommit,
            joinedInFlight: group.joinedInFlight,
            failed: group.failed,
            fenceNs: durationStats(group.fences),
            // Fence time outside the target writes it started itself; fences
            // that waited on another fence's commit are excluded here.
            exclusiveOfWriteFileNs: durationStats(group.exclusive),
        }));
};

const sampleWindows = (report) => {
    const windows = [];
    for (const scenario of report.scenarios) {
        for (const [index, sample] of scenario.warmupSamples.entries()) {
            windows.push({
                scenario: scenario.name,
                index,
                warmup: true,
                start: BigInt(sample.startedAtUnixNs),
                end: BigInt(sample.endedAtUnixNs),
            });
        }
        for (const [index, sample] of scenario.samples.entries()) {
            windows.push({
                scenario: scenario.name,
                index,
                warmup: false,
                start: BigInt(sample.startedAtUnixNs),
                end: BigInt(sample.endedAtUnixNs),
            });
        }
    }
    return windows.sort((left, right) => (left.start < right.start ? -1 : 1));
};

/**
 * Attribute operational records to mounted-benchmark sample windows by their
 * start time. Records inside warmup windows are counted and excluded.
 */
export const attributeToBenchmark = (records, report, label) => {
    validateNativeMountBenchmarkReport(report);
    const windows = sampleWindows(report);
    const perSample = new Map();
    let warmupRecords = 0;
    let unattributedRecords = 0;
    for (const record of records) {
        if (META_PHASES.has(record.phase)) continue;
        let low = 0;
        let high = windows.length - 1;
        let found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (windows[middle].start <= record.start) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        const window =
            found >= 0 && record.start <= windows[found].end
                ? windows[found]
                : undefined;
        if (!window) {
            unattributedRecords++;
            continue;
        }
        if (window.warmup) {
            warmupRecords++;
            continue;
        }
        const key = `${window.scenario}\u0000${window.index}`;
        let sample = perSample.get(key);
        if (!sample) {
            sample = { callbacks: 0, phases: new Map() };
            perSample.set(key, sample);
        }
        if (record.phase === "native.callback") sample.callbacks++;
        const phaseKey = `${record.source} ${record.phase}`;
        const phase = sample.phases.get(phaseKey) ?? { count: 0, ns: 0 };
        phase.count++;
        phase.ns += record.durationNs;
        sample.phases.set(phaseKey, phase);
    }
    const scenarios = report.scenarios.map((scenario) => {
        const samples = scenario.samples.map(
            (_, index) =>
                perSample.get(`${scenario.name}\u0000${index}`) ?? {
                    callbacks: 0,
                    phases: new Map(),
                }
        );
        const phaseNames = new Set(
            samples.flatMap((sample) => [...sample.phases.keys()])
        );
        const phases = [...phaseNames].sort().map((name) => ({
            phase: name,
            countPerSample: durationStats(
                samples.map((sample) => sample.phases.get(name)?.count ?? 0)
            ),
            nsPerSample: durationStats(
                samples.map((sample) => sample.phases.get(name)?.ns ?? 0)
            ),
        }));
        return {
            name: scenario.name,
            samples: scenario.samples.length,
            samplePerceivedNs: {
                p50Ns: scenario.summary.p50Ns,
                p95Ns: scenario.summary.p95Ns,
            },
            callbacksPerSample: durationStats(
                samples.map((sample) => sample.callbacks)
            ),
            phases,
        };
    });
    return {
        label,
        targetKind: report.target.kind,
        warmupRecords,
        unattributedRecords,
        scenarios,
    };
};

export const summarizeMountProfile = ({
    inputs,
    benchmarks = [],
    joinToleranceNs = DEFAULT_JOIN_TOLERANCE_NS,
}) => {
    const records = inputs.flatMap((input) => input.records);
    const operational = records.filter(
        (record) => !META_PHASES.has(record.phase)
    );
    const { sessions, totals } = summarizeSessions(records);
    const sources = [...new Set(operational.map((record) => record.source))];
    return {
        schema: MOUNT_PROFILE_SUMMARY_SCHEMA,
        schemaVersion: MOUNT_PROFILE_SUMMARY_SCHEMA_VERSION,
        inputs: inputs.map((input) => ({
            file: input.file,
            records: input.records.length,
            ignoredLines: input.ignored,
        })),
        integrity: {
            ...totals,
            sources: sources.sort(),
            // Without the adapter's own records only daemon phases exist.
            adapterRecordsPresent: sources.includes("native-adapter"),
            sessions,
        },
        phases: summarizePhases(operational),
        ipc: joinIpcRecords(operational, joinToleranceNs),
        adapterCallbacks: summarizeAdapterCallbacks(operational),
        localCommit: summarizeLocalCommits(operational),
        benchmark: benchmarks.map(({ label, report }) =>
            attributeToBenchmark(operational, report, label)
        ),
        notes: [
            "Phases nest (native.callback > ipc.roundTrip > ipc.service > mount.localCommit > mount.target.writeFile); never add them.",
            "transportNs = joined ipc.roundTrip - ipc.service (framing, loopback, adapter encode/decode).",
            "Failures: absent = ENOENT; unavailable = EAGAIN/EIO/EBUSY/ENOLCK/ETIMEDOUT/ECLOSED or no code; error = any other code.",
            "Kernel time outside userspace callbacks and cached operations that never reach userspace are not observable.",
        ],
    };
};

const ms = (ns) =>
    ns === undefined || ns === null ? "—" : `${(ns / 1e6).toFixed(3)} ms`;

const statsCells = (stats) =>
    stats.count === 0
        ? "— | — | — | —"
        : `${ms(stats.p50Ns)} | ${ms(stats.p95Ns)} | ${ms(stats.p99Ns)} | ${ms(stats.maxNs)}`;

export const formatMountProfileSummaryMarkdown = (
    summary,
    { maxRows = 40, title = "Shared FS mount profile" } = {}
) => {
    const lines = [`## ${title}`, ""];
    const integrity = summary.integrity;
    lines.push(
        `Records: ${summary.inputs.map((input) => `${input.file.split(/[\\/]/u).at(-1)}=${input.records}`).join(", ")}`,
        `Sessions: ${integrity.sessions.length} (${integrity.incompleteSessions} without a final summary); dropped=${integrity.dropped} lost=${integrity.lost} writeErrors=${integrity.writeErrors}`,
        `Adapter records present: ${integrity.adapterRecordsPresent ? "yes" : "no (older adapter, in-process mount, or adapter profiling failed)"}`,
        ""
    );
    const ignored = summary.inputs.reduce(
        (sum, input) =>
            sum +
            Object.values(input.ignoredLines).reduce(
                (inner, value) => inner + value,
                0
            ),
        0
    );
    if (ignored > 0) lines.push(`Ignored lines: ${ignored}`, "");

    lines.push(
        "| Source | Phase | Operation | Count | Absent | Unavailable | Error | p50 | p95 | p99 | max |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const phase of summary.phases.slice(0, maxRows)) {
        lines.push(
            `| ${phase.source} | ${phase.phase} | ${phase.operation} | ${phase.count} | ${phase.failures.absent} | ${phase.failures.unavailable} | ${phase.failures.error} | ${statsCells(phase)} |`
        );
    }
    if (summary.phases.length > maxRows) {
        lines.push(
            "",
            `(${summary.phases.length - maxRows} more phase groups in the JSON summary)`
        );
    }

    const ipc = summary.ipc;
    lines.push(
        "",
        "### IPC lane: queue vs service",
        "",
        `Joined ${ipc.joined}/${ipc.roundTrips} round trips with ${ipc.services} daemon service records (${ipc.keyedJoins} by port+requestId, ${ipc.timeJoins} by requestId+time); unmatched round trips=${ipc.unmatchedRoundTrips}, services=${ipc.unmatchedServices}; containment violations=${ipc.containmentViolations} (tolerance ${ms(ipc.toleranceNs)}); connection-setup samples=${ipc.connectionSetupSamples}.`,
        `Queue share of lane time: ${ipc.queueShareOfLane === null ? "—" : `${(ipc.queueShareOfLane * 100).toFixed(2)}%`}`,
        "",
        "| Component | Count | p50 | p95 | p99 | max |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        `| queue (adapter lane wait) | ${ipc.queueNs.count} | ${statsCells(ipc.queueNs)} |`,
        `| round trip | ${ipc.roundTripNs.count} | ${statsCells(ipc.roundTripNs)} |`,
        `| service (joined) | ${ipc.joinedServiceNs.count} | ${statsCells(ipc.joinedServiceNs)} |`,
        `| transport (round trip - service) | ${ipc.transportNs.count} | ${statsCells(ipc.transportNs)} |`
    );

    const adapter = summary.adapterCallbacks;
    if (adapter.callbacks > 0) {
        lines.push(
            "",
            "### Adapter callbacks",
            "",
            `${adapter.callbacks} callbacks (${adapter.callbacksWithoutIpc} without IPC); attribution ${adapter.attribution}; orphan round trips=${adapter.orphanRoundTrips}.`,
            `Adapter overhead (callback - contained round trips): ${statsCells(adapter.adapterOverheadNs).replaceAll(" | ", " / ")} (p50/p95/p99/max)`
        );
    }

    if (summary.localCommit.length > 0) {
        lines.push(
            "",
            "### Local commit fences",
            "",
            "| Trigger | Fences | Required | Joined in-flight | Failed | fence p50 | fence p95 | excl. writeFile p50 | excl. writeFile p95 |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
        );
        for (const fence of summary.localCommit) {
            lines.push(
                `| ${fence.trigger} | ${fence.fenceNs.count} | ${fence.requiredCommit} | ${fence.joinedInFlight} | ${fence.failed} | ${ms(fence.fenceNs.p50Ns)} | ${ms(fence.fenceNs.p95Ns)} | ${ms(fence.exclusiveOfWriteFileNs.p50Ns)} | ${ms(fence.exclusiveOfWriteFileNs.p95Ns)} |`
            );
        }
    }

    for (const benchmark of summary.benchmark) {
        lines.push(
            "",
            `### Benchmark attribution: ${benchmark.label}`,
            "",
            `Warmup records excluded=${benchmark.warmupRecords}; records outside any sample window=${benchmark.unattributedRecords}.`,
            "",
            "| Scenario | Sample p50 | Callbacks/sample p50 | Top phases (p50 ns/sample) |",
            "| --- | ---: | ---: | --- |"
        );
        for (const scenario of benchmark.scenarios) {
            const top = [...scenario.phases]
                .sort(
                    (left, right) =>
                        right.nsPerSample.p50Ns - left.nsPerSample.p50Ns
                )
                .slice(0, 4)
                .map(
                    (phase) =>
                        `${phase.phase} ${ms(phase.nsPerSample.p50Ns)} ×${phase.countPerSample.p50Ns}`
                )
                .join("; ");
            lines.push(
                `| ${scenario.name} | ${ms(scenario.samplePerceivedNs.p50Ns)} | ${scenario.callbacksPerSample.p50Ns ?? "—"} | ${top || "—"} |`
            );
        }
    }
    lines.push("", ...summary.notes.map((note) => `- ${note}`), "");
    return lines.join("\n");
};

/**
 * Compare alternating unprofiled/profiled benchmark passes (for example
 * A-B-B-A on one VM) so profiling overhead is visible next to the profile.
 */
export const formatProfilingOverheadMarkdown = (passes) => {
    for (const pass of passes) validateNativeMountBenchmarkReport(pass.report);
    const names = passes[0]?.report.scenarios.map(({ name }) => name) ?? [];
    for (const pass of passes) {
        const passNames = pass.report.scenarios.map(({ name }) => name);
        if (JSON.stringify(passNames) !== JSON.stringify(names)) {
            throw new Error(
                `benchmark pass ${pass.label} has a different scenario set`
            );
        }
    }
    const median = (values) => {
        const sorted = [...values].sort((left, right) => left - right);
        if (sorted.length === 0) return undefined;
        const middle = sorted.length >> 1;
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const lines = [
        "## Profiling overhead (alternating passes on one runner)",
        "",
        `| Scenario | ${passes.map((pass) => `${pass.label} (${pass.profiled ? "profiled" : "unprofiled"}) p50`).join(" | ")} | profiled/unprofiled p50 |`,
        `| --- | ${passes.map(() => "---:").join(" | ")} | ---: |`,
    ];
    for (const [index, name] of names.entries()) {
        const p50 = passes.map(
            (pass) => pass.report.scenarios[index].summary.p50Ns
        );
        const profiled = median(
            p50.filter((_, passIndex) => passes[passIndex].profiled)
        );
        const unprofiled = median(
            p50.filter((_, passIndex) => !passes[passIndex].profiled)
        );
        const ratio =
            profiled === undefined || unprofiled === undefined
                ? "—"
                : `${(profiled / unprofiled).toFixed(3)}×`;
        lines.push(`| ${name} | ${p50.map(ms).join(" | ")} | ${ratio} |`);
    }
    lines.push(
        "",
        "Ratios compare medians of per-pass p50s. Report-only: no threshold is applied.",
        ""
    );
    return lines.join("\n");
};

export const parseMountProfileSummaryArguments = (argv) => {
    const options = {
        profileDirectories: [],
        inputs: [],
        benchmarks: [],
        abReports: [],
        joinToleranceNs: DEFAULT_JOIN_TOLERANCE_NS,
        maxRows: 40,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--") continue;
        const value = argv[++index];
        if (value === undefined)
            throw new Error(`${argument} requires a value`);
        switch (argument) {
            case "--profile-dir":
                options.profileDirectories.push(resolve(value));
                break;
            case "--input":
                options.inputs.push(resolve(value));
                break;
            case "--benchmark": {
                const separator = value.indexOf("=");
                options.benchmarks.push(
                    separator > 0
                        ? {
                              label: value.slice(0, separator),
                              path: resolve(value.slice(separator + 1)),
                          }
                        : { label: value, path: resolve(value) }
                );
                break;
            }
            case "--ab-report": {
                const match = /^([^=:]+):(profiled|unprofiled)=(.+)$/u.exec(
                    value
                );
                if (!match) {
                    throw new Error(
                        "--ab-report requires <label>:profiled=<report> or <label>:unprofiled=<report>"
                    );
                }
                options.abReports.push({
                    label: match[1],
                    profiled: match[2] === "profiled",
                    path: resolve(match[3]),
                });
                break;
            }
            case "--join-tolerance-ns": {
                const tolerance = Number(value);
                if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
                    throw new Error(
                        "--join-tolerance-ns must be a non-negative integer"
                    );
                }
                options.joinToleranceNs = tolerance;
                break;
            }
            case "--max-rows": {
                const rows = Number(value);
                if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
                    throw new Error("--max-rows must be from 1 through 1000");
                }
                options.maxRows = rows;
                break;
            }
            case "--json":
                options.json = resolve(value);
                break;
            case "--markdown":
                options.markdown = resolve(value);
                break;
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (
        options.profileDirectories.length === 0 &&
        options.inputs.length === 0 &&
        options.abReports.length === 0
    ) {
        throw new Error(
            "provide --profile-dir, --input, or --ab-report (see the file header)"
        );
    }
    return options;
};

const writeOutput = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

export const runMountProfileSummary = async (options) => {
    const files = [...options.inputs];
    for (const directory of options.profileDirectories) {
        files.push(...(await listMountProfileFiles(directory)));
    }
    const sections = [];
    let summary;
    if (files.length > 0) {
        const inputs = [];
        for (const file of [...new Set(files)].sort()) {
            inputs.push(await readMountProfileFile(file));
        }
        const benchmarks = [];
        for (const { label, path } of options.benchmarks) {
            benchmarks.push({
                label,
                report: JSON.parse(await readFile(path, "utf8")),
            });
        }
        summary = summarizeMountProfile({
            inputs,
            benchmarks,
            joinToleranceNs: options.joinToleranceNs,
        });
        sections.push(
            formatMountProfileSummaryMarkdown(summary, {
                maxRows: options.maxRows,
            })
        );
    }
    if (options.abReports.length > 0) {
        const passes = [];
        for (const pass of options.abReports) {
            passes.push({
                ...pass,
                report: JSON.parse(await readFile(pass.path, "utf8")),
            });
        }
        sections.push(formatProfilingOverheadMarkdown(passes));
    }
    const markdown = sections.join("\n");
    if (options.json && summary) {
        await writeOutput(
            options.json,
            `${JSON.stringify(summary, null, 2)}\n`
        );
    }
    if (options.markdown) await writeOutput(options.markdown, markdown);
    return { summary, markdown };
};

if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
    runMountProfileSummary(
        parseMountProfileSummaryArguments(process.argv.slice(2))
    )
        .then(({ markdown }) => {
            process.stdout.write(markdown);
        })
        .catch((error) => {
            process.stderr.write(
                `${error instanceof Error ? error.stack : String(error)}\n`
            );
            process.exitCode = 1;
        });
}
