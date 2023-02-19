import { Program } from "@dao-xyz/peerbit-program";
import { DocumentIndex, Documents } from "@dao-xyz/peerbit-document";
import { field } from "@dao-xyz/borsh";

export class Model {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    configJSON: string;

    @field({ type: "string" })
    weights: string;

    constructor(properties: { id: string; config: object; weights: string }) {
        this.configJSON = JSON.stringify(properties.config);
        this.weights = properties.weights;
        this.id = properties.id;
    }

    get config() {
        return JSON.parse(this.configJSON);
    }
}

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
