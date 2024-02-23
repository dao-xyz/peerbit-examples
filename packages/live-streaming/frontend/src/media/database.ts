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
import { concat } from "uint8arrays";
import { Entry } from "@peerbit/log";
import { randomBytes } from "@peerbit/crypto";
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
    @field({ type: "u8" })
    private _type: 0 | 1 | 2;

    @field({ type: "u64" })
    private _time: bigint;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(props: {
        type?: "key" | "delta";
        chunk: Uint8Array;
        time: number;
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
                console.log("CAN NOT PUT CHUNK");
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
export class Track<T extends TrackSource> extends Program<Args> {
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
            onTrackOptionsChange?: (
                options: Track<WebcodecsStreamDB | AudioStreamDB>[]
            ) => void;
            onTracksChange?: (
                tracks: Track<WebcodecsStreamDB | AudioStreamDB>[]
            ) => void;
        }
    ): Promise<TracksIterator> {
        console.log("START ITERATOR!");
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
        let paused = false;
        let session = 0;
        let playing = false;
        const nowMicroSeconds = () => performance.now() * 1e3;
        let startPlayAt: number | undefined = undefined;
        const currentTracks: TrackWithBuffer<any>[] = [];
        const currentTrackOptions: Track<any>[] = [];
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

        const selectOption = async (track: Track<any>) => {
            if (await removeTrack(track)) {
                return; // track was already selected, now unselected
            }

            return maybeChangeTrack({ add: track, force: true });
        };

        const removeTrack = async (track: Track<any>, ended?: boolean) => {
            const index = currentTracks.findIndex((x) =>
                equals(x.track.id, track.id)
            );
            if (index >= 0) {
                const element = currentTracks.splice(index, 1)[0];
                opts?.onTracksChange?.(currentTracks.map((x) => x.track));
                await element.track.close();
                console.log(
                    "REMOVE TRACK",
                    track.startTime,
                    track.endTime,
                    ended,
                    index,
                    currentTracks.length,
                    currentTrackOptions.length
                );
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

        const pendingFrames: {
            track: Track<WebcodecsStreamDB | AudioStreamDB>;
            chunk: Chunk;
        }[] = [];

        const renderLoop = (currentSession: number) => {
            let spliceSize = 0;
            for (const frame of pendingFrames) {
                if (paused) {
                    break;
                }

                if (startProgressBarMediaTime === "live") {
                    opts?.onProgress?.({
                        chunk: frame.chunk,
                        track: frame.track,
                    });
                } else {
                    const startAt = frame.track.startTime + frame.chunk.time;
                    const currentTime = mediaTime();
                    const isLaterThanStartProgress =
                        startAt >= startProgressBarMediaTime;
                    const isLaterThanProgress =
                        startAt <= (currentTime as number);

                    if (isLaterThanStartProgress) {
                        if (isLaterThanProgress || startPlayAt == null) {
                            updateLatestFrame(
                                latestPlayedFrame,
                                frame.track,
                                frame.chunk.time
                            );
                            startTimer();
                            opts?.onProgress?.({
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

        const addTrackAsOption = (track: Track<any>) => {
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
            add?: Track<any>;
            remove?: Track<any>;
            isOption?: boolean;
        }) => {
            console.log(
                "MAYBE ADD TRACK",
                change.add && toBase64(change.add.id),
                !!currentTracks.find((x) => equals(x.track.id, change.add!.id))
            );

            return openTrackQueue.add(async () => {
                // remove existing track if we got a new track with same id that has a endtime set before the currentTime
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

                !change.isOption && change.add && addTrackAsOption(change.add);

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
                args: { role: "observer", sync: () => true },
                existing: "reuse",
            });

            await track.source.chunks.log.waitForReplicator(this.owner);

            console.log(
                "INIT TRAACK AT",
                track.startTime,
                startProgressBarMediaTime,
                latestPlayedFrame.get(track.source.mediaType),
                track.source.mediaType
            );

            if (startProgressBarMediaTime === "live") {
                const listener = (change) => {
                    for (const chunk of change.detail.added) {
                        const isLatest = updateLatestFrame(
                            latestPendingFrame,
                            track,
                            chunk.time
                        );
                        //  console.log("GOT CHUNK", chunk.time, track.startTime, track.startTime + chunk.time, track.source.mediaType, isLatest, latestPendingFrame.get(track.source.mediaType), track.source.mediaType);
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

                console.log(
                    "START BUFFER LOOP TRACK",
                    track.startTime,
                    mediaTime(),
                    startProgressBarMediaTime
                );

                const bufferLoop = async (currentSession: number) => {
                    const bufferTime = 3e3; // 3 seconds in microseconds

                    if (!iterator) {
                        iterator = await track.iterate(
                            Math.max(
                                (startProgressBarMediaTime as number) -
                                    track.startTime,
                                0
                            ) as number
                        );
                    }

                    /* THIS WRONG */
                    const loopCondition = () =>
                        (latestPlayedFrame.get(track.source.mediaType) || 0) -
                            (latestPendingFrame.get(track.source.mediaType) ||
                                0) <
                            bufferTime &&
                        !iterator?.done() &&
                        !closed;
                    const q = loopCondition();

                    while (loopCondition()) {
                        // buffer bufferTime worth of video
                        if (session !== currentSession) {
                            return;
                        }

                        const newChunks = await iterator?.next(60);

                        console.log("FETCH CHUNKS", newChunks?.length);
                        /* console.log(
                            "NEW CHUNKS?",
                            { startTime: track.startTime },
                            newChunks.map((x) => track.startTime + x.time)
                        );
 */

                        if (newChunks.length > 0) {
                            for (const chunk of newChunks) {
                                const isLatest = updateLatestFrame(
                                    latestPendingFrame,
                                    track,
                                    chunk.time
                                );
                                //  console.log("GOT CHUNK", isLatest, track.startTime, chunk.time)
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
                                track.duration === "live" ? 0 : track.duration
                            );
                            updateLatestFrame(
                                latestPlayedFrame,
                                track,
                                track.duration === "live" ? 0 : track.duration
                            );
                            startTimer();
                            console.log("RETURN EMPTY!");
                            return removeTrack(track, true);
                        }
                    }

                    if (session !== currentSession) {
                        return;
                    }

                    console.log("REDO LOOP!");
                    delay(bufferTime, { signal: pauseController.signal })
                        .then(() => bufferLoop(currentSession))
                        .catch((e) => {
                            if (e instanceof AbortError) {
                                return;
                            }
                            throw e;
                        });
                };

                open = () => {
                    bufferLoop(session);
                };
                close = () => {
                    iterator?.close();
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
                currentTracks.length
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
                        console.log(
                            "SCHEDULE TRACK",
                            track.startTime,
                            track.endTime,
                            currentTime
                        );
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
        if (startProgressBarMediaTime === "live") {
            const listener = async (change) => {
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
            };

            close = () =>
                this.tracks.events.removeEventListener("change", listener);
            pause = close;
            play = async () => {
                this.tracks.events.removeEventListener("change", listener);
                this.tracks.events.addEventListener("change", listener);

                await this.getLatest().then(async (tracks) => {
                    //  const openTracks = await Promise.all(tracks.map(async (x) => { const openTrack = await this.node.open(x); openTrack.source.chunks.log.waitForReplicator(this.owner); return openTrack }))
                    return listener({ detail: { added: tracks } });
                });
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
                { remote: true, local: true }
            );

            console.log("SETUP TRACKS ITERATOR", startProgressBarMediaTime);

            const bufferLoop = async (currentSession: number) => {
                // buffer tracks that are to start, or should start with at least bufferTime
                const bufferAhead = 1e6; // microseconds
                const bufferTo =
                    (startProgressBarMediaTime as number) + bufferAhead;
                let nextCheckTime = bufferAhead / 1e3; // microseconds to milliseconds
                while (true as any) {
                    if (session !== currentSession) {
                        return;
                    }
                    const current = await tracksIterator.next(1);
                    if (current.length === 0) {
                        break;
                    }

                    for (const track of current) {
                        console.log("ADD OPTION", track.startTime);
                        addTrackAsOption(track);
                    }

                    const last = current[current.length - 1];
                    if (last.startTime > bufferTo) {
                        nextCheckTime = (last.startTime - bufferTo) / 1e3; // microseconds to milliseconds
                        break;
                    }
                }
                console.log("BUFFER TRACKS NEXT CHECK TIME", nextCheckTime);

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
            currentTracks.splice(0, currentTracks.length);
        };

        const closeCtrl = async () => {
            console.log("CLOSE ITERATOR!");
            session++;
            pauseController.abort("Closed");

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
