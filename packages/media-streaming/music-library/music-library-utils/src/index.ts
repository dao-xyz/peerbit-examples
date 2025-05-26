import { PublicSignKey, randomBytes, sha256Sync } from "@peerbit/crypto";
import { field, fixedArray, option, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { Documents, DocumentsChange, id } from "@peerbit/document";
import { MediaStreamDBs } from "@peerbit/media-streaming";

class MediaStreamDBsIndexable {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: option(PublicSignKey) })
    owner?: PublicSignKey;

    constructor(props: MediaStreamDBs) {
        this.id = props.id;
        this.owner = props.owner;
    }
}

@variant("store-of-libraries")
export class StoraOfLibraries extends Program {
    @field({ type: Documents })
    libraries: Documents<MediaStreamDBs, MediaStreamDBsIndexable>;

    constructor(properties?: { id?: Uint8Array }) {
        super();
        this.libraries = new Documents<MediaStreamDBs, MediaStreamDBsIndexable>(
            {
                id:
                    properties?.id ??
                    sha256Sync(new TextEncoder().encode("store-of-libraries")),
            }
        );
    }

    private _replicateAll: boolean = false;

    private _streamListener: (
        args: CustomEvent<
            DocumentsChange<MediaStreamDBs, MediaStreamDBsIndexable>
        >
    ) => void;
    async open(args?: { replicate: boolean }) {
        this._replicateAll = args?.replicate ?? true;
        if (this._replicateAll) {
            this._streamListener = async (
                ev: CustomEvent<
                    DocumentsChange<MediaStreamDBs, MediaStreamDBsIndexable>
                >
            ) => {
                for (const added of ev.detail.added) {
                    await this.node.open<MediaStreamDBs>(added, {
                        args: {
                            replicate: "all",
                        },
                        existing: "reuse",
                    });
                }

                for (const removed of ev.detail.removed) {
                    await removed.close();
                }
            };

            this.libraries.events.addEventListener(
                "change",
                this._streamListener
            );
        }

        await this.libraries.open({
            type: MediaStreamDBs,
            index: {
                type: MediaStreamDBsIndexable,
            },
            keep: "self",
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
            for (const stream of await this.libraries.index
                .iterate({}, { local: true, remote: false })
                .all()) {
                await this.node.open(stream, {
                    args: {
                        replicate: "all",
                    },
                    existing: "reuse",
                });
            }
        }
    }

    close(from?: Program): Promise<boolean> {
        this._streamListener &&
            this.libraries.events.removeEventListener(
                "change",
                this._streamListener
            );
        return super.close(from);
    }
}

class NamedItem {
    @id({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    constructor(props: { id: Uint8Array; name: string }) {
        this.id = props.id;
        this.name = props.name;
    }
}

type ReplicationArgs = { replicate?: boolean };

/* ─────────────── program ─────────────── */
@variant("named-items")
export class NamedItems extends Program<ReplicationArgs> {
    @field({ type: Documents })
    documents: Documents<NamedItem>;

    constructor(props?: { id?: Uint8Array }) {
        super();
        this.documents = new Documents<NamedItem>({
            id:
                props?.id ??
                sha256Sync(new TextEncoder().encode("named-items")),
        });
    }

    /** Write / overwrite name for any address-like object  */
    async setName(id: Uint8Array, name: string) {
        await this.documents.put(new NamedItem({ id, name }));
    }

    async open(args?: ReplicationArgs): Promise<void> {
        await this.documents.open({
            type: NamedItem,
            keep: "self",
            replicate: args?.replicate ? { factor: 1 } : false,
            index: {
                type: NamedItem,
            },
        });
    }
}

class ImageItem {
    @id({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Uint8Array })
    img: Uint8Array;

    @field({ type: "u32" })
    width: number;

    @field({ type: "u32" })
    height: number;

    constructor(props: {
        id: Uint8Array;
        img: Uint8Array;
        width: number;
        height: number;
    }) {
        this.id = props.id;
        this.width = props.width;
        this.height = props.height;
        this.img = props.img;
    }
}

class IndexedImageItem {
    @id({ type: Uint8Array })
    id: Uint8Array;

    constructor(props: ImageItem) {
        this.id = props.id;
    }
}

/* ─────────────── program ─────────────── */
@variant("image-items")
export class ImageItems extends Program {
    @field({ type: Documents })
    documents: Documents<ImageItem, IndexedImageItem>;

    constructor(props?: { id?: Uint8Array }) {
        super();
        this.documents = new Documents<ImageItem, IndexedImageItem>({
            id:
                props?.id ??
                sha256Sync(new TextEncoder().encode("image-items")),
        });
    }

    /** Write / overwrite image for any address-like  */
    async setImage(
        id: Uint8Array,
        img: Uint8Array,
        width: number,
        height: number
    ) {
        await this.documents.put(new ImageItem({ id, img, width, height }));
    }

    async open(args?: ReplicationArgs): Promise<void> {
        await this.documents.open({
            type: ImageItem,
            keep: "self",
            replicate: args?.replicate ? { factor: 1 } : false,
            index: {
                type: IndexedImageItem,
            },
        });
    }
}

@variant(0)
export class PlayEvent {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "u32" })
    duration: number;

    @field({ type: fixedArray("u8", 32) })
    source: Uint8Array;

    constructor(props: { duration: number; source: Uint8Array }) {
        this.duration = props.duration;
        this.source = props.source;
        this.id = randomBytes(32);
    }
}

@variant("play-stats")
export class PlayStats extends Program {
    @field({ type: Documents })
    documents: Documents<PlayEvent, PlayEvent>;

    constructor(props?: { id?: Uint8Array }) {
        super();
        this.documents = new Documents<PlayEvent, PlayEvent>({
            id: props?.id ?? sha256Sync(new TextEncoder().encode("play-stats")),
        });
    }

    async open(args?: ReplicationArgs): Promise<void> {
        await this.documents.open({
            type: PlayEvent,
            keep: "self",
            replicate: args?.replicate ? { factor: 1 } : false,
        });
    }
}
