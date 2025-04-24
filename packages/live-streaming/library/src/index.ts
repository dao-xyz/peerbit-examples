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
    PublicSignKey,
    toBase64,
    sha256Sync,
    fromBase64,
    sha256Base64Sync,
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
    DocumentsChange,
    CustomDocumentDomain,
    createDocumentDomain,
    WithContext,
} from "@peerbit/document";
import {
    id,
    IndexedResults,
    NotStartedError,
} from "@peerbit/indexer-interface";
import { ClosedError, Program, ProgramEvents } from "@peerbit/program";
import { concat, fromString } from "uint8arrays";
import { randomBytes } from "@peerbit/crypto";
import { delay, waitFor, AbortError } from "@peerbit/time";
import PQueue from "p-queue";
import { equals } from "uint8arrays";
import pQueue from "p-queue";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import { hrtime } from "@peerbit/time";
import { Timestamp } from "@peerbit/log";

const isClosedError = (error: any) => {
    if (
        error instanceof NotStartedError ||
        error instanceof ClosedError ||
        error instanceof AbortError
    ) {
        return true;
    }
    return false;
};
export const hrtimeMicroSeconds = () => {
    const nano = hrtime.bigint();
    return nano / 1000n;
};

/* const hrTimeNow = hrtime.bigint();
const startTime = BigInt(Date.now()) * BigInt(1e6) - hrTimeNow;
const bigintNanoNow = () => startTime + hrtime.bigint(); */

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

type Args = { sender: PublicSignKey; startTime: bigint };

@variant("track-source")
export abstract class TrackSource {
    @field({ type: Documents })
    private _chunks: Documents<
        Chunk,
        ChunkIndexable,
        CustomDocumentDomain<"u64">
    >;

    constructor() {
        this._chunks = new Documents({
            id: randomBytes(32),
        });
    }

    get chunks() {
        return this._chunks;
    }

    sender: PublicSignKey;
    startTime: bigint;

    async open(args: Args): Promise<void> {
        /*        
         console.log(
                    "LISTEN FROM",
                    args?.replicate,
                    shiftToU32(+new Date()),
                    "TO",
                    shiftToU32(+new Date()) + 24 * 60 * 60 * 1e3
                ); 
        */

        this.sender = args.sender;
        this.startTime = args.startTime;

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
            replicate: "resume",
            domain: createDocumentDomain({
                resolution: "u64",
                canProjectToOneSegment: () => true, // TODO
                // nano seconds between the insertion
                mergeSegmentMaxDelta: 1e9, // 1 second of delta. I.e. if we buffer video from two segments and there is a gap of 1 second in walltime between the commit, we merge the segments
                fromEntry: (entry) => {
                    return entry.meta.clock.timestamp.wallTime;
                },
            }),
        });
    }

    async waitForReplicators() {
        try {
            await waitFor(
                async () => (await this.chunks.log.getReplicators()).size > 0,
                { timeout: 5e3 }
            );
        } catch (error) {
            throw new Error("No replicators found for track");
        }
    }

    async waitForStreamer() {
        try {
            await waitFor(
                async () =>
                    (await this.chunks.log.replicationIndex.count({
                        query: { hash: this.sender.hashcode() },
                    })) > 0,
                { timeout: 5e3 }
            );
        } catch (error) {
            throw new Error("Sender not available");
        }
    }

    /**
     *
     * @param time in this coordinate space
     */
    async iterate(
        time: number,
        options?: { local?: boolean; remote?: { eager?: boolean } }
    ) {
        await this.waitForReplicators();

        return this.chunks.index.iterate(
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
                remote: options?.remote ?? {
                    eager: true, // TODO eager needed?
                    replicate: true,
                },
                local: options?.local ?? true,
            }
        );
    }

    async last(): Promise<Chunk | undefined> {
        try {
            return (
                await this.chunks.index.search(
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
        } catch (error) {
            if (isClosedError(error)) {
                return undefined;
            }
            throw error;
        }
    }

    lastLivestreamingSegmentId: Uint8Array | undefined;
    lastLivestreamingSegmentStart: bigint | undefined;

    async replicate(args: "live" | "streamer" | "all" | false) {
        if (args === "live") {
            /*  // get latest chunk 
             await this.waitForStreamer()
             const last = await this.last()
             let lastTime = last?.time || 0 */

            if (!this.lastLivestreamingSegmentId) {
                this.lastLivestreamingSegmentId = randomBytes(32);
            }

            await this.chunks.log.waitForReplicator(this.sender);
            let last = await this.last();

            // we add 1n because if we have a previous chunk we want to skip it (we want a live stream)
            // TODO this should perhaps actually do some buffering to ensure that we don't miss any chunks,
            // or can immediately play new chunks, for example in a live video stream we might need some earlier chunks to show the new ones
            let offset: bigint =
                (this.startTime + (last ? last.timeBN + 1n : 0n)) * 1000n;

            this.lastLivestreamingSegmentStart = hrtimeMicroSeconds();

            console.log(
                "Replicate live ",
                offset + " forward  " + 24 * 60 * 60 * 1e3 * 1e9,
                " now " +
                    this.lastLivestreamingSegmentStart +
                    " hrtime " +
                    hrtime.bigint()
            );

            await this.chunks.log.replicate({
                id: this.lastLivestreamingSegmentId,
                factor: 24 * 60 * 60 * 1e3 * 1e9,
                offset,
                normalized: false,
                strict: true,
            });
        } else {
            await this.endPreviousLivestreamSubscription();
            return this.chunks.log.replicate(
                args === "streamer" || args === "all"
                    ? { factor: 1 }
                    : args ?? { factor: 1 }
            );
        }
    }

    async endPreviousLivestreamSubscription() {
        if (!this.lastLivestreamingSegmentId) {
            return;
        }

        /* console.log(
            "END SEGMENT",
            sha256Base64Sync(this.lastLivestreamingSegmentId)
        ); */

        const segment: { value: ReplicationRangeIndexable<"u64"> } = (
            await this.chunks.log.replicationIndex
                .iterate({ query: { id: this.lastLivestreamingSegmentId } })
                .all()
        )?.[0];

        if (!segment) {
            throw new Error("Unexpected, missing livestreaming segment");
        }

        let now = hrtimeMicroSeconds();

        /* console.log("END SEGMENT", {
            hash: sha256Base64Sync(this.lastLivestreamingSegmentId),
            now: now,
            lastLivestreamingSegmentStart: this.lastLivestreamingSegmentStart,
            factor: BigInt(now - this.lastLivestreamingSegmentStart!),
        }); */

        await this.chunks.log.replicate({
            id: segment.value.id,
            offset: segment.value.start1,
            factor: (now - this.lastLivestreamingSegmentStart!) * 1000n, // TODO wthis is wrong potentially if we wrap around u32 and segment.value.start1 is before and now is after
            normalized: false,
            strict: true,
        });

        this.lastLivestreamingSegmentId = undefined;
        this.lastLivestreamingSegmentStart = undefined;
    }

    close() {
        return this.chunks.close();
    }

    abstract get mediaType(): "audio" | "video";
    abstract get description(): string;
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

    get description() {
        return `Audio (Channels: ${this.channels} , Sample rate: ${this.sampleRate})`;
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

    get description() {
        return `Video (${this.decoderConfigJSON})`;
    }
}

@variant("track")
export class Track<
    T extends TrackSource = AudioStreamDB | WebcodecsStreamDB
> extends Program<never> {
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
        let now = this._now();
        let nowBigint = typeof now === "number" ? BigInt(Math.round(now)) : now;
        let globalTime =
            typeof this._globalTime === "number"
                ? BigInt(Math.round(this._globalTime))
                : this._globalTime;
        return nowBigint - globalTime;
    }

    setEnd(time?: bigint | number) {
        this._endTime = time != null ? BigInt(time) : this.timeSinceStart();
    }

    async open(args?: Args): Promise<void> {
        await this.source.open({
            ...args,
            sender: this.sender,
            startTime: this._startTime,
        });
        if (this.node.identity.publicKey.equals(this.sender)) {
            await this.source.replicate("streamer");
        }
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

    toString() {
        return `Track { time: ${this._startTime} - ${this._endTime}, description: (${this.source.description}) }`;
    }

    private _previousWallTime: bigint | undefined = undefined;
    private _previousLogical: number | undefined = undefined;
    async put(
        chunk: Chunk,
        options?: { target?: "all" | "replicators" | "none" }
    ) {
        const wallTime = (this._startTime + chunk.timeBN) * 1000n;
        let logical: number | undefined = undefined;
        if (wallTime === this._previousWallTime) {
            if (this._previousLogical == null) {
                this._previousLogical = 0;
            }
            this._previousLogical++;
            logical = this._previousLogical;
        } else {
            this._previousWallTime = wallTime;
            this._previousLogical = undefined;
        }
        await this.source.chunks.put(chunk, {
            target: options?.target,
            meta: {
                timestamp: new Timestamp({
                    wallTime,
                    logical,
                }),
                next: [],
            },
            unique: true,
        });
    }

    private _idString: string | undefined = undefined;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}

class TrackIndexable {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    sender: string;

    @field({ type: "u64" })
    startTime: bigint;

    @field({ type: option("u64") })
    endTime: bigint | undefined;

    @field({ type: "u32" })
    duration: number;

    constructor(track: Track) {
        this.id = track.id;
        this.startTime = track.startTimeBigInt;
        this.endTime = track.endTimeBigInt;
        this.sender = track.sender.hashcode();
        this.duration = track.duration === "live" ? 0 : track.duration;
    }
}

export type TracksIterator = {
    time: () => number | "live";
    options: () => Track<WebcodecsStreamDB | AudioStreamDB>[];
    current: Map<string, TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>>;
    selectOption: (
        track: Track<WebcodecsStreamDB | AudioStreamDB>
    ) => Promise<void>;
    close: () => Promise<void>;
    play: () => void;
    pause: () => void;
    paused: boolean;
    isLagging: boolean;
};

type TrackWithBuffer<T extends TrackSource> = {
    track: Track<T>;
    iterator?: ResultsIterator<Chunk>;
    last?: number;
    close?: () => boolean | Promise<boolean>;
    open?: () => void | Promise<void>;
    closing?: boolean;
    chunks: Chunk[];
};

export type TrackChangeProcessor<
    T extends TrackSource = WebcodecsStreamDB | AudioStreamDB
> = (
    properties: {
        force?: boolean;
        add?: Track<T>;
        remove?: Track<T>;
        current: Map<string, { track: Track<T> }>;
        options: Track<T>[];
    },
    progress: "live" | number,
    preloadTime: number
) => { add?: Track<T> | { track: Track<T>; when?: number }; remove?: Track<T> };

export const oneVideoAndOneAudioChangeProcessor: TrackChangeProcessor = (
    change,
    progress: "live" | number,
    preloadTime: number
) => {
    if (change.add) {
        let alreadyHave: Track | undefined = undefined;
        for (const [_id, track] of change.current) {
            if (
                track.track.source.constructor ===
                change.add!.source.constructor
            ) {
                alreadyHave = track.track;
                break;
            }
        }

        if (alreadyHave?.idString === change.add.idString) {
            return {
                add: undefined,
                remove: change.remove,
            };
        }

        if (change.force) {
            // replace
            return {
                remove: alreadyHave,
                add: change.add ? { track: change.add } : undefined,
            };
        } else {
            // TODO
            // this conditioin ensures that if we already have a stream but it has an endtime but the new stream does not, we switch
            // but we should not have to have this statement since if an enditme is set before now we should automatically end that track and poll for new tracks?
            if (alreadyHave) {
                if (alreadyHave.endTime == null) {
                    return {};
                }

                if (alreadyHave.endTime !== null) {
                    if (progress === "live") {
                        if (change.add.endTime == null) {
                            return {
                                remove: alreadyHave,
                                add: { track: change.add },
                            }; // always favor live streams
                        }
                    } else {
                        if (progress > alreadyHave.endTime) {
                            // we should definitely end the old track
                            return {
                                remove: alreadyHave,
                                add: { track: change.add },
                            };
                        }

                        // add new track early since we will start to play it soon
                        // but only if the end time is undefined or it is later than the current track
                        if (
                            change.add.startTime - preloadTime < progress &&
                            (change.add.endTime == null ||
                                change.add.endTime > alreadyHave.endTime)
                        ) {
                            let when =
                                alreadyHave?.endTime != null &&
                                alreadyHave?.endTime > change.add.startTime
                                    ? alreadyHave.endTime
                                    : undefined;
                            return {
                                add:
                                    when != null
                                        ? { track: change.add, when }
                                        : change.add,
                            };
                        }
                    }
                    return {};
                }

                if (
                    change.add.endTime != null &&
                    change.add.endTime <= alreadyHave.endTime
                ) {
                    return {}; // old track is to be added, but we don't want to add it so we return nothing
                }
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

type MaxTimeEvent = { maxTime: number };
type ReplicationRangeEvent = { hash: string; track: Track };

export interface MediaStreamDBEvents extends ProgramEvents {
    maxTime: CustomEvent<MaxTimeEvent>;
    replicationChange: CustomEvent<ReplicationRangeEvent>;
}

@variant("media-streams")
export class MediaStreamDB extends Program<{}, MediaStreamDBEvents> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    tracks: Documents<Track<AudioStreamDB | WebcodecsStreamDB>, TrackIndexable>;

    maxTime: number | undefined = undefined;
    private openedTracks: Map<
        string,
        Track<WebcodecsStreamDB | AudioStreamDB>
    > = new Map();

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

    private _trackChangeListener: (
        change: CustomEvent<
            DocumentsChange<Track<AudioStreamDB | WebcodecsStreamDB>>
        >
    ) => void;
    private replicateTracksByDefault: boolean = false;
    async open(args?: { replicateTracksByDefault?: boolean }): Promise<void> {
        this.openedTracks = new Map();
        this.replicateTracksByDefault = args?.replicateTracksByDefault || false;

        if (this.replicateTracksByDefault) {
            this._trackChangeListener = async (ev) => {
                for (const added of ev.detail.added) {
                    await this.node.open(added, {
                        args: {
                            sender: this.owner,
                            startTime: added.startTimeBigInt,
                        },
                        existing: "reuse",
                    });
                    await added.source.replicate("all");
                }

                for (const removed of ev.detail.removed) {
                    await removed.close();
                }
            };

            this.tracks.events.addEventListener(
                "change",
                this._trackChangeListener
            );
        }

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
            canOpen: (_) => Promise.resolve(false),
            replicate: {
                factor: 1,
            },
            index: {
                type: TrackIndexable,
            },
        });
    }

    async afterOpen(): Promise<void> {
        await super.afterOpen();
        if (this.replicateTracksByDefault) {
            const openTrack = async (track: Track) => {
                await this.node.open(track, {
                    args: {
                        sender: this.owner,
                        startTime: track.startTimeBigInt,
                    },
                    existing: "reuse",
                });
                //  await track.source.replicate("all"); already replicated so this call is not needed (TODO dedup??)
            };
            this._trackChangeListener = async (ev) => {
                for (const added of ev.detail.added) {
                    await openTrack(added);
                }

                for (const removed of ev.detail.removed) {
                    await removed.close();
                }
            };

            this.tracks.events.addEventListener(
                "change",
                this._trackChangeListener
            );

            // open all local tracks
            for (const track of await this.tracks.index
                .iterate({}, { local: true, remote: false })
                .all()) {
                await openTrack(track);
            }
        }
    }

    async getLatest(
        options?: SearchOptions<
            Track<AudioStreamDB | WebcodecsStreamDB>,
            any,
            any
        >
    ): Promise<WithContext<Track<AudioStreamDB | WebcodecsStreamDB>>[]> {
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

    private addToOpenTrack(track: Track<any>) {
        if (!this.openedTracks.has(track.address)) {
            this.openedTracks.set(track.address, track);
        }
    }

    maybeUpdateMaxTime(
        maybeNewMaxTime?: number,
        onChange?: (maybeNewMaxtime: number) => void
    ) {
        if (
            maybeNewMaxTime != null &&
            (this.maxTime == null || maybeNewMaxTime > this.maxTime)
        ) {
            this.maxTime = maybeNewMaxTime;
            onChange?.(this.maxTime);
            this.events.dispatchEvent(
                new CustomEvent<MaxTimeEvent>("maxTime", {
                    detail: { maxTime: this.maxTime },
                })
            );
        }
    }

    listenForMaxTimeChanges(keepTracksOpen: boolean | undefined) {
        let singleQueue = new pQueue({ concurrency: 1 });

        let onClose: (() => any)[] = [];

        const fn = () => async () => {
            if (this.tracks.closed) {
                return;
            }
            try {
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

                if (notClosed.length > 0) {
                    for (const track of notClosed) {
                        const openTrack = await this.node.open(track, {
                            existing: "reuse",
                            args: {
                                sender: this.owner,
                                startTime: track.startTimeBigInt,
                            },
                        });

                        const alreadyOpen = openTrack !== track;
                        if (!alreadyOpen) {
                            this.addToOpenTrack(openTrack);
                        }

                        // TODO assumption, streamer is always replicator, is this correct?
                        // if this is not true, then fetching the latest chunk needs to some kind of warmup period
                        /* await openTrack.source.chunks.log.waitForReplicator(
                            this.owner
                        ); */

                        // TODO listen to updates ?

                        const joinListener = async () => {
                            const maxTime =
                                openTrack.startTime +
                                ((await openTrack.source.last())?.time || 0);
                            this.maybeUpdateMaxTime(maxTime);
                        };
                        joinListener();
                        openTrack.source.chunks.log.events.addEventListener(
                            "replicator:join",
                            joinListener
                        );
                        onClose.push(() =>
                            openTrack.source.chunks.log.events.removeEventListener(
                                "replicator:join",
                                joinListener
                            )
                        );

                        const changeListener = async (props: {
                            detail: { added: Chunk[] };
                        }) => {
                            if (props.detail.added) {
                                for (const chunk of props.detail.added) {
                                    this.maybeUpdateMaxTime(
                                        openTrack.startTime + chunk.time
                                    );
                                }
                            }
                        };

                        openTrack.source.chunks.events.addEventListener(
                            "change",
                            changeListener
                        );
                        onClose.push(() =>
                            openTrack.source.chunks.events.removeEventListener(
                                "change",
                                changeListener
                            )
                        );

                        if (!alreadyOpen && !keepTracksOpen) {
                            onClose.push(() => openTrack.close());
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
                        this.maybeUpdateMaxTime(latestClosed.endTime);
                    }
                }
            } catch (error) {
                if (isClosedError(error)) {
                    // ignore
                    return;
                }
                throw error;
            }
        };

        const joinListener = async () => {
            singleQueue.size < 2 && (await singleQueue.add(fn()));
        };
        joinListener();

        this.tracks.log.events.addEventListener(
            "replicator:join",
            joinListener
        );

        this.tracks.events.addEventListener("change", joinListener);

        return {
            stop: async () => {
                singleQueue.clear();
                this.tracks.log.events.removeEventListener(
                    "replicator:join",
                    joinListener
                );
                this.tracks.events.removeEventListener("change", joinListener);

                await Promise.all(onClose.map((x) => x()));
                this.maxTime = undefined;
            },
        };
    }

    listenForReplicationInfo() {
        const dispatchReplicationChangeEvent = (change: {
            hash: string;
            track: Track;
        }) => {
            this.events.dispatchEvent(
                new CustomEvent<ReplicationRangeEvent>("replicationChange", {
                    detail: change,
                })
            );
        };

        const createReplicationChangeListener =
            (track: Track) =>
            async (ev: { detail: { publicKey: PublicSignKey | string } }) => {
                // re-emit replication change info

                dispatchReplicationChangeEvent?.({
                    hash:
                        ev.detail.publicKey instanceof PublicSignKey
                            ? ev.detail.publicKey.hashcode()
                            : ev.detail.publicKey,
                    track,
                });
            };

        const closeFn: (() => void | Promise<void>)[] = [];
        const localTrackListener = async () => {
            const allTracks = await this.tracks.index
                .iterate({}, { local: true, remote: false })
                .all();
            for (const track of allTracks) {
                const openTrack = await this.node.open(track, {
                    existing: "reuse",
                    args: {
                        sender: this.owner,
                        startTime: track.startTimeBigInt,
                    },
                });

                const alreadyOpen = openTrack !== track;
                if (!alreadyOpen) {
                    this.addToOpenTrack(openTrack);
                }

                const replicationInfoListener =
                    createReplicationChangeListener(openTrack);
                openTrack.source.chunks.log.events.addEventListener(
                    "replication:change",
                    replicationInfoListener
                );
                closeFn.push(() =>
                    openTrack.source.chunks.log.events.removeEventListener(
                        "replication:change",
                        replicationInfoListener
                    )
                );
                const replicationInfo: IndexedResults<
                    ReplicationRangeIndexable<"u64">
                > = await openTrack.source.chunks.log.replicationIndex
                    .iterate()
                    .all();
                for (const info of replicationInfo) {
                    replicationInfoListener({
                        detail: {
                            publicKey: info.value.hash,
                        },
                    });
                }
            }
        };

        this.tracks.events.addEventListener("change", localTrackListener);
        closeFn.push(() =>
            this.tracks.events.removeEventListener("change", localTrackListener)
        );

        this.tracks.log.events.addEventListener(
            "replicator:join",
            localTrackListener
        );
        closeFn.push(() => {
            this.tracks.log.events.removeEventListener(
                "replicator:join",
                localTrackListener
            );
        });

        return {
            stop: async () => {
                await Promise.all(closeFn.map((x) => x()));
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
            bufferTime?: number; // how much time to buffer
            bufferSize?: number; // if below bufferTime how big chunks should we buffer from remote
            preload?: number; /// how much preload time
            keepTracksOpen?: boolean;
            changeProcessor?: TrackChangeProcessor;
            onProgress?: (properties: {
                track: Track;
                chunk: Chunk;
            }) => void | Promise<void>;
            onUnderflow?: () => void;
            onMaxTimeChange?: (properties: {
                maxTime: number;
            }) => void | Promise<void>;
            onTrackOptionsChange?: (options: Track[]) => void;
            onTracksChange?: (tracks: Track[]) => void;
            onReplicationChange?: (properties: {
                hash: string;
                track: Track;
            }) => void;
        }
    ): Promise<TracksIterator> {
        const bufferTime = (opts?.bufferTime ?? 6e3) * 1e3; // micro seconds
        const bufferSize = opts?.bufferSize ?? 160;
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
        let startPlayAt: number | undefined = undefined;
        const currentTracks: Map<
            string,
            TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>
        > = new Map();
        const consumedTracks: Set<string> = new Set();

        const currentTrackOptions: Track[] = [];
        const filterTracksInTime = (tracks: Track[]) => {
            let currentTime = mediaTime();
            const filterered: Track[] = [];
            for (const track of tracks) {
                if (currentTime === "live") {
                    if (track.endTime == null) {
                        filterered.push(track);
                    }
                } else {
                    if (track.startTime <= currentTime) {
                        if (
                            track.endTime == null ||
                            track.endTime >= currentTime
                        ) {
                            filterered.push(track);
                        }
                    }
                }
            }
            return filterered;
        };

        let closed = false;

        const latestPendingFrame: Map<string, { time: number; track: Track }> =
            new Map();
        const latestPlayedFrame: Map<string, { time: number; track: Track }> =
            new Map();

        const startTimer: () => void = () => {
            if (startPlayAt != null) {
                return;
            }
            startPlayAt = Number(hrtimeMicroSeconds());
        };

        // Find max media time
        // That is the media time corresponding to the track with the latest chunk
        let startProgressBarMediaTime: () => number | "live" | undefined;

        let laggingSources: Map<string, number> = new Map();
        let laggiestTime: number | undefined = undefined;
        let isLagging = (address: string) => {
            return false as any; //laggingSources.get(address) === laggiestTime
        };

        let accumulatedLag: number = 0;

        let maxtimeListener = (ev: { detail: { maxTime: number } }) => {
            opts?.onMaxTimeChange?.({ maxTime: ev.detail.maxTime });
        };

        this.events.addEventListener("maxTime", maxtimeListener);

        const totalLag = (now = Number(hrtimeMicroSeconds())) => {
            const currentLag = laggiestTime != null ? now - laggiestTime : 0;
            const totalLag = currentLag + accumulatedLag;
            return totalLag;
        };

        const setLaggyTrack = (address: string) => {
            const lagStartAt = Number(hrtimeMicroSeconds());
            laggingSources.set(address, lagStartAt);
            if (laggiestTime == null || lagStartAt < laggiestTime) {
                // TODO second condition never fulfilled?
                laggiestTime = lagStartAt;
            }
        };
        const deleteLaggyTrack = (address: string) => {
            let thisLagTime = laggingSources.get(address);
            if (thisLagTime != null && laggiestTime === thisLagTime) {
                laggingSources.delete(address);
                const newLaggistTime =
                    laggingSources.size > 0
                        ? Math.min(...laggingSources.values())
                        : undefined;
                accumulatedLag +=
                    (newLaggistTime != null
                        ? newLaggistTime
                        : Number(hrtimeMicroSeconds())) - thisLagTime;
                laggiestTime = newLaggistTime;
            }
        };

        let onPending = async (properties: {
            track: Track;
            chunk: Chunk;
        }): Promise<void> => {
            const { latest: isLatest, track: latestTrack } = updateLatestFrame(
                latestPendingFrame,
                properties.track,
                properties.chunk.time
            );

            if (
                !isLatest &&
                latestTrack.startTime < properties.track.startTime
            ) {
                // if the frame to add to the buffer is not the latest and also the start time for the latest is earlier, skip this. TODO this logic does not make sense if we have  a covering track ?
                // here we might end up if we do preloading and we end up with frames we dont need!
                console.log("---------> skip pending: ", {
                    currentPlayedTime:
                        properties.chunk.time + properties.track.startTime,
                    startTime: properties.track.startTime,
                    latestPendingFrame: latestPendingFrame.get(
                        properties.track.source.mediaType
                    )?.time,
                    latestPlayedFrame: latestPlayedFrame.get(
                        properties.track.source.mediaType
                    )?.time,
                    track: properties.track.toString(),
                    latestTrack: latestTrack.toString(),
                });
                return;
            }

            const currentPlayedTime =
                properties.chunk.time + properties.track.startTime;

            //    console.log("--------- > on pending: ", { currentPlayedTime, startTime: properties.track.startTime })

            if (!latestPlayedFrame.has(properties.track.source.mediaType)) {
                // we do this beacuse if we want to calcualte the distance between the latest pending and latest played we dont want to calcuilate it towards 0
                // because if latest pending is 100s and latest played frame is not set, then the differenc would be 100s which is actually not what is in the buffer
                latestPlayedFrame.set(properties.track.source.mediaType, {
                    track: properties.track,
                    time:
                        properties.track.startTime + properties.chunk.time - 1,
                });
            }

            let currentTrack = currentTracks.get(properties.track.idString);
            if (!currentTrack) {
                if (!closed) {
                    console.warn(
                        "Unexpected missing track buffer: " +
                            properties.track.toString()
                    );
                }
                return;
            }
            currentTrack.chunks.push(properties.chunk);

            this.maybeUpdateMaxTime?.(currentPlayedTime);
        };

        let onProgressWrapped: (properties: {
            track: Track;
            chunk: Chunk;
        }) => void | Promise<void> = async (properties) => {
            // console.log("on progress", properties.track.startTime + properties.chunk.time, properties.track.source.mediaType)
            return opts?.onProgress?.(properties);
        };

        let stopReplicationInfoSubscription: (() => Promise<void>) | undefined =
            undefined;

        const evtListener =
            opts?.onReplicationChange &&
            ((ev: CustomEvent<ReplicationRangeEvent>) => {
                opts?.onReplicationChange?.(ev.detail);
            });

        evtListener &&
            this.events.addEventListener("replicationChange", evtListener);
        const listenForReplicationInfoStop =
            this.listenForReplicationInfo().stop;

        stopReplicationInfoSubscription = () => {
            evtListener &&
                this.events.removeEventListener(
                    "replicationChange",
                    evtListener
                );
            return listenForReplicationInfoStop();
        };

        if (this.maxTime != null) {
            // previous iteration yielded a maxTime that we want to annouce to the caller (else this might never be emitted again)
            await opts?.onMaxTimeChange?.({ maxTime: this.maxTime });
        }

        let stopMaxTimeSync: (() => void) | undefined = undefined;

        let preloadTime = opts?.preload != null ? opts.preload * 1e3 : 3e6; // microseconds
        let preloadEndAt = Number(hrtimeMicroSeconds()) + preloadTime;
        const preloadIsDone = () => {
            // waited enough time or there are two pending tracks queues with frames of multiple types
            return (
                Number(hrtimeMicroSeconds()) > preloadEndAt ||
                new Set(
                    [...currentTracks.values()]
                        .filter((x) => x.chunks.length > bufferSize)
                        .map((x) => x.track.source.mediaType)
                ).size >= 2
            );
        };

        if (typeof progress === "number" && progress < 1) {
            const out = this.listenForMaxTimeChanges(opts?.keepTracksOpen);

            let listener = (ev: { detail: { maxTime: number } }) => {
                this.maybeUpdateMaxTime(ev.detail.maxTime);
            };
            this.events.addEventListener("maxTime", listener);
            stopMaxTimeSync = () => {
                out.stop();
                this.events.removeEventListener("maxTime", listener);
            };

            startProgressBarMediaTime = () => {
                if (this.maxTime != null) {
                    return Math.round(progress * this.maxTime);
                }
                return undefined;
            };
        } else {
            startProgressBarMediaTime = () => "live";
        }

        const selectOption = async (track: Track) => {
            if (await removeTrack({ track, clearPending: true })) {
                return; // track was already selected, now unselected
            }

            return maybeChangeTrack({ add: track, force: true });
        };

        const removeTrack = async (properties: {
            track: Track;
            ended?: boolean;
            clearPending?: boolean;
        }) => {
            // remove track in options if ended
            if (properties.ended) {
                const trackOptionIndex = currentTrackOptions.findIndex((x) =>
                    equals(x.id, properties.track.id)
                );
                if (trackOptionIndex >= 0) {
                    currentTrackOptions.splice(trackOptionIndex, 1);
                    opts?.onTrackOptionsChange?.(currentTrackOptions);
                    console.log(
                        "REMOVE TRACK OPTION",
                        properties.track.toString(),
                        properties.ended
                    );
                }
            }

            // remove track in process if we have it
            const trackToRemove = currentTracks.get(properties.track.idString);
            if (trackToRemove) {
                // make sure the we dont skip frames to buffer
                // latestPendingFrame.get(change.add.source.mediaType) will set a threshold where earlier frames are not seem to be worth buffering
                // but force changing track means that we want to replicate the buffer by type to something else
                latestPendingFrame.delete(properties.track.source.mediaType);

                let address = trackToRemove.track.address;
                if (
                    properties.clearPending ||
                    trackToRemove.chunks.length === 0
                ) {
                    console.log("RM TRACK FINALIZE", {
                        track: properties.track.toString(),
                        pendingFrames: currentTracks.get(
                            properties.track.idString
                        )?.chunks.length,
                    });

                    currentTracks.delete(properties.track.idString);
                    opts?.onTracksChange?.(
                        [...currentTracks.values()].map((x) => x.track)
                    );
                }

                deleteLaggyTrack(address);

                if (trackToRemove.track.closed === false) {
                    if (opts?.keepTracksOpen) {
                        await trackToRemove.track.source.endPreviousLivestreamSubscription();
                    } else {
                        await trackToRemove.close?.();
                    }
                }

                if (trackToRemove.track.closed) {
                    this.openedTracks.delete(address);
                }
                /*  console.log("REMOVE TRACK", {
                     startTime: track.startTime,
                     endTime: track.endTime,
                     ended,
                     index,
                     currentTracksLength: currentTracks.length,
                     currentTrackOptionsLength: currentTrackOptions.length,
                 }); */

                return true;
            }

            return false;
        };

        const renderLoop = async (currentSession: number) => {
            let isLive = startProgressBarMediaTime() === "live";
            // console.log({ startPlayAt, laggingStartTime, pendingFrames: pendingFrames.length })

            outer: for (const [address, { track, chunks }] of currentTracks) {
                let spliceSize = 0;

                if (!isLive && startPlayAt != null) {
                    let laggingStartTime = laggingSources.get(address);

                    if (chunks.length === 0 && laggingStartTime == null) {
                        opts?.onUnderflow?.();
                        setLaggyTrack(address);
                    } else if (chunks.length > 0 && laggingStartTime != null) {
                        deleteLaggyTrack(address);
                    }
                }

                for (const chunk of chunks) {
                    if (paused) {
                        break outer;
                    }

                    let isLive = startProgressBarMediaTime() === "live";
                    if (chunks.length - spliceSize < 0) {
                        // TODO larger value to prevent hiccups?
                        break;
                    }

                    if (isLive) {
                        /* console.log("PUSH LIVE", pendingFrames.length); */
                        await onProgressWrapped({
                            chunk: chunk,
                            track: track,
                        });
                        spliceSize++;
                    } else {
                        const startAt = track.startTime + chunk.time;
                        const currentTime = mediaTime();
                        const isLaterThanStartProgress = () => {
                            let time = startProgressBarMediaTime();
                            if (typeof time !== "number") {
                                throw new Error("Unexpected");
                            }
                            return startAt >= time;
                        };

                        const isReadyToPlay =
                            startAt <= (currentTime as number);

                        if (isLaterThanStartProgress()) {
                            let donePreloading = preloadIsDone();
                            if (donePreloading) {
                                startTimer();
                            }
                            if (
                                donePreloading &&
                                (isReadyToPlay ||
                                    /*  startPlayAt == null || */
                                    isLagging(track.address))
                            ) {
                                updateLatestFrame(
                                    latestPlayedFrame,
                                    track,
                                    chunk.time
                                );
                                await onProgressWrapped({
                                    chunk: chunk,
                                    track: track,
                                });
                                spliceSize++;
                            } else {
                                /*  console.log("SKIP", {
                                     startAt,
                                     currentTime,
                                     isReadyToPlay,
                                     startPlayAt,
                                     chunkLength: chunks.length,
                                     track: track.toString(),
                                     isLagging: isLagging(track.address)
                                 }) */
                                break;
                            }
                        } else {
                            spliceSize++; // ignore old frames
                        }
                    }
                }
                if (spliceSize > 0) {
                    chunks.splice(0, spliceSize);

                    // if we are not expecting more frames, delete the buffer
                    // if we dont do this the iterator will think that this track is lagging
                    if (
                        chunks.length === 0 &&
                        (currentTracks.get(track.idString)?.closing ||
                            !currentTracks.has(track.idString))
                    ) {
                        console.log("RM track after empty buffer", address);
                        removeTrack({ track, ended: true, clearPending: true });
                    }
                }
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
                    track.toString(),
                    currentTrackOptions.length
                );
                currentTrackOptions.push(track);

                opts?.onTrackOptionsChange?.([...currentTrackOptions]);
            }
        };

        const updateLatestFrame = (
            map: Map<string, { time: number; track: Track }>,
            track: Track<WebcodecsStreamDB | AudioStreamDB>,
            timeMicroseconds: number
        ) => {
            const latest = map.get(track.source.mediaType);
            const mediaTime = timeMicroseconds + track.startTime;
            if (latest == null || latest.time < mediaTime) {
                map.set(track.source.mediaType, { time: mediaTime, track });
                return { latest: true, track };
            }
            return { latest: false, track: latest.track };
        };

        const maybeChangeTrack = async (change: {
            force?: boolean;
            add?: Track;
            remove?: Track;
            isOption?: boolean;
        }) => {
            // we open track in single queue so we dont re-open and re-listen for same track twice,
            // TODO make parallelizable
            return openTrackQueue.add(async () => {
                // remove existing track if we got a new track with same id that has a endtime set before the currentTime
                try {
                    if (change.add && change.add.endTime != null) {
                        const mediaTimeForType = mediaTime();
                        const existing = currentTrackOptions.find((x) =>
                            equals(x.id, change.add!.id)
                        );
                        if (existing) {
                            // update end time of existing track
                            existing.setEnd(change.add.endTimeBigInt);

                            // remove track if it has ended OR there is a live track in the options and this track is no longer live
                            if (
                                (mediaTimeForType !== "live" &&
                                    change.add.endTime < mediaTimeForType) ||
                                (mediaTimeForType === "live" &&
                                    change.add &&
                                    currentTrackOptions.find(
                                        (x) =>
                                            x.constructor ===
                                                change.add!.constructor &&
                                            x.endTime == null
                                    ))
                            ) {
                                await removeTrack({
                                    track: existing,
                                    ended: true,
                                });
                                console.log(
                                    "RM TRACK ENDED",
                                    change.add.startTime,
                                    change.add.endTime,
                                    mediaTimeForType,
                                    !!currentTrackOptions.find((x) =>
                                        equals(x.id, change.add!.id)
                                    )
                                );
                                return;
                            }
                        }
                    }

                    !change.isOption &&
                        change.add &&
                        addTrackAsOption(change.add);

                    const filteredChange = changeProcessor(
                        {
                            force: change.force,
                            current: currentTracks,
                            options: currentTrackOptions,
                            add: change.add,
                            remove: change.remove,
                        },
                        mediaTime(),
                        preloadTime
                    );

                    if (filteredChange.add || filteredChange.remove) {
                        console.log("MAYBE CHANGE?", {
                            add: filteredChange.add?.toString(),
                            remove: filteredChange.remove?.toString(),
                        });
                    }

                    if (filteredChange.add) {
                        /*   console.log("ADD TRACK FILTER", {
                              track: (filteredChange.add instanceof Track
                                  ? filteredChange.add
                                  : filteredChange.add.track
                              ).toString(),
                          }); */
                        let when =
                            filteredChange.add instanceof Track
                                ? undefined
                                : filteredChange.add.when;
                        await addTrack(
                            filteredChange.add instanceof Track
                                ? filteredChange.add
                                : filteredChange.add.track,
                            when
                        );
                    }
                    if (filteredChange.remove) {
                        /*  console.log("RM TRACK FILTER", {
                             track: filteredChange.remove.toString(),
                         }); */
                        await removeTrack({
                            track: filteredChange.remove,
                            clearPending: true,
                        });
                    }
                } catch (error) {
                    console.error("Error", error);
                    throw error;
                }
            });
        };
        const addTrack = async (track: Track, when?: number) => {
            const runningTrack = currentTracks.get(track.idString);
            if (runningTrack) {
                // console.log("already running cant add ", track.toString())
                return;
            }

            consumedTracks.add(track.idString);

            // is thids clause really needed?
            if (track.endTime != null) {
                const lastPendingFrameTime = latestPendingFrame.get(
                    track.source.mediaType
                );
                if (
                    lastPendingFrameTime != null &&
                    lastPendingFrameTime.time > track.endTime
                ) {
                    return;
                }
            }

            let close: () => void;
            let open: () => void | Promise<void>;

            let prevTrack = track;

            track = await this.node.open(prevTrack, {
                args: {
                    sender: this.owner,
                    startTime: prevTrack.startTimeBigInt,
                },
                existing: "reuse",
            });

            console.log("ADD TRACK", {
                closed,
                track: track.toString(),
                currentTrackSize: currentTracks.size,
            });

            if (track !== prevTrack) {
                // already open
            } else {
                this.addToOpenTrack(track);
            }

            if (startProgressBarMediaTime() === "live") {
                let listener = async (
                    change: CustomEvent<DocumentsChange<Chunk>>
                ) => {
                    for (const chunk of change.detail.added) {
                        await onPending({ chunk, track });
                    }
                };

                close = () => {
                    track.source.chunks.events.removeEventListener(
                        "change",
                        listener
                    );
                };
                open = async () => {
                    close();
                    track.source.chunks.events.addEventListener(
                        "change",
                        listener
                    );
                    await track.source.replicate("live");
                };
            } else {
                let iterator: ResultsIterator<Chunk> | undefined = undefined;
                const createIterator = async () => {
                    const progressStartInMediaTime =
                        startProgressBarMediaTime();
                    if (typeof progressStartInMediaTime == "number") {
                        let currentTime = mediaTime();
                        let currentTimeNumber =
                            typeof currentTime === "number" ? currentTime : 0;
                        // we  need to subtrackt track.startTime to make mediaTime to be relative to the track time
                        let whenPredefined = when ?? 0;
                        let startTimeInTrack = Math.max(
                            Math.max(
                                whenPredefined,
                                progressStartInMediaTime,
                                currentTimeNumber
                            ) - track.startTime,
                            0
                        );
                        return track.source.iterate(startTimeInTrack);
                    }
                    return undefined;
                };

                const bufferLoop = async (currentSession: number) => {
                    if (!iterator) {
                        iterator = await createIterator();
                    }

                    let timeLeftOnBuffer = 0;
                    const loopCondition = () => {
                        let chunks = trackWithBuffer.chunks;
                        if (chunks) {
                            let lastChunk = chunks[chunks.length - 1];
                            let firstChunk = chunks[0];
                            if (lastChunk) {
                                timeLeftOnBuffer =
                                    lastChunk.time - firstChunk.time;
                            } else {
                                timeLeftOnBuffer = 0;
                            }
                        }

                        /*   timeLeftOnBuffer = 
                              (latestPendingFrame.get(track.source.mediaType) ||
                                  0) -
                              (latestPlayedFrame.get(track.source.mediaType) ||
                                  0); */
                        return (
                            timeLeftOnBuffer < bufferTime &&
                            !iterator?.done() &&
                            !closed
                        );
                    };
                    try {
                        while (
                            loopCondition() &&
                            iterator &&
                            iterator.done() !== true &&
                            !track.closed
                        ) {
                            // buffer bufferTime worth of video
                            if (session !== currentSession) {
                                return;
                            }

                            const newChunks = await iterator.next(bufferSize);
                            if (newChunks.length > 0) {
                                for (const chunk of newChunks) {
                                    await onPending({ chunk, track });
                                }
                            }

                            if (
                                !newChunks ||
                                newChunks.length === 0 ||
                                iterator?.done()
                            ) {
                                // TODO? prevent tracks to be reused by setting latest media time to the end time of the track
                                /* updateLatestFrame(
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
                                ); */

                                if (preloadIsDone()) {
                                    startTimer();
                                }

                                console.log("RM TRACK NO MORE CHUNKS", {
                                    deleteImmediately:
                                        trackWithBuffer.chunks.length === 0,
                                    done: iterator?.done(),
                                    pendingFrames:
                                        trackWithBuffer.chunks.length,
                                    track: track.toString(),
                                    address: track.address,
                                });

                                if (trackWithBuffer.chunks.length === 0) {
                                    return removeTrack({
                                        track,
                                        ended: true,
                                        clearPending: true,
                                    });
                                } else {
                                    trackWithBuffer.closing = true;
                                }
                            }
                        }
                    } catch (error) {
                        if (error instanceof AbortError === false) {
                            console.error("Failed to buffer", error);
                        }
                        throw error;
                    }

                    if (session !== currentSession) {
                        return;
                    }

                    const timeTillRunningOutOfFrames = Math.max(
                        (timeLeftOnBuffer - bufferTime) / 1e3,
                        0
                    );

                    /* console.log("---> ", {
                        delay: timeTillRunningOutOfFrames,
                        bufferTime,
                        timeLeftOnBuffer,
                        latestPending: (latestPendingFrame.get(
                            track.source.mediaType
                        ) || 0),
                        latestPlayed: (latestPlayedFrame.get(track.source.mediaType) ||
                            track.startTimeBigInt)
                    }) */

                    delay(timeTillRunningOutOfFrames, {
                        signal: pauseController.signal,
                    })
                        .then(() => bufferLoop(currentSession))
                        .catch((e) => {
                            if (
                                e instanceof AbortError ||
                                e.message === "Not started"
                            ) {
                                // Handling closing errors better
                                return;
                            }
                            console.error("Error in buffer loop", e);
                            throw e;
                        });
                };

                open = () => {
                    /*  track.source.chunks.log.events.addEventListener(
                         "replication:change",
                         replicationChangeListener
                     ); */
                    bufferLoop(session).catch((e) => {
                        if (
                            e instanceof AbortError ||
                            e.message === "Not started"
                        ) {
                            // Handling closing errors better
                            return;
                        }
                        console.error("Error in buffer loop", e);
                        throw e;
                    });
                };
                close = () => {
                    /* track.source.chunks.log.events.removeEventListener(
                        "replication:change",
                        replicationChangeListener
                    ); */
                    return iterator?.close();
                };
            }

            const trackWithBuffer: TrackWithBuffer<any> = {
                track,
                open,
                close: async () => {
                    close();
                    if (!opts?.keepTracksOpen) {
                        return track.close();
                    } else {
                        await track.source.endPreviousLivestreamSubscription();
                        return false;
                    }
                },
                chunks: [],
            };
            currentTracks.set(trackWithBuffer.track.idString, trackWithBuffer);
            await open();
            /* console.log(
                "ADDED TO CURRENT",
                trackWithBuffer.track.startTime,
                mediaTime(),
                currentTracks.length,
                "maxTime: " + this.maxTime
            ); */
            opts?.onTracksChange?.(
                [...currentTracks.values()].map((x) => x.track)
            );
        };

        const scheduleTrackLoop = async (
            fromSession: number,
            preloadEnd: number
        ) => {
            if (fromSession !== session) {
                return;
            }

            const tracksToRemove: [
                Track<WebcodecsStreamDB | AudioStreamDB>,
                boolean
            ][] = [];

            for (const track of currentTrackOptions) {
                if (
                    currentTracks.has(track.idString) ||
                    consumedTracks.has(track.idString)
                ) {
                    continue;
                }

                const currentTime = mediaTime();
                if (currentTime === "live") {
                    await maybeChangeTrack({ add: track, isOption: true });
                } else {
                    if (
                        track.startTime - preloadTime <= currentTime || // ready to play (- preload because we want to load the track earlier since it will take some time to fetch the frames)
                        (currentTracks.size === 0 && startPlayAt == null) // no tracks playing and not started playing yet
                    ) {
                        if (
                            track.endTime == null ||
                            track.endTime > currentTime
                        ) {
                            await maybeChangeTrack({
                                add: track,
                                isOption: true,
                            });
                        } else {
                            tracksToRemove.push([
                                track,
                                track.endTime < currentTime,
                            ]);
                        }
                    }
                }
            }

            for (const [track, ended] of tracksToRemove) {
                await removeTrack({ track, ended });
            }

            requestAnimationFrame(() =>
                scheduleTrackLoop(fromSession, preloadEnd)
            );
        };

        let pauseController = new AbortController();

        let closeListener = () => {
            pauseController.abort("Closed");
            paused = true;
        };

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
                    /* console.log("LATEST", tracks); */
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

            const bufferLoop = async (currentSession: number) => {
                // buffer tracks that are to start, or should start with at least bufferTime
                const progressValue = startProgressBarMediaTime();
                let nextCheckTime = 100; // milliseconds;

                let fetchedOnce = false; // TODO this statement should be inside the while loop?

                if (typeof progressValue === "number") {
                    if (!tracksIterator) {
                        // set the playback start time
                        playbackTime = progressValue;
                        tracksIterator = createIterator(progressValue);
                    }

                    const bufferAhead = 1e6; // microseconds
                    const bufferTo = progressValue + bufferAhead;
                    nextCheckTime = bufferAhead / 1e3; // microseconds to milliseconds

                    while (tracksIterator != null) {
                        if (session !== currentSession) {
                            return;
                        }
                        const current = await tracksIterator.next(1);
                        if (current.length === 0) {
                            if (!fetchedOnce) {
                                // reset the iterator to potentially fetch a new track later
                                // TODO live query instead
                                tracksIterator = undefined;
                            }
                            break;
                        }
                        fetchedOnce = true;

                        for (const track of current) {
                            /*  console.log("ADD OPTION", track.startTime); */
                            addTrackAsOption(track);
                        }

                        const last = current[current.length - 1];
                        if (last.startTime > bufferTo) {
                            nextCheckTime = (last.startTime - bufferTo) / 1e3; // microseconds to milliseconds
                            break;
                        }
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

                playbackTime = mediaTime() as number;
                accumulatedLag = 0;
                laggiestTime = undefined;
                laggingSources.clear();
                startPlayAt = undefined;
            };

            close = () => {
                /* console.log("CLOSE TRACKS"); */
                pause();
                currentTracks.clear();
                stopMaxTimeSync?.();
                stopReplicationInfoSubscription?.();
                return tracksIterator?.close();
            };

            play = () => {
                playing = true;
                bufferLoop(session);
            };

            mediaTime = () => {
                if (playbackTime == undefined) {
                    playbackTime = 0;
                }
                let now = Number(hrtimeMicroSeconds());
                const time =
                    -totalLag(now) +
                    playbackTime +
                    (startPlayAt != null ? now - startPlayAt! : 0);
                return time;
            };
        }

        const playCtrl = () => {
            pauseController = new AbortController();
            this.events.addEventListener("close", closeListener);
            session++;
            play();
            paused = false;
            scheduleTrackLoop(session, Number(hrtimeMicroSeconds()) + 1e6);
            renderLoop(session);
            for (const [_id, track] of currentTracks) {
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
            for (const [_id, track] of currentTracks) {
                track.close?.();
            }
            currentTracks.clear();
        };

        const closeCtrl = async () => {
            session++;
            closed = true;
            paused = true;
            pauseController.abort("Closed");

            openTrackQueue.pause();
            let tracksSize = currentTracks.size;

            await Promise.allSettled([
                close(),
                ...[...currentTracks.values()].map((x) => x.close?.()),
            ]);

            openTrackQueue.clear();
            await openTrackQueue.onEmpty();

            let optionsSize = filterTracksInTime(currentTrackOptions).length;
            currentTrackOptions.splice(0, currentTrackOptions.length);

            currentTracks.clear();
            this.events.removeEventListener("close", closeListener);
            this.events.removeEventListener("maxTime", maxtimeListener);
            tracksSize > 0 && opts?.onTracksChange?.([]);
            optionsSize > 0 && opts?.onTrackOptionsChange?.([]);
        };
        playCtrl();

        return {
            time: () => mediaTime(), // startProgressBarMediaTime === 'live' ? 'live' : latestPlayedFrameTime(),
            options: () => filterTracksInTime(currentTrackOptions),
            current: currentTracks,
            play: playCtrl,
            pause: pauseCtrl,
            paused,
            selectOption,
            close: closeCtrl,
            isLagging: laggiestTime != null,
        };
    }

    async getReplicatedRanges(): Promise<ReplicationRangeIndexable<any>[]> {
        // for all open tracks fetch all my segments are return them
        const ret: ReplicationRangeIndexable<any>[] = [];
        for (const [_address, track] of this.openedTracks) {
            const ranges =
                await track.source.chunks.log.getMyReplicationSegments();
            for (const range of ranges) {
                ret.push(range);
            }
        }
        return ret;
    }

    private async closeOpenTracks() {
        const toClose = this.openedTracks;
        this.openedTracks = new Map();
        if (toClose) {
            for (const [_address, track] of toClose) {
                await track.close();
            }
        }
    }

    public async setEnd(track: Track<any>, time?: bigint | number) {
        if (track.endTime == null) {
            track.setEnd(
                typeof time === "number" ? BigInt(Math.ceil(time)) : time
            );
            await this.tracks.put(track, {
                target: "all",
            });
        }
    }

    async close(args?: any) {
        this._trackChangeListener &&
            this.tracks.events.removeEventListener(
                "change",
                this._trackChangeListener
            );
        await this.closeOpenTracks();
        return super.close(args);
    }

    async drop(args?: any) {
        await this.closeOpenTracks();
        return super.drop(args);
    }
}

class MediaStreamDBIndexable {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    constructor(mediaStream: MediaStreamDB) {
        this.id = mediaStream.id;
        this.owner = mediaStream.owner;
    }
}

/**
 * A database containing media streams so we can replicate any streams
 */
@variant("media-streams-library")
export class MediaStreamDBs extends Program {
    @field({ type: Documents })
    mediaStreams: Documents<MediaStreamDB, MediaStreamDBIndexable>;

    constructor() {
        super();
        this.mediaStreams = new Documents({
            id: sha256Sync(fromString("media-streams-library")),
        });
    }

    private _replicateAll: boolean = false;

    private _streamListener: (
        args: CustomEvent<DocumentsChange<MediaStreamDB>>
    ) => void;
    async open(args?: { replicate: boolean }) {
        this._replicateAll = args?.replicate ?? true;
        console.log("Starting media streams library");
        console.log("Replicating: " + this._replicateAll);
        if (this._replicateAll) {
            this._streamListener = async (
                ev: CustomEvent<DocumentsChange<MediaStreamDB>>
            ) => {
                for (const added of ev.detail.added) {
                    await this.node.open<MediaStreamDB>(added, {
                        args: {
                            replicateTracksByDefault: true,
                        },
                        existing: "reuse",
                    });
                }

                for (const removed of ev.detail.removed) {
                    await removed.close();
                }
            };

            this.mediaStreams.events.addEventListener(
                "change",
                this._streamListener
            );
        }

        await this.mediaStreams.open({
            type: MediaStreamDB,
            index: {
                type: MediaStreamDBIndexable,
            },
            replicate: this._replicateAll
                ? {
                      factor: 1,
                  }
                : false,
            canOpen: () => false, // we do it manually below
        });
    }

    async afterOpen(): Promise<void> {
        await super.afterOpen();
        if (this._replicateAll) {
            // open all local streams
            for (const stream of await this.mediaStreams.index
                .iterate({}, { local: true, remote: false })
                .all()) {
                await this.node.open(stream, {
                    args: {
                        replicateTracksByDefault: true,
                    },
                    existing: "reuse",
                });
            }
        }
    }

    close(from?: Program): Promise<boolean> {
        this._streamListener &&
            this.mediaStreams.events.removeEventListener(
                "change",
                this._streamListener
            );
        return super.close(from);
    }
}
