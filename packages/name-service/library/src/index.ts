import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    SearchRequest,
    Documents,
    StringMatch,
    RoleOptions,
} from "@peerbit/document";
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

type Args = { role?: RoleOptions };

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
            canPerform: (operation, context) => {
                return Promise.resolve(true); // Anyone can create rooms
            },
            index: {
                fields: async (doc, context) => {
                    return {
                        id: doc.id,
                        name: doc.name,
                        keys: (await this.names.log.log.get(
                            context.head
                        ))!.signatures.map((signature) =>
                            signature.publicKey.hashcode()
                        ),
                    };
                },
            },
            role: args?.role,
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
