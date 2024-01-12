import { field, variant, option, serialize, fixedArray } from "@dao-xyz/borsh";
import {
    sha256Base64Sync,
    PublicSignKey,
    toBase64,
    sha256Sync,
    fromBase64,
} from "@peerbit/crypto";
import {
    DocumentIndex,
    Documents,
    SearchRequest,
    BoolQuery,
    Sort,
    SortDirection,
    IntegerCompare,
    Compare,
    SearchOptions,
    RoleOptions,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { v4 as uuid } from "uuid";
import { write, length } from "@protobufjs/utf8";
import { concat } from "uint8arrays";
import { Entry } from "@peerbit/log";

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
export abstract class TrackSource extends Program<Args> {
    @field({ type: "string" })
    private _id: string;

    @field({ type: PublicSignKey })
    private _sender: PublicSignKey;

    @field({ type: "u64" })
    private _timestamp: bigint;

    @field({ type: Documents })
    private _chunks: Documents<Chunk>;

    constructor(properties: { sender: PublicSignKey; id: string }) {
        super();
        this._id = properties.id;
        this._sender = properties.sender;
        this._timestamp = BigInt(+new Date());
        this._chunks = new Documents({
            id: sha256Sync(
                concat([
                    new TextEncoder().encode("chunks"),
                    new TextEncoder().encode(this._id),
                    sha256Sync(this.sender.bytes),
                ])
            ),
        });
    }

    get id() {
        return this._id;
    }

    get sender(): PublicSignKey {
        return this._sender;
    }

    get timestamp() {
        return this._timestamp;
    }

    get chunks() {
        return this._chunks;
    }

    async open(args?: Args): Promise<void> {
        await this.chunks.open({
            type: Chunk,
            canPerform: async (_operation, context) => {
                const keys = await context.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(this.sender)) {
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
}

@variant("audio-stream-db")
export class AudioStreamDB extends TrackSource {
    @field({ type: "u32" })
    sampleRate: number;

    constructor(sender: PublicSignKey, sampleRate: number) {
        super({ sender, id: sender.hashcode() + "/audio" });
        this.sampleRate = sampleRate;
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

    constructor(props: {
        sender: PublicSignKey;
        decoderDescription: VideoDecoderConfig;
    }) {
        const decoderDescription = serializeConfig(props.decoderDescription);

        super({
            id:
                props.sender.hashcode() +
                "/webcodecs/" +
                sha256Base64Sync(utf8Encode(decoderDescription)),
            sender: props.sender,
        }); // Streams addresses will depend on its config
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

@variant(0)
export class Track<T extends TrackSource> {
    @field({ type: "string" })
    id: string;

    @field({ type: "u64" })
    session: bigint;

    @field({ type: TrackSource })
    source: T;

    constructor(properties: { session: bigint; source: T }) {
        this.session = properties.session;
        this.id = properties.source.id;
        this.source = properties.source;
    }
}

@variant("media-streams")
export class MediaStreamDBs extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: Documents })
    streams: Documents<Track<AudioStreamDB | WebcodecsStreamDB>>;

    constructor(sender: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super();
        this.id = sender.bytes;
        this.sender = sender;
        this.streams = new Documents({
            id: sha256Sync(
                concat([
                    new TextEncoder().encode("media-streams"),
                    this.id,
                    sha256Sync(this.sender.bytes),
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
                    if (key.equals(this.sender)) {
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
                    new IntegerCompare({
                        compare: Compare.GreaterOrEqual,
                        key: "session",
                        value: latest[0].session,
                    }),
                ],
                sort: [
                    new Sort({ key: "session", direction: SortDirection.DESC }),
                ],
            }),
            { ...options }
        );
        return tracks;
    }
}
