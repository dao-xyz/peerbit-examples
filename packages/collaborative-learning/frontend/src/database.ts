import { Program } from "@dao-xyz/peerbit-program";
import { DocumentIndex, Documents } from "@dao-xyz/peerbit-document";
import { field, variant } from "@dao-xyz/borsh";

export class Model {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    configJSON: string;

    @field({ type: Uint8Array })
    weights: Uint8Array;

    constructor(properties: {
        id: string;
        config: object;
        weights: Uint8Array;
    }) {
        this.configJSON = JSON.stringify(properties.config);
        this.weights = properties.weights;
        this.id = properties.id;
    }

    get config() {
        return JSON.parse(this.configJSON);
    }
}

@variant("models")
export class ModelDatabase extends Program {
    @field({ type: Documents })
    models: Documents<Model>;

    constructor(properties?: { id: string }) {
        super(properties);
        this.models = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    setup(): Promise<void> {
        return this.models.setup({ type: Model });
    }
}
