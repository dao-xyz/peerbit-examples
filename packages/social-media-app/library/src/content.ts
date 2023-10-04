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
┌──────┐         
│Post_1│         
└┬─────┘         
┌▽──────────────┐
│Documents<Post>│
└┬───────┬──────┘
┌▽─────┐┌▽─────┐ 
│Post_2││Post_3│ 
└──────┘└──────┘

 */





@variant(0)
export class Replies {

    /*     @field({ type: Documents<Element> })
        views: Documents<Element> */

    @field({ type: Documents<Element> })
    elements: Documents<Element>


    @field({ type: option('string') })
    parentElement?: string;


    private element: Element;


    constructor(
        properties: ({ parentElement: string } | { seed: Uint8Array }) & {
            name?: string
        }
    ) {
        const elementsId = sha256Sync(
            concat([
                new TextEncoder().encode("room"),
                properties["parentElement"] ? new TextEncoder().encode(properties["parentElement"]) : properties["seed"],
            ])
        );
        this.elements = new Documents({ id: elementsId });
    }

    get id(): Uint8Array {
        return this.elements.log.log.id;
    }
    /*    async getViews(): Promise<View[]> {
           return (await Promise.allSettled(this.views.map(x => this.node.open<View>(x, { existing: 'reuse' })))).map(x => x.status === 'fulfilled' ? x.value : undefined).filter(x => !!x) as View[];
       } */






    async open(properties: { element: Element }): Promise<void> {
        this.element = properties.element;
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
                    /*    return (
                    !properties.publicKey ||
                    entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(properties.publicKey!)
                    ) != null,
                    true
                ); */
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
        await this.history.open({
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

    toIndex(): Record<string, any> {
        return {
            type: "app",
            // TODO and TEST src: this.getLatest(),
        };
    }

    async getLatest(): Promise<string | undefined> {
        return (await this.history.index.search(new SearchRequest({ sort: new Sort({ key: ['timestamp'], direction: SortDirection.DESC }) })))[0]?.url
    }
}




@variant("element")
export class Element<T extends ElementContent = any> extends Program {

    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: option(PublicSignKey) })
    publicKey?: PublicSignKey // The root trust

    @field({ type: vec('string') })
    views: string[]

    @field({ type: option(ElementContent) })
    content?: T;

    @field({ type: option('string') })
    parentElement?: string;

    @field({ type: Replies })
    replies: Replies;

    constructor(properties: {
        id?: Uint8Array;
        publicKey?: PublicSignKey;
        content?: T;
        views?: string[]
        room?: Replies,
        parentElement?: string
    }) {
        super()
        this.views = properties.views || []
        this.content = properties.content;
        this.publicKey = properties.publicKey;
        this.id = properties.id || randomBytes(32);
        this.replies = properties.room || new Replies({ seed: this.id })
        this.parentElement = properties.parentElement
    }

    async open() {
        await this.content?.open({ publicKey: this.publicKey })
        await this.replies.open({ element: this })
    }



    async getParentElement(): Promise<Element | undefined> {
        if (!this.parentElement) {
            return undefined
        }
        return this.node.open<Element>(this.parentElement, { existing: 'reuse' })
    }


    async getPath(): Promise<Element<any>[]> {
        // TODO add multiparent support
        let current: Element = this;
        const ret: Element<any>[] = []
        ret.push(current)
        while (current.parentElement) {
            const parent = await this.node.open<Element>(current.parentElement, { existing: 'reuse' })
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
