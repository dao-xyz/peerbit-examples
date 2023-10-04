import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
} from "@peerbit/document";
import { View } from "./view";

@variant(0)
export class Layout {
    @field({ type: "u32" })
    x: number;

    @field({ type: "u32" })
    y: number;

    @field({ type: "u32" })
    z: number;

    @field({ type: "u32" })
    w: number;

    @field({ type: "u32" })
    h: number;

    @field({ type: "string" })
    breakpoint: string;

    constructor(properties: {
        breakpoint: string;
        x: number;
        y: number;
        z: number;
        w: number;
        h: number;
    }) {
        this.breakpoint = properties.breakpoint;
        this.x = properties.x;
        this.y = properties.y;
        this.z = properties.z;
        this.w = properties.w;
        this.h = properties.h;
    }
}

@variant(0)
export class ElementLayout {

    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array; // Element id

    @field({ type: vec(Layout) })
    layout: Layout[];

    constructor(properties: { id: Uint8Array, layout: Layout[] }) {
        this.id = properties.id;
        this.layout = properties.layout
    }
}




@variant(1)
export class CanvasView extends View {

    @field({ type: Documents })
    layouts: Documents<ElementLayout>;

    constructor() {
        super()
        this.layouts = new Documents()
    }

}
