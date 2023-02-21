import { field, variant, fixedArray } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    DocumentIndex,
    Documents,
    PutOperation,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";
import { Program } from "@dao-xyz/peerbit-program";

@variant(0)
export class Name {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: PublicSignKey })
    key: PublicSignKey;

    constructor(name: string, key: PublicSignKey) {
        this.name = name;
        this.key = key;
        this.id = key.bytes; // Only one name peer key;
    }
}

@variant("names")
export class NameDB extends Program {
    @field({ type: Documents<Name> })
    names: Documents<Name>;

    constructor(properties?: { id: string }) {
        super(properties);
        this.names = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    setup(): Promise<void> {
        return this.names.setup({
            type: Name,
            canAppend: async (entry) => {
                /**
                 * Only allow updates if we created it
                 */
                const op = entry.payload.getValue();
                if (op instanceof PutOperation) {
                    return (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(op.value.key)
                        ) != null
                    );
                } else if (op instanceof DeleteOperation) {
                    const r = await this.names.index.get(op.key);
                    let ok = true;
                    for (const result of r.results) {
                        ok =
                            ok ||
                            entry.signatures.find((x) =>
                                x.publicKey.equals(result.value.key)
                            ) != null;
                        if (!ok) {
                            break;
                        }
                    }
                    return ok;
                }
                return false; // Unsupported
            },
        });
    }
}
