import { Program } from "@peerbit/program";
import { Documents } from "@peerbit/document";
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

@variant("collaborative_learning_model_indexable")
class ModelIndexable {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    configJSON: string;

    @field({ type: Uint8Array })
    weights: Uint8Array;

    constructor(model: Model) {
        this.id = model.id;
        this.configJSON = model.configJSON;
        this.weights = model.weights;
    }

    get config() {
        return JSON.parse(this.configJSON);
    }
}

@variant("models")
export class ModelDatabase extends Program {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    models: Documents<Model, ModelIndexable>;

    constructor(properties: { id: Uint8Array }) {
        super();
        this.id = properties.id;
        this.models = new Documents<Model, ModelIndexable>({ id: this.id });
    }

    open(): Promise<void> {
        return this.models.open({
            type: Model,
            index: { type: ModelIndexable },
        });
    }
}
