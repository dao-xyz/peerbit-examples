import { field, variant, vec, fixedArray } from "@dao-xyz/borsh";
import { AbstractProgram, Program } from "@dao-xyz/peerbit-program";
import { Store } from "@dao-xyz/peerbit-store";
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
    @field({ type: Documents })
    names: Documents<Name>;

    constructor(properties: { id: string } = { id: "STATIC" }) {
        super(properties);
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
