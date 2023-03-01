import { field, variant, vec, fixedArray } from "@dao-xyz/borsh";
import { AbstractProgram, Program } from "@dao-xyz/peerbit-program";
import { Store } from "@dao-xyz/peerbit-store";
import {
    DocumentIndex,
    DocumentQueryRequest,
    Documents,
    PutOperation,
    SignedByQuery,
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
        });
    }

    async getName(key: PublicSignKey): Promise<string | undefined> {
        let latestNameTime = 0n;
        let latestName: string | undefined = undefined;
        await this.names.index.query(
            new DocumentQueryRequest({
                queries: [new SignedByQuery({ publicKeys: [key] })],
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
