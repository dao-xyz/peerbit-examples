import { field, variant } from "@dao-xyz/borsh";
import { Program, ProgramClient } from "@peerbit/program";
import {
    AddressReference,
    Canvas,
    Element,
    HIGH_QUALITY,
    HIGHEST_QUALITY,
    IndexableCanvas,
    LOWEST_QUALITY,
    MEDIUM_QUALITY,
    Scope,
    StaticContent,
} from "./content.js";
import { ReplicationOptions } from "@peerbit/shared-log";

import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { concat, equals } from "uint8arrays";
import { Documents, WithIndexedContext } from "@peerbit/document";
import {
    ByteMatchQuery,
    Sort,
    SortDirection,
} from "@peerbit/indexer-interface";
import { Identities } from "./identity.js";
import {
    CanvasAddressReference,
    CanvasReference,
    CanvasValueReference,
} from "./references.js";
import { Layout } from "./link.js";
import { StaticImage } from "./static/image.js";

/* ──────────────────────────────────────────────
 * Profile record
 *   - stores a CanvasReference
 *   - ID = hash(publicKey + canvas.id)
 * ────────────────────────────────────────────── */
@variant(0)
export class Profile {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: CanvasReference })
    profile: CanvasReference;

    constructor(props: {
        publicKey: PublicSignKey;
        profile: CanvasReference | Canvas;
    }) {
        this.profile =
            props.profile instanceof CanvasReference
                ? props.profile
                : new CanvasValueReference({ value: props.profile });

        this.id = sha256Sync(
            this.profile instanceof CanvasAddressReference
                ? concat([props.publicKey.bytes, this.profile.id])
                : concat([
                      props.publicKey.bytes,
                      (this.profile as CanvasValueReference).value.id,
                  ])
        );
    }
}

/* ──────────────────────────────────────────────
 * Indexed profile row
 * ────────────────────────────────────────────── */
@variant(0)
export class ProfileIndexed {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: IndexableCanvas })
    profile: IndexableCanvas;

    constructor(props: { id: Uint8Array; profile: IndexableCanvas }) {
        this.id = props.id;
        this.profile = props.profile;
    }
}

type ProfileArgs = { replicate?: boolean };

/* ──────────────────────────────────────────────
 * Profiles registry program
 * ────────────────────────────────────────────── */
@variant("profile")
export class Profiles extends Program<ProfileArgs> {
    @field({ type: Documents })
    profiles: Documents<Profile, ProfileIndexed>;

    constructor(properties?: { id?: Uint8Array }) {
        super();
        const id =
            properties?.id ?? sha256Sync(new TextEncoder().encode("profiles"));
        this.profiles = new Documents({ id });
    }

    /** deterministic public-scope id */
    static scopeIdFor(publicKey: PublicSignKey): Uint8Array {
        return sha256Sync(
            concat([
                new TextEncoder().encode("giga-profile-scope:"),
                publicKey.bytes,
            ])
        );
    }

    /** open deterministic public scope for user */
    static async openPublicScopeFor(
        client: ProgramClient,
        publicKey: PublicSignKey,
        opts?: { replicate?: ReplicationOptions }
    ): Promise<Scope> {
        const scope = new Scope({
            id: Profiles.scopeIdFor(publicKey),
            publicKey,
        });
        return client.open(scope, {
            existing: "reuse",
            args: { replicate: opts?.replicate ?? { factor: 1 } },
        });
    }

    async open(args?: ProfileArgs): Promise<void> {
        await this.profiles.open({
            type: Profile,
            replicate:
                args?.replicate != null
                    ? args.replicate
                        ? { factor: 1 }
                        : false
                    : { factor: 1 },
            canOpen: () => false,
            keep: "self",
            canPerform: async () => true,
            index: {
                idProperty: "id",
                prefetch: { strict: false },
                cache: {
                    query: {
                        strategy: "auto",
                        maxSize: 50,
                        maxTotalSize: 1e4,
                        keepAlive: 1e4,
                        prefetchThreshold: 3,
                    },
                },
                type: ProfileIndexed,
                transform: async (doc, _ctx) => {
                    try {
                        const opened = await doc.profile.resolve(this.node, {
                            args: { replicate: args?.replicate ?? true },
                            existing: "reuse",
                        });

                        if (!opened.initialized) {
                            await opened.load(this.node, {
                                args: {
                                    replicate: args?.replicate,
                                    /*  replicas: args?.replicas, */
                                },
                            });
                        }
                        const profileIx = await IndexableCanvas.from(opened);
                        return new ProfileIndexed({
                            id: doc.id,
                            profile: profileIx,
                        });
                    } catch (error) {
                        console.error("Failed to index profile:", error);
                        throw new Error(`Failed to index profile: ${error}`);
                    }
                },
            },
        });
    }

    /** create or update profile */
    async create(props: {
        publicKey: PublicSignKey;
        profile: CanvasReference | Canvas;
    }) {
        const previous = await this.get(props.publicKey);
        const record = new Profile({
            publicKey: props.publicKey,
            profile: props.profile,
        });
        await this.profiles.put(record);
        if (previous) {
            await this.profiles.del(previous.id);
        }
        return record;
    }

    /** get profile by publicKey, optionally checking linked devices */
    async get(publicKey: PublicSignKey, identities?: Identities) {
        const mine = await this.profiles.index
            .iterate({
                query: new ByteMatchQuery({
                    key: ["profile", "publicKey"],
                    value: publicKey.bytes,
                }),
            })
            .first();

        if (mine) return mine;

        if (identities) {
            const linked = await identities.connections.index.search({
                query: identities.getLinkedDevicesQuery(publicKey),
            });
            for (const link of linked) {
                const other = link.getOtherDevice(publicKey);
                if (!other) continue;
                const alt = await this.profiles.index
                    .iterate({
                        query: new ByteMatchQuery({
                            key: ["profile", "publicKey"],
                            value: other.publicKey.bytes,
                        }),
                    })
                    .first();
                if (alt) return alt;
            }
        }
    }
}

/* ──────────────────────────────────────────────
 * ensureProfile helper
 *   - opens public scope
 *   - creates a canvas with avatar image
 *   - stores Profile with CanvasAddressReference
 * ────────────────────────────────────────────── */
export async function ensureProfile(
    client: ProgramClient,
    imageBytes: Uint8Array
) {
    const profiles = await client.open(new Profiles(), { existing: "reuse" });

    const publicScope = await Profiles.openPublicScopeFor(
        client,
        client.identity.publicKey,
        { replicate: { factor: 1 } }
    );

    const draft = new Canvas({
        publicKey: client.identity.publicKey,
        selfScope: new AddressReference({ address: publicScope.address }),
    });
    const canvas = await publicScope.openWithSameSettings(draft);

    const qualities = [
        LOWEST_QUALITY,
        MEDIUM_QUALITY,
        HIGH_QUALITY,
        HIGHEST_QUALITY,
    ];
    const contentId = sha256Sync(imageBytes);
    await Promise.all(
        qualities.map((q) =>
            publicScope.elements.put(
                new Element({
                    location: Layout.zero(),
                    content: new StaticContent({
                        content: new StaticImage({
                            data: imageBytes,
                            mimeType: "image/jpeg",
                            width: 512,
                            height: 512,
                        }),
                        quality: q,
                        contentId,
                    }),
                    canvasId: canvas.id,
                    publicKey: client.identity.publicKey,
                })
            )
        )
    );

    const profile = await profiles.create({
        publicKey: client.identity.publicKey,
        profile: new CanvasAddressReference({
            id: canvas.id,
            scope: new AddressReference({ address: publicScope.address }),
        }),
    });

    return {
        canvas: canvas as WithIndexedContext<Canvas, IndexableCanvas>,
        profile: profile,
    };
}
