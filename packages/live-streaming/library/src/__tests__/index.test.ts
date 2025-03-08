import { Peerbit } from "peerbit";
import {
    AudioStreamDB,
    Chunk,
    MediaStreamDB,
    MediaStreamDBs,
    oneVideoAndOneAudioChangeProcessor,
    Track,
    TracksIterator,
    WebcodecsStreamDB,
} from "../index.js";
import { delay, hrtime, waitForResolved } from "@peerbit/time";
import { equals } from "uint8arrays";
import { expect } from "chai";
import sinon from "sinon";
import { Ed25519Keypair } from "@peerbit/crypto";
import { MAX_U32, ReplicationRangeIndexable } from "@peerbit/shared-log";
import pDefer, { DeferredPromise } from "p-defer";
import path from "path";
import { WithContext } from "@peerbit/document";

const MILLISECONDS_TO_MICROSECONDS = 1e3;

describe("oneVideoAndOneAudioChangeProcessor", () => {
    it("preload tracks when end time not set", async () => {
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

    it("preload tracks when end time set", async () => {
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

    it("not load track until preload when end time not set", async () => {
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

    it("not load track until preload when end time set", async () => {
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

    it("not add track if end times are equal", async () => {
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

    it("not add track if end times are equal", async () => {
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

    it("will schedule track loading when necessary with", async () => {
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

    it("will schedule track with time when not overlapping", async () => {
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
    it("setEnd", async () => {
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
describe("MediaStream", () => {
    let streamer: Peerbit,
        viewer: Peerbit,
        cleanup: (() => Promise<void>) | undefined,
        iterator: TracksIterator;

    before(async () => {
        global.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 10);
        };

        streamer = await Peerbit.create();
        viewer = await Peerbit.create();
        await streamer.dial(viewer);
    });

    after(async () => {
        await viewer.stop();
        await streamer.stop();
    });

    afterEach(async () => {
        await cleanup?.();
        await iterator?.close();
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

        for (let i = 0; i < firstSize; i++) {
            track1.put(
                new Chunk({
                    chunk: new Uint8Array([i]),
                    time: i * MILLISECONDS_TO_MICROSECONDS * delta,
                    type: "key",
                }),
                {
                    target: "all" /* 
                    meta: {
                        timestamp: new Timestamp({
                            wallTime: now + BigInt(i * deltaNano),
                        }),
                    }, */,
                }
            );
        }
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
            for (let i = 0; i < (properties.second.size ?? 1000); i++) {
                track2.put(
                    new Chunk({
                        chunk: new Uint8Array([i]),
                        time: i * MILLISECONDS_TO_MICROSECONDS * delta,
                        type: "key",
                    }),
                    {
                        target: "all",
                        /*  meta: {
                             timestamp: new Timestamp({
                                 wallTime: now + BigInt(i * deltaNano),
                             }),
                         }, */
                    }
                );
            }
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

    describe("waitFor", () => {
        it("wait for self", async () => {
            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );
            await mediaStreams.waitFor(mediaStreams.node.identity.publicKey);
        });
    });
    describe("live", () => {
        it("one chunk", async () => {
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
                expect(receivedChunks).to.have.length(1)
            );
        });

        it("second chunk", async () => {
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

        it("multiple options", async () => {
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

        it("new", async () => {
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
            (await listenTrack.promise).waitFor(streamer.identity.publicKey);
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

            await track1.put(c1, { target: "all" });
            await waitForResolved(() => expect(chunks).to.have.length(1));
            await track1.put(c2, { target: "all" });
            await waitForResolved(() => expect(chunks).to.have.length(2));

            expect(chunks[0].chunk.id).to.eq(c1.id);
            expect(chunks[1].chunk.id).to.eq(c2.id);
        });

        it("live after progress", async () => {
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
            await track1.put(c1, { target: "all" });
            await track1.put(c2, { target: "all" });

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

            await track1.put(c3, { target: "all" });
            await waitForResolved(() => expect(chunks).to.have.length(3));
            await track1.put(c4, { target: "all" });
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

        it("subscribeForMaxTime for streamer", async () => {
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

        it("new track while viewing", async () => {
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
            delay(ts).then(async () => {
                const track2 = await streamer.open(
                    new Track({
                        sender: streamer.identity.publicKey,
                        source: new AudioStreamDB({ sampleRate: 44100 }),
                        start: ts * 1e3,
                    })
                );

                await mediaStreams.tracks.put(track2);

                await gotTrack2.promise;

                console.log("HERE2");
                await track2.put(
                    new Chunk({
                        chunk: new Uint8Array([101]),
                        time: 123,
                        type: "key",
                    })
                );
            });

            try {
                await waitForResolved(() => expect(chunks).to.have.length(2));
            } catch (error) {
                throw error;
            }
            expect(maxTimes).to.deep.eq([0, ts * 1e3 + 123]);
        });

        /*  TODO should this test be deleted or can we try to figure out a test case where old data can disrupt the live feed?
       
        it("old ignored", async () => {
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
             await track1.put(c1, { target: "all" });
 
             await waitForResolved(() => expect(chunks).to.have.length(1));
             await track1.put(c2, { target: "all" });
             await delay(3000);
             expect(chunks).to.have.length(1);
         }); */

        it("onReplicationChange", async () => {
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

            await track1.put(c1, { target: "all" });
            await waitForResolved(() =>
                expect(replicators.map((x) => x.hash)).to.deep.eq([
                    track1.node.identity.publicKey.hashcode(),
                    viewerStreams.node.identity.publicKey.hashcode(),
                ])
            );
        });

        it("select options", async () => {
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

            await track1.put(c1, { target: "all" });
            await track2.put(c2, { target: "all" });

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

            await track1.put(c3, { target: "all" });
            await track2.put(c4, { target: "all" });

            await waitForResolved(() => expect(chunks).to.have.length(2));
            expect(chunks[1].chunk.id).to.eq(c4.id);
            expect(iterator.options()).to.have.length(2);
        });

        it("options are updated", async () => {
            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );

            const viewerStreams = await viewer.open(mediaStreams.clone());

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
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

            await mediaStreams.tracks.put(track1, { target: "all" });
            const track2 = await streamer.open(
                new Track({
                    sender: streamer.identity.publicKey,
                    source: new WebcodecsStreamDB({
                        decoderDescription: { codec: "av01" },
                    }),
                    start: 1000,
                })
            );
            await mediaStreams.tracks.put(track2, { target: "all" });

            await waitForResolved(() =>
                expect(iterator.options()).to.have.length(2)
            );

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

            await track1.put(c1, { target: "all" });
            await track2.put(c2, { target: "all" });

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.id)).to.deep.eq([c1.id])
            );

            await mediaStreams.setEnd(track1, 0);

            await waitForResolved(() =>
                expect(iterator.options()).to.have.length(1)
            );
            try {
                await waitForResolved(() =>
                    expect(iterator.current).to.have.length(1)
                );
            } catch (error) {
                throw error;
            }

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

            await track1.put(c3, { target: "all" });
            await track2.put(c4, { target: "all" });

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.id)).to.deep.eq([c1.id, c4.id])
            );
        });

        it("closing iterator will end track", async () => {
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

        it("closing iterator with keep alive with prevent further replication when closing", async () => {
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

        it("closing iterator with keep alive with prevent further replication when non-live iterating", async () => {
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
            await delay(Number(lastChunkTime) / 1e3);
            // wait for some extra time for the last chunks to propagate for async operations
            // TODO make it so we dont need this
            await delay(1e3);

            expect(viewerTracksChangesAgain).to.have.length(2); // open and close
            expect(viewerTracksChangesAgain[0]).to.have.length(1);
            expect(viewerTracksChangesAgain[1]).to.have.length(0); // all closed
            expect(viewerTracksChangesAgain[0][0] === viewerTracksChanges[0][0])
                .to.be.true;

            await firstIterator.close();
            await secondIterator.close();
        });

        it("will reuse segment", async () => {
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

        it("will favor live track", async () => {
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

            let receivedChunks: Chunk[] = [];
            let trackChanged: Track<AudioStreamDB | WebcodecsStreamDB>[][] = [];
            let trackOptionsChanged: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            await listener.iterate("live", {
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

            const track2 = await streamer.open(
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

        it("keep track until the end", async () => {
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

            let receivedChunks: Chunk[] = [];
            let trackChanged: Track<AudioStreamDB | WebcodecsStreamDB>[][] = [];
            let trackOptionsChanged: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            await listener.iterate("live", {
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
            it("one chunk", async () => {
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
                        x.map(
                            (y) =>
                                y.hash ===
                                viewerStreams.node.identity.publicKey.hashcode()
                        )
                    )
                ).to.deep.eq([[false], [false, true]]);

                // make sure first chunk was fetched decently fast
                expect(t1! - t0).to.be.lessThan(2e3);
            });

            it("start at middle", async () => {
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

            it("start before first chunk", async () => {
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

            it("current time pauses when lagging", async () => {
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
                iterator = await viewerStreams.iterate(0, {
                    bufferSize: 1,
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
                                    once && (await bufferPausePromise.promise);
                                    once = true;
                                    return next(args);
                                };
                                return iterator;
                            };
                            gotTrackPromise.resolve();
                        }
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
                await waitForResolved(() => expect(chunks.length).to.eq(1));
                await waitForResolved(() => expect(underflowCalled).to.be.true);

                let time = iterator.time();
                for (let i = 0; i < 10; i++) {
                    await delay(1e2);
                    expect(iterator.time()).to.eq(time); // should pause since we are stuck
                }
                bufferPausePromise.resolve(); // release the lock
                await waitForResolved(() => expect(chunks.length).to.eq(2));
                expect(iterator.time()).to.be.greaterThan(time as number);
            });

            it("current time is accurate after pause resume when lagging", async () => {
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
                iterator = await viewerStreams.iterate(0, {
                    bufferSize: 1,
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
                                    once && (await bufferPausePromise.promise);
                                    once = true;
                                    return next(args);
                                };
                                return iterator;
                            };
                            gotTrackPromise.resolve();
                        }
                    },
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await gotTrackPromise.promise;
                await waitForResolved(() => expect(chunks.length).to.eq(1));
                let time = iterator.time();
                await delay(1e3);
                bufferPausePromise.resolve(); // release the lock
                await waitForResolved(() => expect(chunks.length).to.eq(2));
                let timeAfterBuffer = iterator.time();
                expect(timeAfterBuffer as number).to.be.greaterThan(
                    time as number
                );
                const delta = (timeAfterBuffer as number) - (time as number);
                expect(delta).to.lessThan(100 * 1e3); // while 1s has passed, the time between two frames is less
                iterator.pause();
                iterator.play();
                let timeAfterPlay = iterator.time();
                //   expect(timeAfterPlay).to.eq(timeAfterBuffer) // because no new frames has come, even if 1s has passed
                await delay(1e3);
                let timeAfterPlayDelay = iterator.time();
                // expect(timeAfterPlayDelay).to.eq(timeAfterBuffer) // because no new frames has come, even if 1s has passed
                expect(timeAfterPlayDelay).to.eq(timeAfterPlay);
            });

            it("time will progress on track with no chunks", async () => {
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

            it("time will not  progress on track while waiting for chunks", async () => {
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

            it("will emit underflow once buffer runs out", async () => {
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
                // underflow should be called when we go into the buffer loop and does not have any frames,
                // so we will receive  freezeAtChunk - bufferSize amount of chunks
                // so (freezeAtChunk - bufferSize - 1) * delta * 1e3 ms microseconds
                // -1 because we will play the first frame at 0 and not at 1
                expect(underFlowCalled[0]).to.be.closeTo(
                    (freezeAtChunk - bufferSize - 1) * delta * 1e3,
                    1e5
                );
            });

            it("replication segment will grow as buffering continues", async () => {
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

            it("merges segments on re-start at the same time", async () => {
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

                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(size)
                );
                await iterator.close();

                chunks = [];
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 10, // 10 ms,
                    bufferSize: 10,
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                    onReplicationChange: (range) => {
                        expect(
                            viewerStreams.node.identity.publicKey.hashcode() ===
                                range.hash
                        ).to.be.false;
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.have.length(size)
                );
            });

            it("will subscribe to max time while iterating", async () => {
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

            it("will not close track until buffer is empty", async () => {
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
            it("will deduplicate by type", async () => {
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

            it("will not go back intime for same source", async () => {
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

            it("overlapping partly multiple media types", async () => {
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

            it("overlapping partly same media types", async () => {
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

            it("will not buffer overlapping until necessary", async () => {
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
                                            let chunks: WithContext<Chunk>[] =
                                                await next(args);
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

            it("time will not progress until preload", async () => {
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

            it("can select a different track of same source type", async () => {
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
                            trackOptions.set(track.address, track);
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
                                        .address
                                ).to.eq(unselected.address);
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
                    expect(selectedTracks[0][0].address).to.be.oneOf([
                        track1.address,
                        track2.address,
                    ]);
                });

                selected =
                    selectedTracks[0][0].address === track1.address
                        ? trackOptions.get(track1.address)!
                        : trackOptions.get(track2.address)!;
                unselected =
                    selectedTracks[0][0].address === track1.address
                        ? trackOptions.get(track2.address)!
                        : trackOptions.get(track1.address)!;

                // select the unselected track
                await delay(3e3); // wait  for some time to consume some chunks from the first track
                await iterator.selectOption(unselected);

                await selectedUnselected.promise;

                await waitForResolved(() =>
                    expect(chunks).to.have.length(chunkCountPerTrack)
                );
                expect(chunks[0].track.address).to.eq(selected.address); // starts from the first track
                expect(chunks[chunks.length - 1].track.address).to.eq(
                    unselected.address
                ); // ends on the second track
            });
        });

        describe("sequential", () => {
            it("start at 0", async () => {
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
                    trackOptionsPerChunk.map((x) => x.map((y) => y.address))
                ).to.deep.eq([
                    [track1.address],
                    [track1.address],
                    [track2.address],
                    [track2.address],
                ]);

                await waitForResolved(() =>
                    expect(maxTime).to.eq(
                        chunks[chunks.length - 1].track.startTime +
                            chunks[chunks.length - 1].chunk.time
                    )
                );
            });

            it("0.3", async () => {
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

            it("0.3 long", async () => {
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

            it("many chunks single track", async () => {
                let size = 5e3;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 1,
                        first: { start: 0, size },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const start = 0.23;
                console.log("start iterate");
                iterator = await viewerStreams.iterate(start, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });

                await delay(5e3); // why?
                await waitForResolved(() =>
                    expect(chunks.length).to.closeTo(size * (1 - start), 100)
                );
                // assert that the timestamps are correct
                let delta = chunks[1].chunk.time - chunks[0].chunk.time;
                for (let i = 1; i < chunks.length; i++) {
                    expect(
                        chunks[i].chunk.time - chunks[i - 1].chunk.time
                    ).to.be.eq(delta);
                }
            });

            it("many chunks concurrently", async () => {
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

            it("buffers evenly", async () => {
                // TODO this test is flaky for some reason
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

                await mediaStreams.tracks.put(track1, { target: "all" });
                //  console.log(viewerStreams.node.identity.publicKey.hashcode(), await viewerStreams.tracks.log.getCover(undefined as any, undefined))
                // console.log(await viewerStreams.tracks.index.search(new SearchRequest()));
                //  await delay(3000)
                // console.log(viewerStreams.node.identity.publicKey.hashcode(), await viewerStreams.tracks.log.getCover(undefined as any, undefined))

                // console.log(await viewerStreams.tracks.index.search(new SearchRequest()));

                let frames = 3e3;

                for (let i = 0; i < frames; i++) {
                    await track1.put(
                        new Chunk({
                            chunk: new Uint8Array([i]),
                            time: i * MILLISECONDS_TO_MICROSECONDS,
                            type: "key",
                        })
                    );
                }

                let t0 = +new Date();
                let maxDiff = 0;
                let lastTs: number | undefined = undefined;
                let diffs: number[] = [];
                let firstChunkPromise = pDefer();
                iterator = await viewerStreams.iterate(0, {
                    bufferTime: 1e3,
                    preload: 1e3,
                    onProgress: (ev) => {
                        firstChunkPromise.resolve();
                        let now = +new Date();
                        if (lastTs) {
                            maxDiff = Math.max(maxDiff, now - lastTs);
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
                let t1 = +new Date();
                expect(t1 - t0).to.be.greaterThan(frames);

                let meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
                expect(meanDiff - 1).to.be.lessThan(0.001); // TODO polyfill requestAnimationFrame better to make this test more reliable
            });

            it("pause", async () => {
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

                await mediaStreams.tracks.put(track1, { target: "all" });

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
                        chunks.length === frames / 2 && iterator.pause(); // pause after half of the frames
                    },
                });

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(frames / 2)
                    );
                } catch (error) {
                    throw error;
                }

                iterator.play();

                await waitForResolved(() =>
                    expect(chunks.length).to.eq(frames)
                );
            });

            it("change from live subscription to progress earlier track", async () => {
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
                    ])
                );
            });

            it("close", async () => {
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

                await mediaStreams.tracks.put(track1, { target: "all" });

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

            it("will join adjecent replication segments", async () => {
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

            it("replication segments will not join until adjecent", async () => {
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

                await waitForResolved(() =>
                    expect(chunksFromStart).to.length(
                        chunksToFetchFromTheBeginning
                    )
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

            it("can rewatch segment after streamer shuts down", async () => {
                let chunksCount = 1e3;

                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, size: chunksCount, end: 999 },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track<any>[][] = [];

                let maxTime = 0;
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    onProgress: (ev) => {
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
                    expect(chunks.length).to.eq(chunksCount)
                );

                // all stuff should be replicated
                expect(tracks[0][0].source.chunks.log.log.length).to.eq(
                    chunksCount
                );

                await track1.node.stop();

                chunks = [];
                tracks = [];

                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
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
                    expect(chunks.length).to.eq(chunksCount)
                );
            });

            it("can rewatch segment after streamer shuts down - 2 tracks", async () => {
                let chunksCount = 1e3;

                const { track1, viewerStreams } = await createScenario({
                    delta: 1,
                    first: { start: 0, size: chunksCount, end: 999 },
                    second: { start: 1000, size: chunksCount, end: 1999 },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track<any>[][] = [];

                let maxTime = 0;
                iterator = await viewerStreams.iterate(0, {
                    keepTracksOpen: true,
                    onProgress: (ev) => {
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
                    expect(chunks.length).to.eq(chunksCount * 2)
                );

                // all stuff should be replicated
                expect(tracks[0][0].source.chunks.log.log.length).to.eq(
                    chunksCount
                );

                await track1.node.stop();

                chunks = [];
                tracks = [];

                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
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
                    expect(chunks.length).to.eq(chunksCount * 2)
                );
            });
        });

        describe("life cycle", () => {
            it("will reuse track for new iterator", async () => {
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

            it("close all tracks", async () => {
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

            it("can drop track", async () => {
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

            it("can drop after end", async () => {
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
    before(async () => {
        global.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 10);
        };

        streamer = await Peerbit.create();
        replicator = await Peerbit.create({
            directory: replicatorPath,
        });
        await streamer.dial(replicator);
    });

    after(async () => {
        await replicator.stop();
        await streamer.stop();
    });

    afterEach(async () => {
        await cleanup?.();
    });

    it("address is deterministic", async () => {
        const streamerStreams = await streamer.open(new MediaStreamDBs());
        const viewerStreams = await replicator.open(streamerStreams.clone());
        expect(viewerStreams.address).to.eq(streamerStreams.address);
    });

    it("will start replicating things that are added by default", async () => {
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
            args: { replicate: true },
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

        replicatorStreams = await replicator.open(new MediaStreamDBs(), {
            args: { replicate: true },
        });

        await assert();
    });
});
