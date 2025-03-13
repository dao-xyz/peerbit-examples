import { field, variant, fixedArray, option } from "@dao-xyz/borsh";
import { Documents } from "@peerbit/document";
import { Program } from "@peerbit/program";
import {
    Ed25519PublicKey,
    sha256Sync,
    X25519Keypair,
    randomBytes,
} from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { SimpleWebManifest } from "@dao-xyz/app-service";
export class InvalidAppError extends Error {
    constructor() {
        super("Invalid app");
    }
}

@variant(0)
export class Visit {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: SimpleWebManifest })
    app: SimpleWebManifest;

    constructor(properties: { app: SimpleWebManifest }) {
        this.id = randomBytes(32);
        this.app = properties.app;
    }
}

@variant("browsing_history")
export class BrowsingHistory extends Program {
    @field({ type: Documents<Element> })
    visits: Documents<Visit>;

    @field({ type: Ed25519PublicKey })
    key: Ed25519PublicKey;

    @field({ type: option(Uint8Array) })
    context?: Uint8Array;

    constructor(properties: {
        rootTrust: Ed25519PublicKey;
        context?: Uint8Array;
    }) {
        super();
        this.key = properties.rootTrust;
        this.visits = new Documents({
            id: sha256Sync(
                concat([
                    new TextEncoder().encode("browsing_history"),
                    properties.rootTrust.bytes,
                ])
            ),
        });
        this.context = properties.context;
    }

    async open(): Promise<void> {
        return this.visits.open({
            type: Visit,
            canPerform: async (props) => {
                /**
                 * Only allow self
                 */
                return (
                    props.entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.key) &&
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
            },
            canReplicate: (key) => {
                /**
                 * Only allow self
                 */
                return (
                    key.equals(this.key) &&
                    key.equals(this.node.identity.publicKey)
                );
            },
            index: {
                canSearch: (_req, from) => {
                    return from.equals(this.key);
                },
            },
        });
    }

    async insert(app: SimpleWebManifest): Promise<void> {
        if (!app.url.startsWith("native:")) {
            try {
                new URL(app.url); // will fail if invalid url
            } catch (error) {
                throw new InvalidAppError();
            }
        }
        await this.visits.put(new Visit({ app }), {
            encryption: {
                keypair: await X25519Keypair.create(),
                receiver: {
                    meta: [this.key],
                    payload: [this.key],
                    signatures: [this.key],
                },
            },
        });
    }
}
