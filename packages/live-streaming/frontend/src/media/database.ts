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
    IsNull,
    SearchOptions,
    ResultsIterator,
    Or,
    And,
    DocumentsChange,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { concat } from "uint8arrays";
import { randomBytes } from "@peerbit/crypto";
import { delay, waitFor, AbortError } from "@peerbit/time";
import PQueue from "p-queue";
import { equals } from "uint8arrays";
import { createDocumentDomain, CustomDomain } from "./domain";
import pQueue from "p-queue";

/*
const utf8Encode = (value: string) => {
    const l = length(value);
    const arr = new Uint8Array(l);
    write(value, arr, 0);
    return arr;
};
 */

const shiftToU32 = (value: number) => value % 0xffffffff;

@variant(0)
export class Chunk {
    @field({ type: "u8" })
    private _type: 0 | 1 | 2;

    @field({ type: "u64" })
    private _time: bigint;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(props: {
        type?: "key" | "delta";
        chunk: Uint8Array;
        time: bigint | number;
    }) {
        this._type = 0;
        if (props.type == "key") {
            this._type = 1;
        } else {
            this._type = 2; // "delta"
        }
        this.chunk = props.chunk;
        this._time = BigInt(props.time);
    }

    get id(): string {
        return String(this.time);
    }

    get time() {
        return Number(this._time);
    }

    get timeBN() {
        return this._time;
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

class ChunkIndexable {
    @field({ type: "string" })
    id: string;

    @field({ type: option("string") })
    type: "key" | "delta" | undefined;

    @field({ type: "u64" })
    time: bigint;

    @field({ type: "u64" })
    timestamp: bigint;

    constructor(chunk: {
        id: string;
        type: "key" | "delta" | undefined;
        time: bigint | number;
        timestamp: bigint | number;
    }) {
        this.id = chunk.id;
        this.type = chunk.type;
        this.time = BigInt(chunk.time);
        this.timestamp = BigInt(chunk.timestamp);
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

type Args = {
    replicate?: "live" | "streamer" | false;
};

@variant("track-source")
export abstract class TrackSource {
    @field({ type: Documents })
    private _chunks: Documents<Chunk, ChunkIndexable, CustomDomain>;

    constructor() {
        this._chunks = new Documents({
            id: randomBytes(32),
        });
    }

    get chunks() {
        return this._chunks;
    }

    async open(args: { sender: PublicSignKey } & Partial<Args>): Promise<void> {
        console.log(
            "LISTEN FROM",
            args?.replicate,
            shiftToU32(+new Date()),
            "TO",
            shiftToU32(+new Date()) + 24 * 60 * 60 * 1e3
        );
        console.log("REPLICATE FROM", shiftToU32(+new Date()));

        await this.chunks.open({
            type: Chunk,
            canPerform: async (props) => {
                const keys = await props.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(args.sender)) {
                        return true;
                    }
                }
                return false;
            },
            index: {
                type: ChunkIndexable,
                transform: (obj, ctx) => {
                    return new ChunkIndexable({
                        id: obj.id,
                        time: obj.timeBN,
                        type: obj.type,
                        timestamp: ctx.created,
                    });
                },
            },
            replicate:
                args?.replicate === "live"
                    ? {
                          // 24 hourss in ms
                          factor: 24 * 60 * 60 * 1e3,
                          offset: shiftToU32(+new Date()),
                          normalized: false,
                          strict: true,
                      }
                    : args.replicate === "streamer"
                    ? { factor: 1 }
                    : args.replicate ?? { factor: 1 },
            domain: createDocumentDomain(this.chunks, {
                fromEntry: (entry) => {
                    const out = shiftToU32(
                        Number(
                            entry.meta.clock.timestamp.wallTime / BigInt(1e6)
                        )
                    );
                    /*   console.trace("OUT", out) */
                    return out;
                },
            }),
        });
    }

    close() {
        return this.chunks.close();
    }

    abstract get mediaType(): "audio" | "video";
}

@variant("audio-stream-db")
export class AudioStreamDB extends TrackSource {
    @field({ type: "u32" })
    sampleRate: number;

    @field({ type: "u8" })
    channels: number;

    constructor(properties: { sampleRate: number; channels?: number }) {
        super();
        this.sampleRate = properties.sampleRate;
        this.channels = properties.channels || 2;
    }

    get mediaType() {
        return "audio" as const;
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

    get mediaType() {
        return "video" as const;
    }
}

@variant("track")
export class Track<
    T extends TrackSource = AudioStreamDB | WebcodecsStreamDB
> extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: TrackSource })
    source: T; /// audio, video, whatever

    @field({ type: "u64" })
    private _startTime: bigint;

    @field({ type: option("u64") })
    private _endTime?: bigint; // when the track ended

    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: "bool" })
    private effects: false; // TODO effects, like transformation, scaling, filter, etc

    private _now?: () => bigint | number;
    private _globalTime?: bigint | number;

    constructor(properties: {
        sender: PublicSignKey;
        now?: () => bigint | number;
        globalTime?: bigint | number;
        start?: number | bigint;
        end?: number | bigint;
        source: T;
    }) {
        super();
        this.id = randomBytes(32);
        this._now = properties.now;
        this._globalTime = properties.globalTime;
        this._startTime =
            properties.start != null
                ? typeof properties.start === "number"
                    ? BigInt(properties.start)
                    : properties.start
                : this.timeSinceStart();
        this._endTime =
            typeof properties.end === "number"
                ? BigInt(properties.end)
                : properties.end;
        this.source = properties.source;
        this.sender = properties.sender;
        this.effects = false;
    }

    private timeSinceStart() {
        if (this._now == null) {
            throw new Error("Can not set end time without start time");
        }
        if (this._globalTime == null) {
            throw new Error("Can not set end time without global time");
        }
        return BigInt(this._now()) - BigInt(this._globalTime);
    }

    setEnd(time?: bigint | number) {
        this._endTime = time != null ? BigInt(time) : this.timeSinceStart();
    }

    open(args?: Args): Promise<void> {
        return this.source.open({ ...args, sender: this.sender });
    }

    get endTime(): number | undefined {
        return this._endTime == null ? undefined : Number(this._endTime);
    }

    get endTimeBigInt() {
        return this._endTime;
    }

    get duration() {
        if (this._endTime == null) {
            return "live";
        }
        return Number(this._endTime - this._startTime);
    }

    get startTime() {
        return Number(this._startTime);
    }

    get startTimeBigInt() {
        return this._startTime;
    }

    /**
     *
     * @param time in this coordinate space
     */
    async iterate(time: number) {
        // TODO live query instead (?)
        try {
            await waitFor(
                async () =>
                    (await this.source.chunks.log.getReplicators()).size > 0,
                { timeout: 5e3 }
            );
        } catch (error) {
            throw new Error("No replicators found for track");
        }

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
            {
                remote: {
                    eager: true, // TODO eager needed?
                },
                local: true,
            }
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
                    fetch: 1,
                }),
                {
                    local: true,
                    remote: {
                        eager: true,
                    },
                }
            )
        )?.[0];
    }
}

class TrackIndexable {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    sender: string;

    @field({ type: "u64" })
    startTime: bigint;

    @field({ type: option("u64") })
    endTime: bigint | undefined;

    @field({ type: "u32" })
    duration: number;

    constructor(track: Track) {
        this.id = toBase64(track.id);
        this.startTime = track.startTimeBigInt;
        this.endTime = track.endTimeBigInt;
        this.sender = track.sender.hashcode();
        this.duration = track.duration === "live" ? 0 : track.duration;
    }
}

export type TracksIterator = {
    time: () => number | "live";
    options: Track<WebcodecsStreamDB | AudioStreamDB>[];
    current: TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>[];
    selectOption: (
        track: Track<WebcodecsStreamDB | AudioStreamDB>
    ) => Promise<void>;
    close: () => Promise<void>;
    play: () => void;
    pause: () => void;
    paused: boolean;
};

type TrackWithBuffer<T extends TrackSource> = {
    track: Track<T>;
    iterator?: ResultsIterator<Chunk>;
    last?: number;
    close?: () => void;
    open?: () => void;
};

export type TrackChangeProcessor<
    T extends TrackSource = WebcodecsStreamDB | AudioStreamDB
> = (properties: {
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
export class MediaStreamDB extends Program<{}> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    tracks: Documents<Track<AudioStreamDB | WebcodecsStreamDB>, TrackIndexable>;

    private maxTime: number | undefined = undefined;

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

    async open(args?: {}): Promise<void> {
        await this.tracks.open({
            type: Track,
            canPerform: async (props) => {
                const keys = await props.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(this.owner)) {
                        return true;
                    }
                }
                return false;
            },
            canOpen: (_) => Promise.resolve(false), // dont open subdbs by opening this db
            replicate: {
                factor: 1,
            },
            index: {
                type: TrackIndexable,
            },
        });
    }

    async getLatest(
        options?: SearchOptions<Track<AudioStreamDB | WebcodecsStreamDB>, any>
    ): Promise<Track<AudioStreamDB | WebcodecsStreamDB>[]> {
        console.log("QUERY", options);
        const tracks = await this.tracks.index.search(
            new SearchRequest({
                query: [
                    new IsNull({
                        key: "endTime",
                    }),
                ],
                sort: [
                    new Sort({
                        key: "startTime",
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
            {
                ...options,
                remote: {
                    eager: true,
                    ...(typeof options?.remote === "object"
                        ? options?.remote
                        : {}),
                },
            }
        );

        return tracks;
    }

    private async subscribeForMaxTime(
        onChange: (maybeNewMaxtime: number) => void
    ) {
        let singleQueue = new pQueue({ concurrency: 1 });

        const fn = () => async () => {
            const notClosed: Track[] = await this.tracks.index.search(
                new SearchRequest({
                    query: [
                        new IsNull({
                            key: "endTime",
                        }),
                    ],
                }),
                {
                    local: true,
                    remote: {
                        eager: true,
                    },
                }
            );

            let maxTime: number | undefined = undefined;
            if (notClosed.length > 0) {
                for (const track of notClosed) {
                    const openTrack = await this.node.open(track, {
                        existing: "reuse",
                        args: { replicate: false }, // TODO repopen as replicator later?
                    });

                    const alreadyOpen = openTrack !== track;
                    // TODO assumption, streamer is always replicator, is this correct?
                    // if this is not true, then fetching the latest chunk needs to some kind of warmup period
                    await openTrack.source.chunks.log.waitForReplicator(
                        this.owner
                    );

                    // TODO listen to updates ?
                    maxTime =
                        openTrack.startTime +
                        ((await openTrack.last())?.time || 0);
                    if (!alreadyOpen) {
                        await openTrack.close();
                    }
                }
            } else {
                // check closed
                const latestClosed = (
                    await this.tracks.index.search(
                        new SearchRequest({
                            sort: [
                                new Sort({
                                    direction: SortDirection.DESC,
                                    key: "endTime",
                                }),
                            ],
                            fetch: 1,
                        }),
                        {
                            local: true,
                            remote: {
                                eager: true,
                            },
                        }
                    )
                )[0];

                if (latestClosed?.endTime != null) {
                    maxTime =
                        maxTime != null
                            ? Math.max(maxTime, latestClosed.endTime)
                            : latestClosed.endTime;
                }
            }
            maxTime != null && onChange(maxTime);
        };

        const listener =
            async (/* e?: { detail: { publicKey: PublicSignKey } } */) => {
                await singleQueue.add(fn());
            };
        this.tracks.log.events.addEventListener("replicator:join", listener);
        listener();
        return {
            stop: () => {
                this.tracks.log.events.removeEventListener(
                    "replicator:join",
                    listener
                );
                this.maxTime = undefined;
            },
        };
    }

    /**
     *
     * @param progress [0,1] (the progress bar)
     */
    async iterate(
        progress: number | "live",
        opts?: {
            changeProcessor?: TrackChangeProcessor;
            onProgress?: (properties: { track: Track; chunk: Chunk }) => void;
            onMaxTimeChange?: (properties: { maxTime: number }) => void;
            onTrackOptionsChange?: (options: Track[]) => void;
            onTracksChange?: (tracks: Track[]) => void;
        }
    ): Promise<TracksIterator> {
        const openTrackQueue = new PQueue({ concurrency: 1 });
        const changeProcessor =
            opts?.changeProcessor || oneVideoAndOneAudioChangeProcessor;
        let close: () => void;
        let play: () => void;
        let pause: () => void;
        let mediaTime: () => number | "live";
        let paused = false;
        let session = 0;
        let playing = false;
        const nowMicroSeconds = () => performance.now() * 1e3;
        let startPlayAt: number | undefined = undefined;
        const currentTracks: TrackWithBuffer<any>[] = [];
        const currentTrackOptions: Track[] = [];
        let closed = false;

        const latestPendingFrame: Map<"audio" | "video", number> = new Map();
        const latestPlayedFrame: Map<"audio" | "video", number> = new Map();

        const startTimer: () => void = () => {
            if (startPlayAt != null) {
                return;
            }
            startPlayAt = nowMicroSeconds();
        };

        // Find max media time
        // That is the media time corresponding to the track with the latest chunk
        let startProgressBarMediaTime: () => number | "live" | undefined;
        let onMaxTimeChange: ((time: number) => void) | undefined = undefined;

        let onProgressWrapped: (properties: {
            track: Track;
            chunk: Chunk;
        }) => void = (properties) => {
            onMaxTimeMaybeChange?.(
                properties.chunk.time + properties.track.startTime
            );
            opts?.onProgress?.(properties);
        };
        let onMaxTimeMaybeChange: (maybeNewMaxTime: number) => void = (
            maybeNewMaxTime
        ) => {
            if (this.maxTime == null || maybeNewMaxTime > this.maxTime) {
                this.maxTime = maybeNewMaxTime;
                onMaxTimeChange?.(this.maxTime);
                opts?.onMaxTimeChange?.({ maxTime: maybeNewMaxTime });
            }
        };

        let stopMaxTimeSync: (() => void) | undefined = undefined;

        if (typeof progress === "number" && progress < 1) {
            const out = await this.subscribeForMaxTime(onMaxTimeMaybeChange);
            stopMaxTimeSync = out.stop;

            // convert progress bar value into a media time
            startProgressBarMediaTime = () =>
                this.maxTime != null
                    ? Math.round(progress * this.maxTime)
                    : undefined;
        } else {
            startProgressBarMediaTime = () => "live";
        }

        const selectOption = async (track: Track) => {
            if (await removeTrack(track)) {
                return; // track was already selected, now unselected
            }

            return maybeChangeTrack({ add: track, force: true });
        };

        const removeTrack = async (track: Track, ended?: boolean) => {
            const index = currentTracks.findIndex((x) =>
                equals(x.track.id, track.id)
            );
            if (index >= 0) {
                const element = currentTracks.splice(index, 1)[0];
                opts?.onTracksChange?.(currentTracks.map((x) => x.track));
                await element.track.close();
                /*  console.log("REMOVE TRACK", {
                     startTime: track.startTime,
                     endTime: track.endTime,
                     ended,
                     index,
                     currentTracksLength: currentTracks.length,
                     currentTrackOptionsLength: currentTrackOptions.length,
                 }); */
            }

            if (ended) {
                const trackOptionIndex = currentTrackOptions.findIndex((x) =>
                    equals(x.id, track.id)
                );
                if (trackOptionIndex >= 0) {
                    currentTrackOptions.splice(trackOptionIndex, 1);
                    opts?.onTrackOptionsChange?.(currentTrackOptions);
                    console.log(
                        "REMOVE TRACK OPTION",
                        track.startTime,
                        track.endTime,
                        ended
                    );
                }
            }

            return false;
        };

        let pendingFrames: {
            track: Track<WebcodecsStreamDB | AudioStreamDB>;
            chunk: Chunk;
        }[] = [];

        let keepBufferSize = 0; // TODO option to prevent hiccups

        const renderLoop = (currentSession: number) => {
            let spliceSize = 0;
            for (const frame of pendingFrames) {
                if (paused) {
                    break;
                }

                if (pendingFrames.length - spliceSize < keepBufferSize) {
                    break;
                }

                if (startProgressBarMediaTime() === "live") {
                    console.log("PUSH LIVE", pendingFrames.length);
                    onProgressWrapped({
                        chunk: frame.chunk,
                        track: frame.track,
                    });
                } else {
                    const startAt = frame.track.startTime + frame.chunk.time;
                    const currentTime = mediaTime();
                    const isLaterThanStartProgress = () => {
                        let time = startProgressBarMediaTime();
                        if (typeof time !== "number") {
                            throw new Error("Unexpected");
                        }
                        return startAt >= time;
                    };

                    const isLaterThanProgress =
                        startAt <= (currentTime as number);

                    if (isLaterThanStartProgress()) {
                        if (isLaterThanProgress || startPlayAt == null) {
                            updateLatestFrame(
                                latestPlayedFrame,
                                frame.track,
                                frame.chunk.time
                            );
                            startTimer();
                            onProgressWrapped({
                                chunk: frame.chunk,
                                track: frame.track,
                            });
                        } else {
                            break;
                        }
                    } else {
                        console.log("DISCARD!", startAt);
                    }
                }
                spliceSize++;
            }

            if (spliceSize > 0) {
                pendingFrames.splice(0, spliceSize);
            }

            !paused && requestAnimationFrame(() => renderLoop(currentSession));
        };

        const addTrackAsOption = (track: Track) => {
            const exists = currentTrackOptions.find((x) =>
                equals(x.id, track!.id)
            );
            if (!exists) {
                console.log(
                    "ADD TRACK OPTION",
                    track.startTime,
                    currentTrackOptions.length
                );
                currentTrackOptions.push(track);

                opts?.onTrackOptionsChange?.(currentTrackOptions);
            }
        };

        const updateLatestFrame = (
            map: Map<"audio" | "video", number>,
            track: Track<WebcodecsStreamDB | AudioStreamDB>,
            timeMicroseconds: number
        ) => {
            const latest = map.get(track.source.mediaType);
            const mediaTime = timeMicroseconds + track.startTime;
            if (latest == null || latest < mediaTime) {
                map.set(track.source.mediaType, mediaTime);
                return true;
            }
            return false;
        };

        const maybeChangeTrack = async (change: {
            force?: boolean;
            add?: Track;
            remove?: Track;
            isOption?: boolean;
        }) => {
            /*  console.log(
                 "ADD TO QUEUE MAYBE ADD TRACK",
                 change.add && toBase64(change.add.id),
                 !!currentTracks.find((x) => equals(x.track.id, change.add!.id))
             ); */

            return openTrackQueue.add(async () => {
                // remove existing track if we got a new track with same id that has a endtime set before the currentTime
                /*  console.log("MAYBE CHANGE TRACK", change.add?.startTime, change.add?.endTime, change.isOption); */
                try {
                    if (change.add && change.add.endTime != null) {
                        const mediaTimeForType = mediaTime();
                        const existing = currentTrackOptions.find((x) =>
                            equals(x.id, change.add!.id)
                        );
                        if (existing) {
                            // update end time of existing track
                            existing.setEnd(change.add.endTimeBigInt);

                            // remove track if it has ended
                            if (
                                mediaTimeForType === "live" ||
                                change.add.endTime < mediaTimeForType
                            ) {
                                await removeTrack(existing, true);
                                return;
                            }
                        }
                    }

                    !change.isOption &&
                        change.add &&
                        addTrackAsOption(change.add);

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
                } catch (error) {
                    console.error("Error", error);
                    throw error;
                }
            });
        };
        const addTrack = async (track: Track) => {
            const runningTrack = !!currentTracks.find((x) =>
                equals(x.track.id, track.id)
            );
            if (runningTrack) {
                return;
            }

            if (track.endTime != null) {
                const lastPendingFrameTime = latestPendingFrame.get(
                    track.source.mediaType
                );
                if (
                    lastPendingFrameTime != null &&
                    lastPendingFrameTime > track.endTime
                ) {
                    return;
                }
            }

            console.log(
                "ADD TRACK",
                closed,
                track.startTime,
                latestPlayedFrame.get(track.source.mediaType),
                currentTracks.length
            );

            let close: () => void;
            let open: () => void;

            track = await this.node.open(track, {
                args: {
                    replicate:
                        startProgressBarMediaTime() === "live" ? "live" : false,
                }, // TODO only replicate what we need
                existing: "reuse",
            });

            await track.source.chunks.log.waitFor(this.owner);
            /*  console.log(
                 "INIT TRAACK AT",
                 track.startTime,
                 startProgressBarMediaTime,
                 latestPlayedFrame.get(track.source.mediaType),
                 track.source.mediaType
             );
  */
            if (startProgressBarMediaTime() === "live") {
                const listener = (
                    change: CustomEvent<DocumentsChange<Chunk>>
                ) => {
                    for (const chunk of change.detail.added) {
                        const isLatest = updateLatestFrame(
                            latestPendingFrame,
                            track,
                            chunk.time
                        );
                        if (!isLatest) {
                            continue;
                        }
                        pendingFrames.push({ track, chunk });
                    }
                };

                close = () => {
                    track.source.chunks.events.removeEventListener(
                        "change",
                        listener
                    );
                };
                open = () => {
                    close();
                    track.source.chunks.events.addEventListener(
                        "change",
                        listener
                    );
                };
                open();
            } else {
                let iterator: ResultsIterator<Chunk> | undefined = undefined;
                const createIterator = async () => {
                    const progressNumber = startProgressBarMediaTime();
                    if (typeof progressNumber == "number") {
                        console.log("CREATE TRACK ITERATOR", {
                            progressNumber: progressNumber,
                            maxTime: this.maxTime,
                            trackStartTime: track.startTime,
                            diff: progressNumber - track.startTime,
                            iterstart: Math.max(
                                progressNumber - track.startTime,
                                0
                            ),
                            prev: !!iterator,
                        });
                        return track.iterate(
                            Math.max(progressNumber - track.startTime, 0)
                        );
                    }
                    return undefined;
                };

                onMaxTimeChange = async (changeValue: number | undefined) => {
                    await iterator?.close();
                    console.log("MAXTIME CHANGE", changeValue, this.maxTime);
                    iterator = await createIterator();
                };

                const bufferLoop = async (currentSession: number) => {
                    const bufferTime = 3e3; // 3 seconds in microseconds
                    if (!iterator) {
                        iterator = await createIterator();
                    }

                    /* THIS WRONG */
                    const loopCondition = () => {
                        console.log("LOOP CONDITION", {
                            latestPlayedFrame: latestPlayedFrame.get(
                                track.source.mediaType
                            ),
                            latestPendingFrame: latestPendingFrame.get(
                                track.source.mediaType
                            ),
                            bufferTime: bufferTime,
                            done: iterator?.done(),
                            closed: closed,
                            value:
                                (latestPlayedFrame.get(
                                    track.source.mediaType
                                ) || 0) -
                                    (latestPendingFrame.get(
                                        track.source.mediaType
                                    ) || 0) <
                                    bufferTime &&
                                !iterator?.done() &&
                                !closed,
                        });

                        return (
                            (latestPlayedFrame.get(track.source.mediaType) ||
                                0) -
                                (latestPendingFrame.get(
                                    track.source.mediaType
                                ) || 0) <
                                bufferTime &&
                            !iterator?.done() &&
                            !closed
                        );
                    };
                    try {
                        while (
                            loopCondition() &&
                            iterator &&
                            iterator.done() !== true
                        ) {
                            // buffer bufferTime worth of video
                            if (session !== currentSession) {
                                return;
                            }

                            const newChunks = await iterator.next(60);
                            if (newChunks.length > 0) {
                                for (const chunk of newChunks) {
                                    const isLatest = updateLatestFrame(
                                        latestPendingFrame,
                                        track,
                                        chunk.time
                                    );
                                    if (!isLatest) {
                                        continue;
                                    }

                                    pendingFrames.push({ chunk, track });
                                }
                            }

                            if (
                                !newChunks ||
                                newChunks.length === 0 ||
                                iterator?.done()
                            ) {
                                // prevent tracks to be reused by setting latest media time to the end time of the track
                                updateLatestFrame(
                                    latestPendingFrame,
                                    track,
                                    track.duration === "live"
                                        ? 0
                                        : track.duration
                                );
                                updateLatestFrame(
                                    latestPlayedFrame,
                                    track,
                                    track.duration === "live"
                                        ? 0
                                        : track.duration
                                );
                                startTimer();
                                return removeTrack(track, true);
                            }
                        }
                    } catch (error) {
                        console.error("FAILED BUT WE CAUGHT IT!");
                        throw error;
                    }

                    if (session !== currentSession) {
                        return;
                    }

                    delay(bufferTime, { signal: pauseController.signal })
                        .then(() => bufferLoop(currentSession))
                        .catch((e) => {
                            if (e instanceof AbortError) {
                                return;
                            }
                            console.error("Error in buffer loop", e);
                            throw e;
                        });
                };

                open = () => {
                    bufferLoop(session).catch((e) => {
                        if (e instanceof AbortError) {
                            return;
                        }
                        console.error("Error in buffer loop", e);
                        throw e;
                    });
                };
                close = () => {
                    return iterator?.close();
                };

                open();
            }

            const trackWithBuffer: TrackWithBuffer<any> = {
                track,
                open,
                close: () => {
                    close();
                    return track.close();
                },
            };

            currentTracks.push(trackWithBuffer);
            console.log(
                "ADDED TO CURRENT",
                trackWithBuffer.track.startTime,
                mediaTime(),
                currentTracks.length,
                "maxTime: " + this.maxTime
            );
            opts?.onTracksChange?.(currentTracks.map((x) => x.track));
        };

        const scheduleTrackLoop = async (fromSession: number) => {
            if (fromSession !== session) {
                return;
            }

            const tracksToRemove: [
                Track<WebcodecsStreamDB | AudioStreamDB>,
                boolean
            ][] = [];

            for (const track of currentTrackOptions) {
                if (currentTracks.find((x) => equals(x.track.id, track.id))) {
                    continue;
                }

                const currentTime = mediaTime();
                if (currentTime === "live") {
                    await maybeChangeTrack({ add: track, isOption: true });
                } else if (track.startTime <= currentTime) {
                    if (track.endTime == null || track.endTime > currentTime) {
                        /*  console.log(
                             "SCHEDULE TRACK",
                             track.startTime,
                             track.endTime,
                             currentTime
                         ); */
                        await maybeChangeTrack({ add: track, isOption: true });
                    } else {
                        tracksToRemove.push([
                            track,
                            track.endTime < currentTime,
                        ]);
                    }
                }
            }

            for (const [track, ended] of tracksToRemove) {
                await removeTrack(track, ended);
            }

            requestAnimationFrame(() => scheduleTrackLoop(fromSession));
        };

        let pauseController = new AbortController();
        let startProgressBarMediaTimeValue = startProgressBarMediaTime();
        if (startProgressBarMediaTimeValue === "live") {
            const listener = async (
                change: CustomEvent<DocumentsChange<Track>>
            ) => {
                try {
                    if (change.detail.added) {
                        for (const added of change.detail.added) {
                            await maybeChangeTrack({ add: added }); // TODO only add trackes we want to listen on
                        }
                    }
                    if (change.detail.removed) {
                        for (const remove of change.detail.removed) {
                            await maybeChangeTrack({ remove: remove });
                        }
                    }
                } catch (e) {
                    console.error("Error listening", e);
                    throw e;
                }
            };

            close = () =>
                this.tracks.events.removeEventListener("change", listener);
            pause = close;
            play = async () => {
                this.tracks.events.removeEventListener("change", listener);
                this.tracks.events.addEventListener("change", listener);

                await this.getLatest().then(async (tracks) => {
                    //  const openTracks = await Promise.all(tracks.map(async (x) => { const openTrack = await this.node.open(x); openTrack.source.chunks.log.waitForReplicator(this.owner); return openTrack }))
                    console.log("LATEST", tracks);
                    return listener(
                        new CustomEvent("change", {
                            detail: { added: tracks, removed: [] },
                        })
                    );
                });
            };
            mediaTime = () => "live";
        } else {
            let playbackTime = startProgressBarMediaTimeValue;
            // create a iterator that goes from `progressBarMediaTime` and forward
            // for every overlapping track, open it, and iterate until the end

            const createIterator = (progressValue: number) => {
                if (progressValue == null) {
                    return undefined;
                }

                return this.tracks.index.iterate(
                    typeof progressValue === "number"
                        ? new SearchRequest({
                              query: [
                                  new Or([
                                      new IsNull({
                                          key: "endTime",
                                      }),
                                      new IntegerCompare({
                                          key: "endTime",
                                          compare: Compare.Greater,
                                          value: progressValue,
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
                                  new IsNull({
                                      key: "endTime",
                                  }),
                              ],
                          }),
                    { remote: true, local: true }
                );
            };
            let tracksIterator: ReturnType<typeof createIterator> | undefined =
                undefined;
            let fetchedOnce = false;

            const bufferLoop = async (currentSession: number) => {
                // buffer tracks that are to start, or should start with at least bufferTime
                const progressValue = startProgressBarMediaTime();
                let nextCheckTime = 100; // milliseconds;
                if (typeof progressValue === "number") {
                    if (!tracksIterator) {
                        // set the playback start time
                        playbackTime = progressValue;
                        tracksIterator = createIterator(progressValue);
                    }

                    const bufferAhead = 1e6; // microseconds
                    const bufferTo = progressValue + bufferAhead;
                    nextCheckTime = bufferAhead / 1e3; // microseconds to milliseconds

                    try {
                        while (tracksIterator != null) {
                            if (session !== currentSession) {
                                return;
                            }
                            const current = await tracksIterator.next(1);
                            if (current.length === 0) {
                                if (!fetchedOnce) {
                                    // reset the iterator to potentially fetch a new chunk later
                                    // TODO live query instead
                                    tracksIterator = undefined;
                                }
                                break;
                            }
                            fetchedOnce = true;

                            for (const track of current) {
                                console.log("ADD OPTION", track.startTime);
                                addTrackAsOption(track);
                            }

                            const last = current[current.length - 1];
                            if (last.startTime > bufferTo) {
                                nextCheckTime =
                                    (last.startTime - bufferTo) / 1e3; // microseconds to milliseconds
                                break;
                            }
                        }
                    } catch (error) {
                        throw error;
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

            pause = () => {
                if (!playing) {
                    return;
                }
                playing = false;
                if (playbackTime == undefined) {
                    playbackTime = 0;
                }
                playbackTime +=
                    nowMicroSeconds() -
                    (startPlayAt != null
                        ? nowMicroSeconds() - startPlayAt!
                        : 0)!;
                startPlayAt = undefined;
            };

            close = () => {
                console.log("CLOSE TRACKS");
                pause();
                pendingFrames = [];
                stopMaxTimeSync?.();
                return tracksIterator?.close();
            };

            play = () => {
                playing = true;
                bufferLoop(session);
            };

            mediaTime = () => {
                if (!playing) {
                    throw new Error("Not playing");
                }
                if (playbackTime == undefined) {
                    playbackTime = 0;
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
            currentTracks.splice(0, currentTracks.length);
        };

        const closeCtrl = async () => {
            session++;
            pauseController.abort("Closed");
            paused = true;

            openTrackQueue.pause();
            await Promise.all([
                close(),
                ...currentTracks.map((x) => x.iterator?.close()),
            ]);
            openTrackQueue.clear();
            await openTrackQueue.onEmpty();

            closed = true;
            currentTracks.splice(0, currentTracks.length);
            opts?.onTrackOptionsChange?.([]);
        };
        playCtrl();

        return {
            time: () => mediaTime(), // startProgressBarMediaTime === 'live' ? 'live' : latestPlayedFrameTime(),
            options: currentTrackOptions,
            current: currentTracks,
            play: playCtrl,
            pause: pauseCtrl,
            paused,
            selectOption,
            close: closeCtrl,
        };
    }
}
