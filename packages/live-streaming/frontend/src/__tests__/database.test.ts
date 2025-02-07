import { Peerbit } from "peerbit";
import {
    AudioStreamDB,
    Chunk,
    MediaStreamDB,
    Track,
    TracksIterator,
    WebcodecsStreamDB,
} from "../media/database";
import { delay, hrtime, waitForResolved } from "@peerbit/time";
import { equals } from "uint8arrays";
import { expect } from "chai";
import sinon from "sinon";
import { Timestamp } from "@peerbit/log";
import { Ed25519Keypair, PublicSignKey } from "@peerbit/crypto";
import { MAX_U32, ReplicationRangeIndexable } from "@peerbit/shared-log";
import pDefer from "p-defer";

const MILLISECONDS_TO_MICROSECONDS = 1e3;

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
            type?: "video" | "audio";
        };
    };
    type TwoTracks = {
        first: {
            start: number;
            end?: number;
            size?: number;
            type?: "video" | "audio";
        };
        second: {
            start: number;
            end?: number;
            size?: number;
            type?: "video" | "audio";
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
                    properties.first.type === "video"
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
                        properties.second.type === "video"
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
                expect(iterator.options).to.have.length(2)
            );
        });

        it("new", async () => {
            const { mediaStreams, track1, viewerStreams } =
                await createScenario({
                    first: { start: 10 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    console.log("GOT CHUNK", ev.chunk.timeBN);
                    chunks.push(ev);
                },
            });
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

            await waitForResolved(() =>
                expect(iterator.current).to.have.length(1)
            );
            await waitForResolved(() =>
                expect(iterator.options).to.have.length(1)
            );
            await delay(1000);

            await track1.put(c1, { target: "all" });
            await waitForResolved(() => expect(chunks).to.have.length(1));
            await track1.put(c2, { target: "all" });
            await waitForResolved(() => expect(chunks).to.have.length(2));

            expect(chunks[0].chunk.id).to.eq(c1.id);
            expect(chunks[1].chunk.id).to.eq(c2.id);
        });

        it("subscribeForMaxTime for streamer", async () => {
            let start = 100;
            const { mediaStreams, track1 } = await createScenario({
                first: { start, size: 0 },
            });

            let maxTime: number | undefined = undefined;
            mediaStreams.subscribeForMaxTime((time) => {
                maxTime = time;
            }, true);

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
                onTracksChange(track) {
                    if (equals(track[0].id, track1.id)) {
                        gotTrack.resolve();
                    } else if (!equals(track[0].id, track1.id)) {
                        // track 2
                        gotTrack2.resolve();
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

            await waitForResolved(() => expect(chunks).to.have.length(2));
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
                 expect(iterator.options).to.have.length(1)
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
            const { mediaStreams, track1, track2, viewerStreams } =
                await createScenario({
                    first: { start: 0, type: "video" },
                    second: { start: 10, type: "video" }, // start first at 0 so we choose it as the track when listening to live
                });

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];

            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
            });

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
                expect(iterator!.options).to.have.length(2)
            );

            await track1.put(c1, { target: "all" });
            await track2.put(c2, { target: "all" });

            await waitForResolved(() => expect(chunks).to.have.length(1));

            expect(chunks[0].chunk.id).to.eq(c1.id);

            const secondOption = iterator.options.find((x) =>
                equals(x.id, track2.id)
            );
            if (!secondOption) {
                throw new Error("Missing option");
            }
            await iterator.selectOption(secondOption);
            expect(iterator.options).to.have.length(2);

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
            expect(iterator.options).to.have.length(2);
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
                expect(iterator.options).to.have.length(2)
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

            try {
                await waitForResolved(() =>
                    expect(iterator.options).to.have.length(1)
                );
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

            await waitForResolved(() => expect(viewerTracks).to.have.length(1));

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
            let totalTrackTime = 5000;
            let dataPoints = 100;
            const { track1, viewerStreams } = await createScenario({
                delta: totalTrackTime / dataPoints,
                first: { start: 0, size: dataPoints },
            });

            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            let viewerTracksChanges: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];

            let startLiveFeedSubscription: bigint | undefined = undefined;
            let hrtimeStart = hrtime.bigint();
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

            let chunkTime = 999999999n;
            await track1.put(
                new Chunk({
                    chunk: new Uint8Array([1, 2, 3]),
                    time: chunkTime,
                })
            );

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.timeBN)).to.deep.eq([
                    chunkTime,
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
            let hrtimeEnd = hrtime.bigint();

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

            console.log(" ----------- open again -------------- ");
            let viewerTracksChangesAgain: Track<
                AudioStreamDB | WebcodecsStreamDB
            >[][] = [];
            const secondIterator = await viewerStreams.iterate(0, {
                keepTracksOpen: true, // keep tracks alive after closing
                onProgress: (ev) => {
                    chunks.push(ev);
                },
                onTracksChange(tracks) {
                    viewerTracksChangesAgain.push(tracks);
                },
            });

            await delay(totalTrackTime);

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
                let framesPerTrack = 1;

                const { viewerStreams } = await createScenario({
                    first: { start: 0, size: framesPerTrack },
                });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let maxTime: number = 0;

                // start playing from track1 and then assume we will start playing from track2
                let onReplicationChanges: ReplicationRangeIndexable<"u64">[][] =
                    [];

                let t0 = +new Date();
                let t1: number | undefined = undefined;
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        t1 = +new Date();
                        chunks.push(ev);
                    },
                    onMaxTimeChange: (newMaxTime) => {
                        maxTime = newMaxTime.maxTime;
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

            it("time will progress on track", async () => {
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

                console.log(" ---------------------------- ");
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
                    changeProcessor: (change) => change, // allow concurrent tracks
                });

                await delay(2000); // some delay to make sure some data is played

                // expect no chunks to be received because first track started before the second track
                // and the first track ended after the second track started
                expect(chunks.length).to.eq(0);
            });

            it("overlapping partly multiple media types", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario({
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
                    changeProcessor: (change) => change, // allow concurrent tracks
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
        });

        describe("sequential", () => {
            it("start at 0", async () => {
                let trackCount = 2;

                const { viewerStreams } = await createScenario({
                    delta: 999,
                    first: { start: 0, size: trackCount, end: 999 },
                    second: { start: 1000, size: trackCount },
                });

                let chunks: { track: Track<any>; chunk: Chunk }[] = [];
                let tracks: Track<any>[][] = [];

                // start playing from track1 and then assume we will start playing from track2
                let maxTime = 0;
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
                    expect(chunks.length).to.eq(trackCount * 2)
                );
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

            it("many chunks", async () => {
                let size = 1e4;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 1,
                        first: { start: 0, size },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                const start = 0.23;
                let c = 0;
                console.log("start iterate");
                iterator = await viewerStreams.iterate(start, {
                    onProgress: (ev) => {
                        console.log(c++);
                        chunks.push(ev);
                    },
                });

                await delay(5e3); // why?
                await waitForResolved(() =>
                    expect(chunks.length).to.closeTo(size * (1 - start), 100)
                );
                console.log("-------- last ------------");
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

                let frames = 3000;

                for (let i = 0; i < frames; i++) {
                    track1.put(
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
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        let now = +new Date();
                        if (lastTs) {
                            maxDiff = Math.max(maxDiff, now - lastTs);
                            diffs.push(now - lastTs);
                        }
                        lastTs = now;
                        chunks.push(ev);
                    },
                });

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

                const t2 = 1e6 * MILLISECONDS_TO_MICROSECONDS;
                const t1 = t2 + 1;

                await delay(3e3);
                await waitForResolved(() =>
                    expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                        [track2.id],
                    ])
                );

                //  await delay(3e3);
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
                await viewerStreams.iterate(0, {
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
                        [],
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
                expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                    [track1.id],
                    [],
                ]);
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
                    onProgress: (ev) => {
                        chunks.push(ev);
                        if (chunks.length === halfChunks) {
                            return iterator.close();
                        }
                    },
                });

                await waitForResolved(() =>
                    expect(chunks).to.length(halfChunks)
                );
                expect(tracks.map((x) => x.map((y) => y.id))).to.deep.eq([
                    [track1.id],
                    [],
                ]); // last element will be [] i.e. closed, because we will fetch batches of 60 frames and it will reach the end
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

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(chunksCount * 2)
                    );
                } catch (error) {
                    throw error;
                }
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

                console.log("--------------------");
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

                try {
                    await waitForResolved(() =>
                        expect(chunks.length).to.eq(chunksPerTrack)
                    );
                    await waitForResolved(() =>
                        expect(maxTime).to.eq(
                            chunks[chunks.length - 1].track.startTime +
                                chunks[chunks.length - 1].chunk.time
                        )
                    );
                } catch (error) {
                    throw error;
                }

                expect(tracks).to.have.length(2);

                segmentsReplicatedByViewer = await (
                    tracks[1].source as AudioStreamDB | WebcodecsStreamDB
                ).chunks.log.replicationIndex.count({
                    query: {
                        hash: viewerStreams.node.identity.publicKey.hashcode(),
                    },
                });
                console.log(
                    "???",
                    tracks[1].node.identity.publicKey.hashcode()
                );
                expect(segmentsReplicatedByViewer).to.eq(1);

                expect(closeCall.called).to.be.false;
                await iterator.close();
                expect(closeCall.called).to.be.false; // since keepTracksOpen: true
            });

            it("close all tracks", async () => {
                let trackCount = 2;

                const { mediaStreams, track1, viewerStreams } =
                    await createScenario({
                        delta: 999,
                        first: { start: 0, size: trackCount, end: 999 },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

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
                await delay(4000);

                expect(closeCalled.calledOnce).to.be.true;
            });
        });
    });
});
