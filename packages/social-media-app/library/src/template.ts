import { field, fixedArray, variant } from "@dao-xyz/borsh";
import { randomBytes, sha256Sync } from "@peerbit/crypto";
import { Canvas, ChildVisualization, Layout } from "./content.js";
import { Program, ProgramClient } from "@peerbit/program";
import { Documents, id } from "@peerbit/document";
import { concat } from "uint8arrays";

const generateId = (...keys: (Uint8Array | string)[]): Uint8Array => {
    const seed = keys.map((key) => {
        if (typeof key === "string") {
            return new TextEncoder().encode(key);
        } else {
            return key;
        }
    });
    return sha256Sync(concat(seed));
};

/** A serialisable template that can be cloned into any Canvas tree. */
@variant(0)
export class Template {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: "string" })
    description: string;

    /* --- The prototype Canvas subtree ---------------------------------- */
    @field({ type: Canvas })
    prototype: Canvas;

    constructor(p: {
        name: string;
        description: string;
        prototype: Canvas;
        id?: Uint8Array;
    }) {
        this.id = p.id ?? randomBytes(32);
        this.name = p.name;
        this.description = p.description;
        this.prototype = p.prototype;
    }

    /**
     * Materialise the template *below* an already‑opened parent Canvas.
     * A deep copy is produced – nothing in the original prototype
     * (IDs, authors, addresses) leaks into the newly created canvases.
     */
    async insertInto(parent: Canvas): Promise<Canvas> {
        const node = parent.node as ProgramClient;
        if (!node) {
            throw new Error("Parent canvas is not opened");
        }

        // Recursively copy the prototype subtree ------------------------
        this.prototype = await parent.openWithSameSettings(this.prototype)
        return this.prototype.cloneInto(parent);
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

    constructor(properties: {
        id: Uint8Array;
        name: string;
        description: string;
    }) {
        this.id = properties.id;
        this.name = properties.name;
        this.description = properties.description;
    }
}

type TemplateArgs = {
    replicate?: boolean;
};

@variant("templates")
export class Templates extends Program<TemplateArgs> {
    @field({ type: Documents })
    templates: Documents<Template, IndexableTemplate>;

    constructor(id: Uint8Array) {
        super();
        this.templates = new Documents<Template, IndexableTemplate>({
            id: id,
        });
    }

    async open(args?: TemplateArgs): Promise<void> {
        await this.templates.open({
            type: Template,
            keep: "self",
            replicate: args?.replicate ? { factor: 1 } : false, // TODO choose better
            canPerform: async (operation) => {
                return true;
            },
            index: {
                type: IndexableTemplate,
                prefetch: {
                    strict: false,
                },
            },
        });
    }
}

/* ----------------------------------------------------------------------- */
/* A concrete photo‑album template --------------------------------------- */
export async function createAlbumTemplate(properties: {
    peer: ProgramClient;
    name?: string;
    description?: string;
}): Promise<Template> {
    const peer = properties.peer;

    /* Root (Album) ------------------------------------------------------ */
    let albumRoot = new Canvas({
        id: generateId("album"),
        publicKey: peer.identity.publicKey,
    });

    albumRoot = await peer.open(albumRoot, { existing: "reuse" });
    await albumRoot.setExperience(ChildVisualization.FEED);

    let infoText =
        properties?.description == null
            ? properties.name ?? "Album"
            : `# ${properties.name}\n\n${properties.description}`;
    await albumRoot.addTextElement({ text: infoText });

    /* Child: “Photos” --------------------------------------------------- */
    let photos = new Canvas({
        id: generateId(albumRoot.id, "photos"),
        publicKey: peer.identity.publicKey,
        parent: albumRoot,
    });
    photos = await peer.open(photos, { existing: "reuse" });
    await albumRoot.createReply(photos, { layout: new Layout({ x: 0 }), type: ChildVisualization.TREE });
    await photos.addTextElement({ text: "Photos" });

    /* Child: “Comments” ------------------------------------------------- */
    let comments = new Canvas({
        id: generateId(albumRoot.id, "comments"),
        publicKey: peer.identity.publicKey,
        parent: albumRoot,
    });
    comments = await peer.open(comments, { existing: "reuse" });
    await albumRoot.createReply(comments, { layout: new Layout({ x: 1 }), type: ChildVisualization.TREE });
    await comments.addTextElement({ text: "Comments" });

    /* Wrap everything into a shareable Template object ----------------- */
    return new Template({
        id: sha256Sync(new TextEncoder().encode("album")),
        name: "Photo album",
        description: "Photos and Comments children",
        prototype: albumRoot,
    });
}

/* ----------------------------------------------------------------------- */
/* 1. Personal‑profile template ----------------------------------------- */
export async function createProfileTemplate(props: {
    peer: ProgramClient;
    name?: string; // e.g. “Marcus Pousette”
    description?: string; // optional tagline / bio
}): Promise<Template> {
    const { peer } = props;
    /* Root ---------------------------------------------------------------- */
    let root = new Canvas({
        id: sha256Sync(new TextEncoder().encode("profile")),
        publicKey: peer.identity.publicKey,
    });
    root = await peer.open(root, { existing: "reuse" });
    await root.setExperience(ChildVisualization.EXPLORE);

    let header = props.name ?? "Profile";
    if (props.description) {
        header = `# ${header}\n\n${props.description}`;
    }
    await root.addTextElement({ text: header });

    /* Child: “Posts” (timeline, narrative) -------------------------------- */
    const posts = new Canvas({
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(posts, { existing: "reuse" });
    await posts.addTextElement({ text: "Posts" });
    await root.createReply(posts, { layout: new Layout({ x: 0 }), type: ChildVisualization.FEED }); // set narrative type

    /* Child: “Photos” (navigation) --------------------------------------- */
    const photos = new Canvas({
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(photos, { existing: "reuse" });
    await photos.addTextElement({ text: "Photos" });
    await root.createReply(photos, { layout: new Layout({ x: 1 }), type: ChildVisualization.TREE });

    /* Child: “About” (navigation) ---------------------------------------- */
    const about = new Canvas({
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(about, { existing: "reuse" });
    await about.addTextElement({ text: "About" });
    await root.createReply(about, { layout: new Layout({ x: 2 }), type: ChildVisualization.TREE });

    return new Template({
        id: sha256Sync(new TextEncoder().encode("profile")),
        name: "Personal profile",
        description: "Profile root with Posts, Photos and About sections",
        prototype: root,
    });
}

/* ----------------------------------------------------------------------- */
/* 2. Community template -------------------------------------------------- */
export async function createCommunityTemplate(props: {
    peer: ProgramClient;
    name?: string; // community display‑name
    description?: string;
}): Promise<Template> {
    const { peer } = props;
    let root = new Canvas({
        id: sha256Sync(new TextEncoder().encode("community")),
        publicKey: peer.identity.publicKey,
    });
    root = await peer.open(root, { existing: "reuse" });
    await root.setExperience(ChildVisualization.EXPLORE);

    let header = props.name ?? "Community";
    if (props.description) {
        header = `# ${header}\n\n${props.description}`;
    }
    await root.addTextElement({ text: header });

    /* Posts (narrative feed) --------------------------------------------- */
    const posts = new Canvas({
        id: generateId(root.id, "posts"),
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(posts, { existing: "reuse" });
    await posts.addTextElement({ text: "Posts" });
    await root.createReply(posts, { layout: new Layout({ x: 0 }), type: ChildVisualization.FEED });

    /* Members (navigation) ------------------------------------------------ */
    const members = new Canvas({
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(members, { existing: "reuse" });
    await members.addTextElement({ text: "Members" });
    await root.createReply(members, { layout: new Layout({ x: 1 }), type: ChildVisualization.FEED });

    /* Photos (navigation) ------------------------------------------------- */
    const photos = new Canvas({
        id: generateId(root.id, "photos"),
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(photos, { existing: "reuse" });
    await photos.addTextElement({ text: "Photos" });
    await root.createReply(photos, { layout: new Layout({ x: 2 }), type: ChildVisualization.FEED });

    return new Template({
        id: sha256Sync(new TextEncoder().encode("community")),
        name: "Community",
        description: "A community Posts, Members and Photos sections",
        prototype: root,
    });
}

/* ----------------------------------------------------------------------- */
/* 3. Music‑playlist template -------------------------------------------- */
export async function createPlaylistTemplate(props: {
    peer: ProgramClient;
    name?: string; // playlist title
    description?: string;
}): Promise<Template> {
    const { peer } = props;
    let root = new Canvas({
        id: sha256Sync(new TextEncoder().encode("playlist")),
        publicKey: peer.identity.publicKey,
    });
    root = await peer.open(root, { existing: "reuse" });
    await root.setExperience(ChildVisualization.FEED);

    let header = props.name ?? "Playlist";
    if (props.description) {
        header = `# ${header}\n\n${props.description}`;
    }
    await root.addTextElement({ text: header });

    /* Tracks (navigation – list of songs) -------------------------------- */
    const tracks = new Canvas({
        id: generateId(root.id, "tracks"),
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(tracks, { existing: "reuse" });
    await tracks.addTextElement({ text: "Tracks" });
    await root.createReply(tracks, { layout: new Layout({ x: 0 }), type: ChildVisualization.FEED });

    /* Comments (navigation) ---------------------------------------------- */
    const comments = new Canvas({
        id: generateId(root.id, "comments"),
        publicKey: peer.identity.publicKey,
        parent: root,
    });
    await peer.open(comments, { existing: "reuse" });
    await comments.addTextElement({ text: "Comments" });
    await root.createReply(comments, { layout: new Layout({ x: 1 }), type: ChildVisualization.FEED });

    return new Template({
        id: sha256Sync(new TextEncoder().encode("playlist")),
        name: "Music playlist",
        description: "Playlist root with Tracks and Comments sections",
        prototype: root,
    });
}

/* ----------------------------------------------------------------------- */
/* 3. Music‑playlist template -------------------------------------------- */
export async function createChatTemplate(props: {
    peer: ProgramClient;
    name?: string; // playlist title
    description?: string;
}): Promise<Template> {
    const { peer } = props;
    let root = new Canvas({
        id: sha256Sync(new TextEncoder().encode("chat")),
        publicKey: peer.identity.publicKey,
    });
    root = await peer.open(root, { existing: "reuse" });
    await root.setExperience(ChildVisualization.CHAT);

    return new Template({
        id: sha256Sync(new TextEncoder().encode("chat")),
        name: "Chat",
        description: "Start a chat with your friends",
        prototype: root,
    });
}
