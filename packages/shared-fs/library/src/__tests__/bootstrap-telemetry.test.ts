import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type BootstrapTelemetryEvent } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 120_000 : 45_000);
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

type BootstrapEventType = BootstrapTelemetryEvent["type"];

const eventsOf = <T extends BootstrapEventType>(
    events: BootstrapTelemetryEvent[],
    type: T
) =>
    events.filter(
        (event): event is Extract<BootstrapTelemetryEvent, { type: T }> =>
            event.type === type
    );

const expectOrdered = (
    events: BootstrapTelemetryEvent[],
    expected: BootstrapEventType[]
) => {
    let cursor = -1;
    for (const type of expected) {
        const next = events.findIndex(
            (event, index) => index > cursor && event.type === type
        );
        expect(
            next,
            `missing ordered bootstrap telemetry event: ${type}`
        ).not.toBe(-1);
        cursor = next;
    }
};

const waitForSnapshotOverlay = async (
    joiner: { bootstrapStatus(): { phase: string } },
    events: BootstrapTelemetryEvent[]
) => {
    const deadline = Date.now() + (process.env.CI ? 120_000 : 45_000);
    while (Date.now() < deadline) {
        const phase = joiner.bootstrapStatus().phase;
        if (phase === "overlay-active") {
            return;
        }
        const terminal = events.find(
            (event) =>
                event.type === "fallback" ||
                event.type === "aborted" ||
                event.type === "overlay-retired"
        );
        if (phase === "converged" || phase === "unverified" || terminal) {
            throw new Error(
                `snapshot overlay was never observed active (phase=${phase}, terminal=${terminal?.type ?? "none"})`
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for the snapshot overlay to activate");
};

describe("shared fs bootstrap telemetry", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            peers.splice(0).map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* benign close races */
                }
            })
        );
    });

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    const createSnapshotDonor = async (fileCount = 120) => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "telemetry-donor",
        });
        await fs.writeBatch(
            Array.from({ length: fileCount }, (_, index) => ({
                path: `/tree/dir-${index % 8}/file-${index}.txt`,
                content: `content ${index}`,
            }))
        );
        const snapshot = await fs.snapshotWrite();
        expect(snapshot.segments).toBeGreaterThan(0);
        return { peer, fs };
    };

    it(
        "emits ordered, monotonic snapshot milestones exactly once",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await createSnapshotDonor();
            const events: BootstrapTelemetryEvent[] = [];
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);

            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "telemetry-joiner",
                telemetry: { bootstrap: (event) => events.push(event) },
            });

            await waitForSnapshotOverlay(joiner, events);
            const converged = await joiner.awaitBootstrapConverged();
            expect(converged.verified).toBe(true);
            await joiner.awaitWriteReady({ timeout: 60_000 });
            await waitUntil(() => {
                expect(eventsOf(events, "write-ready")).toHaveLength(1);
            });

            const expectedMilestones = [
                "open:start",
                "documents-open:start",
                "documents-open:end",
                "manifest-discovery:start",
                "manifest-discovery:end",
                "segments-fetch:start",
                "segments-fetch:end",
                "overlay-install:start",
                "overlay-ready",
                "pending-drained",
                "overlay-retired",
                "synchronizer-idle",
                "write-ready",
            ] as const;
            expectOrdered(events, [...expectedMilestones]);

            for (const type of expectedMilestones) {
                expect(
                    eventsOf(events, type),
                    `${type} must emit once`
                ).toHaveLength(1);
            }
            expect(eventsOf(events, "fallback")).toHaveLength(0);
            expect(eventsOf(events, "aborted")).toHaveLength(0);

            expect(eventsOf(events, "open:start")[0]).toMatchObject({
                atMs: 0,
                addressOpen: true,
                mode: "auto",
            });

            for (let index = 1; index < events.length; index++) {
                expect(events[index].atMs).toBeGreaterThanOrEqual(
                    events[index - 1].atMs
                );
            }

            expect(eventsOf(events, "overlay-retired")[0]).toMatchObject({
                verified: true,
            });
            expect(eventsOf(events, "write-ready")[0]).toMatchObject({
                source: "remote-settled",
            });
            expect(
                eventsOf(events, "manifest-discovery:end")[0].trusted
            ).toBeGreaterThan(0);
            expect(eventsOf(events, "segments-fetch:end")[0]).toMatchObject({
                segments: expect.any(Number),
                documents: expect.any(Number),
                bytes: expect.any(Number),
            });
            expect(
                eventsOf(events, "segments-fetch:end")[0].bytes
            ).toBeGreaterThan(0);
            expect(
                eventsOf(events, "overlay-ready")[0].documents
            ).toBeGreaterThan(0);
            for (const event of events) {
                if ("durationMs" in event) {
                    expect(event.durationMs).toBeGreaterThanOrEqual(0);
                }
            }
        }
    );

    it(
        "isolates telemetry callback failures from bootstrap convergence",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await createSnapshotDonor();
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            let callbackCalls = 0;
            const events: BootstrapTelemetryEvent[] = [];

            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "throwing-telemetry-joiner",
                telemetry: {
                    bootstrap: (event) => {
                        callbackCalls++;
                        events.push(event);
                        if (callbackCalls % 2 === 0) {
                            return Promise.reject(
                                new Error("async application telemetry failure")
                            );
                        }
                        throw new Error("application telemetry failure");
                    },
                },
            });

            await waitForSnapshotOverlay(joiner, events);
            await expect(
                joiner.awaitBootstrapConverged()
            ).resolves.toMatchObject({ verified: true });
            await joiner.awaitWriteReady({ timeout: 60_000 });
            expect(callbackCalls).toBeGreaterThan(0);
            expect(
                decode(await joiner.readFile("/tree/dir-7/file-47.txt"))
            ).toBe("content 47");
        }
    );

    it(
        "emits one abort and releases its callback when closed mid-bootstrap",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donor = await createSnapshotDonor();
            const joinerPeer = await createPeer();
            await joinerPeer.dial(donor.peer);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.fs.address,
                machineLabel: "closing-telemetry-joiner",
                telemetry: { bootstrap: (event) => events.push(event) },
            });

            await waitUntil(() => {
                expect(["fetching", "overlay-active"]).toContain(
                    joiner.bootstrapStatus().phase
                );
            });
            await joiner.program.close();

            expect(eventsOf(events, "aborted")).toHaveLength(1);
            const eventCountAfterClose = events.length;
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(events).toHaveLength(eventCountAfterClose);
            expect((joiner.program as any).bootstrapTelemetry).toBeUndefined();
        }
    );

    it(
        "reports a reasoned plain-join fallback, reaches readiness, and retains no sync profiler",
        { retry: 1, timeout: 240_000 },
        async () => {
            const donorPeer = await createPeer();
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "plain-telemetry-donor",
            });
            await donor.writeFile("/plain.txt", "no snapshot here");

            const joinerPeer = await createPeer();
            // Exercise SharedLog's native-default SyncOptions clone. Bootstrap
            // telemetry is independent of the temporary sync diagnostic sink,
            // which must be removed from this retained object after open.
            (joinerPeer as any).sharedLogNativeDefaults = {
                sync: { rawExchangeHeads: true },
            };
            await joinerPeer.dial(donorPeer);
            const events: BootstrapTelemetryEvent[] = [];
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.address,
                machineLabel: "plain-telemetry-joiner",
                telemetry: { bootstrap: (event) => events.push(event) },
            });

            expect(
                (joiner.program.entries.log as any)._logProperties?.sync
                    ?.profile
            ).toBeUndefined();
            await waitUntil(async () => {
                expect(decode(await joiner.readFile("/plain.txt"))).toBe(
                    "no snapshot here"
                );
            });
            await waitUntil(() => {
                expect(eventsOf(events, "fallback")).toHaveLength(1);
                expect(joiner.bootstrapStatus().phase).toBe("off");
            });
            await joiner.awaitWriteReady({ timeout: 60_000 });
            await joiner.writeFile("/after-fallback.txt", "safe");
            await waitUntil(() => {
                expect(eventsOf(events, "write-ready")).toHaveLength(1);
            });

            expectOrdered(events, [
                "open:start",
                "documents-open:start",
                "documents-open:end",
                "manifest-discovery:start",
                "manifest-discovery:end",
                "fallback",
                "synchronizer-idle",
                "write-ready",
            ]);
            const fallback = eventsOf(events, "fallback");
            expect(fallback).toHaveLength(1);
            expect(fallback[0].posture).toBe("plain-join");
            expect(fallback[0].reason.length).toBeGreaterThan(0);
            expect(eventsOf(events, "write-ready")[0]).toMatchObject({
                source: "remote-settled",
            });
            expect(eventsOf(events, "segments-fetch:start")).toHaveLength(0);
            expect(eventsOf(events, "overlay-ready")).toHaveLength(0);
            expect(
                (joiner.program.entries.log as any)._logProperties?.sync
                    ?.profile
            ).toBeUndefined();
        }
    );
});
