/**
    This file contains all the definitions for the databases related to media streaming and playback
 
    MediaStreamDB controls all the media sources in Tracks.
    Each Track is defined by its start and end time.
    Each Track contains a database of chunks which is the media
    Tracks can be of different types, like Video, Audio in different encodings

    E.g. A multiresolution stream with audia is done by having multiple tracks active at once. One track for each resolution,
    and one track for the audio.
    If a viewer only want to listen to the audio or specific resolution, they don't have to bother about the other tracks 
    since the viewer can choose to only "open" the tracks it is interested in
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         
    +-----------------------------------------------------------------------------------------------------------------+            
    |                                                                                                                 |            
    |    MediaStreamDB                                                                                                |            
    |    Host/Sender                                                                                                  |            
    |                                                                                                                 |            
    |                                        +------------------------+                                               |            
    |                                        |      Track<Video>      |                                               |            
    |                                        +------------------------+                                               |            
    |           +------------------------++-------------------------------------------------------------------+       |            
    |           |      Track<Video>      ||                           Track<Video>                            |       |            
    |           +------------------------++-------------------------------------------------------------------+       |            
    |           +------------------------+                                                                            |            
    |           |      Track<Audio>      |                                                                            |            
    |           +------------------------+                                                                            |            
    |                          +------------------------+                                                             |            
    |                          |      Track<Audio>      |                                                             |            
    |                          +------------------------+                                                             |            
    |                                                                                                                 |            
    |                                                                                                                 |            
    |     ---------------------------------------------------------------------------------------------------->       |            
    |                                                    Time                                                         |            
    |                                                                                                                 |            
    |                                                                                                                 |            
    +-----------------------------------------------------------------------------------------------------------------+            
                                                                                                                        
 */

import { field, variant, option, serialize, fixedArray } from "@dao-xyz/borsh";
import {
    sha256Base64Sync,
    PublicSignKey,
    toBase64,
    sha256Sync,
    fromBase64,
} from "@peerbit/crypto";
import {
    Documents,
    SearchRequest,
    Sort,
    SortDirection,
    IntegerCompare,
    Compare,
    MissingField,
    RoleOptions,
    SearchOptions,
    ResultsIterator,
    Or,
    And,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { v4 as uuid } from "uuid";
import { concat } from "uint8arrays";
import { Entry } from "@peerbit/log";
import { randomBytes } from "@peerbit/crypto";
import { hrtime } from "@peerbit/time";
import { delay, AbortError } from "@peerbit/time";
import PQueue from "p-queue";
import { equals } from "uint8arrays";

/* 
const utf8Encode = (value: string) => {
    const l = length(value);
    const arr = new Uint8Array(l);
    write(value, arr, 0);
    return arr;
};
 */
@variant(0)
export class Chunk {
    @field({ type: "string" })
    id: string;

    @field({ type: "u8" })
    private _type: 0 | 1 | 2;

    @field({ type: "u32" })
    time: number;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(props: {
        type?: "key" | "delta";
        chunk: Uint8Array;
        time: number;
    }) {
        this.id = uuid();
        this._type = 0;
        if (props.type == "key") {
            this._type = 1;
        } else {
            this._type = 2;
        }
        this.chunk = props.chunk;
        this.time = props.time;
    }
    get type(): "key" | "delta" | undefined {
        if (this._type === 0) {
            return undefined;
        }

        if (this._type === 1) {
            return "key";
        }

        if (this._type === 2) {
            return "delta";
        }
        throw new Error("Unexpected chunk type");
    }
}

@variant(0)
export class VideoInfo {
    @field({ type: option("u32") })
    width: number;

    @field({ type: option("u32") })
    height: number;

    constructor(properties: { width: number; height: number }) {
        this.width = properties.width;
        this.height = properties.height;
    }
}

@variant(0)
export class MediaStreamInfo {
    @field({ type: VideoInfo })
    video: VideoInfo;

    constructor(properties: { video: VideoInfo }) {
        if (properties.video)
            this.video =
                properties.video instanceof VideoInfo
                    ? properties.video
                    : new VideoInfo(properties.video);
    }

    hashcode() {
        return toBase64(serialize(this));
    }
}

type Args = { role?: RoleOptions; sync?: (entry: Entry<any>) => boolean };

@variant("track-source")
export abstract class TrackSource {
    @field({ type: Documents })
    private _chunks: Documents<Chunk>;

    constructor() {
        this._chunks = new Documents({
            id: randomBytes(32),
        });
    }

    get chunks() {
        return this._chunks;
    }

    async open(args: { sender: PublicSignKey } & Partial<Args>): Promise<void> {
        await this.chunks.open({
            type: Chunk,
            canPerform: async (_operation, context) => {
                const keys = await context.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(args.sender)) {
                        return true;
                    }
                }
                return false;
            },
            index: {
                fields: (obj) => {
                    return {
                        id: obj.id,
                        time: obj.time,
                        type: obj.type,
                    };
                },
            },
            role: args?.role,
            sync: args?.sync,
        });
    }

    close() {
        return this.chunks.close();
    }
}

@variant("audio-stream-db")
export class AudioStreamDB extends TrackSource {
    @field({ type: "u32" })
    sampleRate: number;

    constructor(properties: { sampleRate: number }) {
        super();
        this.sampleRate = properties.sampleRate;
    }
}

const serializeConfig = (config: VideoDecoderConfig) => {
    const toSerialize = {
        ...config,
        ...(config.description
            ? {
                  description: toBase64(
                      new Uint8Array(config.description as ArrayBufferLike)
                  ),
              }
            : {}),
    };
    return JSON.stringify(toSerialize);
};
const parseConfig = (string: string): VideoDecoderConfig => {
    const config = JSON.parse(string);
    if (config.description) {
        config.description = fromBase64(config.description);
    }
    return config;
};

@variant("webscodecs-stream-db")
export class WebcodecsStreamDB extends TrackSource {
    @field({ type: "string" })
    decoderConfigJSON: string;

    constructor(props: { decoderDescription: VideoDecoderConfig }) {
        const decoderDescription = serializeConfig(props.decoderDescription);

        super(); // Streams addresses will depend on its config
        this.decoderConfigJSON = decoderDescription;
    }

    private _decoderDescriptionObject: any;
    get decoderDescription(): VideoDecoderConfig | undefined {
        if (!this.decoderConfigJSON) {
            return undefined;
        }
        return (
            this._decoderDescriptionObject ||
            (this._decoderDescriptionObject = parseConfig(
                this.decoderConfigJSON
            ))
        );
    }
}

@variant("track")
export class Track<T extends TrackSource> extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: TrackSource })
    source: T; /// audio, video, whatever

    @field({ type: "u32" })
    startTime: number;

    @field({ type: option("u32") })
    endTime?: number; // when the track ended

    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: "bool" })
    private effects: false; // TODO effects, like transformation, scaling, filter, etc

    constructor(properties: {
        sender: PublicSignKey;
        start: number;
        end?: number;
        source: T;
    }) {
        super();
        this.id = randomBytes(32);
        this.startTime = properties.start;
        this.endTime = properties.end;
        this.source = properties.source;
        this.sender = properties.sender;
        this.effects = false;
    }

    setEnd(startTime: number) {
        this.endTime = +new Date() - startTime;
    }
    open(args?: Args): Promise<void> {
        return this.source.open({ ...args, sender: this.sender });
    }

    /**
     *
     * @param time in this coordinate space
     */
    async iterate(time: number) {
        // Find max media time

        // convert progress bar value into a media time

        console.log("START TRACK ITERATOR", {
            startTime: this.startTime,
            time,
        });

        // create an iterator that starts from the progress bar and goes forward
        return this.source.chunks.index.iterate(
            new SearchRequest({
                query: [
                    new IntegerCompare({
                        key: "time",
                        compare: Compare.GreaterOrEqual,
                        value: time,
                    }),
                ],
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: "time",
                    }),
                ],
            }),
            { remote: true, local: false }
        );
    }

    async last(): Promise<Chunk | undefined> {
        return (
            await this.source.chunks.index.search(
                new SearchRequest({
                    sort: [
                        new Sort({
                            direction: SortDirection.DESC,
                            key: "time",
                        }),
                    ],
                }),
                { local: true, remote: true, size: 1 }
            )
        )?.[0];
    }
}

export type TracksIterator = {
    time: () => number | "live";
    options: Track<WebcodecsStreamDB | AudioStreamDB>[];
    selectOption: (
        track: Track<WebcodecsStreamDB | AudioStreamDB>
    ) => Promise<void>;
    done: () => boolean;
    close: () => Promise<void>;
    play: () => void;
    pause: () => void;
    paused: boolean;
};

export type TrackChangeProcessor<T extends TrackSource = TrackSource> =
    (properties: {
        force?: boolean;
        add?: Track<T>;
        remove?: Track<T>;
        current: Track<T>[];
        options: Track<T>[];
    }) => { add?: Track<T>; remove?: Track<T> };

const oneVideoAndOneAudioChangeProcessor: TrackChangeProcessor = (change) => {
    if (change.add) {
        const alreayHave = change.current.find(
            (x) => x.source.constructor === change.add!.source.constructor
        );
        if (change.force) {
            // replace
            return { remove: alreayHave, add: change.add };
        } else {
            if (alreayHave) {
                return {};
            }
            return change;
        }
    }

    if (change.remove) {
        // if removing one track, maybe start another
        if (change.force) {
            return change;
        } else {
            const replaceWith = change.options.find(
                (x) =>
                    x.source.constructor === change.remove!.source.constructor
            );
            if (replaceWith) {
                return {
                    add: replaceWith,
                    remove: change.remove,
                };
            }
            return change;
        }
    }

    return change;
};

@variant("media-streams")
export class MediaStreamDB extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    tracks: Documents<Track<AudioStreamDB | WebcodecsStreamDB>>;

    constructor(owner: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super();
        this.id = randomBytes(32);
        this.owner = owner;
        this.tracks = new Documents({
            id: sha256Sync(
                concat([
                    new TextEncoder().encode("media-streams"),
                    this.id,
                    sha256Sync(this.owner.bytes),
                ])
            ),
        });
    }

    async open(args?: Args): Promise<void> {
        await this.tracks.open({
            type: Track,
            canPerform: async (opeation, { entry }) => {
                const keys = await entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(this.owner)) {
                        return true;
                    }
                }
                return false;
            },
            canOpen: (_) => Promise.resolve(false), // dont open subdbs by opening this db
            role: args?.role,
            sync: args?.sync,
        });
    }

    async getLatest(
        options?: SearchOptions<Track<AudioStreamDB | WebcodecsStreamDB>>
    ): Promise<Track<AudioStreamDB | WebcodecsStreamDB>[]> {
        const tracks = await this.tracks.index.search(
            new SearchRequest({
                query: [
                    new MissingField({
                        key: "endTime",
                    }),
                ],
                sort: [
                    new Sort({ key: "endTime", direction: SortDirection.DESC }),
                ],
            }),
            { ...options }
        );

        return tracks;
    }

    /* async getDuringOrLater(
        time: number,
        options?: SearchOptions<Track<AudioStreamDB | WebcodecsStreamDB>>
    ): Promise<Track<AudioStreamDB | WebcodecsStreamDB>[]> {
        const tracks = await this.tracks.index.search(
            new SearchRequest({
                query: [
                    new Or([
                        new And([
                            new IntegerCompare({
                                key: "startTime",
                                compare: Compare.GreaterOrEqual,
                                value: time,
                            }),
                            new Or([
                                new MissingField({
                                    key: "endTime",
                                }),
                                new IntegerCompare({
                                    key: "endTime",
                                    compare: Compare.Less,
                                    value: time,
                                }),
                            ])
                        ])
                    ])
                ],
                sort: [
                    new Sort({ key: "startTime", direction: SortDirection.DESC }),
                ],
            }),
            { ...options }
        );

        return tracks;
    } */

    /**
     *
     * @param progress [0,1] (the progress bar)
     */
    async iterate(
        progress: number | "live",
        opts?: {
            changeProcessor?: TrackChangeProcessor<
                WebcodecsStreamDB | AudioStreamDB
            >;
            onProgress?: (properties: {
                track: Track<WebcodecsStreamDB | AudioStreamDB>;
                chunk: Chunk;
            }) => void;
            onOptionsChange?: (
                options: Track<WebcodecsStreamDB | AudioStreamDB>[]
            ) => void;
        }
    ): Promise<TracksIterator> {
        if (!this.owner.equals(this.node.identity.publicKey)) {
            await this.tracks.log.waitForReplicator(this.owner);
        }

        const openTrackQueue = new PQueue({ concurrency: 1 });
        const changeProcessor =
            opts?.changeProcessor || oneVideoAndOneAudioChangeProcessor;
        let close: () => void;
        let play: () => void;
        let pause: () => void;
        let mediaTime: () => number | "live";
        let playedMediaTime = 0;
        let paused = false;
        let session = 0;
        let playing = false;
        const nowMicroSeconds = () => Number(hrtime.bigint() / 1000n);
        let startPlayAt: number | undefined = undefined;

        const endedTracks = new Set();

        const startTimer: () => void = () => {
            if (startPlayAt != null) {
                return;
            }
            startPlayAt = nowMicroSeconds();
        };

        // Find max media time
        // That is the media time corresponding to the track with the latest chunk
        let startProgressBarMediaTime: number | "live";
        if (typeof progress === "number" && progress < 1) {
            let maxTime = 0;
            const latestClosed = (
                await this.tracks.index.search(
                    new SearchRequest({
                        sort: [
                            new Sort({
                                direction: SortDirection.DESC,
                                key: "endTime",
                            }),
                        ],
                    }),
                    { local: true, remote: true, size: 1 }
                )
            )[0];
            if (latestClosed?.endTime != null) {
                maxTime = Math.max(maxTime, latestClosed.endTime);
            }

            const notClosed: Track<AudioStreamDB | WebcodecsStreamDB>[] =
                await this.tracks.index.search(
                    new SearchRequest({
                        query: [
                            new MissingField({
                                key: "endTime",
                            }),
                        ],
                    }),
                    { local: true, remote: true }
                );

            if (notClosed) {
                console.log("NOT CLOSED", notClosed.length);
                for (const track of notClosed) {
                    const openTrack = await this.node.open(track, {
                        existing: "reuse",
                        args: { role: "observer", sync: () => true },
                    });
                    const alreadyOpen = openTrack !== track;
                    await openTrack.source.chunks.log.waitForReplicator(
                        this.owner
                    );
                    maxTime = Math.max(
                        openTrack.startTime +
                            ((await openTrack.last())?.time || 0),
                        maxTime
                    );

                    if (!alreadyOpen) {
                        console.log("CLOSE TRACK b", openTrack.address);
                        await openTrack.close();
                    }
                }
            }
            // convert progress bar value into a media time
            startProgressBarMediaTime = Math.round(progress * maxTime);
        } else {
            startProgressBarMediaTime = "live";
        }

        console.log("START MEDIA TIME", startProgressBarMediaTime);
        const done = false;
        type TrackWithBuffer = {
            track: Track<any>;
            iterator?: ResultsIterator<Chunk>;
            last?: number;
            close?: () => void;
            open?: () => void;
        };

        let currentTracks: TrackWithBuffer[] = [];
        let currentTrackOptions: Track<any>[] = [];

        const selectOption = async (track: Track<any>) => {
            if (await removeTrack(track)) {
                return; // track was already selected, now unselected
            }

            return maybeChangeTrack({ add: track, force: true });
        };

        const removeTrack = async (track: Track<any>, ended?: boolean) => {
            console.log("REMOVE TRACK", track.startTime);
            const index = currentTracks.findIndex(
                (x) => x.track.address === track.address
            );
            if (index >= 0) {
                if (ended) {
                    const trackOptionIndex = currentTrackOptions.findIndex(
                        (x) => equals(x.id, track.id)
                    );
                    if (trackOptionIndex >= 0) {
                        currentTrackOptions.splice(trackOptionIndex, 1);
                    }
                    endedTracks.add(track.address);
                }

                const element = currentTracks.splice(index, 1)[0];
                opts?.onOptionsChange?.(currentTracks.map((x) => x.track));
                console.log("CLOSE TRACK A", element.track.address);
                await element.track.close();
                return true;
            }
            return false;
        };

        let pendingFrames: {
            track: Track<WebcodecsStreamDB | AudioStreamDB>;
            chunk: Chunk;
        }[] = [];
        const renderLoop = (currentSession: number) => {
            if (session !== currentSession) {
                return;
            }
            const currentTime = mediaTime() as number;
            const keepFrames: {
                track: Track<WebcodecsStreamDB | AudioStreamDB>;
                chunk: Chunk;
            }[] = [];
            for (const frame of pendingFrames) {
                if (startProgressBarMediaTime === "live") {
                    opts?.onProgress?.({
                        chunk: frame.chunk,
                        track: frame.track,
                    });
                } else {
                    const startAt = frame.track.startTime + frame.chunk.time;

                    const isLaterThanStartProgress =
                        startAt >= startProgressBarMediaTime;
                    const isLaterThanProgress = startAt <= currentTime;
                    //       console.log(startAt, currentTime, isLaterThanProgress, isLaterThanStartProgress)

                    if (isLaterThanStartProgress) {
                        if (isLaterThanProgress || startPlayAt == null) {
                            /*  console.log("PLAY FRAME", {
                                 mediaTime: mediaTime(),
                                 startPlayAt,
                                 startAt,
                                 playedMediaTime,
                                 track: frame.track.startTime,
                             }); */
                            playedMediaTime = Math.max(
                                startAt,
                                playedMediaTime
                            );
                            startTimer();
                            opts?.onProgress?.({
                                chunk: frame.chunk,
                                track: frame.track,
                            });
                        } else {
                            keepFrames.push(frame);
                        }
                    } else {
                        console.log("DISCARD!", startAt);
                    }
                }
            }
            pendingFrames = keepFrames;
            requestAnimationFrame(() => renderLoop(currentSession));
        };

        const maybeChangeTrack = async (change: {
            force?: boolean;
            add?: Track<any>;
            remove?: Track<any>;
        }) => {
            return openTrackQueue.add(async () => {
                const filteredChange = changeProcessor({
                    force: change.force,
                    current: currentTracks.map((x) => x.track),
                    options: currentTrackOptions,
                    add: change.add,
                    remove: change.remove,
                });
                if (filteredChange.add) {
                    await addTrack(filteredChange.add);
                }
                if (filteredChange.remove) {
                    await removeTrack(filteredChange.remove);
                }
            });
        };
        const addTrack = async (track: Track<any>) => {
            let close: () => void;
            let open: () => void;

            console.log("OPEN TRACK!", toBase64(track.id));
            track = await this.node.open(track, {
                args: { role: "observer", sync: () => true },
                existing: "reuse",
            });
            await track.source.chunks.log.waitForReplicator(this.owner);

            console.log(
                "INIT TRAACK AT",
                startProgressBarMediaTime,
                playedMediaTime
            );

            if (startProgressBarMediaTime === "live") {
                let lastTime = -1;
                const listener = (change) => {
                    for (const chunk of change.detail.added) {
                        if (chunk.time > lastTime) {
                            pendingFrames.push({ track, chunk });
                            lastTime = chunk.time;
                        }
                    }
                };
                open = () => {
                    track.source.chunks.events.addEventListener(
                        "change",
                        listener
                    );
                };
                close = () => {
                    track.source.chunks.events.removeEventListener(
                        "change",
                        listener
                    );
                };
            } else {
                let last: number | undefined = undefined;
                let iterator: ResultsIterator<Chunk> | undefined = undefined;

                console.log(
                    "START BUFFER LOOP TRACK",
                    track.startTime,
                    mediaTime(),
                    playedMediaTime,
                    startProgressBarMediaTime
                );
                const bufferLoop = async (currentSession: number) => {
                    const bufferTime = 3e6; // 3 seconds in microseconds

                    if (!iterator) {
                        /*   console.log("START ITERATOR", { track: track.startTime, offset: (playedMediaTime > 0 ? playedMediaTime : (startProgressBarMediaTime as number)) - track.startTime, playedMediaTime });
                          iterator = await track.iterate(Math.max((playedMediaTime > 0 ? playedMediaTime : (startProgressBarMediaTime as number)) - track.startTime, 0) as number) */

                        console.log("START ITERATOR", {
                            track: track.startTime,
                            offset1: Math.max(
                                (startProgressBarMediaTime as number) -
                                    track.startTime,
                                0
                            ) as number,
                            offset2:
                                (playedMediaTime > 0
                                    ? playedMediaTime
                                    : (startProgressBarMediaTime as number)) -
                                track.startTime,
                            playedMediaTime,
                        });
                        iterator = await track.iterate(
                            Math.max(
                                (startProgressBarMediaTime as number) -
                                    track.startTime,
                                0
                            ) as number
                        );
                    }

                    const loopCondition = () =>
                        (last == null ||
                            last <
                                playedMediaTime -
                                    track.startTime +
                                    bufferTime) &&
                        !iterator?.done();

                    const q = loopCondition();
                    if (!q && track.startTime === 0) {
                        const a =
                            (mediaTime() as number) -
                            track.startTime +
                            bufferTime;
                    }
                    while (loopCondition()) {
                        // buffer bufferTime worth of video
                        const newChunks = await iterator?.next(60);

                        if (session !== currentSession) {
                            return;
                        }

                        if (!newChunks || newChunks.length === 0) {
                            console.log("NO MORE ELEMENTS!");
                            return removeTrack(track, true);
                        }
                        /* console.log(
                            "NEW CHUNKS?",
                            { startTime: track.startTime },
                            newChunks.map((x) => track.startTime + x.time)
                        );
 */
                        last = newChunks[newChunks.length - 1].time;

                        if (newChunks.length > 0) {
                            newChunks.forEach((chunk) => {
                                pendingFrames.push({ chunk, track });
                            });
                        }
                        if (iterator?.done()) {
                            console.log("ITERATOR DONE!");
                            return removeTrack(track, true);
                        }
                    }

                    if (session !== currentSession) {
                        return;
                    }
                    if (track.startTime === 0) {
                        console.log(
                            "BUFFER MORE NEXT",
                            bufferTime,
                            last,
                            mediaTime()
                        );
                    }
                    delay(bufferTime / 1e3, { signal: pauseController.signal })
                        .then(() => bufferLoop(currentSession))
                        .catch((e) => {
                            if (e instanceof AbortError) {
                                return;
                            }
                            throw e;
                        });
                };
                bufferLoop(session);
                open = () => {
                    bufferLoop(session);
                };
                close = () => {
                    iterator?.close();
                };
            }

            console.log("PUSH TRACK");
            const trackWithBuffer: TrackWithBuffer = {
                track,
                open,
                close: () => {
                    close();
                    return track.close();
                },
            };

            currentTracks.push(trackWithBuffer);
            opts?.onOptionsChange?.(currentTracks.map((x) => x.track));
        };

        const scheduleTrackLoop = (fromSession: number) => {
            if (fromSession !== session) {
                return;
            }

            const currentTime = mediaTime();
            const keepTracks: Track<WebcodecsStreamDB | AudioStreamDB>[] = [];
            for (const track of currentTrackOptions) {
                if (currentTime === "live") {
                    maybeChangeTrack({ add: track });
                } else if (track.startTime <= currentTime) {
                    if (track.endTime == null || track.endTime > currentTime) {
                        maybeChangeTrack({ add: track });
                    }

                    // else ignore track!
                } else {
                    keepTracks.push(track);
                }
            }
            currentTrackOptions = keepTracks;

            requestAnimationFrame(() => scheduleTrackLoop(fromSession));
        };

        let pauseController = new AbortController();
        if (startProgressBarMediaTime === "live") {
            const listener = async (change) => {
                if (change.detail.added)
                    for (const added of change.detail.added) {
                        await addTrack(added); // TODO only add trackes we want to listen on
                    }
                if (change.detail.removed)
                    for (const remove of change.detail.removed) {
                        await removeTrack(remove);
                    }
            };
            await this.getLatest().then(async (tracks) => {
                //  const openTracks = await Promise.all(tracks.map(async (x) => { const openTrack = await this.node.open(x); openTrack.source.chunks.log.waitForReplicator(this.owner); return openTrack }))
                return listener({ detail: { added: tracks } });
            });
            close = () =>
                this.tracks.events.removeEventListener("change", listener);
            pause = close;
            play = () => {
                this.tracks.events.removeEventListener("change", listener);
                this.tracks.events.addEventListener("change", listener);
            };
            mediaTime = () => "live";
        } else {
            let playbackTime = startProgressBarMediaTime;

            // create a iterator that goes from `progressBarMediaTime` and forward
            // for every overlapping track, open it, and iterate until the end
            const tracksIterator = this.tracks.index.iterate(
                typeof startProgressBarMediaTime === "number"
                    ? new SearchRequest({
                          query: [
                              new Or([
                                  new MissingField({
                                      key: "endTime",
                                  }),
                                  new IntegerCompare({
                                      key: "endTime",
                                      compare: Compare.Greater,
                                      value: startProgressBarMediaTime,
                                  }),
                              ]),
                          ],
                          sort: [
                              new Sort({
                                  direction: SortDirection.ASC,
                                  key: "startTime",
                              }),
                          ],
                      })
                    : new SearchRequest({
                          query: [
                              new MissingField({
                                  key: "endTime",
                              }),
                          ],
                      }),
                { remote: true, local: false }
            );

            const bufferLoop = async (currentSession: number) => {
                // buffer tracks that are to start, or should start with at least bufferTime
                const bufferAhead = 1e3;
                const bufferTo =
                    (startProgressBarMediaTime as number) + bufferAhead;
                let nextCheckTime = bufferAhead;
                while (true as any) {
                    if (session !== currentSession) {
                        return;
                    }
                    const current = await tracksIterator.next(1);
                    if (current.length === 0) {
                        break;
                    }

                    for (const track of current) {
                        currentTrackOptions.push(track);
                    }

                    const last = current[current.length - 1];
                    if (last.startTime > bufferTo) {
                        nextCheckTime = (last.startTime - bufferTo) / 1e3; // microseconds to milliseconds
                        break;
                    }
                }

                delay(nextCheckTime, { signal: pauseController.signal })
                    .then(() => bufferLoop(currentSession))
                    .catch((e) => {
                        if (e instanceof AbortError) {
                            return;
                        }
                        throw e;
                    });
            };

            // TODO
            close = () => {
                return tracksIterator.close();
            };

            pause = () => {
                if (!playing) {
                    return;
                }
                playing = false;
                playbackTime +=
                    nowMicroSeconds() -
                    (startPlayAt != null
                        ? nowMicroSeconds() - startPlayAt!
                        : 0)!;
                startPlayAt = undefined;
            };

            play = () => {
                playing = true;
                bufferLoop(session);
            };

            mediaTime = () => {
                if (!playing) {
                    throw new Error("Not playing");
                }
                return (
                    playbackTime +
                    (startPlayAt != null ? nowMicroSeconds() - startPlayAt! : 0)
                );
            };
        }

        const playCtrl = () => {
            pauseController = new AbortController();
            session++;
            play();
            paused = false;
            scheduleTrackLoop(session);
            renderLoop(session);
            for (const track of currentTracks) {
                track.open?.();
            }
        };

        const pauseCtrl = async () => {
            pauseController.abort("Paused");
            session++;
            pause();
            paused = true;
            openTrackQueue.clear();
            await openTrackQueue.onEmpty();
            for (const track of currentTracks) {
                track.close?.();
            }
            currentTracks = [];
        };

        const closeCtrl = async () => {
            await pauseCtrl();
            session++;
            await Promise.all([
                close(),
                ...currentTracks.map((x) => x.iterator?.close()),
            ]);
            currentTracks = [];
            opts?.onOptionsChange?.([]);
        };
        playCtrl();

        return {
            time: mediaTime,
            options: currentTracks.map((x) => x.track),
            play: playCtrl,
            pause: pauseCtrl,
            paused,
            selectOption,
            done: () => done,
            close: closeCtrl,
        };
    }
}
