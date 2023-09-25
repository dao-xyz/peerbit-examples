import { field, variant, fixedArray, vec, option, getSchema } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    Sort,
    SortDirection,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { PublicSignKey, sha256Sync, randomBytes } from "@peerbit/crypto";
import { concat } from "uint8arrays";

/* 
┌──────────┐             
│Post      │             
└┬────────┬┘             
┌▽──────┐┌▽───┐          
│Content││Room│          
└───────┘└┬──┬┘          
┌─────────▽┐┌▽──────────┐
│ChatView  ││SpatialView│
└┬─────────┘└───────────┘
┌▽──────────────┐        
│Documents<Post>│        
└┬──────────────┘        
┌▽─────────────┐         
│Post (a reply)│         
└──────────────┘         

 */



@variant("view")
export abstract class View extends Program {

    @field({ type: fixedArray('u8', 32) })
    id: Uint8Array;

    @field({ type: option('string') })
    parentElement?: string;

    @field({ type: Documents<Element> })
    elements: Documents<Element>;

    constructor(properties: { id?: Uint8Array, parentElement?: string }) {
        super()
        this.id = properties.id || randomBytes(32)
        this.elements = new Documents({ id: this.id })
        this.parentElement = properties.parentElement;
    }


    async getParentElement(): Promise<Element | undefined> {
        if (!this.parentElement) {
            return undefined
        }
        return this.node.open<Element>(this.parentElement, { existing: 'reuse' })
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
        return this.elements.open({
            type: Element,
            canPerform: async (operation, { entry }) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return (
                    /*   !this.key ||
                      entry.signatures.find(
                          (x) =>
                              x.publicKey.equals(this.key!) ||
                              x.publicKey.equals(this.node.identity.publicKey)
                      ) != null */
                    true
                );
            },
            canOpen: () => {
                return true;
            },
            index: {
                fields: async (obj, context) => {
                    return {
                        id: obj.id,
                        publicKey: (await (
                            await this.elements.log.log.get(context.head)
                        )?.getPublicKeys())![0].bytes,
                        content: await obj.content.toIndex(),
                    };
                },
            },
        });
    }


}



@variant(0)
export class Replies {

    @field({ type: Documents<View> })
    views: Documents<View>;

    constructor(
        properties: ({ parentId: Uint8Array } | { seed: Uint8Array }) & {
            name?: string;
        }
    ) {
        const viewsId = sha256Sync(
            concat([
                new TextEncoder().encode("room"),
                properties["parentId"] || properties["seed"],
            ])
        );
        this.views = new Documents({ id: viewsId });
    }

    get id(): Uint8Array {
        return this.views.log.log.id;
    }


    async open(properties: { publicKey?: PublicSignKey }): Promise<void> {
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
        return this.views.open({
            type: View,
            canPerform: async (operation, { entry }) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return (
                    !properties.publicKey ||
                    entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(properties.publicKey!)
                    ) != null,
                    true
                );
            },
            canOpen: () => {
                return true;
            },
            index: {
                fields: async (obj, context) => {
                    return {
                        id: obj.id,
                        publicKey: (await (
                            await this.views.log.log.get(context.head)
                        )?.getPublicKeys())![0].bytes,
                        type: getSchema(obj.constructor).variant,
                    };
                },
            },
        });
    }
}

export abstract class ElementContent {
    abstract toIndex(): Record<string, any>;
    abstract open(properties: { publicKey?: PublicSignKey }): Promise<void>
}

@variant(0)
export class Navigation {

    @field({ type: fixedArray('u8', 32) })
    id: Uint8Array

    @field({ type: 'string' })
    url: string

    constructor(url: string) {
        this.id = randomBytes(32);
        this.url = url;
    }
}

@variant(0)
export class IFrameContent extends ElementContent {

    @field({ type: Documents<Navigation> })
    history: Documents<Navigation>; // https://a.cool.thing.com/abc123



    constructor() {
        super();
        this.history = new Documents()
    }

    async open(properties: { publicKey: PublicSignKey }) {
        this.history.open({
            type: Navigation,
            canPerform: (operation, ctx) => {
                return !properties.publicKey || !!ctx.entry.publicKeys.find(x => x.equals(properties.publicKey))
            },
            index: {
                fields: (obj, ctx) => {
                    return {
                        url: obj.url,
                        timestamp: ctx.modified
                    }
                }
            }
        })
    }

    async toIndex(): Promise<Record<string, any>> {
        return {
            type: "app",
            src: this.getLatest(),
        };
    }

    async getLatest(): Promise<string | undefined> {
        return (await this.history.index.search(new SearchRequest({ sort: new Sort({ key: ['timestamp'], direction: SortDirection.DESC }) })))[0]?.url
    }
}




@variant("variant")
export class Element<T extends ElementContent = any> extends Program {

    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: option(PublicSignKey) })
    publicKey?: PublicSignKey // The root trust

    @field({ type: vec('string') })
    views: string[]

    @field({ type: option(ElementContent) })
    content?: T;

    @field({ type: Replies })
    replies: Replies

    constructor(properties: {
        id?: Uint8Array;
        publicKey?: PublicSignKey;
        content?: T;
        views?: string[]
        room?: Replies,
    }) {
        super()
        this.views = properties.views || []
        this.content = properties.content;
        this.publicKey = properties.publicKey;
        this.id = properties.id || randomBytes(32);
        this.replies = properties.room || new Replies({ seed: this.id, parentId: undefined })
    }

    async open() {
        await this.content?.open({ publicKey: this.publicKey })
        await this.replies.open({ publicKey: this.publicKey })
    }

    async getViews(): Promise<View[]> {
        return (await Promise.allSettled(this.views.map(x => this.node.open<View>(x, { existing: 'reuse' })))).map(x => x.status === 'fulfilled' ? x.value : undefined).filter(x => !!x) as View[];
    }


    async getPath(): Promise<Element<any>[]> {
        // TODO add multiparent support
        let current: Element = this;
        let ret: Element<any>[] = []
        ret.push(current)
        while (current.views.length > 0) {
            const parentElements = await Promise.all((await current.getViews()).map(x => x.parentElement ? this.node.open<Element>(x.parentElement, { existing: 'reuse' }) : undefined))
            const parent = parentElements.filter(x => !!x)[0] as Element
            current = parent;
            ret.push(current)

        }
        return ret.reverse();
    }


}


/* 
type Args = { role?: Role; sync?: SyncFilter };

@variant("spaces")
export class Spaces extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Documents<Rect> })
    canvases: Documents<Canvas>;

    constructor() {
        super();
        this.id = randomBytes(32);
        this.canvases = new Documents();
    }

    open(args?: Args): Promise<void> {
        return this.canvases.open({
            type: Canvas,
            canPerform: async (operation, { entry }) => {
                // Only allow modifications from author
                const payload = await entry.getPayloadValue();
                if (payload instanceof PutOperation) {
                    const from = (payload as PutOperation<Canvas>).getValue(
                        this.canvases.index.valueEncoding
                    ).key;
                    return (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(from)
                        ) != null
                    );
                } else if (payload instanceof DeleteOperation) {
                    const canvas = await this.canvases.index.get(payload.key);
                    const from = canvas.key;
                    if (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(from)
                        ) != null
                    ) {
                        return true;
                    }
                }
                return false;
            },
            canOpen: () => Promise.resolve(false), // don't open things that appear in the db
            role: args?.role,
            sync: args?.sync,
        });
    }
}
 */
