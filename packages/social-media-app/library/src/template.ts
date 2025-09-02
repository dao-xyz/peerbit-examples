import { field, fixedArray, variant } from "@dao-xyz/borsh";
import { randomBytes, sha256Sync } from "@peerbit/crypto";
import {
    AddressReference,
    Canvas,
    Scope,
    ChildVisualization,
    resolveChild,
} from "./content.js";
import { Program, ProgramClient } from "@peerbit/program";
import { Documents, id } from "@peerbit/document";
import { concat } from "uint8arrays";
import { LinkKind, ViewKind } from "./link.js";

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
 * Deep-copy this.template.prototype under `parent` (new ids, parent’s scope).
 * Uses Scope.publish(..., { type: "fork", updateHome: "set" }) so payload/experience
 * are copied by the publish pipeline, not manually here.
 */
    async insertInto(parent: Canvas): Promise<Canvas> {
        const parentScope = parent.nearestScope;


        const clone = async (
            src: Canvas,
            dstParent: Canvas,
            kind?: LinkKind,
            view?: ChildVisualization
        ): Promise<Canvas> => {
            // Open source with its own home settings (publish does copies from srcHome→dest)
            const srcOpen = src.initialized ? src : await dstParent.nearestScope.openWithSameSettings(src);

            // Materialize a fork in the parent scope; preserve edge metadata if provided
            const [, dst] = await parentScope.publish(srcOpen, {
                type: "fork",
                id: "new",           // new id for each node in the cloned tree
                updateHome: 'set', // keep srcOpen's selfScope as is (copied by publish)
                visibility: "both",
                targetScope: parentScope,
                parent: dstParent,   // link under the parent we just created
                kind,    // preserves ViewKind(orderKey) for ordering
                view,    // if you store view on the edge, keep it; otherwise omit
                // no need to pass publish.view for node’s own experience:
                // copyVisualizationBetweenScopes already copies the node view/experience
            });

            // Recreate children using their original link metadata
            const links = await srcOpen.getChildrenLinks(); // { child, kind?, view? }[]
            for (const link of links) {
                let child = await resolveChild(link, src.nearestScope);
                if (!child) {
                    throw new Error("Failed to resolve child during template cloning");
                }
                const loaded = await src.nearestScope.openWithSameSettings(child);
                const vizualization = await loaded.getVisualization();
                await clone(loaded, dst, link.kind, vizualization?.view);
            }

            return dst;
        };

        return clone(this.prototype, parent);
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

    const [created, albumRoot] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: generateId("album"),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("album")),
        name: "Photo album",
        description: "Photos and Comments children",
        prototype: albumRoot,
    })

    if (!created) {
        return template;
    }


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

    return template;
}

export async function createProfileTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [created, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("profile")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );

    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("profile")),
        name: "Personal profile",
        description: "Profile root with Posts, Photos and About sections",
        prototype: root,
    })

    if (!created) {
        return template;
    }

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

    return template;
}

export async function createCommunityTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [created, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("community")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );

    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("community")),
        name: "Community",
        description: "A community Posts, Members and Photos sections",
        prototype: root,
    })

    if (!created) {
        return template;
    }

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

    return template;
}

export async function createPlaylistTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [created, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("playlist")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );

    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("playlist")),
        name: "Music playlist",
        description: "Playlist root with Tracks and Comments sections",
        prototype: root,
    });

    if (!created) {
        return template;
    }



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

    return template
}

export async function createChatTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [created, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("chat")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );

    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("chat")),
        name: "Chat",
        description: "Start a chat with your friends",
        prototype: root,
    })

    if (!created) {
        return template;
    }

    await root.setExperience(ChildVisualization.CHAT);

    if (props?.name || props?.description) {
        let header = props.name ?? "Chat";
        if (props.description) header = `# ${header}\n\n${props.description}`;
        await root.addTextElement(header);
    }

    return template;
}

export async function createArticleTemplate(props: {
    peer: ProgramClient;
    scope: Scope;
    name?: string;
    description?: string;
}): Promise<Template> {
    const { peer, scope } = props;

    const [created, root] = await scope.getOrCreateReply(
        undefined,
        new Canvas({
            id: sha256Sync(new TextEncoder().encode("article")),
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: scope.address }),
        })
    );
    const template = new Template({
        id: sha256Sync(new TextEncoder().encode("article")),
        name: "My new article",
        description: "Article with comments sections",
        prototype: root,
    })

    if (!created) {
        return template;
    }

    await root.setExperience(ChildVisualization.FEED);

    let header = props.name ?? "Article";
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
        await body.addTextElement("Article");
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

    return template;
}
