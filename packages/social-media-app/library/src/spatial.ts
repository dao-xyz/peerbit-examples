import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
} from "@peerbit/document";
import { View } from "./content";

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




@variant("canvas")
export class CanvasView extends View {

    @field({ type: Documents })
    layouts: Documents<ElementLayout>;

    constructor(properties: { parentElement: string }) {
        super(properties)
        this.layouts = new Documents()
    }

    async open(): Promise<void> {
        /*  await this.name.open({
             canPerform: async (operation, { entry }) => {
                 // Only allow updates from the creator
                 return (
                     entry.signatures.find(
                         (x) =>
                             x.publicKey.equals(this.key)
                     ) != null
                 );
             }
         })
     */
        await super.open()
        return this.layouts.open({
            type: ElementLayout,
            canPerform: async (operation, { entry }) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                /*  return (
                     !this.key ||
                     entry.signatures.find(
                         (x) =>
                             x.publicKey.equals(this.key!) ||
                             x.publicKey.equals(this.node.identity.publicKey)
                     ) != null
                 ); */
                return true;
            },
            index: {
                fields: async (obj, context) => {
                    return {
                        id: obj.id,
                        publicKey: (await (
                            await this.elements.log.log.get(context.head)
                        )?.getPublicKeys())![0].bytes,
                        ...obj.layout
                    };
                },
            },
        });
    }

}
