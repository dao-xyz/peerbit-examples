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
    And,
    DocumentsChange,
    CustomDocumentDomain,
    createDocumentDomain,
} from "@peerbit/document";
import {
    IndexedResult,
    IndexedResults,
    NotStartedError,
} from "@peerbit/indexer-interface";
import { ClosedError, Program } from "@peerbit/program";
import { concat } from "uint8arrays";
import { randomBytes } from "@peerbit/crypto";
import { delay, waitFor, AbortError } from "@peerbit/time";
import PQueue from "p-queue";
import { equals } from "uint8arrays";
import pQueue from "p-queue";
import { ReplicationRangeIndexable } from "@peerbit/shared-log";
import { hrtime } from "@peerbit/time";
import { Timestamp } from "@peerbit/log";

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
                    /*  const out = BigInt(
                         entry.meta.clock.timestamp.wallTime / BigInt(1e6)
                     );
                     console.log("OUT", out, entry.meta.clock.timestamp.wallTime)
                     return out; */
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
            if (
                error instanceof NotStartedError ||
                error instanceof ClosedError ||
                error instanceof AbortError
            ) {
                return undefined;
            }
            throw error;
        }
    }

    lastLivestreamingSegmentId: Uint8Array | undefined;
    lastLivestreamingSegmentStart: bigint | undefined;

    async replicate(args: "live" | "streamer" | false) {
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

            console.log("SEGMENT", {
                address: this.chunks.address,
                hash: sha256Base64Sync(this.lastLivestreamingSegmentId!),
                timeBN: last?.timeBN,
                startTime: this.startTime,
                range:
                    offset +
                    " < --- > " +
                    (offset + BigInt(24 * 60 * 60 * 1e3 * 1e9)),
            });
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
                args === "streamer" ? { factor: 1 } : args ?? { factor: 1 }
            );
        }
    }

    async endPreviousLivestreamSubscription() {
        if (!this.lastLivestreamingSegmentId) {
            return;
        }

        console.log(
            "END SEGMENT",
            sha256Base64Sync(this.lastLivestreamingSegmentId)
        );

        const segment: { value: ReplicationRangeIndexable<"u64"> } = (
            await this.chunks.log.replicationIndex
                .iterate({ query: { id: this.lastLivestreamingSegmentId } })
                .all()
        )?.[0];

        if (!segment) {
            console.log(
                "MISSING SEGMENT",
                sha256Base64Sync(this.lastLivestreamingSegmentId)
            );
            throw new Error("Unexpected, missing livestreaming segment");
        }

        let now = hrtimeMicroSeconds();
        console.log("END SEGMENT", {
            hash: sha256Base64Sync(this.lastLivestreamingSegmentId),
            now: now,
            lastLivestreamingSegmentStart: this.lastLivestreamingSegmentStart,
            factor: BigInt(now - this.lastLivestreamingSegmentStart!),
        });

        await this.chunks.log.replicate({
            id: segment.value.id,
            offset: segment.value.start1,
            factor: now - this.lastLivestreamingSegmentStart!, // TODO wthis is wrong potentially if we wrap around u32 and segment.value.start1 is before and now is after
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
        return (
            "Track { time: " + this._startTime + " - " + this._endTime + " }"
        );
    }

    async put(
        chunk: Chunk,
        options?: { target?: "all" | "replicators" | "none" }
    ) {
        await this.source.chunks.put(chunk, {
            target: options?.target,
            meta: {
                timestamp: new Timestamp({
                    wallTime: (this._startTime + chunk.timeBN) * 1000n,
                }),
                next: [],
            },
            unique: true,
        });
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
> = (
    properties: {
        force?: boolean;
        add?: Track<T>;
        remove?: Track<T>;
        current: Track<T>[];
        options: Track<T>[];
    },
    progress: "live" | number
) => { add?: Track<T>; remove?: Track<T> };

const oneVideoAndOneAudioChangeProcessor: TrackChangeProcessor = (
    change,
    progress: "live" | number
) => {
    if (change.add) {
        const alreayHave = change.current.find(
            (x) => x.source.constructor === change.add!.source.constructor
        );
        if (change.force) {
            // replace
            return { remove: alreayHave, add: change.add };
        } else {
            // TODO
            // this conditioin ensures that if we already have a stream but it has an endtime but the new stream does not, we switch
            // but we should not have to have this statement since if an enditme is set before now we should automatically end that track and poll for new tracks?
            if (alreayHave) {
                if (alreayHave.endTime == null) {
                    return {};
                }

                if (alreayHave.endTime !== null && change.add.endTime == null) {
                    if (progress === "live" || progress > alreayHave.endTime) {
                        if (progress !== "live") {
                            console.log(
                                "End in favor of new track ",
                                progress,
                                alreayHave.endTime
                            );
                        }
                        return { remove: alreayHave, add: change.add }; // always favor live streams
                    }

                    return {};
                }

                if (
                    change.add.endTime != null &&
                    change.add.endTime < alreayHave.endTime
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

@variant("media-streams")
export class MediaStreamDB extends Program<{}> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    tracks: Documents<Track<AudioStreamDB | WebcodecsStreamDB>, TrackIndexable>;

    private maxTime: number | undefined = undefined;
    private openedTracks: Track<WebcodecsStreamDB | AudioStreamDB>[] = [];

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
        this.openedTracks = [];
    }

    async getLatest(
        options?: SearchOptions<
            Track<AudioStreamDB | WebcodecsStreamDB>,
            any,
            any
        >
    ): Promise<Track<AudioStreamDB | WebcodecsStreamDB>[]> {
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

    subscribeForMaxTime(
        onChange: (maybeNewMaxtime: number) => void,
        keepTracksOpen: boolean | undefined
    ) {
        let singleQueue = new pQueue({ concurrency: 1 });

        let onClose: (() => any)[] = [];

        const onMaybeChange = (maybeNewMaxTime: number) => {
            if (this.maxTime == null || maybeNewMaxTime > this.maxTime) {
                this.maxTime = maybeNewMaxTime;
                onChange(this.maxTime);
            }
        };

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
                        this.openedTracks.push(openTrack);
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
                        onMaybeChange(maxTime);
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
                                onMaybeChange(openTrack.startTime + chunk.time);
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
                        console.log(
                            "close open track from maxTime search",
                            this.node.identity.publicKey.hashcode(),
                            openTrack.address
                        );
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
                    onMaybeChange(latestClosed.endTime);
                }
            }
        };

        const joinListener = async (e?: {
            detail: { publicKey: PublicSignKey };
        }) => {
            await singleQueue.add(fn());
        };
        joinListener();
        this.tracks.log.events.addEventListener(
            "replicator:join",
            joinListener
        );

        const changeListener = async () => {
            await singleQueue.add(fn());
        };

        this.tracks.events.addEventListener("change", changeListener);

        return {
            stop: async () => {
                this.tracks.log.events.removeEventListener(
                    "replicator:join",
                    joinListener
                );
                this.tracks.events.removeEventListener(
                    "change",
                    changeListener
                );

                await Promise.all(onClose.map((x) => x()));
                this.maxTime = undefined;
            },
        };
    }

    subscribeForReplicationInfo(
        onReplicationChange: (properties: {
            hash: string;
            track: Track;
        }) => void
    ) {
        const createReplicationChangeListener =
            (track: Track) =>
            async (ev: { detail: { publicKey: PublicSignKey | string } }) => {
                // re-emit replication change info

                onReplicationChange?.({
                    hash:
                        ev.detail.publicKey instanceof PublicSignKey
                            ? ev.detail.publicKey.hashcode()
                            : ev.detail.publicKey,
                    track,
                });
            };

        const closeFn: (() => void | Promise<void>)[] = [];
        let listeningOn: Set<string> = new Set();
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
                    this.openedTracks.push(openTrack);
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
        closeFn.push(() =>
            this.tracks.log.events.removeEventListener(
                "replicator:join",
                localTrackListener
            )
        );

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
        const currentTracks: TrackWithBuffer<
            WebcodecsStreamDB | AudioStreamDB
        >[] = [];
        const currentTrackOptions: Track[] = [];
        let closed = false;

        const latestPendingFrame: Map<"audio" | "video", number> = new Map();
        const latestPlayedFrame: Map<"audio" | "video", number> = new Map();

        const startTimer: () => void = () => {
            if (startPlayAt != null) {
                return;
            }
            startPlayAt = Number(hrtimeMicroSeconds());
        };

        // Find max media time
        // That is the media time corresponding to the track with the latest chunk
        let startProgressBarMediaTime: () => number | "live" | undefined;
        let onMaxTimeChange:
            | ((time: number) => Promise<void> | void)
            | undefined = undefined;

        let laggingStartTime: number | undefined = undefined;
        let isLagging = () => laggingStartTime != null;
        let accumulatedLag: number = 0;

        const totalLag = (now = Number(hrtimeMicroSeconds())) => {
            const currentLag =
                laggingStartTime != null ? now - laggingStartTime : 0;
            const totalLag = currentLag + accumulatedLag;
            return totalLag;
        };

        let onPending = async (properties: {
            track: Track;
            chunk: Chunk;
        }): Promise<void> => {
            const isLatest = updateLatestFrame(
                latestPendingFrame,
                properties.track,
                properties.chunk.time
            );
            if (!isLatest) {
                return;
            }

            const currentPlayedTime =
                properties.chunk.time + properties.track.startTime;

            if (!latestPlayedFrame.has(properties.track.source.mediaType)) {
                // we do this beacuse if we want to calcualte the distance between the latest pending and latest played we dont want to calcuilate it towards 0
                // because if latest pending is 100s and latest played frame is not set, then the differenc would be 100s which is actually not what is in the buffer
                latestPlayedFrame.set(
                    properties.track.source.mediaType,
                    properties.track.startTime + properties.chunk.time - 1
                );
            }

            pendingFrames.push(properties);

            if (this.maxTime == null || currentPlayedTime > this.maxTime) {
                this.maxTime = currentPlayedTime;
                await onMaxTimexChangeWrapped?.(currentPlayedTime);
            }

            /* 
            let currentTime = mediaTime();
            let currentTimeMicroseconds = currentTime;// typeof currentTime === 'number' ? currentTime * 1e3 : currentTime

            // console.log("currentPlayedTime", currentPlayedTime, currentTimeMicroseconds, ((typeof currentTimeMicroseconds === 'number' ? currentTimeMicroseconds : 0) > currentPlayedTime) ? "lagging " : "no lagging")
            if (typeof currentTimeMicroseconds === 'number') {
                if (currentTimeMicroseconds > currentPlayedTime) {
                    if (laggingStartTime === undefined) {
                        laggingStartTime = hrtimeMicroSeconds()
                        opts?.onUnderflow?.()
                    }
                }
                else if (laggingStartTime != null) {
                    accumulatedLag += hrtimeMicroSeconds() - laggingStartTime;
                    laggingStartTime = undefined;
                }
            } 
            */
        };

        let onProgressWrapped: (properties: {
            track: Track;
            chunk: Chunk;
        }) => void | Promise<void> = async (properties) => {
            return opts?.onProgress?.(properties);
        };

        let stopReplicationInfoSubscription: (() => Promise<void>) | undefined =
            undefined;
        if (opts?.onReplicationChange) {
            stopReplicationInfoSubscription = this.subscribeForReplicationInfo(
                opts.onReplicationChange
            ).stop;
        }

        let onMaxTimexChangeWrapped: (
            newMaxTime: number
        ) => Promise<void> | void = async (newMaxTime) => {
            await onMaxTimeChange?.(newMaxTime);
            await opts?.onMaxTimeChange?.({ maxTime: newMaxTime });
        };

        if (this.maxTime != null) {
            // previous iteration yielded a maxTime that we want to annouce to the caller (else this might never be emitted again)
            await opts?.onMaxTimeChange?.({ maxTime: this.maxTime });
        }

        let stopMaxTimeSync: (() => void) | undefined = undefined;

        if (typeof progress === "number" && progress < 1) {
            const out = this.subscribeForMaxTime(
                onMaxTimexChangeWrapped,
                opts?.keepTracksOpen
            );
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
                !opts?.keepTracksOpen
                    ? await element.track.close()
                    : await element.track.source.endPreviousLivestreamSubscription();
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
                    console.log("REMOVE TRACK OPTION", track.toString(), ended);
                }
            }

            return false;
        };

        let pendingFrames: {
            track: Track<WebcodecsStreamDB | AudioStreamDB>;
            chunk: Chunk;
        }[] = [];

        const renderLoop = async (currentSession: number) => {
            let spliceSize = 0;

            let isLive = startProgressBarMediaTime() === "live";
            if (!isLive && startPlayAt != null) {
                if (pendingFrames.length === 0 && laggingStartTime == null) {
                    opts?.onUnderflow?.();
                    laggingStartTime = Number(hrtimeMicroSeconds());
                } else if (
                    pendingFrames.length > 0 &&
                    laggingStartTime != null
                ) {
                    accumulatedLag +=
                        Number(hrtimeMicroSeconds()) - laggingStartTime;
                    laggingStartTime = undefined;
                }
            }

            for (const frame of pendingFrames) {
                if (paused) {
                    break;
                }

                let isLive = startProgressBarMediaTime() === "live";
                if (pendingFrames.length - spliceSize < 0) {
                    // TODO larger value to prevent hiccups?
                    break;
                }

                if (isLive) {
                    /* console.log("PUSH LIVE", pendingFrames.length); */
                    await onProgressWrapped({
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

                    const isReadyToPlay = startAt <= (currentTime as number);

                    // console.log(isLaterThanStartProgress(), isReadyToPlay, isLagging(), startAt, currentTime)

                    if (isLaterThanStartProgress()) {
                        if (
                            isReadyToPlay ||
                            startPlayAt == null ||
                            isLagging()
                        ) {
                            updateLatestFrame(
                                latestPlayedFrame,
                                frame.track,
                                frame.chunk.time
                            );
                            startTimer();
                            await onProgressWrapped({
                                chunk: frame.chunk,
                                track: frame.track,
                            });
                        } else {
                            break;
                        }
                    } else {
                        //  console.log("DISCARD!", startAt);
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
                    track.toString(),
                    currentTrackOptions.length
                );
                currentTrackOptions.push(track);

                opts?.onTrackOptionsChange?.([...currentTrackOptions]);
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
            /* console.log(
                "ADD TO QUEUE MAYBE ADD TRACK",
                change.add && toBase64(change.add.id),
                !!currentTracks.find((x) => equals(x.track.id, change.add!.id))
            ); */

            return openTrackQueue.add(async () => {
                // remove existing track if we got a new track with same id that has a endtime set before the currentTime
                // console.log("MAYBE CHANGE TRACK", change.add?.startTime, change.add?.endTime, change.isOption);
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
                                console.log(
                                    "RM TRACK ENDED",
                                    change.add.startTime,
                                    change.add.endTime,
                                    mediaTimeForType
                                );
                                await removeTrack(existing, true);
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
                            current: currentTracks.map((x) => x.track),
                            options: currentTrackOptions,
                            add: change.add,
                            remove: change.remove,
                        },
                        mediaTime()
                    );

                    if (filteredChange.add || filteredChange.remove) {
                        console.log("MAYBE CHANGE?", {
                            add: filteredChange.add?.toString(),
                            remove: filteredChange.remove?.toString(),
                        });
                    }

                    if (filteredChange.add) {
                        await addTrack(filteredChange.add);
                    }
                    if (filteredChange.remove) {
                        console.log(
                            "RM TRACK FILTER",
                            filteredChange.remove.startTime
                        );
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
                track.toString(),
                currentTracks.length
            );

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

            if (track !== prevTrack) {
                // already open
            } else {
                this.openedTracks.push(track);
            }

            // await track.source.chunks.log.waitFor(this.owner);
            /* console.log(
                "INIT TRAACK AT",
                track.toString(),
                startProgressBarMediaTime,
                latestPlayedFrame.get(track.source.mediaType),
                track.source.mediaType
            ); */

            /*   const replicationChangeListener = async (ev: {
                  detail: { publicKey: PublicSignKey };
              }) => {
                  // re-emit replication change info
  
                  opts?.onReplicationChange?.({
                      publicKey: ev.detail.publicKey,
                      track,
                  });
              }; */

            if (startProgressBarMediaTime() === "live") {
                const listener = async (
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
                    /*  track.source.chunks.log.events.removeEventListener(
                         "replication:change",
                         replicationChangeListener
                     ); */
                };
                open = async () => {
                    close();
                    track.source.chunks.events.addEventListener(
                        "change",
                        listener
                    );
                    /* track.source.chunks.log.events.addEventListener(
                        "replication:change",
                        replicationChangeListener
                    ); */
                    await track.source.replicate("live");
                };
                await open();
            } else {
                let iterator: ResultsIterator<Chunk> | undefined = undefined;
                const createIterator = async () => {
                    const progressNumber = startProgressBarMediaTime();
                    if (typeof progressNumber == "number") {
                        return track.source.iterate(
                            Math.max(progressNumber - track.startTime, 0)
                        );
                    }
                    return undefined;
                };

                onMaxTimeChange = async (changeValue: number | undefined) => {
                    await iterator?.close();
                    /* console.log("MAXTIME CHANGE", changeValue, this.maxTime); */
                    // TODO what is expected here? when we receive new max time should we restart in some to aggregate more frames?
                    // iterator = await createIterator();
                };

                const bufferLoop = async (currentSession: number) => {
                    if (!iterator) {
                        iterator = await createIterator();
                    }

                    let timeLeftOnBuffer = 0;
                    const loopCondition = () => {
                        timeLeftOnBuffer =
                            (latestPendingFrame.get(track.source.mediaType) ||
                                0) -
                            (latestPlayedFrame.get(track.source.mediaType) ||
                                0);

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
                                console.log(
                                    "RM TRACK NO MORE CHUNKS",
                                    track.toString(),
                                    iterator?.done()
                                );

                                return removeTrack(track, true);
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

                open();
            }

            const trackWithBuffer: TrackWithBuffer<any> = {
                track,
                open,
                close: () => {
                    close();
                    return !opts?.keepTracksOpen
                        ? track.close()
                        : track.source.endPreviousLivestreamSubscription();
                },
            };

            currentTracks.push(trackWithBuffer);
            /* console.log(
                "ADDED TO CURRENT",
                trackWithBuffer.track.startTime,
                mediaTime(),
                currentTracks.length,
                "maxTime: " + this.maxTime
            ); */
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
                } else if (
                    track.startTime <= currentTime || // ready to play
                    (currentTracks.length === 0 && startPlayAt == null) // no tracks playing and not started playing yet
                ) {
                    if (track.endTime == null || track.endTime > currentTime) {
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
                laggingStartTime = undefined;
                startPlayAt = undefined;
            };

            close = () => {
                /* console.log("CLOSE TRACKS"); */
                pause();
                pendingFrames = [];
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
            closed = true;
            paused = true;
            pauseController.abort("Closed");

            openTrackQueue.pause();
            await Promise.allSettled([
                close(),
                ...currentTracks.map((x) => x.close?.()),
            ]);
            openTrackQueue.clear();
            await openTrackQueue.onEmpty();

            currentTracks.splice(0, currentTracks.length);
            this.events.removeEventListener("close", closeListener);
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

    async getReplicatedRanges(): Promise<ReplicationRangeIndexable<any>[]> {
        // for all open tracks fetch all my segments are return them
        const ret: ReplicationRangeIndexable<any>[] = [];
        for (const track of this.openedTracks) {
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
        this.openedTracks = [];
        for (const track of toClose) {
            console.log(
                "closeOpenTracks",
                this.node.identity.publicKey.hashcode(),
                toClose.map((x) => x.address)
            );
            await track.close();
        }
    }

    public async setEnd(track: Track<any>, time?: bigint | number) {
        if (track.endTime == null) {
            track.setEnd(time);
            await this.tracks.put(track, {
                target: "all",
            });
        }
    }

    async close(args?: any) {
        await this.closeOpenTracks();
        return super.close(args);
    }

    async drop(args?: any) {
        await this.closeOpenTracks();
        return super.drop(args);
    }
}
