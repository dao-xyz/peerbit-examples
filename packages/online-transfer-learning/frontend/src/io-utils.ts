/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {
    arrayBufferToBase64String,
    base64StringToArrayBuffer,
    getModelArtifactsInfoForJSON,
} from "@tensorflow/tfjs-core/dist/io/io_utils";
import { ModelStoreManagerRegistry } from "@tensorflow/tfjs-core/dist/io/model_management";
import {
    IORouter,
    IORouterRegistry,
} from "@tensorflow/tfjs-core/dist/io/router_registry";
import {
    IOHandler,
    ModelArtifacts,
    ModelArtifactsInfo,
    ModelStoreManager,
    SaveResult,
    WeightsManifestConfig,
    ModelJSON,
    WeightsManifestEntry,
} from "@tensorflow/tfjs-core/dist/io/types";
import {
    getModelJSONForModelArtifacts,
    getModelArtifactsForJSON,
} from "@tensorflow/tfjs-core/dist/io/io_utils";
import { Model, ModelDatabase } from "./database.js";

const PATH_SEPARATOR = "/";
const PATH_PREFIX = "tensorflowjs_models";
const INFO_SUFFIX = "info";
const MODEL_TOPOLOGY_SUFFIX = "model_topology";
const WEIGHT_SPECS_SUFFIX = "weight_specs";
const WEIGHT_DATA_SUFFIX = "weight_data";
const MODEL_METADATA_SUFFIX = "model_metadata";

function getModelKeys(path: string): {
    info: string;
    topology: string;
    weightSpecs: string;
    weightData: string;
    modelMetadata: string;
} {
    return {
        info: [PATH_PREFIX, path, INFO_SUFFIX].join(PATH_SEPARATOR),
        topology: [PATH_PREFIX, path, MODEL_TOPOLOGY_SUFFIX].join(
            PATH_SEPARATOR
        ),
        weightSpecs: [PATH_PREFIX, path, WEIGHT_SPECS_SUFFIX].join(
            PATH_SEPARATOR
        ),
        weightData: [PATH_PREFIX, path, WEIGHT_DATA_SUFFIX].join(
            PATH_SEPARATOR
        ),
        modelMetadata: [PATH_PREFIX, path, MODEL_METADATA_SUFFIX].join(
            PATH_SEPARATOR
        ),
    };
}

/**
 * Get model path from a local-storage key.
 *
 * E.g., 'tensorflowjs_models/my/model/1/info' --> 'my/model/1'
 *
 * @param key
 */
function getModelPathFromKey(key: string) {
    const items = key.split(PATH_SEPARATOR);
    if (items.length < 3) {
        throw new Error(`Invalid key format: ${key}`);
    }
    return items.slice(1, items.length - 1).join(PATH_SEPARATOR);
}

declare type LocalStorageKeys = {
    info: string;
    topology: string;
    weightSpecs: string;
    weightData: string;
    modelMetadata: string;
};

/**
 * IOHandler subclass: Browser Local Storage.
 *
 * See the doc string to `browserLocalStorage` for more details.
 */
export class P2PStorage implements IOHandler {
    public db: ModelDatabase;
    modelId: string;
    constructor(db: ModelDatabase, modelId: string) {
        this.db = db;
        this.modelId = modelId;
    }

    async save(modelArtifacts: ModelArtifacts): Promise<SaveResult> {
        if (modelArtifacts.modelTopology instanceof ArrayBuffer) {
            throw new Error(
                "BrowserHTTPRequest.save() does not support saving model topology " +
                    "in binary formats yet."
            );
        }

        const weightsManifest: WeightsManifestConfig = [
            {
                paths: ["./model.weights.bin"],
                weights: modelArtifacts.weightSpecs,
            },
        ];

        const modelTopologyAndWeightManifest = getModelJSONForModelArtifacts(
            modelArtifacts,
            weightsManifest
        );

        await this.db.models.put(
            new Model({
                id: this.modelId,
                config: modelTopologyAndWeightManifest,
                weights: new Uint8Array(
                    modelArtifacts.weightData,
                    0,
                    modelArtifacts.weightData.byteLength
                ),
            })
        );
        return {
            modelArtifactsInfo: getModelArtifactsInfoForJSON(modelArtifacts),
        };
    }

    async load(): Promise<ModelArtifacts> {
        // get the latest model
        const modelResults = await this.db.models.index.get(this.modelId, {
            remote: true,
        });

        if (!modelResults || modelResults?.results.length === 0) {
            const msg =
                "Did not find model: " +
                this.db.address.toString() +
                ", " +
                this.db.models.store.oplog.length;
            throw new Error(msg);
        }
        const model = modelResults.results[0].value;
        const modelConfig = model.config;
        const modelTopology = modelConfig.modelTopology;
        const weightsManifest = modelConfig.weightsManifest;

        // We do not allow both modelTopology and weightsManifest to be missing.
        if (modelTopology == null && weightsManifest == null) {
            throw new Error(`Failed to load toplogy and weights`);
        }

        const loadWeights = async (
            from
        ): Promise<[WeightsManifestEntry[], ArrayBuffer]> => {
            const weightSpecs: WeightsManifestEntry[] = [];
            for (const entry of from) {
                weightSpecs.push(...entry.weights);
            }

            // tf does not seem to handle uint8arrays that are views of ArrayBuffers with non-zero offset, so we make a copy
            // to fix this
            const cp = new Uint8Array(model.weights.byteLength);
            cp.set(model.weights);

            return [weightSpecs, cp.buffer];
        };

        return getModelArtifactsForJSON(modelConfig, (weightsManifest) =>
            loadWeights(weightsManifest)
        ); // { modelTopology, weightSpecs, weightData };
    }
}
