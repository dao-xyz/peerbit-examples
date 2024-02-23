import { Peerbit } from "peerbit";
import {
    AudioStreamDB,
    Chunk,
    MediaStreamDB,
    Track,
    TracksIterator,
    WebcodecsStreamDB,
} from "../media/database";
import { delay, waitForResolved } from "@peerbit/time";
import { equals } from "uint8arrays";

const MILLISECONDS_TO_MICROSECONDS = 1e3;

describe("MediaStream", () => {
    let streamer: Peerbit,
        viewer: Peerbit,
        cleanup: (() => Promise<void>) | undefined,
        iterator: TracksIterator;

    beforeAll(async () => {
        //  jest.useFakeTimers();
        global.requestAnimationFrame = function (cb) {
            return setTimeout(cb, 0);
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
        await cleanup?.();
        await iterator?.close();
    });

    const createScenario1 = async (properties: {
        delay?: number;
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
    }) => {
        const delay = properties.delay ?? 1;
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
        for (let i = 0; i < (properties.first.size ?? 1000); i++) {
            track1.source.chunks.put(
                new Chunk({
                    chunk: new Uint8Array([i]),
                    time: i * MILLISECONDS_TO_MICROSECONDS * delay,
                    type: "key",
                }),
                { target: "all" }
            );
        }

        const track2 = await streamer.open(
            new Track({
                sender: streamer.identity.publicKey,
                source:
                    properties.second.type === "video"
                        ? new WebcodecsStreamDB({
                              decoderDescription: { codec: "av01" },
                          })
                        : new AudioStreamDB({ sampleRate: 44100 }),
                start: properties.second.start * MILLISECONDS_TO_MICROSECONDS,
                end:
                    properties.second.end != null
                        ? properties.second.end * MILLISECONDS_TO_MICROSECONDS
                        : undefined,
            })
        );
        for (let i = 0; i < (properties.second.size ?? 1000); i++) {
            track2.source.chunks.put(
                new Chunk({
                    chunk: new Uint8Array([i]),
                    time: i * MILLISECONDS_TO_MICROSECONDS * delay,
                    type: "key",
                }),
                { target: "all" }
            );
        }

        await mediaStreams.tracks.put(track1);
        await mediaStreams.tracks.put(track2);

        const viewerStreams = await viewer.open(mediaStreams.clone(), {
            args: { role: { type: "observer" } },
        });

        cleanup = async () => {
            await mediaStreams.close();
            await viewerStreams.close();
        };

        return { mediaStreams, track1, track2, viewerStreams };
    };

    describe("live", () => {
        it("new", async () => {
            const { mediaStreams, track1, track2, viewerStreams } =
                await createScenario1({
                    first: { start: 10 },
                    second: { start: 100 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
            });
            const c1 = new Chunk({
                chunk: new Uint8Array([101]),
                time: 101 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([102]),
                time: 102 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            await waitForResolved(() =>
                expect(iterator.current).toHaveLength(1)
            );
            await waitForResolved(() =>
                expect(iterator.options).toHaveLength(2)
            );
            await delay(1000);
            await track1.source.chunks.put(c1, { target: "all" });
            await waitForResolved(() => expect(chunks).toHaveLength(1));
            await track1.source.chunks.put(c2, { target: "all" });
            await waitForResolved(() => expect(chunks).toHaveLength(2)); // because old frame
            expect(chunks[0].chunk.id).toEqual(c1.id);
            expect(chunks[1].chunk.id).toEqual(c2.id);
        });

        it("old ignored", async () => {
            const { mediaStreams, track1, track2, viewerStreams } =
                await createScenario1({
                    first: { start: 10 },
                    second: { start: 100 },
                });
            let chunks: { track: Track<any>; chunk: Chunk }[] = [];
            iterator = await viewerStreams.iterate("live", {
                onProgress: (ev) => {
                    chunks.push(ev);
                },
            });

            await waitForResolved(() =>
                expect(iterator.current).toHaveLength(1)
            );
            await waitForResolved(() =>
                expect(iterator.options).toHaveLength(2)
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
            await track1.source.chunks.put(c1, { target: "all" });

            await waitForResolved(() => expect(chunks).toHaveLength(1));
            await track1.source.chunks.put(c2, { target: "all" });
            await delay(3000);
            expect(chunks).toHaveLength(1);
        });

        it("select options", async () => {
            const { mediaStreams, track1, track2, viewerStreams } =
                await createScenario1({
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
                time: 103 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c2 = new Chunk({
                chunk: new Uint8Array([103]),
                time: 103 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            // now we want to listen to the other track
            await waitForResolved(() =>
                expect(iterator!.options).toHaveLength(2)
            );

            await track1.source.chunks.put(c1, { target: "all" });
            await track2.source.chunks.put(c2, { target: "all" });

            await waitForResolved(() => expect(chunks).toHaveLength(1));

            expect(chunks[0].chunk.id).toEqual(c1.id);

            const secondOption = iterator.options.find((x) =>
                equals(x.id, track2.id)
            );
            if (!secondOption) {
                throw new Error("Missing option");
            }
            await iterator.selectOption(secondOption);
            expect(iterator.options).toHaveLength(2);

            const c3 = new Chunk({
                chunk: new Uint8Array([104]),
                time: 104 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });
            const c4 = new Chunk({
                chunk: new Uint8Array([104]),
                time: 104 * MILLISECONDS_TO_MICROSECONDS,
                type: "key",
            });

            await track1.source.chunks.put(c3, { target: "all" });
            await track2.source.chunks.put(c4, { target: "all" });

            await waitForResolved(() => expect(chunks).toHaveLength(2));
            expect(chunks[1].chunk.id).toEqual(c4.id);
            expect(iterator.options).toHaveLength(2);
        });

        it("options are updated", async () => {
            const mediaStreams = await streamer.open(
                new MediaStreamDB(streamer.identity.publicKey)
            );

            const viewerStreams = await viewer.open(mediaStreams.clone(), {
                args: { role: { type: "observer" } },
            });

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
                expect(iterator.options).toHaveLength(2)
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

            await track1.source.chunks.put(c1, { target: "all" });
            await track2.source.chunks.put(c2, { target: "all" });

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.id)).toEqual([c1.id])
            );

            track1.setEnd(0); // end now
            await mediaStreams.tracks.put(track1, { target: "all" });

            await waitForResolved(() =>
                expect(iterator.options).toHaveLength(1)
            );
            await waitForResolved(() =>
                expect(iterator.current).toHaveLength(1)
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

            await track1.source.chunks.put(c3, { target: "all" });
            await track2.source.chunks.put(c4, { target: "all" });

            await waitForResolved(() =>
                expect(chunks.map((x) => x.chunk.id)).toEqual([c1.id, c4.id])
            );
        });
    });

    describe("progress", () => {
        describe("overlapping", () => {
            it("will deduplicate by type", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
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
                    expect(chunks.length).toEqual(framesPerTrack)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).toEqual(framesPerTrack)
                );
            });

            it("will not go back intime for same source", async () => {
                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
                        delay: 1000,
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
                expect(chunks.length).toEqual(0);
            });

            it("overlapping partly multiple media types", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
                        delay: 1000,
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
                try {
                    await waitForResolved(() =>
                        expect(chunks.length).toEqual(expecteChunkCount)
                    );
                    await delay(2000);
                    await waitForResolved(() =>
                        expect(chunks.length).toEqual(expecteChunkCount)
                    );
                } catch (error) {
                    throw error;
                }
            });
        });

        describe("sequential", () => {
            it("start at 0", async () => {
                let trackCount = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
                        delay: 999,
                        first: { start: 0, size: trackCount, end: 999 },
                        second: { start: 1000, size: trackCount },
                    });
                let chunks: { track: Track<any>; chunk: Chunk }[] = [];

                // start playing from track1 and then assume we will start playing from track2
                iterator = await viewerStreams.iterate(0, {
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                await waitForResolved(() =>
                    expect(chunks.length).toEqual(trackCount * 2)
                );
            });

            it("0.3", async () => {
                let framesPerTrack = 100;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
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
                    onProgress: (ev) => {
                        chunks.push(ev);
                    },
                });
                const expecteChunkCount = Math.round(
                    (1 - progress) * (framesPerTrack * 2)
                );
                try {
                    await waitForResolved(() =>
                        expect(
                            Math.abs(chunks.length - expecteChunkCount)
                        ).toBeLessThanOrEqual(1)
                    );
                    await delay(2000);
                    await waitForResolved(() =>
                        expect(
                            Math.abs(chunks.length - expecteChunkCount)
                        ).toBeLessThanOrEqual(1)
                    );
                } catch (error) {
                    throw error;
                }
            });

            it("buffers evenly", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone(), {
                    args: { role: { type: "observer" } },
                });

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

                let frames = 3000;

                for (let i = 0; i < frames; i++) {
                    track1.source.chunks.put(
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
                    expect(chunks.length).toEqual(frames)
                );
                let t1 = +new Date();
                expect(t1 - t0).toBeGreaterThan(frames);

                let meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
                expect(meanDiff - 1).toBeLessThan(0.001); // TODO polyfill requestAnimationFrame better to make this test more reliable
            });

            it("pause", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone(), {
                    args: { role: { type: "observer" } },
                });

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
                    track1.source.chunks.put(
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

                await waitForResolved(() =>
                    expect(chunks.length).toEqual(frames / 2)
                );

                iterator.play();

                await waitForResolved(() =>
                    expect(chunks.length).toEqual(frames)
                );
            });

            it("close", async () => {
                const mediaStreams = await streamer.open(
                    new MediaStreamDB(streamer.identity.publicKey)
                );

                const viewerStreams = await viewer.open(mediaStreams.clone(), {
                    args: { role: { type: "observer" } },
                });

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
                    track1.source.chunks.put(
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

                await waitForResolved(() =>
                    expect(chunks.length).toEqual(frames / 2)
                );
                await delay(2000);
                expect(chunks.length).toEqual(frames / 2);
            });
        });
    });
});
