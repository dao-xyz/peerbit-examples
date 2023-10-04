import { field, variant, fixedArray } from "@dao-xyz/borsh";
import { randomBytes } from "@peerbit/crypto";



@variant(0)
export abstract class View {

    @field({ type: fixedArray('u8', 32) })
    id: Uint8Array;

    constructor(properties?: { id?: Uint8Array }) {
        this.id = properties?.id || randomBytes(32)
    }

}