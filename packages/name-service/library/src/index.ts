import { field, variant, fixedArray } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    DocumentIndex,
    DocumentQuery,
    Documents,
    StringMatch,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";

@variant(0)
export class Name {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    constructor(name: string) {
        this.id = randomBytes(32);
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
        this.names = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.names.setup({
            type: Name,
            canAppend: () => true,
            index: {
                fields: (doc, entry) => {
                    return {
                        id: doc.id,
                        name: doc.name,
                        keys: entry.signatures.map((x) =>
                            x.publicKey.hashcode()
                        ),
                    };
                },
            },
        });
    }

    async getName(key: PublicSignKey): Promise<string | undefined> {
        let latestNameTime = 0n;
        let latestName: string | undefined = undefined;
        await this.names.index.query(
            new DocumentQuery({
                queries: [
                    new StringMatch({ key: "keys", value: key.hashcode() }),
                ],
            }),
            {
                onResponse: (response) => {
                    for (const result of response.results) {
                        if (result.context.created > latestNameTime) {
                            latestName = result.value.name;
                            latestNameTime = result.context.created;
                        }
                    }
                },
            }
        );
        return latestName;
    }
}
