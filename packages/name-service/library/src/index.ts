import { field, variant, fixedArray } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    SearchRequest,
    Documents,
    StringMatch,
    PutOperation,
} from "@peerbit/document";
import { Role, SyncFilter } from "@peerbit/shared-log";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";

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

type Args = { role?: Role; sync?: SyncFilter };

@variant("names")
export class Names extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    names: Documents<Name>;

    constructor(properties: { id: Uint8Array } = { id: new Uint8Array(32) }) {
        super();
        this.id = properties.id;
        this.names = new Documents({ id: properties.id });
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.names.open({
            type: Name,
            canAppend: (entry) => {
                return true; //!!entry.signatures.find(x => x.publicKey.equals((entry.payload.getValue() as PutOperation<Name>).value!.publicKey!))
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
            sync: args?.sync,
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
