import { variant, field, vec, option } from "@dao-xyz/borsh";
import { Canvas, AddressReference, IndexableCanvas } from "./content.js";
import { Program } from "@peerbit/program";
import {
    ByteMatchQuery,
    Documents,
    Or,
    SearchRequest,
    StringMatch,
    WithIndexedContext,
} from "@peerbit/document";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";

abstract class Filter {}

@variant(0)
export class PinnedPosts extends Filter {
    @field({ type: vec(Uint8Array) })
    pinned: Uint8Array[];

    constructor(properties: { pinned: Uint8Array[] }) {
        super();
        this.pinned = properties.pinned;
    }
}

export interface FilterModel {
    id: string; // Key to identify the view.
    name: string; // Human-readable name for the view.
    index?: number; // where this view is in the list of views, useful for sorting or ordering.
    query?: (
        from: WithIndexedContext<Canvas, IndexableCanvas>
    ) => SearchRequest; // The query associated with this view.
    settings: ViewSettings; // Extra settings for customization.
}
// Define the structure for each View Model.
export interface ViewSettings {
    // These are placeholders, and you can expand them as necessary.
    layout: "grid" | "list" | "single";
    paginationLimit?: number; // Define how many replies to show per page.
    showAuthorInfo?: boolean; // Whether or not to show author information.
    classNameContainer?: string; // Optional class name for the container.
    classNameReply?: string; // Optional class name for each reply.
}

@variant(0)
export class StreamSetting {
    @field({ type: "string" })
    id: string; // gallery, best, latest, etc

    @field({ type: option("u32") })
    index?: number; // Index of the view, useful for sorting or ordering.

    @field({ type: option(Uint8Array) })
    canvas?: Uint8Array;

    @field({ type: option(Filter) })
    filter?: Filter;

    @field({ type: option(AddressReference) })
    description?: AddressReference;

    /* @field({ type: option(Settings) })
    settings: Settings;

    @field({ type: option(Layout) })
    layout: Layout;
 */
    constructor(properties: {
        id: string;
        canvas?: Uint8Array;
        description?: AddressReference;
        filter?: Filter;
        index?: number;
    }) {
        this.id = properties.id;
        this.canvas = properties.canvas;
        this.description = properties.description;
        this.filter = properties.filter;
        this.index = properties.index;
    }

    toFilterModel(): FilterModel {
        return {
            id: this.id,
            name: this.id,
            index: this.index,
            query:
                this.filter && this.filter instanceof PinnedPosts
                    ? (from: Canvas) => {
                          let pinned = this.filter as PinnedPosts;
                          return new SearchRequest({
                              query: new Or(
                                  pinned.pinned.map(
                                      (p) =>
                                          new ByteMatchQuery({
                                              key: "id",
                                              value: p,
                                          })
                                  )
                              ),
                          });
                      }
                    : undefined,
            settings: {
                // TODO
                layout: "list",
                paginationLimit: 10,
                showAuthorInfo: true,
            },
        };
    }
}

export class IndexableSettings {
    @field({ type: "string" })
    id: string; // gallery, best, latest, etc

    @field({ type: option("u32") })
    index: number | undefined;

    constructor(properties: StreamSetting) {
        this.id = properties.id;
        this.index = properties.index;
    }
}

@variant("filter-stream-settings")
export class StreamSettings extends Program {
    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: Documents })
    settings: Documents<StreamSetting, IndexableSettings>;

    constructor(properties: {
        publicKey: PublicSignKey;
        canvasId?: Uint8Array;
    }) {
        super();
        const documentId = concat([
            properties.publicKey.bytes,
            properties.canvasId ? properties.canvasId : [],
            new TextEncoder().encode("stream-settings"),
        ]);
        this.publicKey = properties.publicKey;
        this.settings = new Documents({ id: sha256Sync(documentId) });
    }

    async open(): Promise<void> {
        await this.settings.open({
            type: StreamSetting,
            keep: "self",
            replicate: { factor: 1 }, // TODO choose better
            canPerform: async (operation) => {
                return true;
            },
            index: {
                type: IndexableSettings,
                prefetch: {
                    strict: false,
                },
            },
        });
    }
}
