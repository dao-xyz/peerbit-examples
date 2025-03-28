import { field, variant } from '@dao-xyz/borsh';
import { AbstractStaticContent } from './content.js';
import { NATIVE_TEXT_APP_URL } from '../types.js';

@variant(0)
export class StaticMarkdownText extends AbstractStaticContent {
    @field({ type: "string" })
    text: string;

    constructor(properties: { text: string }) {
        super();
        this.text = properties.text;
    }


    get isEmpty() {
        return this.text.length === 0;
    }

    /**
     * Returns the raw markdown string.
     */
    toString(): string {
        return this.text;
    }

    equals(other: StaticMarkdownText): boolean {
        return this.text === other.text;
    }

    get nativeAddress() {
        return NATIVE_TEXT_APP_URL
    }
}