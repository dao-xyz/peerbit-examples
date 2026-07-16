import { Peerbit } from "peerbit";
import {
    AudioStreamDB,
    Chunk,
    ChunkIndexable,
    MediaStreamDB,
    MediaStreamDBs,
    oneVideoAndOneAudioChangeProcessor,
    Track,
    TrackSource,
    TracksIterator,
    WebcodecsStreamDB,
} from "../index.js";
import {
    AbortError,
    delay,
    hrtime,
    TimeoutError,
    waitForResolved,
} from "@peerbit/time";
import { equals } from "uint8arrays";
import { expect, describe, test, beforeAll, afterAll, afterEach } from "vitest";
import sinon from "sinon";
import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { MAX_U32, ReplicationRangeIndexable } from "@peerbit/shared-log";
import pDefer, { DeferredPromise } from "p-defer";
import path from "path";
import { Compare, WithContext, WithIndexedContext } from "@peerbit/document";
import { MissingResponsesError } from "@peerbit/rpc";
import { ClosedError } from "@peerbit/program";

const MILLISECONDS_TO_MICROSECONDS = 1e3;

const interceptTrackSourceIterator = (
    wrap: (iterator: any, source: TrackSource) => void
) => {
    const iterate = TrackSource.prototype.iterate;
    return sinon
        .stub(TrackSource.prototype, "iterate")
        .callsFake(async function (this: TrackSource, ...args: any[]) {
            const iterator = await (iterate as any).apply(this, args);
            wrap(iterator, this);
            return iterator;
        } as any);
};

describe("oneVideoAndOneAudioChangeProcessor", () => {
    test("preload tracks when end time not set", async () => {
        let preload = 10;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 1e3,
            end: undefined,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.eq(toPlay);
        expect(diff.remove).to.be.undefined;
    });

    test("preload tracks when end time set", async () => {
        let preload = 10;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 1e3,
            end: 2e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.eq(toPlay);
        expect(diff.remove).to.be.undefined;
    });

    test("not load track until preload when end time not set", async () => {
        let preload = 0;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 1e3,
            end: undefined,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.be.undefined;
        expect(diff.remove).to.be.undefined;
    });

    test("not load track until preload when end time set", async () => {
        let preload = 0;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 1e3,
            end: 2e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.be.undefined;
        expect(diff.remove).to.be.undefined;
    });

    test("not add track if end times are equal", async () => {
        let preload = 10;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.be.undefined;
        expect(diff.remove).to.be.undefined;
    });

    test("not add track if end times are equal", async () => {
        let preload = 10;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: 1e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            999,
            preload
        );
        expect(diff.add).to.be.undefined;
        expect(diff.remove).to.be.undefined;
    });

    test("will schedule track loading when necessary with", async () => {
        let preload = 500;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let end1 = 1.5e3;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: end1,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 1e3,
            end: 2e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            end1 - preload + 1,
            preload
        );
        const track = diff.add instanceof Track ? diff.add : diff.add?.track;
        const when = diff.add instanceof Track ? undefined : diff.add?.when;
        expect(track).to.eq(toPlay);
        expect(when).to.eq(end1);
    });

    test("will schedule track with time when not overlapping", async () => {
        let preload = 500;
        const publicKey = (await Ed25519Keypair.create()).publicKey;
        let end1 = 1.5e3;
        let already = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: 0,
            end: end1,
        });
        let toPlay = new Track({
            sender: publicKey,
            source: new AudioStreamDB({ sampleRate: 1 }),
            start: end1 + 1,
            end: 2e3,
        });
        const diff = oneVideoAndOneAudioChangeProcessor(
            {
                current: new Map<string, { track: Track }>([
                    ["address", { track: already }],
                ]),
                options: [already],
                add: toPlay,
            },
            end1 - preload + 2,
            preload
        );
        expect(diff.add as Track).to.eq(toPlay);
    });
});
describe("Track", () => {
    test("setEnd", async () => {
        const now = +new Date();
        const track = new Track({
            sender: (await Ed25519Keypair.create()).publicKey,
            source: new WebcodecsStreamDB({
                decoderDescription: { codec: "av1" },
            }),
            globalTime: now,
            now: () => +new Date(),
        });

        await delay(1e3);
        track.setEnd();
        expect(track.endTime).to.be.closeTo(1e3, 10);
    });
});
describe("TrackSource", () => {
    test("clears live replication debt after its shared log is closed", async () => {
        const source = new AudioStreamDB({ sampleRate: 44100 });
        source.lastLivestreamingSegmentId = randomBytes(32);
        source.lastLivestreamingSegmentStart = 1n;

        await source.endPreviousLivestreamSubscription();

        expect(source.lastLivestreamingSegmentId).to.be.undefined;
        expect(source.lastLivestreamingSegmentStart).to.be.undefined;
    });

    test("clears live replication debt when a closed index resolves empty", async () => {
        const source = new AudioStreamDB({ sampleRate: 44100 });
        source.lastLivestreamingSegmentId = randomBytes(32);
        source.lastLivestreamingSegmentStart = 1n;
        const log = source.chunks.log as any;
        const previousIndex = log._replicationRangeIndex;
        const all = sinon.stub().resolves([]);
        const iterate = sinon.stub().returns({ all });
        log._replicationRangeIndex = { iterate };

        try {
            expect(source.chunks.log.closed).to.be.true;
            await source.endPreviousLivestreamSubscription();

            expect(iterate.calledOnce).to.be.true;
            expect(all.calledOnce).to.be.true;
            expect(source.lastLivestreamingSegmentId).to.be.undefined;
            expect(source.lastLivestreamingSegmentStart).to.be.undefined;
        } finally {
            log._replicationRangeIndex = previousIndex;
        }
    });
});
describe("MediaStream", () => {
    let streamer: Peerbit,
        viewer: Peerbit,
        cleanup: (() => Promise<void>) | undefined,
        iterator: TracksIterator;

    beforeAll(async () => {
        global.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 10);
        };

        streamer = await Peerbit.create();
        viewer = await Peerbit.create();
        await streamer.dial(viewer);
    });

    afterAll(async () => {
        await viewer.stop();
        await streamer.stop();
    });

    afterEach(async () => {
        const currentIterator = iterator;
        const currentCleanup = cleanup;
        // Do not let a test without its own scenario inherit and re-run the
        // previous test's teardown handles. Retire playback before closing its
        // owning programs so RAF loops and subscriptions cannot outlive the
        // test that created them.
        iterator = undefined as any;
        cleanup = undefined;

        const failures: unknown[] = [];
        try {
            await currentIterator?.close();
        } catch (error) {
            failures.push(error);
        }
        try {
            await currentCleanup?.();
        } catch (error) {
            failures.push(error);
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Failed to clean up media test");
        }
    });

    type OneTrack = {
        first: {
            start: number;
            end?: number;
            size?: number;
            type?: "video" | "audio" | WebcodecsStreamDB | AudioStreamDB;
        };
    };
    type TwoTracks = {
        first: {
            start: number;
            end?: number;
            size?: number;
            type?: "video" | "audio" | WebcodecsStreamDB | AudioStreamDB;
        };
        second: {
            start: number;
            end?: number;
            size?: number;
            type?: "video" | "audio" | WebcodecsStreamDB | AudioStreamDB;
        };
    };
    type ScenarioReturnType<T> = (T extends TwoTracks
        ? { track1: Track; track2: Track }
        : { track1: Track }) & {
        viewerStreams: MediaStreamDB;
        mediaStreams: MediaStreamDB;
    };
    const isTwoTracks = (
        options: OneTrack | TwoTracks
    ): options is TwoTracks => {
        if ((options as TwoTracks).second) {
            return true;
        }
        return false;
    };
    const createScenario = async <T extends OneTrack | TwoTracks>(
        properties: {
            delta?: number;
        } & T
    ): Promise<ScenarioReturnType<T>> => {
        const delta = properties.delta ?? 1;
        const firstSize = properties.first.size ?? 1000;
        const mediaStreams = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        const track1 = await streamer.open(
            new Track({
                sender: streamer.identity.publicKey,
                source:
                    typeof properties.first.type === "object"
                        ? properties.first.type
                        : properties.first.type === "video"
                          ? new WebcodecsStreamDB({
                                decoderDescription: { codec: "av01" },
                            })
                          : new AudioStreamDB({ sampleRate: 44100 }),
                start: properties.first.start * MILLISECONDS_TO_MICROSECONDS,
                end:
                    properties.first.end != null
                        ? properties.first.end * MILLISECONDS_TO_MICROSECONDS
                        : undefined,
            })
        );

        const firstTrackWrites: Promise<void>[] = [];
        for (let i = 0; i < firstSize; i++) {
            firstTrackWrites.push(
                track1.put(
                    new Chunk({
                        chunk: new Uint8Array([i]),
                        time: i * MILLISECONDS_TO_MICROSECONDS * delta,
                        type: "key",
                    }),
                    {
                        // These are historical fixtures written before a viewer
                        // exists, so they must not require a live fanout route.
                        target: "none" /*
                    meta: {
                        timestamp: new Timestamp({
                            wallTime: now + BigInt(i * deltaNano),
                        }),
                    }, */,
                    }
                )
            );
        }
        await Promise.all(firstTrackWrites);
        await mediaStreams.tracks.put(track1);

        let track2: Track | undefined = undefined;
        if (isTwoTracks(properties)) {
            track2 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source:
                        typeof properties.second.type === "object"
                            ? properties.second.type
                            : properties.second.type === "video"
                              ? new WebcodecsStreamDB({
                                    decoderDescription: { codec: "av01" },
                                })
                              : new AudioStreamDB({ sampleRate: 44100 }),
                    start:
                        properties.second.start * MILLISECONDS_TO_MICROSECONDS,
                    end:
                        properties.second.end != null
                            ? properties.second.end *
                              MILLISECONDS_TO_MICROSECONDS
                            : undefined,
                })
            );
            const secondTrackWrites: Promise<void>[] = [];
            for (let i = 0; i < (properties.second.size ?? 1000); i++) {
                secondTrackWrites.push(
                    track2.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time: i * MILLISECONDS_TO_MICROSECONDS * delta,
                            type: "key",
                        }),
                        {
                            target: "none",
                            /*  meta: {
                             timestamp: new Timestamp({
                                 wallTime: now + BigInt(i * deltaNano),
                             }),
                         }, */
                        }
                    )
                );
            }
            await Promise.all(secondTrackWrites);
            await mediaStreams.tracks.put(track2);
        }

        const viewerStreams = await viewer.open(mediaStreams.clone());

        cleanup = async () => {
            await mediaStreams.close();
            await viewerStreams.close();
        };

        return {
            mediaStreams,
            track1,
            track2,
            viewerStreams,
        } as ScenarioReturnType<T>;
    };

    // TODO add test for max time updates when you are not subsrcibing for live feed.
    // What is the expected option when the iterator runs out?

    describe("route correctness", () => {
        test("forces missing-response errors and bounds empty-page progress", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([1]),
                time: 0,
                type: "key",
            });
            const underlying = {
                next: sinon.stub().resolves([chunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
                first: sinon.stub(),
                all: sinon.stub(),
                [Symbol.asyncIterator]: sinon.stub(),
            } as any;
            let finalOptions: any;
            const probeClose = sinon.stub().resolves();
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (candidate === originHash) {
                                    return [chunk];
                                }
                                throw new MissingResponsesError("wrong route");
                            }),
                            close: probeClose,
                        } as any;
                    }
                    finalOptions = options;
                    options.signal?.addEventListener("abort", () => {
                        void underlying.close();
                    });
                    return underlying;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    remote: { timeout: 25, replicate: false },
                });
                expect(finalOptions.remote.throwOnMissing).to.be.true;
                expect(finalOptions.remote.retryMissingResponses).to.be.false;
                expect(finalOptions.remote.from).to.deep.eq([originHash]);
                expect(finalOptions.timeout).to.eq(25);
                expect(finalOptions.signal).to.be.undefined;

                expect(await result.next(0)).to.deep.eq([]);
                expect(underlying.next.called).to.be.false;
                await expect(result.next(-1)).rejects.toThrow(
                    "Expecting to fetch a positive amount of element"
                );
                expect(underlying.next.called).to.be.false;
                expect(await result.next(1)).to.deep.eq([chunk]);
                expect(underlying.next.calledOnce).to.be.true;

                underlying.next.resetBehavior();
                underlying.next.resolves([]);
                const callsBeforeNoProgress = underlying.next.callCount;
                await expect(result.next(1)).rejects.toThrow(TimeoutError);
                expect(
                    underlying.next.callCount - callsBeforeNoProgress
                ).to.be.lessThanOrEqual(4);
                expect(probeClose.calledOnce).to.be.true;
                await result.close();
                expect(underlying.close.calledOnce).to.be.true;
            } finally {
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("normalizes fractional and u32-exceeding seeks to bigint requests", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const chunk = new Chunk({
                chunk: new Uint8Array([16]),
                time: 0,
                type: "key",
            });
            const requests: any[] = [];
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any) => {
                    requests.push(request);
                    if (request.fetch === 1) {
                        return {
                            next: sinon.stub().resolves([chunk]),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    return {
                        next: sinon.stub().resolves([chunk]),
                        close: sinon.stub().resolves(),
                        done: sinon.stub().returns(false),
                        pending: sinon.stub().returns(0),
                    } as any;
                }) as any);

            try {
                for (const { seek, expected } of [
                    { seek: 0.5, expected: 1n },
                    {
                        seek: MAX_U32 + 123,
                        expected: BigInt(MAX_U32 + 123),
                    },
                ]) {
                    const firstCall = requests.length;
                    const result = await source.iterate(seek, {
                        local: false,
                        remote: { timeout: 25, replicate: false },
                    });
                    const [probeRequest, finalRequest] = requests.slice(
                        firstCall,
                        firstCall + 2
                    );
                    expect(probeRequest.fetch).to.eq(1);
                    expect(finalRequest.fetch).not.to.eq(1);
                    for (const request of [probeRequest, finalRequest]) {
                        expect(request.query[0].compare).to.eq(
                            Compare.GreaterOrEqual
                        );
                        expect(typeof request.query[0].value.value).to.eq(
                            "bigint"
                        );
                        expect(request.query[0].value.value).to.eq(expected);
                    }
                    await result.close();
                }
            } finally {
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("forwards a timeout above one second to the canonical-origin probe", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const chunk = new Chunk({
                chunk: new Uint8Array([17]),
                time: 0,
                type: "key",
            });
            const configuredTimeout = 2_000;
            const simulatedSlowOriginThreshold = 1_500;
            const probeTimeouts: number[] = [];
            let finalOptions: any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const probeTimeout = options.remote.timeout as number;
                        probeTimeouts.push(probeTimeout);
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (
                                    probeTimeout < simulatedSlowOriginThreshold
                                ) {
                                    throw new MissingResponsesError(
                                        "probe budget too short"
                                    );
                                }
                                return [chunk];
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalOptions = options;
                    return {
                        next: sinon.stub().resolves([chunk]),
                        close: sinon.stub().resolves(),
                        done: sinon.stub().returns(false),
                        pending: sinon.stub().returns(0),
                    } as any;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: {
                        timeout: configuredTimeout,
                        replicate: false,
                    },
                });
                expect(probeTimeouts).to.have.length(1);
                expect(probeTimeouts[0]).to.be.greaterThanOrEqual(
                    simulatedSlowOriginThreshold
                );
                expect(probeTimeouts[0]).to.be.lessThanOrEqual(
                    configuredTimeout
                );
                expect(finalOptions.remote.timeout).to.eq(configuredTimeout);
            } finally {
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("rejects a remote-only seek when no route responds", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const probeClose = sinon.stub().resolves();
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .returns({
                    next: sinon
                        .stub()
                        .rejects(new MissingResponsesError("offline sender")),
                    close: probeClose,
                } as any);

            try {
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 25, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(iterateStub.callCount).to.be.greaterThanOrEqual(1);
                expect(probeClose.callCount).to.eq(iterateStub.callCount);
            } finally {
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("rejects a local canonical seek when local reads are disabled", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const source = track1.source;
            const iterateStub = sinon.stub(source.chunks.index, "iterate");

            try {
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 25, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(iterateStub.called).to.be.false;
            } finally {
                iterateStub.restore();
            }
        });

        test("rejects a default seek when the remote origin is unavailable and the cache is empty", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const probeClose = sinon.stub().resolves();
            const localIndexIterateStub = sinon.stub(
                source.chunks.index.index,
                "iterate"
            );
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .returns({
                    next: sinon
                        .stub()
                        .rejects(new MissingResponsesError("offline sender")),
                    close: probeClose,
                } as any);

            try {
                await expect(
                    source.iterate(0, {
                        remote: { timeout: 25, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(localIndexIterateStub.called).to.be.false;
                expect(iterateStub.callCount).to.be.greaterThanOrEqual(1);
                expect(probeClose.callCount).to.eq(iterateStub.callCount);
            } finally {
                iterateStub.restore();
                localIndexIterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("aborts a stalled canonical-origin probe", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const probeClose = sinon.stub().resolves();
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((_request: any, options: any) => {
                    const signal = options.remote.signal as AbortSignal;
                    return {
                        next: sinon.stub().callsFake(
                            () =>
                                new Promise<Chunk[]>((_resolve, reject) => {
                                    if (signal.aborted) {
                                        reject(new AbortError());
                                        return;
                                    }
                                    signal.addEventListener(
                                        "abort",
                                        () => reject(new AbortError()),
                                        { once: true }
                                    );
                                })
                        ),
                        close: probeClose,
                    } as any;
                }) as any);
            const controller = new AbortController();

            try {
                const pending = source.iterate(0, {
                    local: false,
                    remote: { timeout: 5_000, replicate: false },
                    signal: controller.signal,
                });
                await waitForResolved(
                    () => expect(iterateStub.calledOnce).to.be.true
                );
                const abortedAt = Date.now();
                controller.abort();
                await expect(pending).rejects.toThrow(AbortError);
                expect(Date.now() - abortedAt).to.be.lessThan(1_000);
                expect(probeClose.calledOnce).to.be.true;
            } finally {
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("bounds a stalled canonical-origin probe by the route timeout", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const probeClose = sinon.stub().resolves();
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((_request: any, options: any) => ({
                    next: sinon.stub().callsFake(async () => {
                        await delay(options.remote.timeout);
                        throw new TimeoutError("origin probe timed out");
                    }),
                    close: probeClose,
                })) as any);

            try {
                const startedAt = Date.now();
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 25, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(Date.now() - startedAt).to.be.lessThan(1_000);
                expect(iterateStub.callCount).to.be.greaterThanOrEqual(1);
                expect(probeClose.callCount).to.eq(iterateStub.callCount);
            } finally {
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("does not accept an abort-resolved empty origin probe", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const probeClose = sinon.stub().resolves();
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((_request: any, options: any) => {
                    const signal = options.remote.signal as AbortSignal;
                    return {
                        next: sinon.stub().callsFake(
                            () =>
                                new Promise<Chunk[]>((resolve) => {
                                    if (signal.aborted) {
                                        resolve([]);
                                        return;
                                    }
                                    signal.addEventListener(
                                        "abort",
                                        () => resolve([]),
                                        { once: true }
                                    );
                                })
                        ),
                        close: probeClose,
                    } as any;
                }) as any);

            try {
                const startedAt = Date.now();
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 25, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(Date.now() - startedAt).to.be.lessThan(1_000);
                expect(iterateStub.callCount).to.be.greaterThanOrEqual(1);
                expect(probeClose.callCount).to.eq(iterateStub.callCount);
            } finally {
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("fails closed after the canonical origin disappears between pages", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const relayHash = "unverified-relay";
            const firstChunk = new Chunk({
                chunk: new Uint8Array([3]),
                time: 0,
                type: "key",
            });
            const relayChunk = new Chunk({
                chunk: new Uint8Array([4]),
                time: 1,
                type: "key",
            });
            let originOffline = false;
            let firstPageRead = false;
            const segmentsStub = sinon
                .stub(source.chunks.log, "getAllReplicationSegments")
                .resolves([{ hash: relayHash }] as any);
            const firstIterator = {
                next: sinon.stub().callsFake(async () => {
                    if (!firstPageRead) {
                        firstPageRead = true;
                        return [firstChunk];
                    }
                    originOffline = true;
                    throw new MissingResponsesError("origin disappeared");
                }),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const forbiddenRelayIterator = {
                next: sinon.stub().resolves([relayChunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const finalOptions: any[] = [];
            const probeQueries: any[] = [];
            const probedHashes: string[] = [];
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        probeQueries.push(request.query[0]);
                        const candidate = options.remote.from[0] as string;
                        probedHashes.push(candidate);
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (
                                    !originOffline &&
                                    candidate === originHash
                                ) {
                                    return [firstChunk];
                                }
                                if (candidate === relayHash) {
                                    return [relayChunk];
                                }
                                throw new MissingResponsesError(
                                    "origin unavailable"
                                );
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalOptions.push(options);
                    return finalOptions.length === 1
                        ? firstIterator
                        : forbiddenRelayIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                });
                const firstPage = await result.next(1);
                expect(firstPage).to.have.length(1);
                expect(firstPage[0].timeBN).to.eq(0n);
                await expect(result.next(1)).rejects.toThrow(
                    MissingResponsesError
                );
                expect(finalOptions).to.have.length(1);
                expect(finalOptions[0].remote.from).to.deep.eq([originHash]);
                expect(finalOptions[0].remote.throwOnMissing).to.be.true;
                expect(probedHashes).not.to.be.empty;
                expect(probedHashes.every((hash) => hash === originHash)).to.be
                    .true;
                expect(segmentsStub.called).to.be.false;
                expect(forbiddenRelayIterator.next.called).to.be.false;
                expect(probeQueries.at(-1).compare).to.eq(Compare.Greater);
                expect(probeQueries.at(-1).value.value).to.eq(0n);
                await result.close();
                expect(firstIterator.close.calledOnce).to.be.true;
            } finally {
                await result?.close();
                iterateStub.restore();
                segmentsStub.restore();
                await viewerTrack.close();
            }
        });

        test("accepts clean exhaustion after the canonical origin recovers empty", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([5]),
                time: 0,
                type: "key",
            });
            let routeFailed = false;
            let firstPageRead = false;
            const firstIterator = {
                next: sinon.stub().callsFake(async () => {
                    if (!firstPageRead) {
                        firstPageRead = true;
                        return [chunk];
                    }
                    routeFailed = true;
                    throw new MissingResponsesError("route moved");
                }),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const exhaustedIterator = {
                next: sinon.stub().resolves([]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(true),
                pending: sinon.stub().returns(0),
            } as any;
            const finalOptions: any[] = [];
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (candidate !== originHash) {
                                    throw new MissingResponsesError(
                                        "unexpected route"
                                    );
                                }
                                if (!routeFailed) {
                                    return [chunk];
                                }
                                return [];
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalOptions.push(options);
                    return finalOptions.length === 1
                        ? firstIterator
                        : exhaustedIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 100, replicate: false },
                });
                expect(await result.next(1)).to.deep.eq([chunk]);
                expect(await result.next(1)).to.deep.eq([]);
                expect(result.done()).to.be.true;
                expect(finalOptions).to.have.length(2);
                expect(
                    finalOptions.every((options) =>
                        options.remote.from.every(
                            (hash: string) => hash === originHash
                        )
                    )
                ).to.be.true;
                expect(firstIterator.close.calledOnce).to.be.true;
            } finally {
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("finishes after the inclusive endpoint without re-probing a lost origin", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, end: 10, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const endpointChunk = new Chunk({
                chunk: new Uint8Array([15]),
                time: 10_000,
                type: "key",
            });
            let originOffline = false;
            let probeCalls = 0;
            let delivered = false;
            let finalRequest: any;
            const finalIterator = {
                next: sinon.stub().callsFake(async () => {
                    delivered = true;
                    return [endpointChunk];
                }),
                close: sinon.stub().resolves(),
                done: sinon.stub().callsFake(() => delivered),
                pending: sinon.stub().returns(0),
            } as any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any) => {
                    if (request.fetch === 1) {
                        probeCalls++;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (originOffline) {
                                    throw new MissingResponsesError(
                                        "origin offline"
                                    );
                                }
                                return [endpointChunk];
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalRequest = request;
                    return finalIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 50, replicate: false },
                });
                expect(await result.next(1)).to.deep.eq([endpointChunk]);
                finalIterator.pending.resetHistory();
                expect(result.pending()).to.eq(0);
                expect(finalIterator.pending.called).to.be.false;
                originOffline = true;
                const probesBeforeTerminalPull = probeCalls;
                expect(await result.next(1)).to.deep.eq([]);
                expect(result.done()).to.be.true;
                expect(probeCalls).to.eq(probesBeforeTerminalPull);
                expect(finalRequest.query[1].compare).to.eq(
                    Compare.LessOrEqual
                );
                expect(finalRequest.query[1].value.value).to.eq(10_000n);
            } finally {
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("returns an exhausted iterator for an offline seek past track end", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, end: 10, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const segmentsStub = sinon.stub(
                source.chunks.log,
                "getAllReplicationSegments"
            );
            const iterateStub = sinon.stub(source.chunks.index, "iterate");
            let result: any;

            try {
                result = await source.iterate(10_001, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                });
                expect(result.done()).to.be.true;
                expect(await result.next(1)).to.deep.eq([]);
                expect(segmentsStub.called).to.be.false;
                expect(iterateStub.called).to.be.false;
            } finally {
                await result?.close();
                iterateStub.restore();
                segmentsStub.restore();
                await viewerTrack.close();
            }
        });

        test("rejects a productive suffix relay before it can mask a missing prefix", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, end: 10, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const relayHash = "partial-relay";
            const endpointChunk = new Chunk({
                chunk: new Uint8Array([8]),
                time: 10_000,
                type: "key",
            });
            const segmentsStub = sinon
                .stub(source.chunks.log, "getAllReplicationSegments")
                .resolves([
                    {
                        hash: relayHash,
                        start1: 5_000_000n,
                        end1: 10_000_001n,
                        start2: 0n,
                        end2: 0n,
                        width: 5_000_001n,
                        wrapped: false,
                    },
                ] as any);
            const probedHashes: string[] = [];
            const forbiddenFinalIterator = {
                next: sinon.stub().resolves([endpointChunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            let finalIteratorCreations = 0;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        probedHashes.push(candidate);
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (candidate === relayHash) {
                                    return [endpointChunk];
                                }
                                throw new MissingResponsesError(
                                    "origin offline"
                                );
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalIteratorCreations++;
                    return forbiddenFinalIterator;
                }) as any);

            try {
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 50, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(segmentsStub.called).to.be.false;
                expect(probedHashes).not.to.be.empty;
                expect(probedHashes.every((hash) => hash === originHash)).to.be
                    .true;
                expect(probedHashes).not.to.include(relayHash);
                expect(finalIteratorCreations).to.eq(0);
                expect(forbiddenFinalIterator.next.called).to.be.false;
            } finally {
                iterateStub.restore();
                segmentsStub.restore();
                await viewerTrack.close();
            }
        });

        test("rejects gap-free relay advertisements without sync-complete proof", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, end: 10, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const relayHashes = ["first-cover", "second-cover"];
            const probedHashes: string[] = [];
            const segmentsStub = sinon
                .stub(source.chunks.log, "getAllReplicationSegments")
                .resolves([
                    {
                        hash: relayHashes[0],
                        start1: 0n,
                        end1: 5_000_000n,
                        start2: 0n,
                        end2: 0n,
                        width: 5_000_000n,
                        wrapped: false,
                    },
                    {
                        hash: relayHashes[1],
                        start1: 5_000_000n,
                        end1: 10_000_001n,
                        start2: 0n,
                        end2: 0n,
                        width: 5_000_001n,
                        wrapped: false,
                    },
                ] as any);
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        probedHashes.push(candidate);
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (relayHashes.includes(candidate)) {
                                    return [];
                                }
                                throw new MissingResponsesError(
                                    "origin offline"
                                );
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    throw new Error("unexpected final iterator");
                }) as any);

            try {
                await expect(
                    source.iterate(0, {
                        local: false,
                        remote: { timeout: 50, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(segmentsStub.called).to.be.false;
                expect(probedHashes).not.to.be.empty;
                expect(probedHashes.every((hash) => hash === originHash)).to.be
                    .true;
                expect(probedHashes.some((hash) => relayHashes.includes(hash)))
                    .to.be.false;
            } finally {
                iterateStub.restore();
                segmentsStub.restore();
                await viewerTrack.close();
            }
        });

        test("does not use a partial local cache when the remote origin is offline", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, end: 10, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const selfHash = viewer.identity.publicKey.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([9]),
                time: 0,
                type: "key",
            });
            const segmentsStub = sinon
                .stub(source.chunks.log, "getAllReplicationSegments")
                .resolves([
                    {
                        hash: selfHash,
                        start1: 0n,
                        end1: 5_000_000n,
                        start2: 0n,
                        end2: 0n,
                        width: 5_000_000n,
                        wrapped: false,
                    },
                ] as any);
            const localIndexIterateStub = sinon.stub(
                source.chunks.index.index,
                "iterate"
            );
            const forbiddenLocalIterator = {
                next: sinon.stub().resolves([chunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            let finalIteratorCreations = 0;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any) => {
                    if (request.fetch === 1) {
                        return {
                            next: sinon
                                .stub()
                                .rejects(
                                    new MissingResponsesError("origin offline")
                                ),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalIteratorCreations++;
                    return forbiddenLocalIterator;
                }) as any);

            try {
                await expect(
                    source.iterate(0, {
                        remote: { timeout: 50, replicate: false },
                    })
                ).rejects.toThrow(MissingResponsesError);
                expect(segmentsStub.called).to.be.false;
                expect(localIndexIterateStub.called).to.be.false;
                expect(finalIteratorCreations).to.eq(0);
                expect(forbiddenLocalIterator.next.called).to.be.false;
            } finally {
                iterateStub.restore();
                localIndexIterateStub.restore();
                segmentsStub.restore();
                await viewerTrack.close();
            }
        });

        test("does not create a replacement iterator after concurrent close", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([5]),
                time: 0,
                type: "key",
            });
            const closeGate = pDefer<void>();
            const firstIterator = {
                next: sinon
                    .stub()
                    .rejects(new MissingResponsesError("route moved")),
                close: sinon.stub().callsFake(() => closeGate.promise),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const replacementIterator = {
                next: sinon.stub().resolves([chunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            let finalIteratorCreations = 0;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (candidate === originHash) {
                                    return [chunk];
                                }
                                throw new MissingResponsesError("stale sender");
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    finalIteratorCreations++;
                    return finalIteratorCreations === 1
                        ? firstIterator
                        : replacementIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 600, replicate: false },
                });
                const pendingNext = result.next(1);
                void pendingNext.catch(() => {});
                await waitForResolved(
                    () => expect(firstIterator.close.called).to.be.true
                );
                const pendingClose = result.close();
                closeGate.resolve();

                expect(await pendingNext).to.deep.eq([]);
                await pendingClose;
                expect(finalIteratorCreations).to.eq(1);
                expect(replacementIterator.close.called).to.be.false;
            } finally {
                closeGate.resolve();
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("drops a page that resolves after concurrent close", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([10]),
                time: 0,
                type: "key",
            });
            const page = pDefer<Chunk[]>();
            const finalIterator = {
                next: sinon.stub().returns(page.promise),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (options.remote.from[0] === originHash) {
                                    return [chunk];
                                }
                                throw new MissingResponsesError("offline");
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    return finalIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                });
                const pendingNext = result.next(1);
                await waitForResolved(
                    () => expect(finalIterator.next.calledOnce).to.be.true
                );
                await result.close();
                page.resolve([chunk]);
                expect(await pendingNext).to.deep.eq([]);
                expect(result.done()).to.be.true;
                expect(finalIterator.close.calledOnce).to.be.true;
            } finally {
                page.resolve([]);
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("waits for in-flight route probe cleanup before close resolves", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunk = new Chunk({
                chunk: new Uint8Array([11]),
                time: 0,
                type: "key",
            });
            const probeCloseGate = pDefer<void>();
            const recoveryProbeClose = sinon
                .stub()
                .returns(probeCloseGate.promise);
            let probeCreations = 0;
            const finalIterator = {
                next: sinon
                    .stub()
                    .rejects(new MissingResponsesError("route moved")),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const creation = probeCreations++;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (options.remote.from[0] === originHash) {
                                    return [chunk];
                                }
                                throw new MissingResponsesError("offline");
                            }),
                            close:
                                creation === 0
                                    ? sinon.stub().resolves()
                                    : recoveryProbeClose,
                        } as any;
                    }
                    return finalIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 600, replicate: false },
                });
                const pendingNext = result.next(1);
                await waitForResolved(
                    () => expect(recoveryProbeClose.calledOnce).to.be.true
                );
                let closeResolved = false;
                const pendingClose = result.close().then(() => {
                    closeResolved = true;
                });
                await delay(25);
                expect(closeResolved).to.be.false;
                probeCloseGate.resolve();
                await pendingClose;
                expect(await pendingNext).to.deep.eq([]);
                expect(recoveryProbeClose.calledOnce).to.be.true;
            } finally {
                probeCloseGate.resolve();
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("retries a failed route probe cleanup during wrapper close", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const chunk = new Chunk({
                chunk: new Uint8Array([12]),
                time: 0,
                type: "key",
            });
            const recoveryProbeClose = sinon
                .stub()
                .onFirstCall()
                .rejects(new Error("transient probe close failure"));
            recoveryProbeClose.onSecondCall().resolves();
            let probeCreations = 0;
            const finalIterator = {
                next: sinon
                    .stub()
                    .rejects(new MissingResponsesError("route moved")),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any) => {
                    if (request.fetch === 1) {
                        const creation = probeCreations++;
                        return {
                            next: sinon.stub().resolves([chunk]),
                            close:
                                creation === 0
                                    ? sinon.stub().resolves()
                                    : recoveryProbeClose,
                        } as any;
                    }
                    return finalIterator;
                }) as any);
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 600, replicate: false },
                });
                const pendingNext = result.next(1);
                void pendingNext.catch(() => {});
                await waitForResolved(
                    () => expect(recoveryProbeClose.calledOnce).to.be.true
                );
                await result.close();
                expect(recoveryProbeClose.calledTwice).to.be.true;
                await expect(pendingNext).rejects.toThrow(
                    "transient probe close failure"
                );
            } finally {
                await result?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("caller abort closes and detaches the active iterator", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const chunk = new Chunk({
                chunk: new Uint8Array([13]),
                time: 0,
                type: "key",
            });
            const finalIterator = {
                next: sinon.stub().resolves([chunk]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any) => {
                    if (request.fetch === 1) {
                        return {
                            next: sinon.stub().resolves([chunk]),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    return finalIterator;
                }) as any);
            const controller = new AbortController();
            const removeListener = sinon.spy(
                controller.signal,
                "removeEventListener"
            );
            let result: any;

            try {
                result = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                    signal: controller.signal,
                });
                controller.abort();
                await waitForResolved(
                    () => expect(finalIterator.close.calledOnce).to.be.true
                );
                await result.close();
                expect(finalIterator.close.calledOnce).to.be.true;
                expect(removeListener.calledOnce).to.be.true;
                expect(result.done()).to.be.true;
            } finally {
                await result?.close();
                removeListener.restore();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("bounds all() batches and closes terminal helper iterators", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const viewerTrack = await viewer.open(track1.clone());
            const source = viewerTrack.source;
            const originHash = source.sender.hashcode();
            const chunks = Array.from(
                { length: 101 },
                (_, time) =>
                    new Chunk({
                        chunk: new Uint8Array([time]),
                        time,
                        type: "key",
                    })
            );
            let drainOffset = 0;
            const drainAmounts: number[] = [];
            const drainIterator = {
                next: sinon.stub().callsFake(async (amount: number) => {
                    if (drainOffset >= chunks.length) {
                        throw new Error(
                            "next called after iterator exhaustion"
                        );
                    }
                    drainAmounts.push(amount);
                    const batch = chunks.slice(
                        drainOffset,
                        drainOffset + amount
                    );
                    drainOffset += batch.length;
                    return batch;
                }),
                close: sinon.stub().resolves(),
                done: sinon.stub().callsFake(() => {
                    return drainOffset >= chunks.length;
                }),
                pending: sinon.stub().returns(0),
            } as any;
            const firstIterator = {
                next: sinon.stub().resolves([chunks[0]]),
                close: sinon.stub().resolves(),
                done: sinon.stub().returns(false),
                pending: sinon.stub().returns(0),
            } as any;
            const finalIterators = [drainIterator, firstIterator];
            let finalIteratorIndex = 0;
            const iterateStub = sinon
                .stub(source.chunks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (request.fetch === 1) {
                        const candidate = options.remote.from[0] as string;
                        return {
                            next: sinon.stub().callsFake(async () => {
                                if (candidate === originHash) {
                                    return drainOffset >= chunks.length
                                        ? []
                                        : [chunks[0]];
                                }
                                throw new MissingResponsesError("stale sender");
                            }),
                            close: sinon.stub().resolves(),
                        } as any;
                    }
                    return finalIterators[finalIteratorIndex++];
                }) as any);
            let drainResult: any;
            let firstResult: any;

            try {
                drainResult = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                });
                expect(await drainResult.all()).to.deep.eq(chunks);
                expect(drainAmounts).to.deep.eq([100, 100]);
                expect(drainIterator.close.calledOnce).to.be.true;
                expect(drainResult.done()).to.be.true;
                expect(await drainResult.pending()).to.eq(0);

                firstResult = await source.iterate(0, {
                    local: false,
                    remote: { timeout: 25, replicate: false },
                });
                expect(await firstResult.first()).to.eq(chunks[0]);
                expect(firstIterator.close.calledOnce).to.be.true;
                expect(firstResult.done()).to.be.true;
                expect(await firstResult.pending()).to.eq(0);
            } finally {
                await firstResult?.close();
                await drainResult?.close();
                iterateStub.restore();
                await viewerTrack.close();
            }
        });

        test("surfaces a missing responder from a real later page", async () => {
            const { track1 } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const firstChunk = new Chunk({
                chunk: new Uint8Array([6]),
                time: 0,
                type: "key",
            });
            const secondChunk = new Chunk({
                chunk: new Uint8Array([7]),
                time: 1,
                type: "key",
            });
            await track1.put(firstChunk, { target: "none" });
            await track1.put(secondChunk, { target: "none" });
            const viewerTrack = await viewer.open(track1.clone());
            let result: any;

            try {
                result = await viewerTrack.source.iterate(0, {
                    local: false,
                    remote: { timeout: 500, replicate: false },
                });
                const firstPage = await result.next(1);
                expect(firstPage).to.have.length(1);
                expect(firstPage[0].timeBN).to.eq(0n);

                await track1.close();
                await expect(result.next(1)).rejects.toThrow(
                    MissingResponsesError
                );
            } finally {
                await result?.close();
                await viewerTrack.close();
            }
        });
    });

    describe("waitFor", () => {
        test("wait for self", async () => {
            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );
            await mediaStreams.waitFor(mediaStreams.node.identity.publicKey);
        });
    });
    describe("live", () => {
        test("pauses after a live progress callback fails without hot retrying", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const attempts: number[] = [];
            const delivered: number[] = [];
            let rejectFrame = true;
            const errorLog = sinon.stub(console, "error");

            try {
                iterator = await viewerStreams.iterate("live", {
                    onProgress: async ({ chunk }) => {
                        attempts.push(chunk.time);
                        if (rejectFrame) {
                            rejectFrame = false;
                            throw new Error(
                                "synthetic live frame delivery failure"
                            );
                        }
                        delivered.push(chunk.time);
                    },
                });
                await track1.put(
                    new Chunk({
                        time: 0,
                        chunk: new Uint8Array([0]),
                    })
                );

                await waitForResolved(() => expect(iterator.paused).to.be.true);
                expect(attempts).to.deep.eq([0]);
                await track1.put(
                    new Chunk({
                        time: MILLISECONDS_TO_MICROSECONDS,
                        chunk: new Uint8Array([1]),
                    })
                );
                await delay(100);
                expect(attempts).to.deep.eq([0]);

                await iterator.play();
                await track1.put(
                    new Chunk({
                        time: 2 * MILLISECONDS_TO_MICROSECONDS,
                        chunk: new Uint8Array([2]),
                    })
                );
                await waitForResolved(() =>
                    expect(delivered).to.deep.eq([
                        MILLISECONDS_TO_MICROSECONDS,
                        2 * MILLISECONDS_TO_MICROSECONDS,
                    ])
                );
                expect(
                    errorLog.calledWithMatch(
                        "Media progress callback failed; playback paused"
                    )
                ).to.be.true;
            } finally {
                errorLog.restore();
            }
        });

        test("delivers one chunk with the default target", async () => {
            const track1 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 44100 }),
                    start: 0,
                    end: 100,
                })
            );

            const listenTrack = await viewer.open(track1.clone());
            await listenTrack.source.replicate("live");

            const receivedChunks: Chunk[] = [];

            listenTrack.source.chunks.events.addEventListener(
                "change",
                (change) => {
                    for (const chunk of change.detail.added) {
                        receivedChunks.push(chunk);
                    }
                    expect(change.detail.removed).to.have.length(0);
                }
            );

            await listenTrack.waitFor(streamer.identity.publicKey);
            await track1.put(
                new Chunk({ time: 0, chunk: new Uint8Array([1, 2, 3]) })
            );
            await waitForResolved(() =>
                expect(receivedChunks.map((chunk) => chunk.timeBN)).to.deep.eq([
                    0n,
                ])
            );
        });

        test("second chunk", async () => {
            const track1 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 44100 }),
                    start: 0,
                    end: 100,
                })
            );

            await track1.put(
                new Chunk({ time: 0n, chunk: new Uint8Array([1, 2, 3]) })
            );

            const listenTrack = await viewer.open(track1.clone());
            await listenTrack.source.replicate("live");

            const receivedChunks: Chunk[] = [];

            listenTrack.source.chunks.events.addEventListener(
                "change",
                (change) => {
                    for (const chunk of change.detail.added) {
                        receivedChunks.push(chunk);
                    }
                    expect(change.detail.removed).to.have.length(0);
                }
            );

            await listenTrack.waitFor(streamer.identity.publicKey);
            await track1.put(
                new Chunk({ time: 1n, chunk: new Uint8Array([1, 2, 3]) })
            );
            await waitForResolved(() =>
                expect(receivedChunks.map((x) => x.timeBN)).to.deep.eq([1n])
            );
        });

        test("multiple options", async () => {
            const { mediaStreams, track1, track2, viewerStreams } =
                await createScenario({
                    first: { start: 10 },
                    second: { start: 100 },
                });
            iterator = await viewerStreams.iterate("live");

            await waitForResolved(() =>
                expect(iterator.current).to.have.length(1)
            );
            await waitForResolved(() =>
                expect(iterator.options()).to.have.length(2)
            );
        });

        test("new", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 10 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];

            let listenTrack: DeferredPromise<Track> = pDefer();
            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    console.log("GOT CHUNK", ev.chunk.timeBN);
                    chunks.push(ev);
                },

                onTracksChange(tracks) {
                    if (tracks.length > 0) {
                        listenTrack.resolve(tracks[0]);
                    }
                },
            });
            await (
                await listenTrack.promise
            ).waitFor(streamer.identity.publicKey);
            const c1 = new Chunk({
                chunk: new Uint8Array([101]),
                time: 8888888 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([102]),
                time: 8888889 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            await track1.put(c1, { target: "replicators" });
            await waitForResolved(() => expect(chunks).to.have.length(1));
            await track1.put(c2, { target: "replicators" });
            await waitForResolved(() => expect(chunks).to.have.length(2));

            expect(chunks[0].chunk.id).to.eq(c1.id);
            expect(chunks[1].chunk.id).to.eq(c2.id);
        });

        test("live after progress", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 0, size: 0 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];

            const c1 = new Chunk({
                chunk: new Uint8Array([101]),
                time: 0 * MILLISECONDS_TO_MICROSECONDS, // this one seems to render at wrong time
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([102]),
                time: (0 + 1) * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            await track1.put(c1, { target: "replicators" });
            await track1.put(c2, { target: "replicators" });

            let listenTrackDeferred: DeferredPromise<Track> = pDefer();
            let maxTimeFromCallback = -1;
            iterator = await viewerStreams.iterate(0, {
                onProgress: (ev) => {
                    console.log("GOT CHUNK", ev.chunk.timeBN);
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    if (tracks.length > 0) {
                        listenTrackDeferred.resolve(tracks[0]);
                    }
                },
                onMaxTimeChange: (ev) => {
                    maxTimeFromCallback = ev.maxTime;
                },
            });
            await listenTrackDeferred.promise;

            await waitForResolved(() => expect(chunks).to.have.length(2));
            expect(maxTimeFromCallback).to.eq(1 * MILLISECONDS_TO_MICROSECONDS);

            expect(chunks[0].chunk.id).to.eq(c1.id);
            expect(chunks[1].chunk.id).to.eq(c2.id);

            await iterator.close();
            listenTrackDeferred = pDefer();

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    console.log("GOT CHUNK", ev.chunk.timeBN);
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    if (tracks.length > 0) {
                        listenTrackDeferred.resolve(tracks[0]);
                    }
                },
                onMaxTimeChange: (ev) => {
                    maxTimeFromCallback = ev.maxTime;
                },
            });
            await listenTrackDeferred.promise;

            const c3 = new Chunk({
                chunk: new Uint8Array([101]),
                time: (8888888 + 2) * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            let last = (8888888 + 3) * MILLISECONDS_TO_MICROSECONDS;
            const c4 = new Chunk({
                chunk: new Uint8Array([102]),
                time: last,
                type: "key",
            });

            let maxTime = -1;

            viewerStreams.events.addEventListener("maxTime", (ev) => {
                maxTime = ev.detail.maxTime;
            });

            await track1.put(c3, { target: "replicators" });
            await waitForResolved(() => expect(chunks).to.have.length(3));
            await track1.put(c4, { target: "replicators" });
            await waitForResolved(() => expect(chunks).to.have.length(4));

            expect(chunks[2].chunk.id).to.eq(c3.id);
            expect(chunks[3].chunk.id).to.eq(c4.id);

            const allSegmentsFromStreamer =
                await track1.source.chunks.log.replicationIndex.iterate().all();
            let listenTrack = await listenTrackDeferred.promise;
            const allSegmentsFromViewer =
                await listenTrack.source.chunks.log.replicationIndex
                    .iterate()
                    .all();

            expect(allSegmentsFromStreamer).to.have.length(3);
            expect(allSegmentsFromViewer).to.have.length(3);
            expect(maxTime).to.eq(last);
            expect(maxTimeFromCallback).to.eq(last);
        });

        test("subscribeForMaxTime for streamer", async () => {
            let start = 100;
            const { mediaStreams, track1 } = await createScenario({
                first: { start, size: 0 },
            });

            let maxTime: number | undefined = undefined;
            mediaStreams.events.addEventListener(
                "maxTime",
                (ev) => (maxTime = ev.detail.maxTime)
            );
            mediaStreams.listenForMaxTimeChanges(true);

            let time = 123;
            await delay(3e3); // wait some time beofre putting the first chunk
            await track1.put(
                new Chunk({ chunk: new Uint8Array([1, 2, 3]), time })
            );
            await waitForResolved(() =>
                expect(maxTime).to.eq(start * 1e3 + time)
            );
        });

        test("keeps max-time scan ownership until the final subscriber stops", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const first = viewerStreams.listenForMaxTimeChanges(false);
            const second = viewerStreams.listenForMaxTimeChanges(false);

            try {
                await Promise.all([first.ready, second.ready]);
                const lease = (viewerStreams as any).trackLeases.get(
                    track1.idString
                );
                expect(lease.references).to.eq(2);
                const closeTrack = sinon.spy(lease.track, "close");

                await first.stop();
                expect(lease.track.closed).to.be.false;
                expect(closeTrack.called).to.be.false;

                await second.stop();
                expect(lease.track.closed).to.be.true;
                expect(closeTrack.calledOnce).to.be.true;
            } finally {
                await Promise.allSettled([first.stop(), second.stop()]);
            }
        });

        test("coalesces a burst of max-time refreshes to one pending scan", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const scanStarted = pDefer<void>();
            const releaseScan = pDefer<void>();
            const index = viewerStreams.tracks.index as any;
            const search = index.search.bind(index);
            let scanCount = 0;
            const searchStub = sinon
                .stub(index, "search")
                .callsFake(async (...args: any[]) => {
                    scanCount++;
                    if (scanCount === 1) {
                        scanStarted.resolve();
                        await releaseScan.promise;
                    }
                    return search(...args);
                });
            const subscription = viewerStreams.listenForMaxTimeChanges(false);

            try {
                await scanStarted.promise;
                for (let i = 0; i < 10; i++) {
                    viewerStreams.tracks.events.dispatchEvent(
                        new CustomEvent("change", {
                            detail: { added: [], removed: [] },
                        })
                    );
                }
                releaseScan.resolve();
                await subscription.ready;
                expect(scanCount).to.eq(2);
            } finally {
                releaseScan.resolve();
                searchStub.restore();
                await subscription.stop();
            }
        });

        test("re-arms a max-time refresh that arrives during scan handoff", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const tracksAddListener = sinon.spy(
                viewerStreams.tracks.events,
                "addEventListener"
            );
            const logAddListener = sinon.spy(
                viewerStreams.tracks.log.events,
                "addEventListener"
            );
            const subscription = viewerStreams.listenForMaxTimeChanges(false);
            const changeListener = tracksAddListener.args.find(
                ([type]) => type === "change"
            )?.[1] as ((event: CustomEvent) => void) | undefined;
            const joinListener = logAddListener.args.find(
                ([type]) => type === "replicator:join"
            )?.[1] as (() => void) | undefined;
            expect(changeListener).to.be.a("function");
            expect(joinListener).to.be.a("function");
            // Exercise the captured requestScan closure directly so unrelated
            // document/replicator traffic cannot inflate this handoff count.
            viewerStreams.tracks.events.removeEventListener(
                "change",
                changeListener as any
            );
            viewerStreams.tracks.log.events.removeEventListener(
                "replicator:join",
                joinListener as any
            );
            await subscription.ready;

            const lease = (viewerStreams as any).trackLeases.get(
                track1.idString
            );
            let queueHandoffRefresh = true;
            const dispatchRefresh = () =>
                changeListener?.(
                    new CustomEvent("change", {
                        detail: { added: [], removed: [] },
                    })
                );
            const lastStub = sinon.stub(lease.track.source, "last").callsFake(
                () =>
                    ({
                        then: (resolve: (value: undefined) => void) => {
                            resolve(undefined);
                            if (queueHandoffRefresh) {
                                queueHandoffRefresh = false;
                                // Cross last() -> refresh() -> scan() before
                                // firing in the running-loop/finally handoff.
                                queueMicrotask(() =>
                                    queueMicrotask(() =>
                                        queueMicrotask(dispatchRefresh)
                                    )
                                );
                            }
                        },
                    }) as any
            );

            try {
                dispatchRefresh();
                // Other consumers can legitimately refresh the same shared
                // track. The burst test above owns the exact upper-bound
                // assertion; this handoff test only needs to prove that the
                // queued edge produces a follow-up refresh instead of being
                // lost while the running scan settles.
                await waitForResolved(() =>
                    expect(lastStub.callCount).to.be.greaterThanOrEqual(2)
                );
            } finally {
                lastStub.restore();
                tracksAddListener.restore();
                logAddListener.restore();
                await subscription.stop();
            }
        });

        test("cleans up a max-time monitor after its initial scan fails", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const scanError = new Error("synthetic max-time scan failure");
            const searchStub = sinon
                .stub(viewerStreams.tracks.index, "search")
                .rejects(scanError);
            const subscription = viewerStreams.listenForMaxTimeChanges(false);

            try {
                await expect(subscription.ready).rejects.toBe(scanError);
                await subscription.stop();
                expect((viewerStreams as any).maxTimeSubscriptionCount).to.eq(
                    0
                );
                expect((viewerStreams as any).activeMediaConsumers.size).to.eq(
                    0
                );
            } finally {
                searchStub.restore();
                await subscription.stop().catch(() => {});
            }
        });

        test("shares replication monitoring and skips it without a callback", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const startSubscription = sinon.spy(
                viewerStreams as any,
                "startReplicationInfoSubscription"
            );
            const withoutCallback = await viewerStreams.iterate("live");
            const openTrack = [...withoutCallback.current.values()][0].track;
            const listenerCountBeforeMonitoring =
                openTrack.source.chunks.log.events.listenerCount(
                    "replication:change"
                );
            let first: TracksIterator | undefined;
            let second: TracksIterator | undefined;

            try {
                expect(startSubscription.called).to.be.false;

                const firstChanges: { hash: string; track: Track }[] = [];
                const secondChanges: { hash: string; track: Track }[] = [];
                first = await viewerStreams.iterate("live", {
                    onReplicationChange: (change) => firstChanges.push(change),
                });
                second = await viewerStreams.iterate("live", {
                    onReplicationChange: (change) => secondChanges.push(change),
                });
                expect(startSubscription.calledOnce).to.be.true;
                await waitForResolved(() =>
                    expect(
                        openTrack.source.chunks.log.events.listenerCount(
                            "replication:change"
                        )
                    ).to.be.greaterThan(listenerCountBeforeMonitoring)
                );

                firstChanges.length = 0;
                secondChanges.length = 0;
                openTrack.source.chunks.log.events.dispatchEvent(
                    new CustomEvent("replication:change", {
                        detail: { publicKey: "synthetic-replicator" },
                    })
                );
                expect(firstChanges).to.have.length(1);
                expect(secondChanges).to.have.length(1);
                expect(firstChanges[0].hash).to.eq("synthetic-replicator");
                expect(secondChanges[0].hash).to.eq("synthetic-replicator");
            } finally {
                startSubscription.restore();
                await Promise.allSettled([
                    withoutCallback.close(),
                    first?.close(),
                    second?.close(),
                ]);
            }
        });

        test("coalesces a burst of replication refreshes to one pending scan", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const scanStarted = pDefer<void>();
            const releaseScan = pDefer<void>();
            const index = viewerStreams.tracks.index as any;
            const iterateTracks = index.iterate.bind(index);
            let scanCount = 0;
            const iterateStub = sinon
                .stub(index, "iterate")
                .callsFake((...args: any[]) => {
                    scanCount++;
                    const result = iterateTracks(...args);
                    if (scanCount === 1) {
                        const all = result.all.bind(result);
                        result.all = async () => {
                            scanStarted.resolve();
                            await releaseScan.promise;
                            return all();
                        };
                    }
                    return result;
                });
            const subscription = viewerStreams.listenForReplicationInfo();

            try {
                await scanStarted.promise;
                for (let i = 0; i < 10; i++) {
                    viewerStreams.tracks.events.dispatchEvent(
                        new CustomEvent("change", {
                            detail: { added: [], removed: [] },
                        })
                    );
                }
                releaseScan.resolve();
                await subscription.ready;
                expect(scanCount).to.eq(2);
            } finally {
                releaseScan.resolve();
                iterateStub.restore();
                await subscription.stop();
            }
        });

        test("re-arms a replication refresh that arrives during scan handoff", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const subscription = viewerStreams.listenForReplicationInfo();
            await subscription.ready;

            const index = viewerStreams.tracks.index as any;
            const iterateTracks = index.iterate.bind(index);
            let scanCount = 0;
            let queueHandoffRefresh = false;
            let callsPerRefresh = Number.POSITIVE_INFINITY;
            const dispatchRefresh = () =>
                viewerStreams.tracks.events.dispatchEvent(
                    new CustomEvent("change", {
                        detail: { added: [], removed: [] },
                    })
                );
            const iterateStub = sinon
                .stub(index, "iterate")
                .callsFake((...args: any[]) => {
                    const result = iterateTracks(...args);
                    if (args[1]?.local && args[1]?.remote === false) {
                        scanCount++;
                        const all = result.all.bind(result);
                        result.all = () =>
                            ({
                                then: (
                                    resolve: (value: Track[]) => void,
                                    reject: (error: unknown) => void
                                ) => {
                                    void all().then((tracks: Track[]) => {
                                        resolve(tracks);
                                        if (
                                            queueHandoffRefresh &&
                                            scanCount === callsPerRefresh
                                        ) {
                                            queueHandoffRefresh = false;
                                            // Cross all() -> scanLocalTracks()
                                            // before firing after the outer
                                            // loop has observed no pending edge.
                                            queueMicrotask(() =>
                                                queueMicrotask(dispatchRefresh)
                                            );
                                        }
                                    }, reject);
                                },
                            }) as any;
                    }
                    return result;
                });

            try {
                // Establish how many index iterations one ordinary refresh
                // performs, then inject the edge after that final await.
                dispatchRefresh();
                await waitForResolved(() =>
                    expect(scanCount).to.be.greaterThan(0)
                );
                await delay(100);
                callsPerRefresh = scanCount;
                scanCount = 0;
                queueHandoffRefresh = true;

                dispatchRefresh();
                await waitForResolved(() =>
                    // The handoff edge must add one replacement scan beyond
                    // the monitor's ordinary refresh work.
                    expect(scanCount).to.eq(callsPerRefresh + 1)
                );
            } finally {
                iterateStub.restore();
                await subscription.stop();
            }
        });

        test("retries the exact final replication subscription release", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const cleanupError = new Error(
                "synthetic replication cleanup failure"
            );
            const stopUnderlying = sinon.stub();
            stopUnderlying.onFirstCall().rejects(cleanupError);
            stopUnderlying.onSecondCall().resolves();
            const startSubscription = sinon
                .stub(viewerStreams as any, "startReplicationInfoSubscription")
                .returns({
                    ready: Promise.resolve(),
                    stop: stopUnderlying,
                });
            const subscription = viewerStreams.listenForReplicationInfo();

            try {
                await expect(subscription.stop()).rejects.toBe(cleanupError);
                expect(stopUnderlying.calledOnce).to.be.true;
                expect(
                    (viewerStreams as any).replicationInfoSubscription
                        .references
                ).to.eq(0);

                await subscription.stop();
                expect(stopUnderlying.callCount).to.eq(2);
                expect((viewerStreams as any).replicationInfoSubscription).to.be
                    .undefined;
            } finally {
                startSubscription.restore();
                await subscription.stop().catch(() => {});
            }
        });

        test("retains a shared replication callback until its final handle stops", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const onChange = sinon.stub();
            const withoutCallback = await viewerStreams.iterate("live");
            const openTrack = [...withoutCallback.current.values()][0].track;
            const listenerCountBeforeMonitoring =
                openTrack.source.chunks.log.events.listenerCount(
                    "replication:change"
                );
            const first = await viewerStreams.iterate("live", {
                onReplicationChange: onChange,
            });
            const second = await viewerStreams.iterate("live", {
                onReplicationChange: onChange,
            });

            try {
                await waitForResolved(() =>
                    expect(
                        openTrack.source.chunks.log.events.listenerCount(
                            "replication:change"
                        )
                    ).to.be.greaterThan(listenerCountBeforeMonitoring)
                );
                onChange.resetHistory();
                const removeListener = sinon.spy(
                    openTrack.source.chunks.log.events,
                    "removeEventListener"
                );

                try {
                    openTrack.source.chunks.log.events.dispatchEvent(
                        new CustomEvent("replication:change", {
                            detail: { publicKey: "first-synthetic-replicator" },
                        })
                    );
                    expect(onChange.calledOnce).to.be.true;

                    await first.close();
                    expect(
                        (viewerStreams as any).replicationInfoSubscription
                            .references
                    ).to.eq(1);
                    expect(
                        removeListener
                            .getCalls()
                            .filter(
                                (call) => call.args[0] === "replication:change"
                            )
                    ).to.have.length(0);

                    openTrack.source.chunks.log.events.dispatchEvent(
                        new CustomEvent("replication:change", {
                            detail: {
                                publicKey: "second-synthetic-replicator",
                            },
                        })
                    );
                    expect(onChange.callCount).to.eq(2);

                    await second.close();
                    expect(
                        removeListener
                            .getCalls()
                            .filter(
                                (call) => call.args[0] === "replication:change"
                            )
                    ).not.to.have.length(0);
                    expect((viewerStreams as any).replicationInfoSubscription)
                        .to.be.undefined;
                } finally {
                    removeListener.restore();
                }
            } finally {
                await Promise.allSettled([
                    withoutCallback.close(),
                    first.close(),
                    second.close(),
                ]);
            }
        });

        test("cleans up replication monitoring after its initial scan fails", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const scanError = new Error("synthetic replication scan failure");
            const iterateStub = sinon
                .stub(viewerStreams.tracks.index, "iterate")
                .returns({
                    all: () => Promise.reject(scanError),
                } as any);
            const subscription = viewerStreams.listenForReplicationInfo();

            try {
                await expect(subscription.ready).rejects.toBe(scanError);
                await subscription.stop();
                expect((viewerStreams as any).replicationInfoSubscription).to.be
                    .undefined;
                expect((viewerStreams as any).activeMediaConsumers.size).to.eq(
                    0
                );
            } finally {
                iterateStub.restore();
                await subscription.stop().catch(() => {});
            }
        });

        test("new track while viewing", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 0, size: 0 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let gotTrack = pDefer();
            let gotTrack2 = pDefer();
            let maxTimes: number[] = [];
            iterator = await viewerStreams.iterate("live", {
                onTracksChange(tracks) {
                    for (const track of tracks) {
                        if (equals(track.id, track1.id)) {
                            gotTrack.resolve();
                        } else if (!equals(track.id, track1.id)) {
                            // track 2
                            gotTrack2.resolve();
                        }
                    }
                },
                onTrackOptionsChange(options) {
                    for (let option of options) {
                        if (!equals(option.id, track1.id)) {
                            // track 2
                            iterator.selectOption(option);
                        }
                    }
                },
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onMaxTimeChange: ({ maxTime }) => {
                    maxTimes.push(maxTime);
                },
            });

            await gotTrack.promise;
            await track1.put(
                new Chunk({ time: 0, chunk: new Uint8Array([1, 2, 3]) })
            );

            let ts = 1e3;
            const publishSecondTrack = (async () => {
                await delay(ts);
                const track2 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new AudioStreamDB({ sampleRate: 44100 }),
                        start: ts * 1e3,
                    })
                );

                await mediaStreams.tracks.put(track2);

                const secondTrackTimeout = new AbortController();
                try {
                    await Promise.race([
                        gotTrack2.promise,
                        delay(30_000, {
                            signal: secondTrackTimeout.signal,
                        }).then(() => {
                            throw new Error(
                                "Timed out opening the second track"
                            );
                        }),
                    ]);
                } finally {
                    secondTrackTimeout.abort();
                }

                console.log("HERE2");
                await track2.put(
                    new Chunk({
                        chunk: new Uint8Array([101]),
                        time: 123,
                        type: "key",
                    })
                );
            })();

            try {
                await Promise.all([
                    publishSecondTrack,
                    waitForResolved(() => expect(chunks).to.have.length(2), {
                        timeout: 30_000,
                    }),
                ]);
            } catch (error) {
                throw error;
            }
            expect(maxTimes).to.deep.eq([0, ts * 1e3 + 123]);
        });

        /*  TODO should this test be deleted or can we try to figure out a test case where old data can disrupt the live feed?

        test("old ignored", async () => {
             const { mediaStreams, track1, viewerStreams } =
                 await createScenario({
                     first: { start: 10 },
                 });
             let chunks: { track: Track<any>; chunk: Chunk }[] = [];
             iterator = await viewerStreams.iterate("live", {
                 onProgress: (ev) => {
                     chunks.push(ev);
                 },
             });
 
             await waitForResolved(() =>
                 expect(iterator.current).to.have.length(1)
             );
             await waitForResolved(() =>
                 expect(iterator.options()).to.have.length(1)
             );
             const c1 = new Chunk({
                 chunk: new Uint8Array([103]),
                 time: 103 * MILLISECONDS_TO_MICROSECONDS,
                 type: "key",
             });
             const c2 = new Chunk({
                 chunk: new Uint8Array([102]),
                 time: 102 * MILLISECONDS_TO_MICROSECONDS,
                 type: "key",
             });
             await track1.put(c1, { target: "replicators" });
 
             await waitForResolved(() => expect(chunks).to.have.length(1));
             await track1.put(c2, { target: "replicators" });
             await delay(3000);
             expect(chunks).to.have.length(1);
         }); */

        test("onReplicationChange", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, type: "video" },
            });

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let replicators: {
                hash: string;
                ranges: ReplicationRangeIndexable<"u64">[];
            }[] = [];

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onReplicationChange: async (properties) => {
                    replicators.push({
                        ...properties,
                        ranges: (
                            await properties.track.source.chunks.log.replicationIndex
                                .iterate()
                                .all()
                        ).map((x) => x.value),
                    });
                },
            });

            const c1 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 99998 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            await track1.put(c1, { target: "replicators" });
            await waitForResolved(() =>
                expect(replicators.map((x) => x.hash)).to.deep.eq([
                    track1.node.identity.publicKey.hashcode(),
                    viewerStreams.node.identity.publicKey.hashcode(),
                ])
            );
        });

        test("select options", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 0, type: "video" },
                });

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];

            let gotFirstTrack = pDefer<Track>();
            let gotSecondTrack = pDefer<Track>();

            // we create track2 here because we really want to make sure track1 is select first by default
            // and then we ant to announce track2 and make sure it is selectable as an option thne
            const track2 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new WebcodecsStreamDB({
                        decoderDescription: { codec: "av01" },
                    }),
                    start: 0,
                })
            );

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    for (const track of tracks) {
                        if (track.address === track1.address) {
                            gotFirstTrack.resolve(track);
                        }

                        if (
                            track2.closed === false &&
                            track.address === track2.address
                        ) {
                            gotSecondTrack.resolve(track);
                        }
                    }
                },
            });

            await gotFirstTrack.promise;

            await mediaStreams.tracks.put(track2);

            const c1 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 99998 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 99998 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            // now we want to listen to the other track
            await waitForResolved(() =>
                expect(iterator!.options()).to.have.length(2)
            );

            await track1.put(c1, { target: "replicators" });
            await track2.put(c2, { target: "replicators" });

            await waitForResolved(() => expect(chunks).to.have.length(1));

            expect(chunks[0].chunk.id).to.eq(c1.id);

            const secondOption = iterator
                .options()
                .find((x) => equals(x.id, track2.id));
            if (!secondOption) {
                throw new Error("Missing option");
            }
            await iterator.selectOption(secondOption);
            expect(iterator.options()).to.have.length(2);

            const secondTrackFromViewer = await gotSecondTrack.promise;
            await secondTrackFromViewer.source.chunks.index.waitFor(
                mediaStreams.node.identity.publicKey
            ); // wait for streamer

            const c3 = new Chunk({
                chunk: new Uint8Array([104]),
                time: 99999 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c4 = new Chunk({
                chunk: new Uint8Array([104]),
                time: 99999 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            await track1.put(c3, { target: "replicators" });
            await track2.put(c4, { target: "replicators" });

            await waitForResolved(() => expect(chunks).to.have.length(2));
            expect(chunks[1].chunk.id).to.eq(c4.id);
            expect(iterator.options()).to.have.length(2);
        });

        test("options are updated", async () => {
            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );

            const viewerStreams = await viewer.open(mediaStreams.clone());

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            const progressStarted = pDefer<void>();
            const releaseProgress = pDefer<void>();
            let blockedTrackId: string | undefined;
            let allowReplacement = false;

            iterator = await viewerStreams.iterate("live", {
                onProgress: async (ev) => {
                    chunks.push(ev);
                    if (chunks.length === 1) {
                        progressStarted.resolve();
                        await releaseProgress.promise;
                    }
                },
                changeProcessor: (change, progress, preloadTime) =>
                    !allowReplacement && change.add?.idString === blockedTrackId
                        ? {}
                        : oneVideoAndOneAudioChangeProcessor(
                              change,
                              progress,
                              preloadTime
                          ),
            });

            const track1 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new WebcodecsStreamDB({
                        decoderDescription: { codec: "av01" },
                    }),
                    start: 0,
                })
            );

            await mediaStreams.tracks.put(track1, { target: "replicators" });
            const track2 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new WebcodecsStreamDB({
                        decoderDescription: { codec: "av01" },
                    }),
                    start: 1000,
                })
            );
            blockedTrackId = track2.idString;
            await mediaStreams.tracks.put(track2, { target: "replicators" });

            await waitForResolved(() =>
                expect(iterator.options()).to.have.length(2)
            );
            await track1.source.chunks.log.waitForReplicator(
                viewer.identity.publicKey,
                { eager: true }
            );
            await waitForResolved(() => {
                expect(iterator.current).to.have.length(1);
                expect([...iterator.current.values()][0]?.track.idString).to.eq(
                    track1.idString
                );
            });
            const viewerTrack = [...iterator.current.values()][0].track;
            const closeStarted = pDefer<void>();
            const releaseClose = pDefer<void>();
            const endPreviousLivestreamSubscription =
                viewerTrack.source.endPreviousLivestreamSubscription.bind(
                    viewerTrack.source
                );
            const endLiveStub = sinon
                .stub(viewerTrack.source, "endPreviousLivestreamSubscription")
                .callsFake(async () => {
                    closeStarted.resolve();
                    await releaseClose.promise;
                    return endPreviousLivestreamSubscription();
                });

            // insert some data and make sure only track1 is played
            const c1 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 103 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 103 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            try {
                await track1.put(c1, { target: "replicators" });
                await track2.put(c2, { target: "replicators" });
                await progressStarted.promise;

                expect(chunks.map((x) => x.chunk.id)).to.deep.eq([c1.id]);

                await mediaStreams.setEnd(track1, 0);
                await waitForResolved(() =>
                    expect(iterator.options()).to.have.length(1)
                );
                await closeStarted.promise;
                expect(iterator.current).to.have.length(1);
                expect([...iterator.current.values()][0]?.track.idString).to.eq(
                    track1.idString
                );

                releaseProgress.resolve();
                await waitForResolved(() => {
                    expect(iterator.current).to.have.length(1);
                    expect(
                        [...iterator.current.values()][0]?.chunks
                    ).to.have.length(0);
                });
                expect(endLiveStub.calledOnce).to.be.true;

                releaseClose.resolve();
                await waitForResolved(
                    () => expect(iterator.current).to.have.length(0),
                    { timeout: 10_000, delayInterval: 10 }
                );
                expect(endLiveStub.calledOnce).to.be.true;

                allowReplacement = true;
                await waitForResolved(() => {
                    expect(iterator.current).to.have.length(1);
                    expect(
                        [...iterator.current.values()][0]?.track.idString
                    ).to.eq(track2.idString);
                });
                await track2.source.chunks.log.waitForReplicator(
                    viewer.identity.publicKey,
                    { eager: true }
                );

                // put some data in track1 and track2 and make sure only track2 is played
                const c3 = new Chunk({
                    chunk: new Uint8Array([103]),
                    time: 104 * MILLISECONDS_TO_MICROSECONDS,
                    type: "key",
                });
                const c4 = new Chunk({
                    chunk: new Uint8Array([103]),
                    time: 104 * MILLISECONDS_TO_MICROSECONDS,
                    type: "key",
                });

                await track1.put(c3, { target: "replicators" });
                await track2.put(c4, { target: "replicators" });

                await waitForResolved(() =>
                    expect(chunks.map((x) => x.chunk.id)).to.deep.eq([
                        c1.id,
                        c4.id,
                    ])
                );
            } finally {
                allowReplacement = true;
                releaseProgress.resolve();
                releaseClose.resolve();
                endLiveStub.restore();
            }
        });

        test("closing iterator will end track", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 10, size: 1 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let viewerTracks: Track<AudioStreamDB | WebcodecsStreamDB>[] = [];

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracks.push(...tracks);
                },
            });

            try {
                await waitForResolved(() =>
                    expect(viewerTracks).to.have.length(1)
                );
            } catch (error) {
                throw error;
            }

            await waitForResolved(
                () => expect(viewerTracks[0].closed).to.be.false
            );
            await iterator.close();
            expect(viewerTracks[0].closed).to.be.true;
        });

        test("keeps a shared track open until its final iterator closes", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const firstTracks: Track[] = [];
            const secondTracks: Track[] = [];
            const first = await viewerStreams.iterate("live", {
                onTracksChange: (tracks) => firstTracks.push(...tracks),
            });
            const second = await viewerStreams.iterate("live", {
                onTracksChange: (tracks) => secondTracks.push(...tracks),
            });

            try {
                await waitForResolved(() => {
                    expect(firstTracks).to.have.length(1);
                    expect(secondTracks).to.have.length(1);
                });
                expect(firstTracks[0]).to.eq(secondTracks[0]);
                const closeTrack = sinon.spy(firstTracks[0], "close");

                await first.close();
                expect(firstTracks[0].closed).to.be.false;
                expect(closeTrack.called).to.be.false;

                await second.close();
                expect(firstTracks[0].closed).to.be.true;
                expect(closeTrack.calledOnce).to.be.true;
            } finally {
                await Promise.allSettled([first.close(), second.close()]);
            }
        });

        test("reference-counts live replication independently of non-live track leases", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const monitor = viewerStreams.listenForMaxTimeChanges(false);
            await monitor.ready;
            const sharedLease = [
                ...(viewerStreams as any).trackLeases.values(),
            ][0];
            const replicateLive = sinon
                .stub(sharedLease.track.source, "replicate")
                .resolves();
            const endLive = sinon
                .stub(
                    sharedLease.track.source,
                    "endPreviousLivestreamSubscription"
                )
                .resolves();
            let first:
                | Awaited<ReturnType<MediaStreamDB["iterate"]>>
                | undefined;
            let second:
                | Awaited<ReturnType<MediaStreamDB["iterate"]>>
                | undefined;

            try {
                first = await viewerStreams.iterate("live");
                second = await viewerStreams.iterate("live");

                expect(replicateLive.calledOnceWith("live")).to.be.true;
                expect(endLive.notCalled).to.be.true;

                await first.close();
                expect(endLive.notCalled).to.be.true;

                await second.close();
                expect(endLive.calledOnce).to.be.true;
                expect(
                    (viewerStreams as any).trackLeases.get(
                        sharedLease.track.idString
                    ).references
                ).to.eq(1);
            } finally {
                await Promise.allSettled([first?.close(), second?.close()]);
                replicateLive.restore();
                endLive.restore();
                await monitor.stop();
            }
        });

        test("retries the exact live shutdown before retiring its track lease", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const lease = [...(viewerStreams as any).trackLeases.values()][0];
            const shutdownError = new Error(
                "synthetic live subscription shutdown failure"
            );
            const realEnd =
                lease.track.source.endPreviousLivestreamSubscription.bind(
                    lease.track.source
                );
            const endLive = sinon.stub(
                lease.track.source,
                "endPreviousLivestreamSubscription"
            );
            endLive.onFirstCall().rejects(shutdownError);
            endLive.onSecondCall().callsFake(realEnd);

            try {
                await expect(viewerStreams.close()).rejects.toBe(shutdownError);
                expect(endLive.calledOnce).to.be.true;
                expect(viewerStreams.closed).to.be.false;
                expect(lease.track.closed).to.be.false;
                expect(
                    (viewerStreams as any).trackLeases.get(lease.track.idString)
                ).to.eq(lease);
                expect(
                    (viewerStreams as any).openedTracks.get(lease.track.address)
                ).to.eq(lease.track);

                await viewerStreams.close();
                expect(endLive.callCount).to.eq(2);
                expect(viewerStreams.closed).to.be.true;
                expect(lease.track.closed).to.be.true;
                expect((viewerStreams as any).trackLeases.size).to.eq(0);
                expect((viewerStreams as any).openedTracks.size).to.eq(0);
                await waitForResolved(() =>
                    expect((viewerStreams as any).trackLeaseQueues.size).to.eq(
                        0
                    )
                );
            } finally {
                endLive.restore();
                await result.close().catch(() => {});
                await viewerStreams.close().catch(() => {});
            }
        });

        test("retires the queue for a final keep-open track lease", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live", {
                keepTracksOpen: true,
            });

            await result.close();
            expect((viewerStreams as any).trackLeases.size).to.eq(1);
            expect((viewerStreams as any).trackLeaseQueues.size).to.eq(1);

            await (viewerStreams as any).closeMediaResources();

            expect((viewerStreams as any).trackLeases.size).to.eq(0);
            expect((viewerStreams as any).openedTracks.size).to.eq(0);
            await waitForResolved(() =>
                expect((viewerStreams as any).trackLeaseQueues.size).to.eq(0)
            );
        });

        test("does not block an unrelated lease behind a stalled live start", async () => {
            const { track1, track2, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
                second: { start: 0, size: 0, type: "video" },
            });
            const first = await (viewerStreams as any).acquireTrackLease(
                track1.clone()
            );
            const second = await (viewerStreams as any).acquireTrackLease(
                track2.clone()
            );
            const startEntered = pDefer<void>();
            const releaseStart = pDefer<void>();
            const replicateLive = sinon
                .stub(first.track.source, "replicate")
                .callsFake(async () => {
                    startEntered.resolve();
                    await releaseStart.promise;
                });
            const starting = first.acquireLivestream();

            try {
                await startEntered.promise;
                const unrelatedReleased = await Promise.race([
                    second.release().then(() => true),
                    delay(1000).then(() => false),
                ]);
                expect(unrelatedReleased).to.be.true;
            } finally {
                releaseStart.resolve();
                await starting.catch(() => {});
                await Promise.allSettled([first.release(), second.release()]);
                replicateLive.restore();
            }
        });

        test("rejects duplicate and foreign parent closes without tearing down valid consumers", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const openTrack = [...result.current.values()][0].track;
            const previousParents = (viewerStreams as any).parents;
            const firstParent = {} as MediaStreamDB;
            const secondParent = {} as MediaStreamDB;
            (viewerStreams as any).parents = [firstParent, secondParent];

            try {
                expect(await viewerStreams.close(firstParent)).to.be.false;
                expect(viewerStreams.closed).to.be.false;
                expect(result.current.size).to.eq(1);
                expect(openTrack.closed).to.be.false;
                expect(
                    (viewerStreams as any).activeMediaConsumers.size
                ).to.be.greaterThan(0);

                await expect(viewerStreams.close(firstParent)).rejects.toThrow(
                    "Could not find from in parents"
                );
                const foreignParent = {} as MediaStreamDB;
                await expect(
                    viewerStreams.close(foreignParent)
                ).rejects.toThrow("Could not find from in parents");

                expect(viewerStreams.closed).to.be.false;
                expect(result.current.size).to.eq(1);
                expect(openTrack.closed).to.be.false;
                expect(
                    (viewerStreams as any).activeMediaConsumers.size
                ).to.be.greaterThan(0);
            } finally {
                (viewerStreams as any).parents = previousParents;
                await result.close();
            }
        });

        test("keeps consumers alive after a non-final parent drop", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const openTrack = [...result.current.values()][0].track;
            const previousParents = (viewerStreams as any).parents;
            const firstParent = {} as MediaStreamDB;
            const secondParent = {} as MediaStreamDB;
            (viewerStreams as any).parents = [firstParent, secondParent];

            try {
                expect(await viewerStreams.drop(firstParent)).to.be.false;
                expect(viewerStreams.closed).to.be.false;
                expect(result.current.size).to.eq(1);
                expect(openTrack.closed).to.be.false;
                expect(
                    (viewerStreams as any).activeMediaConsumers.size
                ).to.be.greaterThan(0);
            } finally {
                (viewerStreams as any).parents = previousParents;
                await result.close();
            }
        });

        test("coalesces final cleanup and rejects parent attachment behind its fence", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const parent = await viewer.open(
                new MediaStreamDBs({ id: randomBytes(32) }),
                { args: { replicate: false } }
            );
            const cleanupStarted = pDefer<void>();
            const releaseCleanup = pDefer<void>();
            const drainMediaResources = sinon
                .stub(viewerStreams as any, "drainMediaResources")
                .callsFake(async () => {
                    cleanupStarted.resolve();
                    await releaseCleanup.promise;
                });
            const firstClose = viewerStreams.close();
            const secondClose = viewerStreams.close();

            try {
                await cleanupStarted.promise;
                expect(drainMediaResources.calledOnce).to.be.true;
                expect(viewerStreams.acceptsParentAttachments).to.be.false;
                await expect(
                    viewer.open(viewerStreams, {
                        existing: "reuse",
                        parent,
                    })
                ).rejects.toThrow();
                expect(viewerStreams.parents).not.to.include(parent);

                releaseCleanup.resolve();
                expect(await Promise.all([firstClose, secondClose])).to.deep.eq(
                    [true, true]
                );
            } finally {
                releaseCleanup.resolve();
                await Promise.allSettled([firstClose, secondClose]);
                drainMediaResources.restore();
                await parent.close().catch(() => {});
            }
        });

        test("fences parent admission before destructive media drop cleanup", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const cleanupStarted = pDefer<void>();
            const releaseCleanup = pDefer<void>();
            const closeMediaResources = sinon
                .stub(viewerStreams as any, "closeMediaResources")
                .callsFake(async () => {
                    cleanupStarted.resolve();
                    await releaseCleanup.promise;
                });
            const dropping = viewerStreams.drop();

            try {
                await cleanupStarted.promise;
                expect(viewerStreams.acceptsParentAttachments).to.be.false;
                releaseCleanup.resolve();
                expect(await dropping).to.be.true;
            } finally {
                releaseCleanup.resolve();
                await dropping.catch(() => {});
                closeMediaResources.restore();
            }
        });

        test("rejects a queued track lease once final close begins", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const leaseQueue = (viewerStreams as any).getTrackLeaseQueue(
                track1.idString
            );
            const blockerStarted = pDefer<void>();
            const releaseBlocker = pDefer<void>();
            const blocker = leaseQueue.add(async () => {
                blockerStarted.resolve();
                await releaseBlocker.promise;
            });
            await blockerStarted.promise;

            const admission = (viewerStreams as any).acquireTrackLease(
                track1.clone()
            );
            const admissionRejected =
                expect(admission).rejects.toBeInstanceOf(ClosedError);
            const closing = viewerStreams.close();

            try {
                expect((viewerStreams as any).mediaResourcesClosing).to.be.true;
                releaseBlocker.resolve();
                await admissionRejected;
                await blocker;
                await closing;
                expect((viewerStreams as any).trackLeases.size).to.eq(0);
                expect((viewerStreams as any).openedTracks.size).to.eq(0);
            } finally {
                releaseBlocker.resolve();
                await Promise.allSettled([blocker, admission, closing]);
            }
        });

        test("fences iterator and monitor admission during final drop", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const initialReadStarted = pDefer<void>();
            const releaseInitialRead = pDefer<void>();
            const getLatest = sinon
                .stub(viewerStreams, "getLatest")
                .callsFake(async () => {
                    initialReadStarted.resolve();
                    await releaseInitialRead.promise;
                    return [];
                });
            const iteration = viewerStreams.iterate("live");
            await initialReadStarted.promise;
            const iterationRejected =
                expect(iteration).rejects.toBeInstanceOf(ClosedError);
            const dropping = viewerStreams.drop();

            try {
                expect((viewerStreams as any).mediaResourcesClosing).to.be.true;
                expect(() =>
                    viewerStreams.listenForMaxTimeChanges(false)
                ).to.throw(ClosedError);
                expect(() => viewerStreams.listenForReplicationInfo()).to.throw(
                    ClosedError
                );
                await expect(
                    viewerStreams.iterate("live")
                ).rejects.toBeInstanceOf(ClosedError);

                releaseInitialRead.resolve();
                await iterationRejected;
                await dropping;
                expect((viewerStreams as any).activeMediaConsumers.size).to.eq(
                    0
                );
                expect((viewerStreams as any).trackLeases.size).to.eq(0);
            } finally {
                releaseInitialRead.resolve();
                getLatest.restore();
                await Promise.allSettled([iteration, dropping]);
            }
        });

        test("releases only its explicit parent from an externally opened track", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const openedTrack = await viewer.open(track1.clone());
            const closeTrack = sinon.spy(openedTrack, "close");

            try {
                const lease = await (viewerStreams as any).acquireTrackLease(
                    openedTrack
                );
                expect(lease.track).to.eq(openedTrack);
                expect(openedTrack.parents).to.include(viewerStreams);
                await lease.release();
                expect(openedTrack.closed).to.be.false;
                expect(closeTrack.calledOnceWith(viewerStreams)).to.be.true;
                expect(openedTrack.parents).not.to.include(viewerStreams);
            } finally {
                closeTrack.restore();
                await openedTrack.close();
            }
        });

        test("preserves a later external root when releasing its track parent", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const lease = await (viewerStreams as any).acquireTrackLease(
                track1.clone()
            );
            const openedTrack = lease.track as Track;
            const externalTrack = await viewer.open(openedTrack, {
                existing: "reuse",
            });
            const closeTrack = sinon.spy(openedTrack, "close");

            try {
                expect(externalTrack).to.eq(openedTrack);
                expect(openedTrack.parents).to.include(viewerStreams);
                expect(openedTrack.parents).to.include(undefined);

                await lease.release();

                expect(closeTrack.calledOnceWith(viewerStreams)).to.be.true;
                expect(openedTrack.closed).to.be.false;
                expect(openedTrack.parents).not.to.include(viewerStreams);
                expect(openedTrack.parents).to.include(undefined);
            } finally {
                closeTrack.restore();
                await openedTrack.close();
            }
        });

        test("resets default replication when reopened without it", async () => {
            const mediaStreams = new MediaStreamDB(viewer.identity.publicKey);
            const tracksOpen = sinon
                .stub(mediaStreams.tracks, "open")
                .resolves();

            try {
                await mediaStreams.open({ replicate: "all" });
                expect((mediaStreams as any).replicateTracksByDefault).to.be
                    .true;

                await mediaStreams.open({ replicate: false });
                expect((mediaStreams as any).replicateTracksByDefault).to.be
                    .false;

                (mediaStreams as any).replicateTracksByDefault = true;
                await mediaStreams.open();
                expect((mediaStreams as any).replicateTracksByDefault).to.be
                    .false;
            } finally {
                tracksOpen.restore();
            }
        });

        test("drains default replication admission that races stream close", async () => {
            const { track1, viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const replicationStarted = pDefer<void>();
            const releaseReplication = pDefer<void>();
            const replicateStub = sinon
                .stub(AudioStreamDB.prototype, "replicate")
                .callsFake(async function (this: AudioStreamDB, mode) {
                    expect(mode).to.eq("all");
                    replicationStarted.resolve();
                    await releaseReplication.promise;
                });

            try {
                const admission = (
                    viewerStreams as any
                ).ensureDefaultTrackReplication(track1.clone());
                await replicationStarted.promise;
                const openedTrack = (
                    viewerStreams as any
                ).defaultReplicationLeases.get(track1.idString).handle.track;

                const closing = viewerStreams.close();
                releaseReplication.resolve();
                await Promise.all([admission, closing]);

                expect(openedTrack.closed).to.be.true;
                expect(
                    (viewerStreams as any).defaultReplicationLeases.size
                ).to.eq(0);
                expect((viewerStreams as any).trackLeases.size).to.eq(0);
                expect((viewerStreams as any).openedTracks.size).to.eq(0);
            } finally {
                releaseReplication.resolve();
                replicateStub.restore();
                await viewerStreams.close().catch(() => {});
            }
        });

        test("retries a failed nested iterator cleanup", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const cleanupError = new Error("synthetic track cleanup failure");
            const closeTrackResources = sinon.stub();
            closeTrackResources.onFirstCall().rejects(cleanupError);
            closeTrackResources.onSecondCall().resolves();
            result.current.set("synthetic-track", {
                track: {
                    idString: "synthetic-track",
                    source: { mediaType: "synthetic" },
                },
                chunks: [],
                close: closeTrackResources,
            } as any);

            await expect(result.close()).rejects.toBe(cleanupError);
            expect(closeTrackResources.calledOnce).to.be.true;

            await result.close();
            expect(closeTrackResources.callCount).to.eq(2);
        });

        test("retains the exact closer when a non-final track notification throws", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const notificationError = new Error(
                "synthetic track removal notification failure"
            );
            let failRemovalNotification = true;
            const result = await viewerStreams.iterate("live", {
                onTracksChange: (tracks) => {
                    if (tracks.length === 0 && failRemovalNotification) {
                        failRemovalNotification = false;
                        throw notificationError;
                    }
                },
            });
            const trackWithBuffer = [...result.current.values()][0];
            const originalClose = trackWithBuffer.close;
            expect(originalClose).to.be.a("function");
            const cleanupError = new Error(
                "synthetic retained track cleanup failure"
            );
            const closeTrackResources = sinon.stub();
            closeTrackResources.onFirstCall().rejects(cleanupError);
            closeTrackResources
                .onSecondCall()
                .callsFake(() => originalClose!());
            trackWithBuffer.close = closeTrackResources;

            try {
                await expect(
                    result.selectOption(trackWithBuffer.track)
                ).rejects.toBe(notificationError);
                expect(closeTrackResources.called).to.be.false;

                await expect(result.close()).rejects.toBe(cleanupError);
                expect(closeTrackResources.calledOnce).to.be.true;

                await result.close();
                expect(closeTrackResources.callCount).to.eq(2);
            } finally {
                trackWithBuffer.close = originalClose;
                await result.close().catch(() => {});
            }
        });

        test("pause waits for nested track cleanup", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const releaseCleanup = pDefer<void>();
            const cleanupStarted = pDefer<void>();
            result.current.set("delayed-track", {
                track: {
                    idString: "delayed-track",
                    source: { mediaType: "synthetic" },
                },
                chunks: [],
                close: async () => {
                    cleanupStarted.resolve();
                    await releaseCleanup.promise;
                },
            } as any);

            let pauseSettled = false;
            const pause = result.pause().then(() => {
                pauseSettled = true;
            });
            await cleanupStarted.promise;
            expect(result.paused).to.be.true;
            expect(pauseSettled).to.be.false;

            releaseCleanup.resolve();
            await pause;
            expect(pauseSettled).to.be.true;
            await result.close();
        });

        test("interrupts delayed live startup on pause and close", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            await result.pause();

            const firstReadStarted = pDefer<AbortSignal>();
            const secondReadStarted = pDefer<AbortSignal>();
            const starts = [firstReadStarted, secondReadStarted];
            let invocation = 0;
            const latestStub = sinon
                .stub(viewerStreams, "getLatest")
                .callsFake((options: any) => {
                    const signal = options.signal as AbortSignal;
                    starts[invocation++].resolve(signal);
                    return new Promise<any[]>((_, reject) => {
                        const abort = () =>
                            reject(new Error("synthetic aborted live read"));
                        if (signal.aborted) {
                            abort();
                        } else {
                            signal.addEventListener("abort", abort, {
                                once: true,
                            });
                        }
                    });
                });

            try {
                const firstPlay = result.play();
                const firstSignal = await firstReadStarted.promise;
                const pause = result.pause();
                expect(firstSignal.aborted).to.be.true;
                await Promise.all([firstPlay, pause]);
                expect(result.paused).to.be.true;

                const secondPlay = result.play();
                const secondSignal = await secondReadStarted.promise;
                const close = result.close();
                expect(secondSignal.aborted).to.be.true;
                await Promise.all([secondPlay, close]);
                expect(result.paused).to.be.true;
            } finally {
                latestStub.restore();
                await result.close().catch(() => {});
            }
        });

        test("cancels initial iteration through the caller signal", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const readStarted = pDefer<AbortSignal>();
            const latestStub = sinon
                .stub(viewerStreams, "getLatest")
                .callsFake((options: any) => {
                    const signal = options.signal as AbortSignal;
                    readStarted.resolve(signal);
                    return new Promise<any[]>((_, reject) => {
                        const abort = () => reject(new AbortError());
                        if (signal.aborted) {
                            abort();
                        } else {
                            signal.addEventListener("abort", abort, {
                                once: true,
                            });
                        }
                    });
                });
            const controller = new AbortController();

            try {
                const iteration = viewerStreams.iterate("live", {
                    signal: controller.signal,
                });
                const playbackSignal = await readStarted.promise;
                controller.abort("Viewer unmounted");
                expect(playbackSignal.aborted).to.be.true;
                await expect(iteration).rejects.toBeInstanceOf(AbortError);
                expect((viewerStreams as any).activeMediaConsumers.size).to.eq(
                    0
                );
            } finally {
                latestStub.restore();
            }
        });

        test("interrupts delayed live track admission on pause", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            await result.pause();
            const replicateStarted = pDefer<AbortSignal>();
            const replicateStub = sinon
                .stub(AudioStreamDB.prototype, "replicate")
                .callsFake((_args: any, options?: { signal?: AbortSignal }) => {
                    const signal = options?.signal;
                    if (!signal) {
                        throw new Error("Missing playback lifecycle signal");
                    }
                    replicateStarted.resolve(signal);
                    return new Promise<void>((_, reject) => {
                        const abort = () =>
                            reject(
                                new Error(
                                    "synthetic aborted live track admission"
                                )
                            );
                        if (signal.aborted) {
                            abort();
                        } else {
                            signal.addEventListener("abort", abort, {
                                once: true,
                            });
                        }
                    });
                });

            try {
                const play = result.play();
                const signal = await replicateStarted.promise;
                const pause = result.pause();
                expect(signal.aborted).to.be.true;
                await Promise.all([play, pause]);
                expect(result.paused).to.be.true;
            } finally {
                replicateStub.restore();
                await result.close().catch(() => {});
            }
        });

        test("does not publish an orphan live segment when startup aborts", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live", {
                keepTracksOpen: true,
            });
            const openTrack = [...result.current.values()][0]?.track;
            expect(openTrack).to.exist;
            const source = openTrack.source;
            await result.pause();
            expect(source.lastLivestreamingSegmentId).to.be.undefined;

            const originalLast = source.last.bind(source);
            const lastStarted = pDefer<AbortSignal>();
            let delayNextLast = true;
            const lastStub = sinon
                .stub(source, "last")
                .callsFake((options?: { signal?: AbortSignal }) => {
                    if (!delayNextLast) {
                        return originalLast(options);
                    }
                    delayNextLast = false;
                    const signal = options?.signal;
                    if (!signal) {
                        throw new Error("Missing playback lifecycle signal");
                    }
                    lastStarted.resolve(signal);
                    return new Promise<Chunk | undefined>((_, reject) => {
                        const abort = () => reject(new AbortError());
                        if (signal.aborted) {
                            abort();
                        } else {
                            signal.addEventListener("abort", abort, {
                                once: true,
                            });
                        }
                    });
                });

            try {
                const play = result.play();
                const signal = await lastStarted.promise;
                const pause = result.pause();
                expect(signal.aborted).to.be.true;
                await Promise.all([play, pause]);

                // The failed probe never reached chunks.log.replicate, so no
                // segment ID may be exposed to the retryable cleanup path.
                expect(source.lastLivestreamingSegmentId).to.be.undefined;

                // Cleanup debt from the aborted attempt must not poison the
                // next admission. A real retry can create and then end a live
                // segment normally.
                await result.play();
                expect(source.lastLivestreamingSegmentId).to.exist;
                await result.pause();
                expect(source.lastLivestreamingSegmentId).to.be.undefined;
            } finally {
                lastStub.restore();
                await result.close().catch(() => {});
            }
        });

        test("interrupts delayed recorded startup on pause and close", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate(0.5);
            await result.pause();

            const firstReadStarted = pDefer<AbortSignal>();
            const secondReadStarted = pDefer<AbortSignal>();
            const starts = [firstReadStarted, secondReadStarted];
            const closes = [sinon.stub().resolves(), sinon.stub().resolves()];
            let invocation = 0;
            const metadataStub = sinon
                .stub(viewerStreams.tracks.index as any, "iterate")
                .callsFake((_request: any, options: any) => {
                    const currentInvocation = invocation++;
                    const signal = options.signal as AbortSignal;
                    starts[currentInvocation].resolve(signal);
                    const next = () =>
                        new Promise<any[]>((_, reject) => {
                            const abort = () =>
                                reject(
                                    new Error("synthetic aborted recorded read")
                                );
                            if (signal.aborted) {
                                abort();
                            } else {
                                signal.addEventListener("abort", abort, {
                                    once: true,
                                });
                            }
                        });
                    return {
                        next,
                        done: () => false,
                        pending: () => 0,
                        first: async () => (await next())[0],
                        all: async () => next(),
                        close: closes[currentInvocation],
                        [Symbol.asyncIterator]: async function* () {},
                    };
                });

            try {
                const firstPlay = result.play();
                const firstSignal = await firstReadStarted.promise;
                const pause = result.pause();
                expect(firstSignal.aborted).to.be.true;
                await Promise.all([firstPlay, pause]);
                expect(closes[0].calledOnce).to.be.true;
                expect(result.paused).to.be.true;

                const secondPlay = result.play();
                const secondSignal = await secondReadStarted.promise;
                const close = result.close();
                expect(secondSignal.aborted).to.be.true;
                await Promise.all([secondPlay, close]);
                expect(closes[1].calledOnce).to.be.true;
                expect(result.paused).to.be.true;
            } finally {
                metadataStub.restore();
                await result.close().catch(() => {});
            }
        });

        test("retries only failed iterator close notifications", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const notificationError = new Error(
                "synthetic close notification failure"
            );
            let failTrackNotification = true;
            const onTracksChange = sinon.stub().callsFake((tracks: Track[]) => {
                if (tracks.length === 0 && failTrackNotification) {
                    failTrackNotification = false;
                    throw notificationError;
                }
            });
            const onTrackOptionsChange = sinon.stub();
            const onClose = sinon.stub();
            const result = await viewerStreams.iterate("live", {
                onTracksChange,
                onTrackOptionsChange,
                onClose,
            });

            await expect(result.close()).rejects.toBe(notificationError);
            expect(
                onTracksChange
                    .getCalls()
                    .filter((call) => call.args[0].length === 0)
            ).to.have.length(1);
            expect(
                onTrackOptionsChange
                    .getCalls()
                    .filter((call) => call.args[0].length === 0)
            ).to.have.length(1);
            expect(onClose.calledOnce).to.be.true;

            await Promise.resolve();
            await result.close();
            expect(
                onTracksChange
                    .getCalls()
                    .filter((call) => call.args[0].length === 0)
            ).to.have.length(2);
            expect(
                onTrackOptionsChange
                    .getCalls()
                    .filter((call) => call.args[0].length === 0)
            ).to.have.length(1);
            expect(onClose.calledOnce).to.be.true;
        });

        test("does not await an async close notification that closes its own iterator", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const callbackCompleted = pDefer<void>();

            iterator = await viewerStreams.iterate("live", {
                onClose: async () => {
                    await iterator.close();
                    callbackCompleted.resolve();
                },
            });

            await Promise.race([
                iterator.close(),
                delay(2_000).then(() => {
                    throw new Error("Re-entrant iterator close deadlocked");
                }),
            ]);
            await callbackCompleted.promise;
            expect((viewerStreams as any).activeMediaConsumers.size).to.eq(0);
        });

        test("does not deadlock when an async close notification closes its owner", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const callbackCompleted = pDefer<void>();

            iterator = await viewerStreams.iterate("live", {
                onClose: async () => {
                    await viewerStreams.close();
                    callbackCompleted.resolve();
                },
            });

            await Promise.race([
                iterator.close(),
                delay(2_000).then(() => {
                    throw new Error("Iterator-to-owner close deadlocked");
                }),
            ]);
            await Promise.race([
                callbackCompleted.promise,
                delay(2_000).then(() => {
                    throw new Error(
                        "Iterator-to-owner callback did not finish"
                    );
                }),
            ]);
            expect(viewerStreams.closed).to.be.true;
        });

        test("does not deadlock an owner close on its iterator notification", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const callbackCompleted = pDefer<void>();

            iterator = await viewerStreams.iterate("live", {
                onClose: async () => {
                    await viewerStreams.close();
                    callbackCompleted.resolve();
                },
            });

            await Promise.race([
                viewerStreams.close(),
                delay(2_000).then(() => {
                    throw new Error("Owner-to-iterator close deadlocked");
                }),
            ]);
            await callbackCompleted.promise;
            expect(viewerStreams.closed).to.be.true;
            expect((viewerStreams as any).activeMediaConsumers.size).to.eq(0);
        });

        test("publishes a final empty track state after pause then close", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const trackChanges: Track[][] = [];

            iterator = await viewerStreams.iterate("live", {
                onTracksChange: (tracks) => trackChanges.push([...tracks]),
            });
            await waitForResolved(
                () =>
                    expect(trackChanges.some((tracks) => tracks.length > 0)).to
                        .be.true
            );

            await iterator.pause();
            expect(iterator.current.size).to.eq(0);
            expect(trackChanges.at(-1)).not.to.deep.eq([]);

            await iterator.close();
            expect(trackChanges.at(-1)).to.deep.eq([]);
        });

        test("publishes a final empty state when a nonempty callback closes re-entrantly", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const trackChanges: Track[][] = [];
            let closeOnNextNonempty = false;
            let reentrantClose: Promise<void> | undefined;
            const nonemptyCallbackStarted = pDefer<void>();

            iterator = await viewerStreams.iterate("live", {
                changeProcessor: (change) =>
                    change.force
                        ? { add: change.add, remove: change.remove }
                        : {},
                onTracksChange: (tracks) => {
                    trackChanges.push([...tracks]);
                    if (closeOnNextNonempty && tracks.length > 0) {
                        closeOnNextNonempty = false;
                        reentrantClose = iterator.close();
                        nonemptyCallbackStarted.resolve();
                    }
                },
            });
            await waitForResolved(() =>
                expect(iterator.options()).to.have.length(1)
            );
            const option = iterator.options()[0];
            expect(iterator.current.size).to.eq(0);
            trackChanges.length = 0;
            closeOnNextNonempty = true;
            const selecting = iterator.selectOption(option);
            await Promise.race([
                nonemptyCallbackStarted.promise,
                delay(2_000).then(() => {
                    throw new Error("Nonempty reentrant callback did not run");
                }),
            ]);
            await selecting;
            await reentrantClose;

            expect(trackChanges.some((tracks) => tracks.length > 0)).to.be.true;
            expect(trackChanges.at(-1)).to.deep.eq([]);
        });

        test("clears a published future-only track option on close", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 10_000, end: 20_000, size: 0 },
            });
            const optionChanges: Track[][] = [];

            iterator = await viewerStreams.iterate(0, {
                preload: 0,
                changeProcessor: () => ({}),
                onTrackOptionsChange: (tracks) =>
                    optionChanges.push([...tracks]),
            });
            await waitForResolved(
                () =>
                    expect(optionChanges.some((tracks) => tracks.length > 0)).to
                        .be.true
            );
            expect(iterator.current.size).to.eq(0);

            await iterator.close();
            expect(optionChanges.at(-1)).to.deep.eq([]);
        });

        test("does not publish a metadata page resolved after iterator close", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const lateTrack = new Track({
                sender: streamer.identity.publicKey,
                source: new AudioStreamDB({ sampleRate: 44100 }),
                start: 10_000 * MILLISECONDS_TO_MICROSECONDS,
                end: 20_000 * MILLISECONDS_TO_MICROSECONDS,
            });
            const optionChanges: Track[][] = [];

            iterator = await viewerStreams.iterate(0, {
                preload: 0,
                changeProcessor: () => ({}),
                onTrackOptionsChange: (tracks) =>
                    optionChanges.push([...tracks]),
            });
            await waitForResolved(
                () =>
                    expect(optionChanges.some((tracks) => tracks.length > 0)).to
                        .be.true
            );
            await iterator.pause();
            optionChanges.length = 0;

            const pageRequested = pDefer<void>();
            const page = pDefer<Track[]>();
            const metadataClose = sinon.stub().resolves();
            const realIterate = viewerStreams.tracks.index.iterate.bind(
                viewerStreams.tracks.index
            );
            const iterateStub = sinon
                .stub(viewerStreams.tracks.index, "iterate")
                .callsFake(((request: any, options: any) => {
                    if (options?.remote && "replicate" in options.remote) {
                        return {
                            next: async () => {
                                pageRequested.resolve();
                                return page.promise;
                            },
                            done: () => false,
                            close: metadataClose,
                        } as any;
                    }
                    return realIterate(request, options);
                }) as any);

            try {
                const replay = iterator.play();
                await pageRequested.promise;
                const closing = iterator.close();
                page.resolve([lateTrack.clone()]);

                await Promise.all([replay, closing]);
                expect(optionChanges.some((tracks) => tracks.length > 0)).to.be
                    .false;
                expect(optionChanges.at(-1)).to.deep.eq([]);
                expect(metadataClose.calledOnce).to.be.true;
            } finally {
                page.resolve([]);
                iterateStub.restore();
                await iterator.close();
            }
        });

        test("serializes concurrent play, pause, and close controls", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const result = await viewerStreams.iterate("live");
            const controls = await Promise.allSettled([
                result.pause(),
                result.play(),
                result.pause(),
                result.close(),
            ]);

            expect(controls.every((control) => control.status === "fulfilled"))
                .to.be.true;
            expect(result.paused).to.be.true;
            expect(result.current.size).to.eq(0);
        });

        test("stream close retains and retries a failed owned track", async () => {
            const { viewerStreams } = await createScenario({
                first: { start: 0, size: 0 },
            });
            const cleanupError = new Error("synthetic owned track failure");
            const closeTrack = sinon.stub();
            closeTrack.onFirstCall().rejects(cleanupError);
            closeTrack.onSecondCall().resolves(true);
            const ownedTrack = {
                close: closeTrack,
                parents: [viewerStreams],
            };
            (viewerStreams as any).openedTracks.set(
                "synthetic-owned-track",
                ownedTrack
            );

            await expect(viewerStreams.close()).rejects.toBe(cleanupError);
            expect(
                (viewerStreams as any).openedTracks.get("synthetic-owned-track")
            ).to.eq(ownedTrack);

            await viewerStreams.close();
            expect(closeTrack.callCount).to.eq(2);
            expect(closeTrack.alwaysCalledWith(viewerStreams)).to.be.true;
            expect(
                (viewerStreams as any).openedTracks.has("synthetic-owned-track")
            ).to.be.false;
        });

        test("closing iterator with keep alive with prevent further replication when closing", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 0, size: 0 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let viewerTracks: Track<AudioStreamDB | WebcodecsStreamDB>[] = [];

            iterator = await viewerStreams.iterate("live", {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracks.push(...tracks);
                },
            });
            await waitForResolved(() => expect(viewerTracks).to.have.length(1));

            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 99999 * MILLISECONDS_TO_MICROSECONDS,
                    type: "key",
                })
            );

            await waitForResolved(() => expect(chunks).to.have.length(1));
            await waitForResolved(
                () => expect(viewerTracks[0].closed).to.be.false
            );
            await iterator.close();

            expect(viewerTracks[0].closed).to.be.false;

            // try inserting one more chunk and make sure it does not reach the viewer
            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: chunks[0].chunk.timeBN + 1n, // this does not matter since live feed is only looking at entry commit timestamps and not actual Chunk timestamp (TODO?)
                    type: "key",
                })
            );

            await delay(1500); // wait for some times for the chunks to propagate
            expect(chunks).to.have.length(1);
            expect(viewerTracks[0].source.chunks.log.log.length).to.eq(1);
        });

        test("closing iterator with keep alive with prevent further replication when non-live iterating", async () => {
            let preCreatedTrackTime = 5000;
            let dataPoints = 100;
            let start = 0;
            const { track1, viewerStreams } = await createScenario({
                delta: preCreatedTrackTime / dataPoints,
                first: { start, size: dataPoints },
            });

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let viewerTracksChanges: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            let startLiveFeedSubscription: bigint | undefined = undefined;
            const firstIterator = await viewerStreams.iterate("live", {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    startLiveFeedSubscription = hrtime.bigint();
                    viewerTracksChanges.push(tracks);
                },
            });

            await waitForResolved(() =>
                expect(viewerTracksChanges).to.have.length(1)
            );
            expect(viewerTracksChanges[0]).to.have.length(1);

            let lastChunkTime = BigInt(
                (start + preCreatedTrackTime + 999) * 1e3
            );
            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([1, 2, 3]),
                    time: lastChunkTime,
                })
            );

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.timeBN)).to.deep.eq([
                    lastChunkTime,
                ])
            );

            const callToEnd =
                viewerTracksChanges[0][0].source.endPreviousLivestreamSubscription.bind(
                    viewerTracksChanges[0][0].source
                );

            const segmentsFirst =
                await viewerTracksChanges[0][0].source.chunks.log.replicationIndex
                    .iterate({
                        query: {
                            hash: viewerStreams.node.identity.publicKey.hashcode(),
                        },
                    })
                    .all();

            expect(segmentsFirst).to.have.length(1);

            let endLiveFeedSubscription: bigint | undefined = undefined;
            viewerTracksChanges[0][0].source.endPreviousLivestreamSubscription =
                async () => {
                    endLiveFeedSubscription = hrtime.bigint();
                    const end = await callToEnd();
                    return end;
                };

            await firstIterator.close();
            expect(endLiveFeedSubscription).to.exist;

            const segments =
                await viewerTracksChanges[0][0].source.chunks.log.replicationIndex
                    .iterate({
                        query: {
                            hash: viewerStreams.node.identity.publicKey.hashcode(),
                        },
                    })
                    .all();
            expect(segments).to.have.length(1);

            // the replication segment should end at the last chunk that was played (from the live stream)
            expect(
                Number(segments[0].value.end2 - segments[0].value.start1)
            ).to.be.closeTo(
                Number(
                    (endLiveFeedSubscription! - startLiveFeedSubscription!) /
                        1000n
                ),
                1e9 // 1 second
            );

            let viewerTracksChangesAgain: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];
            let firstChunk = pDefer();
            const secondIterator = await viewerStreams.iterate(0, {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    firstChunk.resolve();
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracksChangesAgain.push(tracks);
                },
            });

            await firstChunk.promise;
            await waitForResolved(
                () => expect(viewerTracksChangesAgain).to.have.length(2),
                {
                    // Playback starts after its preload window, so a fixed
                    // media-duration sleep races slower CI schedulers.
                    timeout: Number(lastChunkTime) / 1e3 + 10_000,
                }
            );

            expect(viewerTracksChangesAgain[0]).to.have.length(1);
            expect(viewerTracksChangesAgain[1]).to.have.length(0); // all closed
            expect(secondIterator.current.size).to.eq(0);
            expect(viewerTracksChangesAgain[0][0].closed).to.be.false;
            expect(viewerTracksChangesAgain[0][0] === viewerTracksChanges[0][0])
                .to.be.true;

            await firstIterator.close();
            await secondIterator.close();
        });

        test("will reuse segment", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 0, size: 0 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let viewerTracks: Track<AudioStreamDB | WebcodecsStreamDB>[] = [];

            const firstIterator = await viewerStreams.iterate("live", {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracks.push(...tracks);
                },
            });

            await waitForResolved(() => expect(viewerTracks).to.have.length(1));

            const secondIterator = await viewerStreams.iterate("live", {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracks.push(...tracks);
                },
            });

            await waitForResolved(() => expect(viewerTracks).to.have.length(2));

            expect(viewerTracks[0] === viewerTracks[1]).to.be.true;
            const segments =
                await viewerTracks[0].source.chunks.log.replicationIndex
                    .iterate({
                        query: {
                            hash: viewerStreams.node.identity.publicKey.hashcode(),
                        },
                    })
                    .all();
            expect(segments).to.have.length(1);

            await firstIterator.close();
            await secondIterator.close();
        });

        test("will favor live track", async () => {
            let track1 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 44100 }),
                    start: 0,
                })
            );

            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );

            await mediaStreams.tracks.put(track1);

            const listener = await viewer.open(mediaStreams.clone());
            let track2: Track | undefined;
            cleanup = async () => {
                const results = await Promise.allSettled(
                    [listener, mediaStreams, track1, track2]
                        .filter((resource) => resource != null)
                        .map((resource) => resource!.close())
                );
                const failures = results
                    .filter(
                        (result): result is PromiseRejectedResult =>
                            result.status === "rejected"
                    )
                    .map((result) => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        "Failed to clean up live-track preference test"
                    );
                }
            };

            let receivedChunks: Chunk[] = [];
            let trackChanged: Track<AudioStreamDB | WebcodecsStreamDB>[][] = [];
            let trackOptionsChanged: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            iterator = await listener.iterate("live", {
                onTracksChange(tracks) {
                    trackChanged.push(tracks);
                },
                onTrackOptionsChange(tracks) {
                    trackOptionsChanged.push(tracks);
                },
                onProgress: (ev) => {
                    receivedChunks.push(ev.chunk);
                },
            });

            await waitForResolved(() => expect(trackChanged).to.have.length(1));

            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 1n,
                    type: "key",
                })
            );

            await waitForResolved(() =>
                expect(receivedChunks.map((x) => x.timeBN)).to.deep.eq([1n])
            );

            await waitForResolved(() =>
                expect(
                    trackOptionsChanged.map((x) => x.map((y) => y.id))
                ).to.deep.eq([[track1.id]])
            );

            track2 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 44100 }),
                    start: 0,
                })
            );
            await mediaStreams.tracks.put(track2);
            await delay(1e3);

            await mediaStreams.setEnd(track1, MAX_U32);

            await waitForResolved(() =>
                expect(trackChanged.map((x) => x.map((y) => y.id))).to.deep.eq([
                    [track1.id],
                    [],
                    [track2.id],
                ])
            );

            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 2n,
                    type: "key",
                })
            );

            await track2.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 3n,
                    type: "key",
                })
            );

            await waitForResolved(
                () =>
                    expect(receivedChunks.map((x) => x.timeBN)).to.deep.eq([
                        1n,
                        3n,
                    ]) // 2n should not exist here because track2 should superseed track1
            );
        });

        test("keep track until the end", async () => {
            let track1 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 44100 }),
                    start: 0,
                })
            );

            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );

            await mediaStreams.tracks.put(track1);

            const listener = await viewer.open(mediaStreams.clone());
            cleanup = async () => {
                const results = await Promise.allSettled(
                    [listener, mediaStreams, track1].map((resource) =>
                        resource.close()
                    )
                );
                const failures = results
                    .filter(
                        (result): result is PromiseRejectedResult =>
                            result.status === "rejected"
                    )
                    .map((result) => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        "Failed to clean up live-track completion test"
                    );
                }
            };

            let receivedChunks: Chunk[] = [];
            let trackChanged: Track<AudioStreamDB | WebcodecsStreamDB>[][] = [];
            let trackOptionsChanged: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            iterator = await listener.iterate("live", {
                onTracksChange(tracks) {
                    trackChanged.push(tracks);
                },
                onTrackOptionsChange(tracks) {
                    trackOptionsChanged.push(tracks);
                },
                onProgress: (ev) => {
                    receivedChunks.push(ev.chunk);
                },
            });

            await waitForResolved(() => expect(trackChanged).to.have.length(1));

            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 1n,
                    type: "key",
                })
            );
            await waitForResolved(() =>
                expect(receivedChunks).to.have.length(1)
            );
            await mediaStreams.setEnd(track1, MAX_U32);

            await delay(1e3);

            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([0]),
                    time: 2n,
                    type: "key",
                })
            );
            await waitForResolved(() =>
                expect(receivedChunks).to.have.length(2)
            );
        });
    });

    describe("progress", () => {
        describe("one track", () => {
            test("one chunk", async () => {
                // test we get 1 chunk and test that we close the track after the chunk is received
                let framesPerTrack = 1;

                const { viewerStreams } = await createScenario({
                    first: { start: 0, size: framesPerTrack },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let maxTime: number = 0;

                let onReplicationChanges: ReplicationRangeIndexable<"u64">[][] =
                    [];

                let t0 = +new Date();
                let t1: number | undefined = undefined;
                iterator = await viewerStreams.iterate(0, {
                    preload: 0,
                    onProgress: (ev) => {
                        t1 = +new Date();
                        chunks.push(ev);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                    onTracksChange(tracks) {
                        if (tracks.length === 0 && chunks.length === 0) {
                            throw new Error(
                                "Expected track to close after chunk was received"
                            );
                        }
                    },
                    onReplicationChange: async ({ track }) => {
                        onReplicationChanges.push(
                            await track.source.chunks.log.getAllReplicationSegments()
                        );
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(framesPerTrack)
                );
                await waitForResolved(() =>
                    expect(maxTime).to.eq(chunks[chunks.length - 1].chunk.time)
                );

                expect(
                    onReplicationChanges.map((x) =>
                        x
                            .map(
                                (y) =>
                                    y.hash ===
                                    viewerStreams.node.identity.publicKey.hashcode()
                            )
                            .sort((left, right) => Number(left) - Number(right))
                    )
                ).to.deep.eq([[false], [false, true]]);

                // make sure first chunk was fetched decently fast
                expect(t1! - t0).to.be.lessThan(2e3);
            });

            test("start at middle", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 1000,
                        first: {
                            start: 0,
                            size: framesPerTrack,
                            end: 1000,
                            type: "video",
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0.45;
                let maxTime = 0;
                iterator = await viewerStreams.iterate(progress, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    changeProcessor: (change) => change, // allow concurrent tracks
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                });
                const expecteChunkCount = 1;
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );

                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );
            });

            test("start before first chunk", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 1000,
                        first: {
                            start: 10,
                            size: framesPerTrack,
                            end: 1010,
                            type: "video",
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0;
                let maxTime = 0;
                iterator = await viewerStreams.iterate(progress, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    changeProcessor: (change) => change, // allow concurrent tracks
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                });
                const expecteChunkCount = framesPerTrack;
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );
            });

            test("current time pauses when lagging", async () => {
                const { viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        size: 2,
                    },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                let bufferPausePromise = pDefer();
                let once = false;
                let gotTrackPromise = pDefer();
                let underflowCalled = false;
                const iterateStub = interceptTrackSourceIterator(
                    (trackIterator) => {
                        const next = trackIterator.next.bind(trackIterator);
                        trackIterator.next = async (args: number) => {
                            once && (await bufferPausePromise.promise);
                            once = true;
                            return next(args);
                        };
                    }
                );

                try {
                    iterator = await viewerStreams.iterate(0, {
                        bufferSize: 1,
                        onTracksChange(tracks) {
                            tracks[0] && gotTrackPromise.resolve();
                        },
                        onProgress: (ev) => {
                            chunks.push(ev);
                        },
                        onUnderflow: () => {
                            if (chunks.length > 0) {
                                underflowCalled = true;
                            }
                        },
                    });

                    await gotTrackPromise.promise;
                    await waitForResolved(
                        () => expect(chunks.length).to.eq(1),
                        {
                            timeout: 15_000,
                        }
                    );
                    await waitForResolved(
                        () => expect(underflowCalled).to.be.true
                    );

                    let time = iterator.time();
                    for (let i = 0; i < 10; i++) {
                        await delay(1e2);
                        expect(iterator.time()).to.eq(time); // should pause since we are stuck
                    }
                    bufferPausePromise.resolve(); // release the lock
                    await waitForResolved(() => expect(chunks.length).to.eq(2));
                    expect(iterator.time()).to.be.greaterThan(time as number);
                } finally {
                    bufferPausePromise.resolve();
                    iterateStub.restore();
                }
            });

            test("current time is accurate after pause resume when lagging", async () => {
                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 1,
                        first: {
                            start: 0,
                            size: 2,
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                let bufferPausePromise = pDefer();
                let once = false;
                let gotTrackPromise = pDefer();
                const iterateStub = interceptTrackSourceIterator(
                    (trackIterator) => {
                        const next = trackIterator.next.bind(trackIterator);
                        trackIterator.next = async (args: number) => {
                            once && (await bufferPausePromise.promise);
                            once = true;
                            return next(args);
                        };
                    }
                );

                try {
                    iterator = await viewerStreams.iterate(0, {
                        bufferSize: 1,
                        onTracksChange(tracks) {
                            tracks[0] && gotTrackPromise.resolve();
                        },
                        onProgress: (ev) => {
                            chunks.push(ev);
                        },
                    });

                    await gotTrackPromise.promise;
                    await waitForResolved(
                        () => expect(chunks.length).to.eq(1),
                        {
                            timeout: 15_000,
                        }
                    );
                    let time = iterator.time();
                    await delay(1e3);
                    bufferPausePromise.resolve(); // release the lock
                    await waitForResolved(() => expect(chunks.length).to.eq(2));
                    let timeAfterBuffer = iterator.time();
                    expect(timeAfterBuffer as number).to.be.greaterThan(
                        time as number
                    );
                    const delta =
                        (timeAfterBuffer as number) - (time as number);
                    expect(delta).to.lessThan(100 * 1e3); // while 1s has passed, the time between two frames is less
                    await iterator.pause();
                    await iterator.play();
                    let timeAfterPlay = iterator.time();
                    //   expect(timeAfterPlay).to.eq(timeAfterBuffer) // because no new frames has come, even if 1s has passed
                    await delay(1e3);
                    let timeAfterPlayDelay = iterator.time();
                    // expect(timeAfterPlayDelay).to.eq(timeAfterBuffer) // because no new frames has come, even if 1s has passed
                    expect(timeAfterPlayDelay).to.eq(timeAfterPlay);
                } finally {
                    bufferPausePromise.resolve();
                    iterateStub.restore();
                }
            });

            test("time will progress on track with no chunks", async () => {
                const { viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        end: 10000,
                        size: 0,
                    },
                });
                let waitForTrack = pDefer();
                iterator = await viewerStreams.iterate(0, {
                    preload: 0, // we want to progress time as soon we get a track
                    bufferSize: 1,
                    onTracksChange: (tracks) => {
                        if (tracks[0]) {
                            waitForTrack.resolve();
                        }
                    },
                });
                let time = iterator.time();
                await waitForTrack.promise;
                let timeWhenReceivedTrack = iterator.time();
                expect(timeWhenReceivedTrack).to.eq(time);

                await delay(1e3);
                let timeAgain = iterator.time();
                expect(timeAgain).to.be.greaterThan(time as number);
            });

            test("time will not  progress on track while waiting for chunks", async () => {
                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        end: 10000,
                        size: 0,
                    },
                });
                await track1.put(
                    new Chunk({
                        chunk: new Uint8Array([123]),
                        time: 1e3,
                        type: "key",
                    })
                );

                let waitForChunk = pDefer();
                let gotTrackPromise = pDefer();

                let bufferSize = 2;
                iterator = await viewerStreams.iterate(0, {
                    bufferSize,
                    onTracksChange: (tracks) => {
                        if (tracks[0]) {
                            const iterate =
                                tracks[0].source.chunks.index.iterate.bind(
                                    tracks[0].source.chunks.index
                                );
                            tracks[0].source.chunks.index.iterate = (q, o) => {
                                const iterator = iterate(q, o);
                                const next = iterator.next.bind(iterator);
                                iterator.next = async (args) => {
                                    if (args === bufferSize) {
                                        // only pause iterations related to the buffer loop
                                        await waitForChunk.promise;
                                    }

                                    return next(args);
                                };
                                return iterator;
                            };
                            gotTrackPromise.resolve();
                        }
                    },
                });
                let time = iterator.time();
                await gotTrackPromise.promise;
                let timeWhenReceivedTrack = iterator.time();
                expect(timeWhenReceivedTrack).to.eq(time);

                await delay(1e3);
                let timeAgain = iterator.time();
                expect(timeAgain).to.be.eq(time as number);
                waitForChunk.resolve();
                await delay(6e3);
                expect(iterator.time()).to.be.greaterThan(timeAgain as number);
            });

            test("will emit underflow once buffer runs out", async () => {
                let delta = 1e2;
                const { viewerStreams } = await createScenario({
                    delta,
                    first: {
                        start: 0,
                        size: 10,
                    },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                let bufferPausePromise = pDefer();
                let gotTrackPromise = pDefer();
                let freezeAtChunk = 6;
                let underFlowCalled: number[] = [];
                let bufferSize = 2;
                let c = 0;
                iterator = await viewerStreams.iterate(0, {
                    bufferSize,
                    preload: 0,
                    onTracksChange(tracks) {
                        if (tracks[0]) {
                            const iterate =
                                tracks[0].source.chunks.index.iterate.bind(
                                    tracks[0].source.chunks.index
                                );
                            tracks[0].source.chunks.index.iterate = (q, o) => {
                                const iterator = iterate(q, o);
                                const next = iterator.next.bind(iterator);
                                iterator.next = async (args) => {
                                    if (args === bufferSize) {
                                        // only pause iterations related to the buffer loop
                                        if (c * bufferSize === freezeAtChunk) {
                                            await bufferPausePromise.promise;
                                        }
                                        c++;
                                    }

                                    return next(args);
                                };
                                return iterator;
                            };
                            gotTrackPromise.resolve();
                        }
                    },
                    onProgress: (ev) => {
                        console.log("onProgress", ev.chunk.time);
                        chunks.push(ev);
                    },

                    onUnderflow: () => {
                        underFlowCalled.push(iterator.time() as number);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(freezeAtChunk - bufferSize)
                );

                await waitForResolved(() =>
                    expect(underFlowCalled).to.have.length(1)
                );
                // The blocked read begins after freezeAtChunk frames have been
                // buffered. Underflow must wait until that buffered tail has
                // played, so its media time is the last delivered frame.
                expect(chunks).to.have.length(freezeAtChunk);
                expect(underFlowCalled[0]).to.be.closeTo(
                    (freezeAtChunk - 1) * delta * 1e3,
                    1e5
                );
            });

            test("replication segment will grow as buffering continues", async () => {
                let size = 200;
                let delta = 10;
                const {
                    viewerStreams,
                } = // 2 seconds worth of video
                    await createScenario({
                        delta,
                        first: {
                            start: 0,
                            size,
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let ranges: ReplicationRangeIndexable<"u64">[] = [];
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onReplicationChange: async ({ track, hash }) => {
                        if (
                            viewerStreams.node.identity.publicKey.hashcode() ===
                            hash
                        ) {
                            ranges.push(
                                ...(await track.source.chunks.log.getMyReplicationSegments())
                            );
                        }
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(size)
                );
                let end2 = -1;
                for (let i = 0; i < ranges.length; i++) {
                    expect(Number(ranges[i].end2)).to.be.greaterThan(end2);
                    end2 = Number(ranges[i].end2);
                }
            });

            test("keeps one merged segment when restarting at the same time", async () => {
                let size = 200;
                let delta = 10;
                const {
                    viewerStreams,
                } = // 2 seconds worth of video
                    await createScenario({
                        delta,
                        first: {
                            start: 0,
                            size,
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track[][] = [];

                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    keepTracksOpen: true,
                    onTracksChange: (current) => {
                        tracks.push(current);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(size)
                );
                await waitForResolved(async () =>
                    expect(
                        await tracks[0]?.[0]?.source.chunks.log.getMyReplicationSegments()
                    ).to.have.length(1)
                );
                const firstSegment = (
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments()
                )[0];
                const firstRange = {
                    idString: firstSegment.idString,
                    hash: firstSegment.hash,
                    start1: firstSegment.start1,
                    end1: firstSegment.end1,
                    start2: firstSegment.start2,
                    end2: firstSegment.end2,
                    width: firstSegment.width,
                };
                await iterator.close();

                chunks = [];
                tracks = [];
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    keepTracksOpen: true,
                    onTracksChange: (current) => {
                        tracks.push(current);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(size)
                );
                await waitForResolved(async () =>
                    expect(
                        await tracks[0]?.[0]?.source.chunks.log.getMyReplicationSegments()
                    ).to.have.length(1)
                );
                const restartedSegments =
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments();
                expect({
                    idString: restartedSegments[0].idString,
                    hash: restartedSegments[0].hash,
                    start1: restartedSegments[0].start1,
                    end1: restartedSegments[0].end1,
                    start2: restartedSegments[0].start2,
                    end2: restartedSegments[0].end2,
                    width: restartedSegments[0].width,
                }).to.deep.equal(firstRange);
                expect(firstRange.hash).to.eq(
                    viewerStreams.node.identity.publicKey.hashcode()
                );
            });

            test("will subscribe to max time while iterating", async () => {
                let size = 1e3;
                let delta = 10;
                let start = 123;
                const {
                    viewerStreams,
                } = // 2 seconds worth of video
                    await createScenario({
                        delta,
                        first: {
                            start,
                            size,
                        },
                    });
                let maxTime = (size - 1) * delta + start;

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                console.log(
                    "Viewer id: ",
                    viewerStreams.node.identity.publicKey.hashcode()
                );
                const bufferPausePromise = pDefer();
                let c = 0;
                let freezeAtChunk = 2;
                let maxTimes: number[] = [];
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    onTracksChange(tracks) {
                        if (tracks[0]) {
                            const iterate =
                                tracks[0].source.chunks.index.iterate.bind(
                                    tracks[0].source.chunks.index
                                );
                            tracks[0].source.chunks.index.iterate = (q, o) => {
                                const iterator = iterate(q, o);
                                const next = iterator.next.bind(iterator);
                                iterator.next = async (args) => {
                                    if (c === freezeAtChunk) {
                                        await bufferPausePromise.promise;
                                    }
                                    c++;
                                    return next(args);
                                };
                                return iterator;
                            };
                        }
                    },
                    onMaxTimeChange(properties) {
                        maxTimes.push(properties.maxTime);
                    },
                });

                await waitForResolved(() =>
                    expect(maxTimes[maxTimes.length - 1]).to.eq(maxTime * 1e3)
                );

                bufferPausePromise.resolve();
            });

            test("will not close track until buffer is empty", async () => {
                // test we get 1 chunk and test that we close the track after the chunk is received
                let framesPerTrack = 11;

                const { viewerStreams } = await createScenario({
                    first: { start: 0, size: framesPerTrack },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let maxTime: number = 0;

                const endTracksPromise = pDefer();
                const endTracksOptionPromise = pDefer();
                iterator = await viewerStreams.iterate(0, {
                    bufferSize: 10,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                    onTracksChange(tracks) {
                        if (
                            tracks.length === 0 &&
                            chunks.length !== framesPerTrack
                        ) {
                            endTracksPromise.reject(
                                new Error(
                                    "Expected track to close after chunks was received"
                                )
                            );
                        } else if (tracks.length === 0) {
                            endTracksPromise.resolve();
                        }
                    },
                    onTrackOptionsChange: (tracks) => {
                        if (
                            tracks.length === 0 &&
                            chunks.length !== framesPerTrack
                        ) {
                            endTracksOptionPromise.reject(
                                new Error(
                                    "Expected track to close after chunks was received"
                                )
                            );
                        } else if (tracks.length === 0) {
                            endTracksOptionPromise.resolve();
                        }
                    },
                });

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(framesPerTrack)
                    );
                } catch (error) {
                    throw error;
                }

                let timeout = setTimeout(() => {
                    endTracksOptionPromise.reject(
                        new Error(
                            "Timed out waiting for track options to empty"
                        )
                    );
                    endTracksPromise.reject(
                        new Error("Timed out waiting for tracks to empty")
                    );
                }, 5e3);
                await endTracksOptionPromise.promise;
                await endTracksPromise.promise;
                clearTimeout(timeout);
            });
        });

        describe("overlapping", () => {
            test("will deduplicate by type", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario({
                        first: { start: 0, size: framesPerTrack },
                        second: { start: 0, size: framesPerTrack },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(framesPerTrack)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(framesPerTrack)
                );
            });

            test("will not go back intime for same source", async () => {
                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario({
                        delta: 1000,
                        first: { start: 0, size: 0, end: 1000, type: "video" },
                        second: {
                            start: 333,
                            size: 100,
                            end: 666,
                            type: "video",
                        },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0.22;
                iterator = await viewerStreams.iterate(progress, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await delay(2000); // some delay to make sure some data is played

                // expect no chunks to be received because first track started before the second track
                // and the first track ended after the second track started
                expect(chunks.length).to.eq(0);
            });

            test("overlapping partly multiple media types", async () => {
                let framesPerTrack = 2;

                const { viewerStreams } = await createScenario({
                    delta: 1000,
                    first: {
                        start: 0,
                        size: framesPerTrack,
                        end: 1000,
                        type: "video",
                    },
                    second: {
                        start: 500,
                        size: framesPerTrack,
                        end: 1500,
                        type: "audio",
                    },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0.22;
                iterator = await viewerStreams.iterate(progress, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                const expecteChunkCount = Math.round(
                    0.75 * (framesPerTrack * 2)
                );
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
            });

            test("overlapping partly same media types", async () => {
                let framesPerTrack = 2;

                const { viewerStreams } = await createScenario({
                    delta: 1000,
                    first: {
                        start: 0,
                        size: framesPerTrack,
                        end: 1000,
                        type: "audio",
                    },
                    second: {
                        start: 500,
                        size: framesPerTrack,
                        end: 1500,
                        type: "audio",
                    },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0;
                iterator = await viewerStreams.iterate(progress, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                const expecteChunkCount = 3;
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(expecteChunkCount)
                );
            });

            test("will not buffer overlapping until necessary", async () => {
                let delta = 500;
                let preload = 500;
                let firstTrackEndTime = 2000;
                let end = 3500;
                const { viewerStreams, track2 } = await createScenario({
                    delta: delta,
                    first: {
                        start: 0,
                        size: Math.round((firstTrackEndTime - 0) / delta),
                        end: firstTrackEndTime,
                        type: "audio",
                    },
                    second: {
                        start: 500,
                        end,
                        size: Math.round(end - 500) / delta,
                        type: "audio",
                    },
                });
                let chunks: Map<number, { track: Track<any>; chunk: Chunk }[]> =
                    new Map();

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0;
                let bufferSize = 3;
                let firstChunkPromise = pDefer();

                iterator = await viewerStreams.iterate(progress, {
                    preload,
                    bufferSize,
                    onProgress: (ev) => {
                        firstChunkPromise.resolve();
                        let timeKey = ev.track.startTime + ev.chunk.time;
                        let arr = chunks.get(timeKey) || [];
                        arr.push(ev);
                        chunks.set(timeKey, arr);
                    },
                    onTracksChange: (tracks) => {
                        for (const track of tracks) {
                            if (track.address === track2.address) {
                                const iterate =
                                    track.source.chunks.index.iterate.bind(
                                        track.source.chunks.index
                                    );
                                track.source.chunks.index.iterate = (q, o) => {
                                    const iterator = iterate(q, o);
                                    const next = iterator.next.bind(iterator);
                                    iterator.next = async (args) => {
                                        if (args === bufferSize) {
                                            let chunks: WithIndexedContext<
                                                Chunk,
                                                ChunkIndexable
                                            >[] = await next(args);
                                            for (const chunk of chunks) {
                                                let time =
                                                    track.startTime +
                                                    chunk.time;
                                                console.log(time);
                                                if (
                                                    time <
                                                    firstTrackEndTime * 1e3
                                                ) {
                                                    throw new Error(
                                                        "Should not buffer chunks that are not necessary"
                                                    );
                                                }
                                            }
                                            return chunks;
                                        }
                                        return next(args);
                                    };
                                    return iterator;
                                };
                            }
                        }
                    },
                });
                await firstChunkPromise.promise;
                await waitForResolved(() =>
                    expect(chunks.size).to.eq(Math.round(end / delta))
                );
                for (let i = 0; i < end - delta; i += delta) {
                    let microSeconds = i * 1e3;
                    if (i === 1500) {
                        expect(chunks.get(microSeconds)!.length).to.be.oneOf([
                            1, 2,
                        ]); // not defined behaviour yet TODO
                    } else {
                        expect(chunks.get(microSeconds)).to.have.length(1);
                    }
                }
            });

            test("time will not progress until preload", async () => {
                const { track1, track2, viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        end: 10000,
                        size: 0,
                        type: "audio",
                    },
                    second: {
                        start: 0,
                        end: 10000,
                        size: 0,
                        type: "video",
                    },
                });
                await track1.put(
                    new Chunk({
                        chunk: new Uint8Array([123]),
                        time: 1e3,
                        type: "key",
                    })
                );
                await track2.put(
                    new Chunk({
                        chunk: new Uint8Array([234]),
                        time: 1e3,
                        type: "key",
                    })
                );

                let waitForChunk = pDefer();

                let bufferSize = 2;
                let trackCount = 0;
                let visitedTracks: Set<string> = new Set();
                let preload = 5e3; // 5s

                iterator = await viewerStreams.iterate(0, {
                    bufferSize,
                    preload,
                    onTracksChange: (tracks) => {
                        console.log(tracks.map((x) => x.toString()));
                        for (const track of tracks) {
                            if (visitedTracks.has(track.address)) {
                                continue;
                            }

                            visitedTracks.add(track.address);

                            if (track.source.mediaType === "video") {
                                // make video laggy
                                const iterate =
                                    track.source.chunks.index.iterate.bind(
                                        track.source.chunks.index
                                    );
                                track.source.chunks.index.iterate = (q, o) => {
                                    const iterator = iterate(q, o);
                                    const next = iterator.next.bind(iterator);
                                    iterator.next = async (args) => {
                                        if (args === bufferSize) {
                                            // only pause iterations related to the buffer loop
                                            await waitForChunk.promise;
                                        }

                                        return next(args);
                                    };
                                    return iterator;
                                };
                            }

                            trackCount++;
                        }
                    },
                });
                let timeStart = iterator.time();
                let timeBeforeChunksArrive: number | undefined = undefined;
                setTimeout(() => {
                    timeBeforeChunksArrive = iterator.time() as number;
                    waitForChunk.resolve();
                }, preload - 2e3); // start to resolve chunks for both tracks before preload finishesh
                await waitForChunk.promise;
                expect(timeStart).to.eq(timeBeforeChunksArrive);
                const timeAfterChunksArrive = iterator.time();
                await delay(5e3);
                let timeAgain = iterator.time();
                expect(timeAgain).to.be.greaterThan(
                    timeAfterChunksArrive as number
                );
            });

            test("can select a different track of same source type", async () => {
                let chunkCountPerTrack = 10;

                const { viewerStreams, track1, track2 } = await createScenario({
                    delta: 1e3,
                    first: {
                        start: 0,
                        size: chunkCountPerTrack,
                        type: new AudioStreamDB({ sampleRate: 1 }),
                    },
                    second: {
                        start: 0,
                        size: chunkCountPerTrack,
                        type: new AudioStreamDB({ sampleRate: 2 }),
                    },
                });

                let trackOptions: Map<string, Track<any>> = new Map();
                let selectedTracks: Track<any>[][] = [];
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                let selected: Track | undefined = undefined;
                let unselected: Track | undefined = undefined;
                let selectedUnselected = pDefer();
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onTrackOptionsChange: (tracks) => {
                        tracks.forEach((track) => {
                            trackOptions.set(track.idString, track);
                        });
                    },
                    onTracksChange: (tracks) => {
                        selectedTracks.push(tracks);

                        if (unselected) {
                            try {
                                expect(selectedTracks.length).to.be.greaterThan(
                                    1
                                );
                                expect(
                                    selectedTracks[selectedTracks.length - 1]
                                ).to.have.length(1);
                                expect(
                                    selectedTracks[selectedTracks.length - 1][0]
                                        .idString
                                ).to.eq(unselected.idString);
                                selectedUnselected.resolve();
                            } catch (error) {
                                // ignore
                            }
                        }
                    },
                });
                await waitForResolved(() => expect(trackOptions.size).to.eq(2));
                await waitForResolved(() => {
                    expect(selectedTracks).to.have.length(1);
                    expect(selectedTracks[0]).to.have.length(1);
                    expect(selectedTracks[0][0].idString).to.be.oneOf([
                        track1.idString,
                        track2.idString,
                    ]);
                });

                selected =
                    selectedTracks[0][0].idString === track1.idString
                        ? trackOptions.get(track1.idString)!
                        : trackOptions.get(track2.idString)!;
                unselected =
                    selectedTracks[0][0].idString === track1.idString
                        ? trackOptions.get(track2.idString)!
                        : trackOptions.get(track1.idString)!;

                // select the unselected track
                await delay(3e3); // wait  for some time to consume some chunks from the first track
                await iterator.selectOption(unselected);

                await selectedUnselected.promise;

                await waitForResolved(() =>
                    expect(chunks).to.have.length(chunkCountPerTrack)
                );
                expect(chunks[0].track.idString).to.eq(selected.idString); // starts from the first track
                expect(chunks[chunks.length - 1].track.idString).to.eq(
                    unselected.idString
                ); // ends on the second track
            });
        });

        describe("sequential", () => {
            test("start at 0", async () => {
                let trackCount = 2;
                let delta = 500;
                let totalTime = trackCount * 2 * delta;
                const { viewerStreams, track1, track2 } = await createScenario({
                    delta,
                    first: { start: 0, size: trackCount, end: 999 },
                    second: { start: 1000, size: trackCount },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track<any>[][] = [];

                // start playing from track1 and then assume we will start playing from track2
                let maxTime = 0;
                let trackOptionsPerChunk: Track[][] = [];
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        trackOptionsPerChunk[chunks.length] =
                            iterator.options();
                        chunks.push(ev);
                    },
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.be.greaterThan(0)
                );
                await delay(totalTime);

                // assert the track options are correct for each time
                expect(
                    trackOptionsPerChunk.map((x) => x.map((y) => y.idString))
                ).to.deep.eq([
                    [track1.idString],
                    [track1.idString],
                    [track2.idString],
                    [track2.idString],
                ]);

                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );
            });

            test("0.3", async () => {
                let framesPerTrack = 100;

                const { viewerStreams } = await createScenario({
                    first: {
                        start: 0,
                        end: framesPerTrack,
                        size: framesPerTrack,
                    },
                    second: { start: framesPerTrack, size: framesPerTrack },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0.3;

                iterator = await viewerStreams.iterate(progress, {
                    //  bufferSize: 1, TODO make sure this test also works for smaller buffer sizes
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                const expectedChunkCount = Math.round(
                    (1 - progress) * (framesPerTrack * 2)
                );
                await waitForResolved(() =>
                    expect(
                        Math.abs(chunks.length - expectedChunkCount)
                    ).to.be.lessThanOrEqual(1)
                );
            });

            test("0.3 long", async () => {
                let framesPerTrack = 100;

                const { viewerStreams } = await createScenario({
                    delta: 1e3, // 1 second
                    first: {
                        start: 0,
                        end: framesPerTrack,
                        size: framesPerTrack,
                    },
                    second: { start: framesPerTrack, size: framesPerTrack },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const progress = 0.3;

                iterator = await viewerStreams.iterate(progress, {
                    bufferSize: 1,
                    bufferTime: 1,
                    onProgress: (ev) => {
                        chunks.push(ev);
                        if (chunks.length === 2) {
                            return iterator.close();
                        }
                    },
                });
                const expectedChunkCount = 2;
                await waitForResolved(() =>
                    expect(chunks).to.have.length(expectedChunkCount)
                );
            });

            test("many chunks single track", async () => {
                const size = 1e3;

                const { viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, size },
                });
                const chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const start = 0.23;
                console.log("start iterate");
                iterator = await viewerStreams.iterate(start, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                const expectedChunkCount = Math.round(size * (1 - start));
                await waitForResolved(
                    () =>
                        expect(
                            Math.abs(chunks.length - expectedChunkCount)
                        ).to.be.lessThanOrEqual(size * 0.02),
                    { timeout: 30_000 }
                );
                // assert that the timestamps are correct
                let delta = chunks[1].chunk.time - chunks[0].chunk.time;
                for (let i = 1; i < chunks.length; i++) {
                    expect(
                        chunks[i].chunk.time - chunks[i - 1].chunk.time
                    ).to.be.eq(delta);
                }
            });

            test("many chunks concurrently", async () => {
                let size = 100;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario({
                        delta: 1,
                        first: { start: 0, size, type: "video" },
                        second: { start: 0, size, type: "audio" },
                    });
                let chunks: Map<string, Chunk[]> = new Map();
                chunks.set(track1.address, []);
                chunks.set(track2.address, []);

                // start playing from track1 and then assume we will start playing from track2
                const start = 0;
                let c = 0;
                console.log("start iterate");
                iterator = await viewerStreams.iterate(start, {
                    onProgress: (ev) => {
                        console.log(c++);
                        chunks.get(ev.track.address)!.push(ev.chunk);
                    },
                });

                try {
                    await waitForResolved(() => {
                        expect(chunks.get(track1.address)!.length).to.eq(size);
                        expect(chunks.get(track2.address)!.length).to.eq(size);
                    });
                } catch (error) {
                    throw error;
                }

                // assert that the timestamps are correct
                let delta =
                    chunks.get(track1.address)![1].time -
                    chunks.get(track1.address)![0].time;
                for (let i = 1; i < size; i++) {
                    expect(
                        chunks.get(track1.address)![i].time -
                            chunks.get(track1.address)![i - 1].time
                    ).to.be.eq(delta);
                    expect(
                        chunks.get(track2.address)![i].time -
                            chunks.get(track2.address)![i - 1].time
                    ).to.be.eq(delta);
                }
            });

            test("buffers evenly", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone());

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                    })
                );

                await mediaStreams.tracks.put(track1, {
                    target: "replicators",
                });
                //  console.log(viewerStreams.node.identity.publicKey.hashcode(), await viewerStreams.tracks.log.getCover(undefined as any, undefined))
                // console.log(await viewerStreams.tracks.index.search(new SearchRequest()));
                //  await delay(3000)
                // console.log(viewerStreams.node.identity.publicKey.hashcode(), await viewerStreams.tracks.log.getCover(undefined as any, undefined))

                // console.log(await viewerStreams.tracks.index.search(new SearchRequest()));

                const frameIntervalMs = 10;
                const frames = 300;

                for (let i = 0; i < frames; i++) {
                    await track1.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time:
                                i *
                                frameIntervalMs *
                                MILLISECONDS_TO_MICROSECONDS,
                            type: "key",
                        })
                    );
                }

                const t0 = performance.now();
                let lastTs: number | undefined;
                const diffs: number[] = [];
                const firstChunkPromise = pDefer<void>();
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 1e3,
                    preload: 1e3,
                    onProgress: (ev) => {
                        firstChunkPromise.resolve();
                        const now = performance.now();
                        if (lastTs) {
                            diffs.push(now - lastTs);
                        }
                        lastTs = now;
                        chunks.push(ev);
                    },
                });

                await firstChunkPromise.promise;
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(frames)
                );
                const elapsedMs = performance.now() - t0;
                const mediaDurationMs = (frames - 1) * frameIntervalMs;
                expect(elapsedMs).to.be.greaterThanOrEqual(mediaDurationMs);

                const meanDiff =
                    diffs.reduce((a, b) => a + b, 0) / diffs.length;
                // Ten-millisecond frames stay above timer quantization while
                // retaining a three-second pacing window. The tolerance catches
                // burst delivery without assuming a dedicated real-time runner.
                expect(meanDiff).to.be.closeTo(
                    frameIntervalMs,
                    frameIntervalMs * 0.25
                );
            });

            test("pause", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone());

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                    })
                );

                await mediaStreams.tracks.put(track1, {
                    target: "replicators",
                });

                let frames = 1000;

                for (let i = 0; i < frames; i++) {
                    track1.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time: i * MILLISECONDS_TO_MICROSECONDS,
                            type: "key",
                        })
                    );
                }
                iterator = await viewerStreams.iterate(0, {
                    onProgress: async (ev) => {
                        chunks.push(ev);
                        if (chunks.length === frames / 2) {
                            await iterator.pause(); // pause after half of the frames
                        }
                    },
                });

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(frames / 2)
                    );
                } catch (error) {
                    throw error;
                }

                await iterator.play();

                await waitForResolved(() =>
                    expect(chunks.length).to.be.at.least(frames)
                );
                expect(chunks.length).to.eq(frames);
                chunks.forEach(({ chunk }, index) => {
                    expect(chunk.time, `frame ${index}`).to.eq(
                        index * MILLISECONDS_TO_MICROSECONDS
                    );
                });
            });

            test("retries an uncommitted async frame after pause and play", async () => {
                const { viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        size: 3,
                        type: "video",
                    },
                });

                const delivered: number[] = [];
                const attempts: number[] = [];
                const blockedAttemptStarted = pDefer<void>();
                const releaseBlockedAttempt = pDefer<void>();
                let rejectBlockedAttempt = true;
                let trackAdmissions = 0;
                iterator = await viewerStreams.iterate(0, {
                    preload: 0,
                    onTracksChange: (tracks) => {
                        if (tracks.length > 0) {
                            trackAdmissions++;
                        }
                    },
                    onProgress: async ({ chunk }) => {
                        attempts.push(chunk.time);
                        if (
                            chunk.time === MILLISECONDS_TO_MICROSECONDS &&
                            rejectBlockedAttempt
                        ) {
                            rejectBlockedAttempt = false;
                            blockedAttemptStarted.resolve();
                            await releaseBlockedAttempt.promise;
                            throw new Error(
                                "synthetic interrupted frame delivery"
                            );
                        }
                        delivered.push(chunk.time);
                    },
                });

                try {
                    await blockedAttemptStarted.promise;
                    await iterator.pause();
                    await iterator.play();
                    expect(trackAdmissions).to.be.greaterThanOrEqual(2);
                    await delay(100);
                    expect(delivered).to.deep.eq([0]);
                    expect(
                        attempts.filter(
                            (time) => time === MILLISECONDS_TO_MICROSECONDS
                        )
                    ).to.have.length(1);
                    releaseBlockedAttempt.resolve();

                    await waitForResolved(() =>
                        expect(delivered).to.deep.eq([
                            0,
                            MILLISECONDS_TO_MICROSECONDS,
                            2 * MILLISECONDS_TO_MICROSECONDS,
                        ])
                    );
                    expect(
                        attempts.filter(
                            (time) => time === MILLISECONDS_TO_MICROSECONDS
                        )
                    ).to.have.length(2);
                } finally {
                    releaseBlockedAttempt.resolve();
                }
            });

            test("pauses after an active progress callback fails and retries on play", async () => {
                const { viewerStreams } = await createScenario({
                    delta: 1,
                    first: {
                        start: 0,
                        size: 3,
                        type: "video",
                    },
                });
                const delivered: number[] = [];
                const attempts: number[] = [];
                let rejectFrame = true;
                const errorLog = sinon.stub(console, "error");

                try {
                    iterator = await viewerStreams.iterate(0, {
                        preload: 0,
                        onProgress: async ({ chunk }) => {
                            attempts.push(chunk.time);
                            if (
                                chunk.time === MILLISECONDS_TO_MICROSECONDS &&
                                rejectFrame
                            ) {
                                rejectFrame = false;
                                await delay(100);
                                throw new Error(
                                    "synthetic active frame delivery failure"
                                );
                            }
                            delivered.push(chunk.time);
                        },
                    });

                    await waitForResolved(
                        () => expect(iterator.paused).to.be.true
                    );
                    expect(attempts).to.deep.eq([
                        0,
                        MILLISECONDS_TO_MICROSECONDS,
                    ]);
                    expect(delivered).to.deep.eq([0]);
                    await delay(100);
                    expect(attempts).to.deep.eq([
                        0,
                        MILLISECONDS_TO_MICROSECONDS,
                    ]);

                    await iterator.play();
                    await waitForResolved(() =>
                        expect(delivered).to.deep.eq([
                            0,
                            MILLISECONDS_TO_MICROSECONDS,
                            2 * MILLISECONDS_TO_MICROSECONDS,
                        ])
                    );
                    expect(
                        attempts.filter(
                            (time) => time === MILLISECONDS_TO_MICROSECONDS
                        )
                    ).to.have.length(2);
                    expect(
                        errorLog.calledWithMatch(
                            "Media progress callback failed; playback paused"
                        )
                    ).to.be.true;
                } finally {
                    errorLog.restore();
                }
            });

            test("change from live subscription to progress earlier track", async () => {
                const trackCount = 2;
                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario({
                        delta: 999,
                        first: { start: 0, size: trackCount, end: 999 },
                        second: { start: 1000, size: 0 },
                    });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track[][] = [];

                iterator = await viewerStreams.iterate("live", {
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                const t2 = 1e3 * MILLISECONDS_TO_MICROSECONDS;
                const t1 = t2 + 1;

                await waitForResolved(() =>
                    expect(
                        tracks[tracks.length - 1].map((x) => x.id)
                    ).to.deep.eq([track2.id])
                );

                await track1.put(
                    new Chunk({
                        chunk: new Uint8Array([0]),
                        time: t1,
                        type: "key",
                    })
                );

                await track2.put(
                    new Chunk({
                        chunk: new Uint8Array([0]),
                        time: t2,
                        type: "key",
                    })
                );

                await waitForResolved(() => expect(chunks).to.have.length(1));

                await iterator.close();
                tracks = [];
                chunks = [];
                iterator = await viewerStreams.iterate(0, {
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await waitForResolved(() => expect(chunks).to.have.length(3)); // 2 chunks from first track, 1 from second track

                await waitForResolved(() =>
                    expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                        [track1.id],
                        [track1.id, track2.id],
                        [track2.id],
                        [],
                    ])
                );
            });

            test("close", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone());

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                    })
                );

                await mediaStreams.tracks.put(track1, {
                    target: "replicators",
                });

                let frames = 1000;

                for (let i = 0; i < frames; i++) {
                    track1.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time: i * MILLISECONDS_TO_MICROSECONDS,
                            type: "key",
                        })
                    );
                }
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                        chunks.length === frames / 2 && iterator.close(); // pause after half of the frames
                    },
                });

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(frames / 2)
                    );
                    await delay(2000);
                    expect(chunks.length).to.eq(frames / 2);
                } catch (e) {
                    throw e;
                }
            });

            test("close on end", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone());

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                        end: 1000,
                    })
                );

                await mediaStreams.tracks.put(track1, {
                    target: "replicators",
                });

                let frames = 3;

                for (let i = 0; i < frames; i++) {
                    track1.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time: i * MILLISECONDS_TO_MICROSECONDS,
                            type: "key",
                        })
                    );
                }
                let closePromise = pDefer<void>();
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                        chunks.length === frames / 2 && iterator.close(); // pause after half of the frames
                    },
                    onClose: () => {
                        closePromise.resolve();
                    },
                    closeOnEnd: true,
                });

                /*   await waitForResolved(() =>
                      expect(chunks.length).to.eq(frames / 2)
                  );
                  await delay(2000);
                  expect(chunks.length).to.eq(frames / 2); */

                let timeout = setTimeout(() => {
                    closePromise.reject(
                        new Error("Timed out waiting for track to close")
                    );
                }, 5e3);
                await closePromise.promise;
                clearTimeout(timeout);
            });

            test("close on exhausted recorded track without an end time", async () => {
                const { viewerStreams } = await createScenario({
                    delta: 10,
                    first: { start: 0, size: 3 },
                });
                const chunks: Chunk[] = [];
                const trackChanges: Track[][] = [];
                let closed = false;

                iterator = await viewerStreams.iterate(0, {
                    preload: 0,
                    closeOnEnd: true,
                    onProgress: ({ chunk }) => chunks.push(chunk),
                    onTracksChange: (tracks) => trackChanges.push(tracks),
                    onClose: () => {
                        closed = true;
                    },
                });

                await waitForResolved(() => expect(closed).to.be.true);
                expect(chunks).to.have.length(3);
                expect(trackChanges).to.have.length(2);
                expect(trackChanges[0]).to.have.length(1);
                expect(trackChanges[1]).to.have.length(0);
                expect(iterator.current.size).to.eq(0);
            });

            test("close on an exhausted recorded track with no chunks", async () => {
                const { viewerStreams } = await createScenario({
                    first: { start: 0, end: 10, size: 0 },
                });
                let closed = false;

                iterator = await viewerStreams.iterate(0, {
                    preload: 0,
                    closeOnEnd: true,
                    onClose: () => {
                        closed = true;
                    },
                });

                await waitForResolved(() => expect(closed).to.be.true);
                expect(iterator.current.size).to.eq(0);
            });

            test("does not close on an empty non-terminal metadata page", async () => {
                const { track1, viewerStreams } = await createScenario({
                    first: { start: 0, end: 10, size: 1 },
                });
                let metadataDone = false;
                let metadataReads = 0;
                const metadataClose = sinon.stub().resolves();
                const realMetadataIterate =
                    viewerStreams.tracks.index.iterate.bind(
                        viewerStreams.tracks.index
                    );
                const metadataStub = sinon
                    .stub(viewerStreams.tracks.index, "iterate")
                    .callsFake(((request: any, options: any) => {
                        // Max-time subscription scans share this index but do
                        // not use the sorted playback metadata request.
                        if (
                            !options?.remote ||
                            !("replicate" in options.remote)
                        ) {
                            return realMetadataIterate(request, options);
                        }
                        return {
                            next: async () => {
                                metadataReads++;
                                if (metadataReads === 1) {
                                    return [];
                                }
                                if (metadataReads === 2) {
                                    return [track1.clone()];
                                }
                                metadataDone = true;
                                return [];
                            },
                            done: () => metadataDone,
                            close: metadataClose,
                        } as any;
                    }) as any);
                const delivered: number[] = [];
                let closed = false;

                try {
                    iterator = await viewerStreams.iterate(0, {
                        preload: 0,
                        closeOnEnd: true,
                        onProgress: ({ chunk }) => {
                            delivered.push(chunk.time);
                        },
                        onClose: () => {
                            closed = true;
                        },
                    });

                    expect(metadataReads).to.eq(1);
                    expect(metadataClose.notCalled).to.be.true;
                    await delay(100);
                    expect(closed).to.be.false;
                    expect(metadataReads).to.eq(1);

                    await waitForResolved(() => expect(closed).to.be.true, {
                        timeout: 5_000,
                    });
                    expect(delivered).to.deep.eq([0]);
                    expect(metadataReads).to.eq(3);
                    expect(metadataClose.calledOnce).to.be.true;
                } finally {
                    metadataStub.restore();
                }
            });

            test("waits for a future recorded segment before closing on end", async () => {
                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, end: 10, size: 1 },
                    // Keep the later historical source open-ended so this
                    // exercises exhausted-recording behavior without a
                    // finite admission boundary masking a stuck playback clock.
                    second: { start: 1_000, size: 1 },
                });
                const realMetadataIterate =
                    viewerStreams.tracks.index.iterate.bind(
                        viewerStreams.tracks.index
                    );
                let playbackMetadataIterators = 0;
                const metadataStub = sinon
                    .stub(viewerStreams.tracks.index, "iterate")
                    .callsFake(((request: any, options: any) => {
                        if (options?.remote && "replicate" in options.remote) {
                            playbackMetadataIterators++;
                        }
                        return realMetadataIterate(request, options);
                    }) as any);
                const delivered: number[] = [];
                const releaseFirstExhaustion = pDefer<void>();
                const releaseSecondDelivery = pDefer<void>();
                let firstSourceIteratorWrapped = false;
                let firstUnderflowObserved = false;
                let secondDeliveryStarted = false;
                let closed = false;
                let closeCalls = 0;
                const sourceIteratorStub = interceptTrackSourceIterator(
                    (trackIterator, source) => {
                        if (
                            firstSourceIteratorWrapped ||
                            source.address !== track1.source.address
                        ) {
                            return;
                        }
                        firstSourceIteratorWrapped = true;
                        const next = trackIterator.next.bind(trackIterator);
                        const done = trackIterator.done.bind(trackIterator);
                        let reads = 0;
                        let allowExhaustion = false;
                        trackIterator.done = () => allowExhaustion && done();
                        trackIterator.next = async (args: number) => {
                            reads++;
                            if (reads > 1) {
                                await releaseFirstExhaustion.promise;
                                allowExhaustion = true;
                            }
                            return next(args);
                        };
                    }
                );

                try {
                    iterator = await viewerStreams.iterate(0, {
                        preload: 0,
                        closeOnEnd: true,
                        onUnderflow: () => {
                            firstUnderflowObserved = true;
                        },
                        onProgress: async ({ track, chunk }) => {
                            const timestamp = track.startTime + chunk.time;
                            if (
                                timestamp ===
                                1_000 * MILLISECONDS_TO_MICROSECONDS
                            ) {
                                secondDeliveryStarted = true;
                                await releaseSecondDelivery.promise;
                            }
                            delivered.push(timestamp);
                        },
                        onClose: () => {
                            closed = true;
                            closeCalls++;
                        },
                    });

                    await waitForResolved(() =>
                        expect(delivered).to.deep.eq([0])
                    );
                    expect(firstSourceIteratorWrapped).to.be.true;
                    await waitForResolved(
                        () => expect(firstUnderflowObserved).to.be.true,
                        { timeout: 10_000 }
                    );
                    releaseFirstExhaustion.resolve();
                    await waitForResolved(
                        () => expect(secondDeliveryStarted).to.be.true,
                        { timeout: 10_000 }
                    );

                    // Hold the future frame beyond the normal one-second
                    // metadata rescan. Terminal close-on-end playback must not
                    // reopen the snapshot from zero and resurrect track one.
                    await delay(1_100);
                    expect(closed).to.be.false;
                    expect(playbackMetadataIterators).to.eq(1);

                    releaseSecondDelivery.resolve();

                    await waitForResolved(() => expect(closed).to.be.true, {
                        timeout: 30_000,
                    });
                    expect(delivered).to.deep.eq([
                        0,
                        1_000 * MILLISECONDS_TO_MICROSECONDS,
                    ]);
                    expect(playbackMetadataIterators).to.eq(1);
                    expect(closeCalls).to.eq(1);
                } finally {
                    releaseFirstExhaustion.resolve();
                    releaseSecondDelivery.resolve();
                    sourceIteratorStub.restore();
                    metadataStub.restore();
                }
            });

            test("will join adjecent replication segments", async () => {
                let allChunks = 10;
                let halfChunks = 5;
                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        first: { start: 0, size: allChunks },
                    });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track[][] = [];
                iterator = await viewerStreams.iterate(0.5, {
                    keepTracksOpen: true,
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                await waitForResolved(() =>
                    expect(chunks).to.length(halfChunks)
                );

                await waitForResolved(() =>
                    expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                        [track1.id],
                        [],
                    ])
                );

                expect(
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments()
                ).to.have.length(1);
                await iterator.close();
                tracks = [];
                chunks = [];
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: async (ev) => {
                        chunks.push(ev);
                        if (chunks.length === halfChunks) {
                            await iterator.close();
                        }
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(halfChunks)
                );
                await waitForResolved(() => {
                    expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                        [track1.id],
                        [],
                    ]); // last element will be [] i.e. closed, because we will fetch batches of 60 frames and it will reach the end
                });
                expect(
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments()
                ).to.have.length(1);
            });

            test("replication segments will not join until adjecent", async () => {
                let delta = 10; // ms

                // 101 becaue we want 1010 ms gap, 100 because we want to make it at least 60 frames larger because the iterator will buffer ahead at least 60 (?) frames, so we dont want to close the gap
                let bufferSize = 1; // dont buffer to much extra (so we can assert gaps)
                let bufferTime = bufferSize * delta; // dont buffer to much extra (so we can assert gaps)
                let gapSize = 101 + bufferSize; // gapSize * delta  -> 1010 milliseconds  which is greater than 1s + (extra buffering) which we assume in this test to be the maximum gap allowed for segment merging
                let allChunks = 500;
                let halfChunks = 250;
                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta,
                        first: { start: 0, size: allChunks },
                    });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track[][] = [];
                iterator = await viewerStreams.iterate(0.5, {
                    keepTracksOpen: true,
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                await delay(delta * halfChunks);
                await waitForResolved(() =>
                    expect(chunks).to.length(halfChunks)
                );
                expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                    [track1.id],
                    [],
                ]);
                expect(
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments()
                ).to.have.length(1);
                await iterator.close();
                tracks = [];
                let chunksFromStart: { track: Track; chunk: Chunk }[] = [];

                let chunksToFetchFromTheBeginning = halfChunks - gapSize;
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    bufferTime,
                    bufferSize,
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                    onProgress: (ev) => {
                        chunksFromStart.push(ev);
                        if (
                            chunksFromStart.length >=
                            chunksToFetchFromTheBeginning
                        ) {
                            return iterator.close();
                        }
                    },
                });

                await waitForResolved(
                    () =>
                        expect(chunksFromStart).to.length(
                            chunksToFetchFromTheBeginning
                        ),
                    {
                        // A continuation miss may spend 5s on the page request
                        // and then use the route's 15s recovery window before
                        // playback reaches this assertion under suite load.
                        timeout: 30_000,
                    }
                );

                const segments =
                    await tracks[0][0].source.chunks.log.getMyReplicationSegments();

                expect(segments).to.have.length(2);

                // now iterate over the gap and check that there only will be one replication segments describing the replication intent of the viewer
                const chunksFromGap: { track: Track<any>; chunk: Chunk }[] = [];
                let startFromProgress =
                    chunksToFetchFromTheBeginning / allChunks;
                let trackAgain: Track | undefined = undefined;
                iterator = await viewerStreams.iterate(
                    startFromProgress - 0.01,
                    {
                        keepTracksOpen: true,
                        bufferTime, // dont buffer to much extra (so we can assert gaps)
                        bufferSize,
                        onTracksChange(track) {
                            if (track[0]) {
                                trackAgain = track[0];
                            }
                        },
                        onProgress: async (ev) => {
                            chunksFromGap.push(ev);
                            if (
                                trackAgain &&
                                (
                                    await trackAgain.source.chunks.log.getMyReplicationSegments()
                                ).length === 1
                            ) {
                                return iterator.close();
                            }
                        },
                    }
                );

                await waitForResolved(async () =>
                    expect(
                        trackAgain
                            ? await trackAgain.source.chunks.log.getMyReplicationSegments()
                            : []
                    ).to.have.length(1)
                );
                expect(chunksFromGap.length).to.be.lessThanOrEqual(gapSize);
            });

            test("rejects an unverified cached segment after the streamer shuts down", async () => {
                let chunksCount = 1e3;

                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, size: chunksCount, end: 999 },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track<any>[][] = [];

                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onTracksChange(track) {
                        tracks.push(track);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(chunksCount)
                );

                // all stuff should be replicated
                expect(tracks[0][0].source.chunks.log.log.length).to.eq(
                    chunksCount
                );
                const cachedTrack = tracks[0][0];

                await iterator.close();
                await track1.node.stop();

                try {
                    await expect(
                        cachedTrack.source.iterate(0, {
                            local: true,
                            remote: {
                                timeout: 25,
                                replicate: false,
                            },
                        })
                    ).rejects.toThrow(MissingResponsesError);
                } finally {
                    await viewer.stop();
                    cleanup = undefined;
                    streamer = await Peerbit.create();
                    viewer = await Peerbit.create();
                    await streamer.dial(viewer);
                }
            });

            test("rejects two unverified cached tracks after the streamer shuts down", async () => {
                let chunksCount = 1e3;

                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, size: chunksCount, end: 999 },
                    second: { start: 1000, size: chunksCount, end: 1999 },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                const cachedTracks = new Map<string, Track<any>>();

                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onTracksChange(tracks) {
                        tracks.forEach((track) =>
                            cachedTracks.set(track.idString, track)
                        );
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(chunksCount * 2)
                );
                expect(cachedTracks.size).to.eq(2);
                for (const track of cachedTracks.values()) {
                    expect(track.source.chunks.log.log.length).to.eq(
                        chunksCount
                    );
                }

                await iterator.close();
                await track1.node.stop();

                try {
                    for (const track of cachedTracks.values()) {
                        await expect(
                            track.source.iterate(0, {
                                local: true,
                                remote: {
                                    timeout: 25,
                                    replicate: false,
                                },
                            })
                        ).rejects.toThrow(MissingResponsesError);
                    }
                } finally {
                    await viewer.stop();
                    cleanup = undefined;
                    streamer = await Peerbit.create();
                    viewer = await Peerbit.create();
                    await streamer.dial(viewer);
                }
            });
        });

        describe("life cycle", () => {
            test("will reuse track for new iterator", async () => {
                let chunksPerTrack = 2;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 999,
                        first: { start: 0, size: chunksPerTrack, end: 999 },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                let maxTime = 0;
                let tracks: Track<any>[] = [];
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true, // this option will prevent closing
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                    onTracksChange: (change) => {
                        tracks.push(...change);
                    },
                });
                await waitForResolved(() =>
                    expect(chunks.length).to.eq(chunksPerTrack)
                );
                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );

                expect(tracks).to.have.length(1);
                let segmentsReplicatedByViewer = await (
                    tracks[0].source as AudioStreamDB | WebcodecsStreamDB
                ).chunks.log.replicationIndex.count({
                    query: {
                        hash: viewerStreams.node.identity.publicKey.hashcode(),
                    },
                });

                const fff = await (
                    tracks[0].source as AudioStreamDB | WebcodecsStreamDB
                ).chunks.log.replicationIndex
                    .iterate({
                        query: {
                            hash: viewerStreams.node.identity.publicKey.hashcode(),
                        },
                    })
                    .all();

                expect(segmentsReplicatedByViewer).to.eq(1);

                expect(tracks).to.have.length(1);
                expect(tracks[0].closed).to.be.false;

                chunks = [];
                maxTime = 0;

                // do the same iterator again and expect same results

                const closeCall = sinon.spy(tracks[0].close);
                tracks[0].close = closeCall;

                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true, // this option will prevent closing
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
                    },
                    onTracksChange: (change) => {
                        tracks.push(...change);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(chunksPerTrack)
                );
                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );
                expect(tracks).to.have.length(2);

                segmentsReplicatedByViewer = await (
                    tracks[1].source as AudioStreamDB | WebcodecsStreamDB
                ).chunks.log.replicationIndex.count({
                    query: {
                        hash: viewerStreams.node.identity.publicKey.hashcode(),
                    },
                });
                expect(segmentsReplicatedByViewer).to.eq(1);

                expect(closeCall.called).to.be.false;
                await iterator.close();
                expect(closeCall.called).to.be.false; // since keepTracksOpen: true
            });

            test("close all tracks", async () => {
                let chunkSize = 2;

                const { viewerStreams } = await createScenario({
                    delta: 999,
                    first: { start: 0, size: chunkSize, end: 999 },
                });

                // start playing from track1 and then assume we will start playing from track2
                let tracks: Track<any>[] = [];
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true, // this option will prevent closing
                    onTracksChange: (change) => {
                        tracks.push(...change);
                    },
                });
                await waitForResolved(() => {
                    expect(tracks).to.have.length(1);
                    expect(tracks[0].closed).to.be.false;
                });

                const closeCalled = sinon.spy(tracks[0].close);
                tracks[0].close = closeCalled;
                await viewerStreams.close();
                console.log("---- closed ---");
                await delay(3000);

                expect(closeCalled.calledOnce).to.be.true;
            });

            test("can drop track", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );
                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                    })
                );

                await mediaStreams.tracks.put(track1);
                await track1.put(
                    new Chunk({ chunk: new Uint8Array([123]), time: 0 })
                );
                await track1.drop();
                await mediaStreams.tracks.del(track1.id);
            });

            test("can drop after end", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );
                const track1 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new WebcodecsStreamDB({
                            decoderDescription: { codec: "av01" },
                        }),
                        start: 0,
                    })
                );

                await mediaStreams.tracks.put(track1);
                await mediaStreams.setEnd(track1, 10n);
                await track1.put(
                    new Chunk({ chunk: new Uint8Array([123]), time: 0 })
                );
                await track1.drop();
                await mediaStreams.tracks.del(track1.id);
            });
        });
    });
});

describe("MediaStreams", () => {
    let replicator: Peerbit,
        streamer: Peerbit,
        cleanup: (() => Promise<void>) | undefined;

    let replicatorPath = path.join(
        "tmp",
        "video-stream-lib",
        "MediaStreams",
        String(+new Date())
    );
    beforeAll(async () => {
        global.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 10);
        };

        streamer = await Peerbit.create();
        replicator = await Peerbit.create({
            directory: replicatorPath,
        });
        await streamer.dial(replicator);
    });

    afterAll(async () => {
        await replicator.stop();
        await streamer.stop();
    });

    afterEach(async () => {
        await cleanup?.();
    });

    test("address is deterministic", async () => {
        const streamerStreams = await streamer.open(new MediaStreamDBs());
        const viewerStreams = await replicator.open(streamerStreams.clone());
        try {
            expect(viewerStreams.address).to.eq(streamerStreams.address);
        } finally {
            await Promise.allSettled([
                viewerStreams.close(),
                streamerStreams.close(),
            ]);
        }
    });

    test("fences parent admission before destructive library drop cleanup", async () => {
        const library = await replicator.open(
            new MediaStreamDBs({ id: randomBytes(32) }),
            { args: { replicate: false } }
        );
        const cleanupStarted = pDefer<void>();
        const releaseCleanup = pDefer<void>();
        const closeReplicatedStreams = sinon
            .stub(library as any, "closeReplicatedStreams")
            .callsFake(async () => {
                cleanupStarted.resolve();
                await releaseCleanup.promise;
            });
        const dropping = library.drop();

        try {
            await cleanupStarted.promise;
            expect(library.acceptsParentAttachments).to.be.false;
            releaseCleanup.resolve();
            expect(await dropping).to.be.true;
        } finally {
            releaseCleanup.resolve();
            await dropping.catch(() => {});
            closeReplicatedStreams.restore();
        }
    });

    test("keeps a replicated stream open until final library cleanup succeeds", async () => {
        const library = await replicator.open(
            new MediaStreamDBs({ id: randomBytes(32) }),
            { args: { replicate: false } }
        );
        const stream = await replicator.open(
            new MediaStreamDB(replicator.identity.publicKey),
            {
                args: { replicate: false },
                parent: library,
            }
        );
        const streamId = stream.idString;
        (library as any).replicatedStreams.set(streamId, stream);
        const cleanupError = new Error(
            "synthetic final replicated-stream cleanup failure"
        );
        const realClose = stream.close.bind(stream);
        const closeStream = sinon.stub(stream, "close");
        closeStream.onFirstCall().rejects(cleanupError);
        closeStream.onSecondCall().callsFake(realClose);

        try {
            await expect(library.close()).rejects.toBe(cleanupError);
            expect(library.closed).to.be.false;
            expect(stream.closed).to.be.false;
            expect(stream.parents).to.include(library);
            expect((library as any).replicatedStreams.get(streamId)).to.eq(
                stream
            );

            await library.close();
            expect(closeStream.callCount).to.eq(2);
            expect(library.closed).to.be.true;
            expect(stream.closed).to.be.true;
            expect((library as any).replicatedStreams.size).to.eq(0);
        } finally {
            closeStream.restore();
            await Promise.allSettled([library.close(), stream.close()]);
        }
    });

    test("retries a replicated stream after its failing close detached the parent", async () => {
        const library = new MediaStreamDBs({ id: randomBytes(32) });
        const stream = new MediaStreamDB(streamer.identity.publicKey);
        const streamId = stream.idString;
        const cleanupError = new Error(
            "synthetic detached replicated-stream cleanup failure"
        );
        stream.closed = false;
        stream.parents = [library];
        library.children = [stream];
        const closeStream = sinon.stub(stream, "close");
        closeStream.onFirstCall().callsFake(async (from?: any) => {
            expect(from).to.eq(library);
            stream.parents = [];
            stream.closed = true;
            throw cleanupError;
        });
        closeStream.onSecondCall().resolves(true);
        (library as any).replicatedStreams.set(streamId, stream);

        try {
            await expect(
                (library as any).closeReplicatedStreams()
            ).rejects.toBe(cleanupError);
            expect((library as any).replicatedStreams.get(streamId)).to.eq(
                stream
            );
            expect(library.children).to.include(stream);

            await (library as any).closeReplicatedStreams();
            expect(closeStream.callCount).to.eq(2);
            expect(closeStream.firstCall.calledWithExactly(library)).to.be.true;
            expect(closeStream.secondCall.calledWithExactly()).to.be.true;
            expect((library as any).replicatedStreams.has(streamId)).to.be
                .false;
            expect(library.children).not.to.include(stream);
        } finally {
            closeStream.restore();
        }
    });

    test("closes dynamically parented replication streams with the library", async () => {
        const track = await streamer.open(
            new Track({
                sender: streamer.identity.publicKey,
                source: new AudioStreamDB({ sampleRate: 44100 }),
                start: 0,
            })
        );
        const mediaStream = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        await mediaStream.tracks.put(track);
        const streamerLibrary = await streamer.open(
            new MediaStreamDBs({ id: randomBytes(32) }),
            { args: { replicate: false } }
        );
        await streamerLibrary.mediaStreams.put(mediaStream);
        const replicatorLibrary = await replicator.open(
            streamerLibrary.clone(),
            { args: { replicate: "all" } }
        );
        cleanup = async () => {
            await Promise.allSettled([
                replicatorLibrary.close(),
                streamerLibrary.close(),
                mediaStream.close(),
                track.close(),
            ]);
        };

        let replicatedStream: MediaStreamDB | undefined;
        let replicatedTrack: Track | undefined;
        await waitForResolved(() => {
            replicatedStream = (replicatorLibrary as any).replicatedStreams.get(
                mediaStream.idString
            );
            expect(replicatedStream).to.exist;
            expect(replicatedStream!.parents).to.include(replicatorLibrary);
            replicatedTrack = (
                replicatedStream as any
            ).defaultReplicationLeases.get(track.idString)?.handle.track;
            expect(replicatedTrack).to.exist;
        });

        await replicatorLibrary.close();

        expect(replicatedStream!.closed).to.be.true;
        expect(replicatedTrack!.closed).to.be.true;
        expect((replicatorLibrary as any).replicatedStreams.size).to.eq(0);
        expect(mediaStream.closed).to.be.false;
        expect(track.closed).to.be.false;
    });

    test("closes rather than drops dynamically replicated streams when dropping the library", async () => {
        const mediaStream = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        const streamerLibrary = await streamer.open(
            new MediaStreamDBs({ id: randomBytes(32) }),
            { args: { replicate: false } }
        );
        await streamerLibrary.mediaStreams.put(mediaStream);
        const replicatorLibrary = await replicator.open(
            streamerLibrary.clone(),
            { args: { replicate: "all" } }
        );
        cleanup = async () => {
            await Promise.allSettled([
                replicatorLibrary.close(),
                streamerLibrary.close(),
                mediaStream.close(),
            ]);
        };

        let replicatedStream: MediaStreamDB | undefined;
        await waitForResolved(() => {
            replicatedStream = (replicatorLibrary as any).replicatedStreams.get(
                mediaStream.idString
            );
            expect(replicatedStream).to.exist;
            expect(replicatedStream!.parents).to.include(replicatorLibrary);
        });
        const closeStream = sinon.spy(replicatedStream!, "close");
        const dropStream = sinon.spy(replicatedStream!, "drop");

        await replicatorLibrary.drop();

        expect(closeStream.calledOnceWith(replicatorLibrary)).to.be.true;
        expect(dropStream.notCalled).to.be.true;
        expect(replicatedStream!.closed).to.be.true;
        expect((replicatorLibrary as any).replicatedStreams.size).to.eq(0);
    });

    test("does not close a reused root stream with the library", async () => {
        const mediaStream = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        const streamerLibrary = await streamer.open(
            new MediaStreamDBs({ id: randomBytes(32) }),
            { args: { replicate: false } }
        );
        await streamerLibrary.mediaStreams.put(mediaStream);
        const externalStream = await replicator.open(mediaStream.clone());
        const replicatorLibrary = await replicator.open(
            streamerLibrary.clone(),
            { args: { replicate: "all" } }
        );
        cleanup = async () => {
            await Promise.allSettled([
                replicatorLibrary.close(),
                externalStream.close(),
                streamerLibrary.close(),
                mediaStream.close(),
            ]);
        };

        await waitForResolved(() => {
            expect(
                (replicatorLibrary as any).replicatedStreams.get(
                    mediaStream.idString
                )
            ).to.eq(externalStream);
            expect(externalStream.parents).to.include(replicatorLibrary);
        });

        await replicatorLibrary.close();

        expect(externalStream.closed).to.be.false;
        expect(externalStream.parents).not.to.include(replicatorLibrary);
        expect((replicatorLibrary as any).replicatedStreams.size).to.eq(0);
    });

    test("will start replicating things that are added by default", async () => {
        const track1 = await streamer.open(
            new Track({
                sender: streamer.identity.publicKey,
                source: new WebcodecsStreamDB({
                    decoderDescription: { codec: "av01" },
                }),
                start: 0,
            })
        );

        await track1.put(new Chunk({ chunk: new Uint8Array([123]), time: 0 }));

        expect(await track1.source.chunks.log.calculateCoverage()).to.eq(1); // only the streamer replicates

        const mediaStreams = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        await mediaStreams.tracks.put(track1);

        const streamerStreams = await streamer.open(new MediaStreamDBs(), {
            args: { replicate: false },
        });

        await streamerStreams.mediaStreams.put(mediaStreams);

        let replicatorStreams = await replicator.open(new MediaStreamDBs(), {
            args: { replicate: "all" },
        });
        await delay(3e3);

        try {
            await waitForResolved(async () =>
                expect(await mediaStreams.tracks.log.calculateCoverage()).to.eq(
                    2
                )
            ); // streamer + replicator replicates
        } catch (error) {
            throw error;
        }

        try {
            await waitForResolved(async () =>
                expect(
                    await track1.source.chunks.log.calculateCoverage()
                ).to.eq(2)
            ); // streamer + replicator replicates
        } catch (error) {
            throw error;
        }

        // also make sure replicator can restart

        const assert = async () => {
            await waitForResolved(async () => {
                const streams = await replicatorStreams.mediaStreams.index
                    .iterate({}, { local: true, remote: false })
                    .all();
                const firstStream = streams[0];
                expect(firstStream).to.exist;
                const tracks = await firstStream.tracks.index
                    .iterate({}, { local: true, remote: false })
                    .all();
                const firstTrack = tracks[0];
                expect(firstTrack).to.exist;

                const chunks = await firstTrack.source.chunks.index
                    .iterate({}, { local: true, remote: false })
                    .all();
                expect(chunks).to.have.length(1);
            });
        };
        await assert();

        await replicator.stop();

        replicator = await Peerbit.create({
            directory: replicatorPath,
        });

        replicatorStreams = await replicator.open(new MediaStreamDBs({}), {
            args: { replicate: "all" },
        });

        await assert();
    });
});
