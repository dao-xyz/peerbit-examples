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
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { v4 as uuid } from "uuid";
import { write, length } from "@protobufjs/utf8";
import { concat } from "uint8arrays";
import { Entry } from "@peerbit/log";
import { randomBytes } from "@peerbit/crypto";

const utf8Encode = (value: string) => {
    const l = length(value);
    const arr = new Uint8Array(l);
    write(value, arr, 0);
    return arr;
};

@variant(0)
export class Chunk {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    type: string;

    @field({ type: "u64" })
    timestamp: bigint;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(props: { type: string; chunk: Uint8Array; timestamp: bigint }) {
        this.id = uuid();
        this.type = props.type;
        this.chunk = props.chunk;
        this.timestamp = props.timestamp;
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
                        timestamp: obj.timestamp,
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
    get decoderDescription(): VideoDecoderConfig {
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

    @field({ type: "u64" })
    session: bigint;

    @field({ type: "u32" })
    startTime: number;

    @field({ type: option("u32") })
    endTime?: number; // when the track ended

    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    constructor(properties: {
        sender: PublicSignKey;
        session: bigint;
        start: number;
        source: T;
    }) {
        super();
        this.id = randomBytes(32);
        this.session = properties.session;
        this.startTime = properties.start;
        this.source = properties.source;
        this.sender = properties.sender;
    }

    setEnd() {
        this.endTime = +new Date() - Number(this.session);
    }
    open(args?: Args): Promise<void> {
        return this.source.open({ ...args, sender: this.sender });
    }

    /**
     *
     * @param progress [0,1] (the progress bar)
     */
    async iterate(progress: number) {
        // Find max media time
        console.log("FETCH MAX TIME");
        const maxMediaTime = (
            await this.source.chunks.index.search(
                new SearchRequest({
                    sort: [
                        new Sort({
                            direction: SortDirection.DESC,
                            key: "timestamp",
                        }),
                    ],
                }),
                { local: true, remote: true, size: 1 }
            )
        )[0].timestamp;

        // convert progress bar value into a media time
        const progressBarMediaTime = progress * Number(maxMediaTime);

        console.log("MAX TIME", progress, progressBarMediaTime);

        // create an iterator that starts from the progress bar and goes forward
        return this.source.chunks.index.iterate(
            new SearchRequest({
                query: [
                    new IntegerCompare({
                        key: "timestamp",
                        compare: Compare.GreaterOrEqual,
                        value: BigInt(Math.round(progressBarMediaTime)),
                    }),
                ],
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: "timestamp",
                    }),
                ],
            }),
            { remote: true, local: false }
        );
    }
}

@variant("media-streams")
export class MediaStreamDB extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    streams: Documents<Track<AudioStreamDB | WebcodecsStreamDB>>;

    constructor(owner: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super();
        this.id = owner.bytes;
        this.owner = owner;
        this.streams = new Documents({
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
        await this.streams.open({
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
        const latest = await this.streams.index.search(
            new SearchRequest({
                sort: [
                    new Sort({ key: "session", direction: SortDirection.DESC }),
                ],
            }),
            { ...options, size: 1 }
        );
        if (latest.length === 0) {
            return [];
        }
        const tracks = await this.streams.index.search(
            new SearchRequest({
                query: [
                    // Only get by the latest session
                    new IntegerCompare({
                        compare: Compare.GreaterOrEqual,
                        key: "session",
                        value: latest[0].session,
                    }),

                    // make track has not ended
                    new MissingField({
                        key: "endTime",
                    }),
                ],
                /*    sort: [
                       // sort first by session 
                       new Sort({ key: "session", direction: SortDirection.DESC }),
                   ], */
            }),
            { ...options }
        );

        return tracks;
    }
}
