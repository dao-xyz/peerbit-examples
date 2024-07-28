import { field, variant, vec } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { SearchRequest, Documents, StringMatch } from "@peerbit/document";
import { ReplicationOptions } from "@peerbit/shared-log";
import { PublicSignKey } from "@peerbit/crypto";

@variant(0)
export class Name {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    constructor(publicKey: PublicSignKey, name: string) {
        this.id = publicKey.bytes;
        this.name = name;
    }
}

class IndexedName {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: vec("string") })
    keys: string[];

    constructor(name: Name, keys: string[]) {
        this.id = name.id;
        this.name = name.name;
        this.keys = keys;
    }
}

type Args = { replicate?: ReplicationOptions };

// A random ID, but unique for this app
const ID = new Uint8Array([
    30, 222, 227, 76, 164, 10, 61, 8, 21, 176, 122, 5, 79, 110, 115, 255, 233,
    253, 92, 76, 146, 158, 46, 212, 14, 162, 30, 94, 1, 134, 99, 174,
]);

@variant("names")
export class Names extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    names: Documents<Name>;

    constructor(properties: { id: Uint8Array } = { id: ID }) {
        super();
        this.id = properties.id;
        this.names = new Documents({ id: properties.id });
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.names.open({
            type: Name,
            canPerform: (operation) => {
                return Promise.resolve(true); // Anyone can create rooms
            },
            index: {
                type: IndexedName,
                transform: async (doc, context) => {
                    return new IndexedName(
                        doc,
                        (await this.names.log.log.get(
                            context.head
                        ))!.signatures.map((signature) =>
                            signature.publicKey.hashcode()
                        )
                    );
                },
            },
            replicate: args?.replicate,
        });
    }

    async getName(key: PublicSignKey): Promise<Name | undefined> {
        const results = await this.names.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({ key: "keys", value: key.hashcode() }),
                ],
            })
        );
        return results[0];
    }
}
