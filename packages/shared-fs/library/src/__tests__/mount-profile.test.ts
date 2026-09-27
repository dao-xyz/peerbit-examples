import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
    SHARED_FS_MOUNT_PROFILE_SCHEMA,
    SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION,
    createSharedFsMountProfileWriter,
    emitSharedFsMountProfile,
    openSharedFsMountProfileFile,
    profileSharedFsMountOperation,
    sharedFsMountProfileErrorCode,
    sharedFsMountProfileUnixNs,
    type SharedFsMountProfileEvent,
} from "../mount-profile.js";

const UNIX_NS = /^[1-9][0-9]{0,18}$/u;

const event = (operation: string): SharedFsMountProfileEvent => ({
    schema: SHARED_FS_MOUNT_PROFILE_SCHEMA,
    schemaVersion: SHARED_FS_MOUNT_PROFILE_SCHEMA_VERSION,
    source: "node-daemon",
    phase: "ipc.service",
    operation,
    startUnixNs: "1790000000000000000",
    durationNs: 1,
    ok: true,
});

/**
 * A writable whose first write stays pending until released. Everything the
 * writer hands it is recorded, so tests can inspect exact NDJSON output.
 */
class GatedWritable extends Writable {
    chunks: string[] = [];
    private gate: Promise<void>;
    private open!: () => void;
    writes = 0;

    constructor(options: { gated: boolean }) {
        super({ decodeStrings: false });
        this.gate = options.gated
            ? new Promise<void>((resolve) => {
                  this.open = resolve;
              })
            : Promise.resolve();
    }

    release() {
        this.open();
    }

    override _write(
        chunk: string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void
    ) {
        this.writes++;
        this.gate.then(() => {
            this.chunks.push(chunk);
            callback();
        });
    }

    lines() {
        return this.chunks
            .join("")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as SharedFsMountProfileEvent);
    }
}

const nextMacrotask = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

describe("shared fs mount profiling", () => {
    it("anchors start times in Unix nanoseconds and preserves the result", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        const before = BigInt(Date.now()) * 1_000_000n;
        await expect(
            profileSharedFsMountOperation(
                (value) => events.push(value),
                {
                    source: "node-daemon",
                    phase: "ipc.service",
                    operation: "getattr",
                    detail: { requestId: 7 },
                },
                async () => "result"
            )
        ).resolves.toBe("result");
        expect(events).toHaveLength(1);
        const [recorded] = events;
        expect(recorded).toMatchObject({
            schema: "peerbit.shared-fs.mount-profile",
            schemaVersion: 1,
            source: "node-daemon",
            phase: "ipc.service",
            operation: "getattr",
            ok: true,
            detail: { requestId: 7 },
        });
        expect(recorded.startUnixNs).toMatch(UNIX_NS);
        expect(Number.isSafeInteger(recorded.durationNs)).toBe(true);
        expect(recorded.durationNs).toBeGreaterThanOrEqual(0);
        // Wall-clock sanity only: the anchor derives from the same host clock.
        // A one-minute window keeps this independent of scheduling latency.
        const start = BigInt(recorded.startUnixNs);
        expect(start > before - 60_000_000_000n).toBe(true);
        expect(start < before + 60_000_000_000n).toBe(true);
    });

    it("derives Unix start times from one monotonic reading", () => {
        const base = process.hrtime.bigint();
        expect(
            BigInt(sharedFsMountProfileUnixNs(base + 1_234n)) -
                BigInt(sharedFsMountProfileUnixNs(base))
        ).toBe(1_234n);
    });

    it("reports a failure code without replacing the operation error", async () => {
        const expected = Object.assign(new Error("absent"), {
            code: "ENOENT",
        });
        const events: SharedFsMountProfileEvent[] = [];
        await expect(
            profileSharedFsMountOperation(
                (value) => events.push(value),
                {
                    source: "node-daemon",
                    phase: "mount.target.writeFile",
                    operation: "writeFile",
                    detail: { bytes: 3 },
                },
                async () => {
                    throw expected;
                }
            )
        ).rejects.toBe(expected);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            phase: "mount.target.writeFile",
            ok: false,
            detail: { bytes: 3, code: "ENOENT" },
        });
    });

    it("classifies uncoded and malformed failures as EIO", () => {
        expect(sharedFsMountProfileErrorCode(new Error("plain"))).toBe("EIO");
        expect(sharedFsMountProfileErrorCode({ code: 5 })).toBe("EIO");
        expect(sharedFsMountProfileErrorCode({ code: "not-errno" })).toBe(
            "EIO"
        );
        expect(sharedFsMountProfileErrorCode(undefined)).toBe("EIO");
        expect(sharedFsMountProfileErrorCode({ code: "EAGAIN" })).toBe(
            "EAGAIN"
        );
    });

    it("isolates a report sink failure", () => {
        expect(() =>
            emitSharedFsMountProfile(() => {
                throw new Error("report failed");
            }, event("read"))
        ).not.toThrow();
    });

    it("isolates a rejected async report sink", async () => {
        const rejection = Promise.reject(new Error("async report failed"));
        const catchRejection = vi.spyOn(rejection, "catch");

        emitSharedFsMountProfile(() => rejection, event("read"));

        expect(catchRejection).toHaveBeenCalledOnce();
        await expect(rejection).rejects.toThrow("async report failed");
    });
});

describe("bounded mount profile writer", () => {
    it("writes framed NDJSON and a final summary", async () => {
        const output = new GatedWritable({ gated: false });
        const writer = createSharedFsMountProfileWriter(output);
        writer.sink(event("getattr"));
        writer.sink(event("read"));
        const stats = await writer.close();

        const lines = output.lines();
        expect(lines.map((line) => line.phase)).toEqual([
            "profile.start",
            "ipc.service",
            "ipc.service",
            "profile.summary",
        ]);
        for (const line of lines) {
            expect(line.schema).toBe("peerbit.shared-fs.mount-profile");
            expect(line.schemaVersion).toBe(1);
            expect(line.startUnixNs).toMatch(UNIX_NS);
        }
        expect(lines[0].detail).toMatchObject({
            pid: process.pid,
            maxQueuedEvents: 16_384,
            maxQueuedBytes: 8 * 1024 * 1024,
        });
        expect(lines.at(-1)).toMatchObject({
            source: "node-daemon",
            ok: true,
            detail: {
                emitted: 2,
                written: 2,
                dropped: 0,
                lost: 0,
                writeErrors: 0,
            },
        });
        expect(stats).toMatchObject({ emitted: 2, written: 2, dropped: 0 });
    });

    it("drops beyond the event cap without blocking the caller", async () => {
        const output = new GatedWritable({ gated: false });
        const writer = createSharedFsMountProfileWriter(output, {
            maxQueuedEvents: 4,
        });
        // Sink calls return synchronously; the batch drains on a later
        // macrotask, so ten calls in one turn meet a four-event queue.
        for (let index = 0; index < 10; index++) {
            writer.sink(event(`op-${index}`));
        }
        expect(writer.stats()).toMatchObject({ emitted: 10, dropped: 6 });
        const stats = await writer.close();
        expect(stats).toMatchObject({ emitted: 10, written: 4, dropped: 6 });
        const lines = output.lines();
        expect(
            lines
                .filter((line) => line.phase === "ipc.service")
                .map((line) => line.operation)
        ).toEqual(["op-0", "op-1", "op-2", "op-3"]);
        expect(lines.at(-1)?.detail).toMatchObject({
            emitted: 10,
            written: 4,
            dropped: 6,
        });
    });

    it("drops while the output holds too many bytes and recovers after release", async () => {
        const output = new GatedWritable({ gated: true });
        const writer = createSharedFsMountProfileWriter(output, {
            maxQueuedBytes: 1,
        });
        // The pending start record already exceeds the one-byte bound.
        expect(output.writableLength).toBeGreaterThan(1);
        writer.sink(event("blocked"));
        expect(writer.stats()).toMatchObject({ emitted: 1, dropped: 1 });

        output.release();
        // The gate resolves in a microtask; every microtask has run before
        // the next macrotask, so the start record's bytes have left the queue.
        await nextMacrotask();
        expect(output.writableLength).toBe(0);
        writer.sink(event("after-release"));
        const stats = await writer.close();
        expect(stats).toMatchObject({ emitted: 2, written: 1, dropped: 1 });
        expect(
            output
                .lines()
                .filter((line) => line.phase === "ipc.service")
                .map((line) => line.operation)
        ).toEqual(["after-release"]);
    });

    it("keeps accepting (and counting) while a write is stalled", async () => {
        const output = new GatedWritable({ gated: true });
        const writer = createSharedFsMountProfileWriter(output, {
            maxQueuedEvents: 2,
            maxQueuedBytes: 1 << 20,
        });
        writer.sink(event("first"));
        await nextMacrotask();
        // The first batch is handed to the stalled stream; a later batch can
        // still queue behind it up to the event cap, and the rest are dropped.
        writer.sink(event("second"));
        writer.sink(event("third"));
        writer.sink(event("fourth"));
        expect(writer.stats()).toMatchObject({ emitted: 4, dropped: 1 });

        const closing = writer.close();
        writer.sink(event("late"));
        output.release();
        const stats = await closing;
        expect(stats).toMatchObject({
            emitted: 4,
            written: 3,
            dropped: 1,
            droppedAfterClose: 1,
        });
        expect(output.lines().at(-1)?.detail).toMatchObject({
            emitted: 4,
            written: 3,
            dropped: 1,
        });
    });

    it("counts output failures instead of surfacing them to the mount", async () => {
        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback(new Error("disk full"));
            },
        });
        const writer = createSharedFsMountProfileWriter(output);
        writer.sink(event("lost"));
        await nextMacrotask();
        writer.sink(event("after-failure"));
        const stats = await writer.close();
        expect(stats.writeErrors).toBeGreaterThan(0);
        expect(stats.emitted).toBe(2);
        expect(stats.written).toBe(0);
        expect(stats.dropped + stats.lost).toBe(2);
    });

    it("rejects invalid bounds", () => {
        const output = new GatedWritable({ gated: false });
        expect(() =>
            createSharedFsMountProfileWriter(output, { maxQueuedEvents: 0 })
        ).toThrow(RangeError);
        expect(() =>
            createSharedFsMountProfileWriter(output, { maxQueuedBytes: 1.5 })
        ).toThrow(RangeError);
    });

    it("creates profile files exclusively", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "peerbit-mount-profile-writer-")
        );
        try {
            const path = join(directory, "node-daemon.ndjson");
            const writer = await openSharedFsMountProfileFile(path);
            writer.sink(event("getattr"));
            await writer.close();
            const lines = (await readFile(path, "utf8"))
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(lines.map((line) => line.phase)).toEqual([
                "profile.start",
                "ipc.service",
                "profile.summary",
            ]);

            const existing = join(directory, "existing.ndjson");
            await writeFile(existing, "keep\n");
            await expect(
                openSharedFsMountProfileFile(existing)
            ).rejects.toMatchObject({ code: "EEXIST" });
            expect(await readFile(existing, "utf8")).toBe("keep\n");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
