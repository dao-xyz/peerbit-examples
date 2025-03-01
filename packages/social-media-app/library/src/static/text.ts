import { field, variant } from '@dao-xyz/borsh';
import { AbstractStaticContent } from './content.js';

@variant(1)
export class StaticMarkdownText extends AbstractStaticContent {
    @field({ type: "string" })
    text: string;

    constructor(properties: { text: string }) {
        super();
        this.text = properties.text;
    }


    /**
     * Returns the raw markdown string.
     */
    toString(): string {
        return this.text;
    }
}