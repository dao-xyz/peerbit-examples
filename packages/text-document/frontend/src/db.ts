import { Program } from "@peerbit/program";
import { DString } from "@peerbit/string";
import { field, variant, vec } from "@dao-xyz/borsh";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";

@variant("text_document")
export class CollaborativeTextDocument extends Program {


    @field({ type: DString })
    string: DString;

    constructor(properties: { id: Uint8Array } = { id: randomBytes(32) }) {
        super();
        this.string = new DString({ id: properties.id });
    }

    open(args?: any): Promise<void> {
        return this.string.open({
            canAppend: () => true,
        });
    }
}
