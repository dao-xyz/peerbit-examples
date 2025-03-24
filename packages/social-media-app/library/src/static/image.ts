import { field, variant } from '@dao-xyz/borsh';
import { AbstractStaticContent } from './content.js';

@variant(0)
export class StaticImage extends AbstractStaticContent {
    @field({ type: "string" })
    base64: string; // base64 encoded original image data

    @field({ type: "string" })
    mimeType: string; // e.g., "image/png", "image/jpeg"

    @field({ type: "u32" })
    width: number; // original width

    @field({ type: "u32" })
    height: number; // original height

    @field({ type: "string" })
    alt: string; // alt text for accessibility

    @field({ type: "string" })
    caption: string; // optional caption for social feeds

    constructor(properties: {
        base64: string,
        mimeType: string,
        width: number,
        height: number,
        alt?: string,
        caption?: string,
    }) {
        super();
        this.base64 = properties.base64;
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
        return this.base64.length === 0;
    }

    equals(other: StaticImage): boolean {
        return this.base64 === other.base64 &&
            this.mimeType === other.mimeType &&
            this.width === other.width &&
            this.height === other.height &&
            this.alt === other.alt &&
            this.caption === other.caption;
    }
}

