import { field, fixedArray, variant } from "@dao-xyz/borsh";
import { randomBytes, sha256Sync } from "@peerbit/crypto";
import {
    AddressReference,
    Canvas,
    Scope,
    ChildVisualization,
} from "./content.js";
import { Program, ProgramClient } from "@peerbit/program";
import { Documents, id } from "@peerbit/document";
import { concat } from "uint8arrays";
import { ViewKind } from "./link.js";

/* ----------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

const generateId = (...keys: (Uint8Array | string)[]): Uint8Array => {
    const seed = keys.map((key) =>
        typeof key === "string" ? new TextEncoder().encode(key) : key
    );
    return sha256Sync(concat(seed));
};

const getContextText = async (c: Canvas): Promise<string> => {
    return c.nearestScope.createContext(c);
};

/** Minimal helper for same-scope insertions with ordering + experience. */
async function linkSection(
    parent: Canvas,
    draft: Canvas,
    orderKey: string,
    view: ChildVisualization
) {
    const [created, child] = await parent.upsertReply(draft, {
        type: "link-only",                      // new API (no migration)
        kind: new ViewKind({ orderKey }),       // View/ordering kind
        view,                             // replaces old `type`
    });
    return [created, child] as const;
}

/* ----------------------------------------------------------------------------
 * Template (serializable)
 * ------------------------------------------------------------------------- */

@variant(0)
export class Template {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: "string" })
    description: string;

    @field({ type: Canvas })
    prototype: Canvas;

    constructor(p: { name: string; description: string; prototype: Canvas; id?: Uint8Array }) {
        this.id = p.id ?? randomBytes(32);
        this.name = p.name;
        this.description = p.description;
        this.prototype = p.prototype;
    }

    /**
     * Materialize the template under `parent` (deep copy into parent's scope).
     */
    async insertInto(parent: Canvas): Promise<Canvas> {
        const parentScope = parent.nearestScope;

        const cloneSubtree = async (src: Canvas, dstParent: Canvas | undefined): Promise<Canvas> => {
            if (!src.initialized) {
                src = await parentScope.openWithSameSettings(src);
            }

            // fresh node living in the parent's scope
            const draft = new Canvas({
                publicKey: parentScope.node.identity.publicKey,
                selfScope: new AddressReference({ address: parentScope.address }),
            });

            const [_, created] = await parentScope.getOrCreateReply(dstParent, draft);

            // copy text context
            const text = await getContextText(src);
            if (text) await created.addTextElement(text);

            // copy child visualization
            const exp = await src.getExperience();
            if (exp !== undefined) await created.setExperience(exp, { scope: parentScope });

            // preserve child ordering if ViewKind keys exist
            const ordered =
                (await src.getOrderedChildren?.().catch(() => undefined)) ??
                (await src.getChildren());

            let lastKey: string | undefined = undefined;
            for (const child of ordered) {
                const cloned = await cloneSubtree(child, created);
                const viewKey = await src.getChildOrderKey?.(child.id);
                if (viewKey !== undefined) {
                    const nextKey = lastKey ? `${lastKey}~` : "0";
                    await created.upsertViewPlacement(cloned, nextKey);
                    lastKey = nextKey;
                }
            }

            return created;
        };

        return cloneSubtree(this.prototype, parent);
    }
}

@variant(0)
export class IndexableTemplate {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: "string" })
    description: string;

    constructor(p: { id: Uint8Array; name: string; description: string }) {
        this.id = p.id;
        this.name = p.name;
        this.description = p.description;
    }
}

type TemplateArgs = { replicate?: boolean };

@variant("templates")
export class Templates extends Program<TemplateArgs> {
    @field({ type: Documents })
    templates: Documents<Template, IndexableTemplate>;

    constructor(id: Uint8Array) {
        super();
        this.templates = new Documents<Template, IndexableTemplate>({ id });
    }

    async open(args?: TemplateArgs): Promise<void> {
        await this.templates.open({
            type: Template,
            keep: "self",
            replicate: args?.replicate ? { factor: 1 } : false,
            canPerform: async () => true,
            index: {
                type: IndexableTemplate,
                prefetch: { strict: false },
                transform: async (t) =>
                    new IndexableTemplate({
                        id: t.id,
                        name: t.name,
                        description: t.description,
                    }),
            },
        });
    }
}

/* ----------------------------------------------------------------------------
 * Concrete templates
 * ------------------------------------------------------------------------- */

export async function createAlbumTemplate(properties: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = properties;

    const [_, albumRoot] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: generateId("album"),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );

    await albumRoot.setExperience(ChildVisualization.FEED);

    const infoText =
        properties?.description == null
            ? properties.name ?? "Album"
            : `# ${properties.name}\n\n${properties.description}`;
    await albumRoot.addTextElement(infoText);

    // Photos
    {
        const draft = new Canvas({
            id: generateId(albumRoot.id, "photos"),
            publicKey: peer.identity.publicKey,
        });
        const [__, photos] = await linkSection(
            albumRoot,
            draft,
            "0",
            ChildVisualization.OUTLINE
        );
        await photos.addTextElement("Photos");
    }

    // Comments
    {
        const draft = new Canvas({
            id: generateId(albumRoot.id, "comments"),
            publicKey: peer.identity.publicKey,
        });
        const [__, comments] = await linkSection(
            albumRoot,
            draft,
            "1",
            ChildVisualization.OUTLINE
        );
        await comments.addTextElement("Comments");
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("album")),
        name: "Photo album",
        description: "Photos and Comments children",
        prototype: albumRoot,
    });
}

export async function createProfileTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [_, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("profile")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    await root.setExperience(ChildVisualization.EXPLORE);

    let header = props.name ?? "Profile";
    if (props.description) header = `# ${header}\n\n${props.description}`;
    await root.addTextElement(header);

    // Posts
    {
        const draft = new Canvas({
            id: generateId(root.id, "posts"),
            publicKey: peer.identity.publicKey,
        });
        const [__, posts] = await linkSection(
            root,
            draft,
            "0",
            ChildVisualization.FEED
        );
        await posts.addTextElement("Posts");
    }

    // Photos
    {
        const draft = new Canvas({
            id: generateId(root.id, "photos"),
            publicKey: peer.identity.publicKey,
        });
        const [__, photos] = await linkSection(
            root,
            draft,
            "1",
            ChildVisualization.OUTLINE
        );
        await photos.addTextElement("Photos");
    }

    // About
    {
        const draft = new Canvas({
            id: generateId(root.id, "about"),
            publicKey: peer.identity.publicKey,
        });
        const [__, about] = await linkSection(
            root,
            draft,
            "2",
            ChildVisualization.OUTLINE
        );
        await about.addTextElement("About");
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("profile")),
        name: "Personal profile",
        description: "Profile root with Posts, Photos and About sections",
        prototype: root,
    });
}

export async function createCommunityTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [_, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("community")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    await root.setExperience(ChildVisualization.EXPLORE);

    let header = props.name ?? "Community";
    if (props.description) header = `# ${header}\n\n${props.description}`;
    await root.addTextElement(header);

    // Posts
    {
        const draft = new Canvas({
            id: generateId(root.id, "posts"),
            publicKey: peer.identity.publicKey,
        });
        const [__, posts] = await linkSection(
            root,
            draft,
            "0",
            ChildVisualization.FEED
        );
        await posts.addTextElement("Posts");
    }

    // Members
    {
        const draft = new Canvas({
            id: generateId(root.id, "members"),
            publicKey: peer.identity.publicKey,
        });
        const [__, members] = await linkSection(
            root,
            draft,
            "1",
            ChildVisualization.FEED
        );
        await members.addTextElement("Members");
    }

    // Photos
    {
        const draft = new Canvas({
            id: generateId(root.id, "photos"),
            publicKey: peer.identity.publicKey,
        });
        const [__, photos] = await linkSection(
            root,
            draft,
            "2",
            ChildVisualization.FEED
        );
        await photos.addTextElement("Photos");
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("community")),
        name: "Community",
        description: "A community Posts, Members and Photos sections",
        prototype: root,
    });
}

export async function createPlaylistTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [_, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("playlist")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    await root.setExperience(ChildVisualization.FEED);

    let header = props.name ?? "Playlist";
    if (props.description) header = `# ${header}\n\n${props.description}`;
    await root.addTextElement(header);

    // Tracks
    {
        const draft = new Canvas({
            id: generateId(root.id, "tracks"),
            publicKey: peer.identity.publicKey,
        });
        const [__, tracks] = await linkSection(
            root,
            draft,
            "0",
            ChildVisualization.FEED
        );
        await tracks.addTextElement("Tracks");
    }

    // Comments
    {
        const draft = new Canvas({
            id: generateId(root.id, "comments"),
            publicKey: peer.identity.publicKey,
        });
        const [__, comments] = await linkSection(
            root,
            draft,
            "1",
            ChildVisualization.FEED
        );
        await comments.addTextElement("Comments");
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("playlist")),
        name: "Music playlist",
        description: "Playlist root with Tracks and Comments sections",
        prototype: root,
    });
}

export async function createChatTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [_, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("chat")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    await root.setExperience(ChildVisualization.CHAT);

    if (props?.name || props?.description) {
        let header = props.name ?? "Chat";
        if (props.description) header = `# ${header}\n\n${props.description}`;
        await root.addTextElement(header);
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("chat")),
        name: "Chat",
        description: "Start a chat with your friends",
        prototype: root,
    });
}

export async function createArticleTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [__, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("article")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    await root.setExperience(ChildVisualization.FEED);

    let header = props.name ?? "My new article";
    if (props.description) header = `# ${header}\n\n${props.description}`;
    await root.addTextElement(header);

    // Body
    {
        const draft = new Canvas({
            id: generateId(root.id, "article"),
            publicKey: peer.identity.publicKey,
        });
        const [__, body] = await linkSection(
            root,
            draft,
            "0",
            ChildVisualization.OUTLINE
        );
        await body.addTextElement("My new article");
    }

    // Comments
    {
        const draft = new Canvas({
            id: generateId(root.id, "comments"),
            publicKey: peer.identity.publicKey,
        });
        const [__, comments] = await linkSection(
            root,
            draft,
            "1",
            ChildVisualization.FEED
        );
        await comments.addTextElement("Comments");
    }

    return new Template({
        id: sha256Sync(new TextEncoder().encode("article")),
        name: "Article",
        description: "Article with comments sections",
        prototype: root,
    });
}
