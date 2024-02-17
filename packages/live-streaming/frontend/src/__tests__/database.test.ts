import { Peerbit } from "peerbit";
import {
    Chunk,
    MediaStreamDB,
    Track,
    WebcodecsStreamDB,
} from "../media/database";
import { delay, waitForResolved } from "@peerbit/time";

const MILLISECONDS_TO_MICROSECONDS = 1e3;

describe("MediaStream", () => {
    let streamer: Peerbit,
        viewer: Peerbit,
        cleanup: (() => Promise<void>) | undefined,
        iterator: { close: () => Promise<void> | void };

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
        await streamer.stop();
        await viewer.stop();
    });

    afterEach(async () => {
        await cleanup?.();
        await iterator?.close();
    });

    const createScenario1 = async (properties: {
        delay?: number;
        first: { start: number; end?: number; size?: number };
        second: { start: number; end?: number; size?: number };
    }) => {
        const delay = properties.delay ?? 1;
        const mediaStreams = await streamer.open(
            new MediaStreamDB(streamer.identity.publicKey)
        );
        const track1 = await streamer.open(
            new Track({
                sender: streamer.identity.publicKey,
                source: new WebcodecsStreamDB({
                    decoderDescription: { codec: "av01" },
                }),
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
                source: new WebcodecsStreamDB({
                    decoderDescription: { codec: "av01" },
                }),
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
            await track2.source.chunks.put(c1, { target: "all" });
            await waitForResolved(() => expect(chunks).toHaveLength(1));
            await track2.source.chunks.put(c2, { target: "all" });
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
            await track2.source.chunks.put(c1, { target: "all" });
            await waitForResolved(() => expect(chunks).toHaveLength(1));
            await track2.source.chunks.put(c2, { target: "all" });
            await delay(3000);
            expect(chunks).toHaveLength(1);
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

            it("overlapping partly", async () => {
                let framesPerTrack = 2;

                const { mediaStreams, track1, track2, viewerStreams } =
                    await createScenario1({
                        delay: 1000,
                        first: { start: 0, size: framesPerTrack, end: 1000 },
                        second: { start: 500, size: framesPerTrack, end: 1500 },
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
                    expect(chunks.length).toEqual(expecteChunkCount)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).toEqual(expecteChunkCount)
                );
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
                await waitForResolved(() =>
                    expect(chunks.length).toEqual(expecteChunkCount)
                );
                await delay(2000);
                await waitForResolved(() =>
                    expect(chunks.length).toEqual(expecteChunkCount)
                );
            });
        });
    });
});
