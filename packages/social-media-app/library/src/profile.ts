import { field, option, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { Canvas, IndexableCanvas } from "./content";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { Documents } from "@peerbit/document";
import { ByteMatchQuery } from "@peerbit/indexer-interface";
import { Identities } from "./identity";

@variant(0)
export class Profile {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Canvas })
    profile: Canvas;

    @field({ type: option(Canvas) })
    context?: Canvas; // when the profile should be used

    constructor(properties: {
        publicKey: PublicSignKey;
        profile: Canvas;
        context?: Canvas;
    }) {
        this.profile = properties.profile;
        this.context = properties.context;

        let arr: Uint8Array[] = [properties.publicKey.bytes, this.profile.id];
        if (this.context) {
            arr.push(this.context.id);
        }
        this.id = sha256Sync(concat(arr));
    }
}
@variant(0)
export class ProfileIndexed {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: IndexableCanvas })
    profile: IndexableCanvas;

    @field({ type: option(IndexableCanvas) })
    context?: IndexableCanvas;

    constructor(properties: {
        id: Uint8Array;
        profile: IndexableCanvas;
        context?: IndexableCanvas;
    }) {
        this.id = properties.id;
        this.profile = properties.profile;
        this.context = properties.context;
    }
}

@variant("profile")
export class Profiles extends Program {
    @field({ type: Documents })
    profiles: Documents<Profile, ProfileIndexed>;

    constructor(properties?: { id?: Uint8Array }) {
        super();

        const id =
            properties?.id || sha256Sync(new TextEncoder().encode("profiles"));
        this.profiles = new Documents({
            id,
        });
    }

    async open(): Promise<void> {
        await this.profiles.open({
            type: Profile,
            replicate: { factor: 1 }, // TODO choose better
            canOpen: () => false,
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                if (operation.type === "put") {
                    const document = operation.value;
                    return (
                        operation.entry.signatures.find((x) =>
                            x.publicKey.equals(document.profile.publicKey)
                        ) != null
                    );
                } else {
                    const get = await this.profiles.index.get(
                        operation.operation.key
                    );
                    if (
                        !get ||
                        !operation.entry.signatures.find((x) =>
                            x.publicKey.equals(get.profile.publicKey)
                        )
                    ) {
                        return false;
                    }
                    return true;
                }
            },
            index: {
                type: ProfileIndexed,
                transform: async (arg, _context) => {
                    return new ProfileIndexed({
                        id: arg.id,
                        profile: await IndexableCanvas.from(
                            arg.profile,
                            this.node
                        ),
                        context: arg.context
                            ? await IndexableCanvas.from(arg.context, this.node)
                            : undefined,
                    });
                },
            },
        });
    }

    async create(properties: { profile: Canvas; context?: Canvas }) {
        const profileIndexed = new Profile({
            publicKey: properties.profile.publicKey,
            profile: properties.profile,
            context: properties.context,
        });
        await this.profiles.put(profileIndexed);
    }

    async get(publicKey: PublicSignKey, identities?: Identities) {
        const profileFromKey = async (_publicKey: PublicSignKey) => {
            const profiles = await this.profiles.index.search({
                query: [
                    new ByteMatchQuery({
                        key: ["profile", "publicKey"],
                        value: _publicKey.bytes,
                    }),
                ],
            });
            return profiles[0];
        };
        const found = await profileFromKey(publicKey);
        if (found) {
            return found;
        }

        if (identities) {
            // if not found, try to find from linked accounts
            const linked = await identities.connections.index.search({
                query: identities.getLinkedDevicesQuery(publicKey),
            });

            if (linked.length === 0) {
                return undefined;
            }

            for (const link of linked) {
                const otherDevice = link.getOtherDevice(publicKey);
                const profile = await profileFromKey(otherDevice!.publicKey);
                if (profile) {
                    return profile;
                }
            }
        }
    }
}
