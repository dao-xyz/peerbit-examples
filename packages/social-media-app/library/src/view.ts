import { variant, field, vec, option } from "@dao-xyz/borsh";
import { Canvas, CanvasAddressReference } from "./content.js";
import { Program } from "@peerbit/program";
import {
    And,
    Documents,
    Or,
    SearchRequest,
    StringMatch,
} from "@peerbit/document";
import { sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";

abstract class Filter {}

@variant(0)
export class PinnedPosts extends Filter {
    @field({ type: vec(CanvasAddressReference) })
    pinned: CanvasAddressReference[];

    constructor(properties: { pinned: CanvasAddressReference[] }) {
        super();
        this.pinned = properties.pinned;
    }
}

export interface ViewModel {
    id: string; // Key to identify the view.
    name: string; // Human-readable name for the view.
    index?: number; // where this view is in the list of views, useful for sorting or ordering.
    query?: (from: Canvas) => SearchRequest; // The query associated with this view.
    settings: ViewSettings; // Extra settings for customization.
}
// Define the structure for each View Model.
export interface ViewSettings {
    // These are placeholders, and you can expand them as necessary.
    layout: "grid" | "list" | "single";
    focus: "first" | "last";
    paginationLimit?: number; // Define how many replies to show per page.
    showAuthorInfo?: boolean; // Whether or not to show author information.
    classNameContainer?: string; // Optional class name for the container.
    classNameReply?: string; // Optional class name for each reply.
}

@variant(0)
export class View {
    @field({ type: "string" })
    id: string; // gallery, best, latest, etc

    @field({ type: option("u32") })
    index?: number; // Index of the view, useful for sorting or ordering.

    @field({ type: CanvasAddressReference })
    canvas: CanvasAddressReference;

    @field({ type: option(Filter) })
    filter?: Filter;

    @field({ type: option(CanvasAddressReference) })
    description?: CanvasAddressReference;

    /* @field({ type: option(Settings) })
    settings: Settings;

    @field({ type: option(Layout) })
    layout: Layout;
 */
    constructor(properties: {
        id: string;
        canvas: CanvasAddressReference;
        description?: CanvasAddressReference;
        filter?: Filter;
        index?: number;
    }) {
        this.id = properties.id;
        this.canvas = properties.canvas;
        this.description = properties.description;
        this.filter = properties.filter;
        this.index = properties.index;
    }

    toViewModel(): ViewModel {
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
                                          new StringMatch({
                                              key: "address",
                                              value: p.address,
                                          })
                                  )
                              ),
                          });
                      }
                    : undefined,
            settings: {
                // TODO
                layout: "list",
                focus: "first",
                paginationLimit: 10,
                showAuthorInfo: true,
            },
        };
    }
}

export class IndexableView {
    @field({ type: "string" })
    id: string; // gallery, best, latest, etc

    @field({ type: option("u32") })
    index: number | undefined;

    constructor(properties: View) {
        this.id = properties.id;
        this.index = properties.index;
    }
}

@variant("views")
export class Views extends Program {
    @field({ type: Documents })
    views: Documents<View, IndexableView>;

    constructor(properties: { canvasId: Uint8Array }) {
        super();
        const documentId = concat([
            properties.canvasId,
            new TextEncoder().encode("views"),
        ]);
        this.views = new Documents({ id: sha256Sync(documentId) });
    }

    async open(): Promise<void> {
        await this.views.open({
            type: View,
            keep: "self",
            replicate: { factor: 1 }, // TODO choose better
            canPerform: async (operation) => {
                return true;
            },
            index: {
                type: IndexableView,
                prefetch: {
                    strict: false,
                },
            },
        });
    }
}
