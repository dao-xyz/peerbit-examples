import { field, variant, fixedArray } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    SearchRequest,
    Documents,
    StringMatch,
    PutOperation,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";

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

@variant("names")
export class Names extends Program {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    names: Documents<Name>;

    constructor(properties: { id: Uint8Array } = { id: new Uint8Array(32) }) {
        super();
        this.id = properties.id;
        this.names = new Documents();
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.names.setup({
            type: Name,
            canAppend: (entry) => {
                return true; //!!entry.signatures.find(x => x.publicKey.equals((entry.payload.getValue() as PutOperation<Name>).value!.publicKey!))
            },
            index: {
                fields: async (doc, context) => {
                    return {
                        id: doc.id,
                        name: doc.name,
                        keys: (await this.names.log.get(
                            context.head
                        ))!.signatures.map((signature) =>
                            signature.publicKey.hashcode()
                        ),
                    };
                },
            },
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
