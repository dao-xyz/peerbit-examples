import { field, variant, option, serialize, vec } from "@dao-xyz/borsh";
import { sha256Base64Sync, PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { DocumentIndex, Documents } from "@dao-xyz/peerbit-document";
import { Program } from "@dao-xyz/peerbit-program";
import { v4 as uuid } from "uuid";
import { toBase64 } from "@dao-xyz/peerbit-crypto";
import { write, length } from "@protobufjs/utf8";

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

@variant("media_stream")
export abstract class TrackSource extends Program {
    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: "u64" })
    timestamp: bigint;

    @field({ type: Documents })
    chunks: Documents<Chunk>;

    async setup(): Promise<void> {
        await this.chunks.setup({
            type: Chunk,
            canAppend: async (entry) => {
                const keys = await entry.getPublicKeys();
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
        });
    }
}

@variant(0)
export class AudioStreamDB extends TrackSource {
    @field({ type: "u32" })
    sampleRate: number;

    constructor(sender: PublicSignKey, sampleRate: number) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super({ id: sender.hashcode() + "/audio" }); // Streams addresses will depend on its config
        this.sender = sender;
        this.chunks = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
        this.timestamp = BigInt(+new Date());
        this.sampleRate = sampleRate;
    }
}

@variant(2)
export class WebcodecsStreamDB extends TrackSource {
    @field({ type: "string" })
    decoderConfigJSON?: string;

    constructor(props: {
        sender: PublicSignKey;
        decoderDescription: VideoDecoderConfig | string;
        timestamp?: bigint;
    }) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        const decoderDescription =
            props.decoderDescription &&
            typeof props.decoderDescription === "string"
                ? props.decoderDescription
                : JSON.stringify(props.decoderDescription);

        super({
            id:
                props.sender.hashcode() +
                "/webcodecs/" +
                sha256Base64Sync(utf8Encode(decoderDescription)),
        }); // Streams addresses will depend on its config

        this.decoderConfigJSON = decoderDescription;
        this.sender = props.sender;
        this.chunks = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
        this.timestamp = props.timestamp || BigInt(+new Date());
    }

    private _decoderDescriptionObject: any;
    get decoderDescription(): VideoDecoderConfig {
        if (!this.decoderConfigJSON) {
            return undefined;
        }
        return (
            this._decoderDescriptionObject ||
            (this._decoderDescriptionObject = JSON.parse(
                this.decoderConfigJSON
            ))
        );
    }
}

@variant(0)
export class Track<T extends TrackSource> {
    @field({ type: "string" })
    id: string;

    @field({ type: "bool" })
    active: boolean;

    @field({ type: TrackSource })
    source: T;

    constructor(properties: { active: boolean; source: T }) {
        this.active = properties.active;
        this.id = properties.source.id;
        this.source = properties.source;
    }

    toInactive(): Track<T> {
        return new Track({ active: false, source: this.source });
    }
}

@variant("media_streams")
export class MediaStreamDBs extends Program {
    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: Documents })
    streams: Documents<Track<AudioStreamDB | WebcodecsStreamDB>>;

    constructor(sender: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super({ id: sender.hashcode() });
        this.sender = sender;
        this.streams = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    async setup(): Promise<void> {
        await this.streams.setup({
            type: Track,
            canAppend: async (entry) => {
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
        });
    }
}
