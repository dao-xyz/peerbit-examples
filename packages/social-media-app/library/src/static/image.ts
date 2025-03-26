import { field, variant } from "@dao-xyz/borsh";
import { AbstractStaticContent } from "./content.js";
import { concat, equals } from "uint8arrays";

/**
 * Full image data stored as raw binary (Uint8Array).
 */
@variant(1)
export class StaticImage extends AbstractStaticContent {
    // Raw binary image data
    @field({ type: Uint8Array })
    data: Uint8Array;

    @field({ type: "string" })
    mimeType: string; // e.g., "image/png", "image/jpeg"

    @field({ type: "u32" })
    width: number;

    @field({ type: "u32" })
    height: number;

    @field({ type: "string" })
    alt: string; // alt text for accessibility

    @field({ type: "string" })
    caption: string; // optional caption for social feeds

    constructor(properties: {
        data: Uint8Array;
        mimeType: string;
        width: number;
        height: number;
        alt?: string;
        caption?: string;
    }) {
        super();
        this.data = properties.data;
        this.mimeType = properties.mimeType;
        this.width = properties.width;
        this.height = properties.height;
        this.alt = properties.alt || "";
        this.caption = properties.caption || "";
    }

    toString(): string {
        return this.caption;
    }

    get isEmpty() {
        return this.data.length === 0;
    }

    equals(other: StaticImage): boolean {
        return (
            equals(this.data, other.data) &&
            this.mimeType === other.mimeType &&
            this.width === other.width &&
            this.height === other.height &&
            this.alt === other.alt &&
            this.caption === other.caption
        );
    }
}

/**
 * Partial image data stored as raw binary chunks.
 */
@variant(2)
export class StaticPartialImage extends AbstractStaticContent {
    // Raw binary chunk for this part.
    @field({ type: Uint8Array })
    partialData: Uint8Array;

    // The order index of this chunk (e.g. 0, 1, 2, ...)
    @field({ type: "u32" })
    partIndex: number;

    // Total number of parts for the complete image
    @field({ type: "u32" })
    totalParts: number;

    // Image metadata
    @field({ type: "string" })
    mimeType: string; // e.g., "image/png", "image/jpeg"

    @field({ type: "u32" })
    width: number;

    @field({ type: "u32" })
    height: number;

    @field({ type: "string" })
    alt: string;

    @field({ type: "string" })
    caption: string;

    // Group key that identifies which partial images belong together.
    @field({ type: "string" })
    groupKey: string;

    constructor(properties: {
        partialData: Uint8Array;
        partIndex: number;
        totalParts: number;
        mimeType?: string;
        width?: number;
        height?: number;
        alt?: string;
        caption?: string;
        groupKey: string;
    }) {
        super();
        this.partialData = properties.partialData;
        this.partIndex = properties.partIndex;
        this.totalParts = properties.totalParts;
        this.mimeType = properties.mimeType || "";
        this.width = properties.width || 0;
        this.height = properties.height || 0;
        this.alt = properties.alt || "";
        this.caption = properties.caption || "";
        // groupKey is now required.
        this.groupKey = properties.groupKey;
    }

    toString(): string {
        return `Partial ${this.partIndex + 1} of ${this.totalParts}`;
    }

    get isEmpty() {
        return this.partialData.length === 0;
    }

    equals(other: StaticPartialImage): boolean {
        return (
            equals(this.partialData, other.partialData) &&
            this.partIndex === other.partIndex &&
            this.totalParts === other.totalParts &&
            this.mimeType === other.mimeType &&
            this.width === other.width &&
            this.height === other.height &&
            this.alt === other.alt &&
            this.caption === other.caption &&
            this.groupKey === other.groupKey
        );
    }

    /**
     * Combine an array of StaticPartialImage instances into a full StaticImage.
     * This method sorts the parts by partIndex and concatenates the binary chunks.
     * It assumes that all parts share the same groupKey and metadata.
     */
    static combine(parts: StaticPartialImage[]): StaticImage {
        // Sort the parts by their partIndex.
        const sortedParts = parts.sort((a, b) => a.partIndex - b.partIndex);
        // Verify that all parts have the same group key.
        const key = sortedParts[0].groupKey;
        if (!sortedParts.every((p) => p.groupKey === key)) {
            throw new Error("Partial image parts do not share the same groupKey");
        }
        // Combine the Uint8Array chunks.
        const fullData = concat(sortedParts.map((p) => p.partialData));
        const meta = sortedParts[0];

        return new StaticImage({
            data: fullData,
            mimeType: meta.mimeType,
            width: meta.width,
            height: meta.height,
            alt: meta.alt,
            caption: meta.caption,
        });
    }
}
