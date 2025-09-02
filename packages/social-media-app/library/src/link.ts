
/* ---------------------------------------------------------
 * The edge that lives * inside the parent * and describes
 * how one child should appear under that parent.
 * --------------------------------------------------------- */

import { field, option, variant } from "@dao-xyz/borsh";

export abstract class LinkKind {

    abstract get tag(): number;

}


@variant(0)
export class Layout {
    @field({ type: option("u32") })
    x?: number;

    @field({ type: option("u32") })
    y?: number;

    @field({ type: option("u32") })
    z?: number;

    @field({ type: option("u32") })
    w?: number;

    @field({ type: option("u32") })
    h?: number;

    @field({ type: option("string") })
    breakpoint?: string;

    constructor(properties: {
        x?: number;
        y?: number;
        z?: number;
        w?: number;
        h?: number;
        breakpoint?: string;
    }) {
        this.breakpoint = properties.breakpoint;
        this.x = properties.x;
        this.y = properties.y;
        this.z = properties.z;
        this.w = properties.w;
        this.h = properties.h;
    }

    static zero(breakpoint: string = "md") {
        return new Layout({
            breakpoint,
            x: 0,
            y: 0,
            z: 0,
            w: 0,
            h: 0,
        });
    }
}

@variant(0)
export class ReplyKind extends LinkKind {

    @field({ type: 'u8' })
    tag: number;
    constructor() {
        super()
        this.tag = 0; // ReplyKind tag
    }
}

@variant(1)
export class ViewKind extends LinkKind {
    @field({ type: 'u8' })
    tag: number;

    @field({ type: "string" })
    orderKey: string;
    constructor(p: { orderKey: string }) {
        super()
        this.tag = 1; // ViewKind tag
        this.orderKey = p.orderKey;
    }
}
// 2b) Board/grid view TODO
/* @variant(2)
export class BoardViewKind extends LinkKind {
    @field({ type: 'u8' })
    tag: number;

    @field({ type: Layout })
    layout: Layout;

    constructor(p: { layout: Layout }) {
        super();
        this.tag = 2;
        this.layout = p.layout;
    }
} */