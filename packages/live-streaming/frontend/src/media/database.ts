import { field, variant, option, serialize } from "@dao-xyz/borsh";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { DocumentIndex, Documents } from "@dao-xyz/peerbit-document";
import { Program } from "@dao-xyz/peerbit-program";
import { v4 as uuid } from "uuid";
import { toBase64 } from "@dao-xyz/peerbit-crypto";

@variant(0)
export class Chunk {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    type: string; // video format

    @field({ type: "u64" })
    ts: bigint;

    @field({ type: Uint8Array })
    header: Uint8Array;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(
        type: string,
        header: Uint8Array,
        chunk: Uint8Array,
        ts?: bigint
    ) {
        this.id = uuid();
        this.type = type;
        this.header = header;
        this.chunk = chunk;
        this.ts = ts || BigInt(+new Date());
    }
}

@variant(0)
export class VideoInfo {
    @field({ type: option("u32") })
    width: number;

    @field({ type: option("u32") })
    height: number;

    @field({ type: "u32" })
    bitrate: number;

    constructor(properties: {
        width: number;
        height: number;
        bitrate: number;
    }) {
        this.width = properties.width;
        this.height = properties.height;
        this.bitrate = properties.bitrate;
    }
}

@variant(0)
export class AudioInfo {
    @field({ type: "u32" })
    bitrate: number;

    constructor(properties: { bitrate: number }) {
        this.bitrate = properties.bitrate;
    }
}

@variant(0)
export class MediaStreamInfo {
    @field({ type: option(VideoInfo) })
    video?: VideoInfo;

    @field({ type: option(AudioInfo) })
    audio?: AudioInfo;

    constructor(
        properties:
            | { video: VideoInfo; audio: AudioInfo }
            | { video?: VideoInfo; audio: AudioInfo }
            | { video: VideoInfo; audio?: AudioInfo }
    ) {
        if (properties.video)
            this.video =
                properties.video instanceof VideoInfo
                    ? properties.video
                    : new VideoInfo(properties.video);
        if (properties.audio)
            this.audio =
                properties.audio instanceof AudioInfo
                    ? properties.audio
                    : new AudioInfo(properties.audio);
    }

    hashcode() {
        return toBase64(serialize(this));
    }
}

@variant("media_stream")
export class MediaStreamDB extends Program {
    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: "u64" })
    timestamp: bigint;

    @field({ type: Documents })
    chunks: Documents<Chunk>;

    @field({ type: MediaStreamInfo })
    info: MediaStreamInfo;

    constructor(sender: PublicSignKey, info: MediaStreamInfo) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super({ id: sender.hashcode() + "/" + info.hashcode() }); // Streams addresses will depend on its config
        this.sender = sender;
        this.chunks = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
        this.info = info;
        this.timestamp = BigInt(+new Date());
    }

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
        });
    }
}

@variant(0)
export class MediaStreamDBInfo {
    @field({ type: "string" })
    id: string;

    @field({ type: "bool" })
    active: boolean;

    @field({ type: MediaStreamDB })
    db: MediaStreamDB;

    constructor(properties: { active: boolean; db: MediaStreamDB }) {
        this.active = properties.active;
        this.db = properties.db;
        this.id = this.db.id;
    }
}

@variant("media_streams")
export class MediaStreamDBs extends Program {
    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: Documents })
    streams: Documents<MediaStreamDBInfo>;

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
            type: MediaStreamDBInfo,
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
