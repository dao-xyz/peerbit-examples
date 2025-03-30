import { field, fixedArray, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { queryOllama } from "./query.js";
import { PublicSignKey, sha256Base64Sync } from "@peerbit/crypto";
import { SilentDelivery } from "@peerbit/stream-interface";
import { DEEP_SEEK_R1 } from "./model.js";
import { delay } from "@peerbit/time";
import { AbortError, TimeoutError } from "@peerbit/time";
export * from "./model.js";

const ignoreTimeoutandAbort = (error: Error) => {
    if (error instanceof TimeoutError) {
        // Ignore timeout errors
    } else if (error instanceof AbortError) {
        // Ignore abort errors
    } else {
        // Handle other errors
        throw error;
    }
};
export type Args = {
    server?: boolean;
    /**
     * Optional callback invoked for every incoming request.
     */
    onRequest?: (query: ChatQuery | ModelRequest, context?: any) => void;
};

@variant("ai-response-program")
export class AIResponseProgram extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: RPC })
    rpc: RPC<ChatQuery | ModelRequest, AIResponse>;

    // Map to store model information: key = model name, value = peer identifier.
    private modelMap: Map<string, Set<string>>;

    // List of models supported by this server (if running in server mode).
    public supportedModels: string[] = [];

    constructor(
        properties: { id: Uint8Array } = {
            id: new Uint8Array([
                38, 8, 228, 136, 247, 41, 32, 68, 122, 69, 86, 130, 235, 190,
                83, 104, 253, 185, 197, 202, 247, 167, 188, 49, 90, 168, 248,
                40, 213, 211, 174, 166,
            ]),
        }
    ) {
        super();
        this.id = properties.id;
        this.rpc = new RPC();
    }

    /**
     * Opens the RPC channel.
     * In server mode:
     *  - Registers a response handler that handles both chat and model requests.
     *  - Initializes the supportedModels list with a default ("deepseek-r1:1.5b").
     * In client mode:
     *  - Requests model info from peers and stores it in a map.
     */
    async open(args?: Args): Promise<void> {
        const isServer = args?.server;
        this.modelMap = new Map();
        if (isServer) {
            // Initialize default supported model.
            this.supportedModels = ["deepseek-r1:1.5b"];
        } else {
            // Client mode: request model info from peers.
            this.supportedModels = [];
        }

        await this.rpc.open({
            responseType: AIResponse,
            queryType: AIRequest,
            topic: sha256Base64Sync(this.id),
            responseHandler: isServer
                ? async (query, context) => {
                      if (args?.onRequest) {
                          args.onRequest(query, context);
                      }
                      if (query instanceof ChatQuery) {
                          // Use the default model from supportedModels
                          const modelToUse = query.model;
                          if (!this.supportedModels.includes(modelToUse)) {
                              return new MissingModel({ model: modelToUse });
                          }

                          const result = await queryOllama(
                              query.prompt,
                              modelToUse
                          );
                          return new ChatResponse({ response: result });
                      } else if (query instanceof ModelRequest) {
                          // Respond with supported model information.
                          return new ModelResponse({
                              model: this.supportedModels.join(", "),
                              info: "Supported models by this peer",
                          });
                      }
                  }
                : undefined,
        });

        if (!isServer) {
            // Helper to request model info from peers.
            const requestModels = async (toPeers?: PublicSignKey[]) => {
                try {
                    const responses = await this.rpc.request(
                        new ModelRequest(),
                        {
                            mode: toPeers
                                ? new SilentDelivery({
                                      to: toPeers,
                                      redundancy: 1,
                                  })
                                : undefined,
                        }
                    );
                    for (const resp of responses) {
                        const modelResp = resp.response as ModelResponse;
                        const peerId = resp.from!;
                        const set = this.modelMap.get(modelResp.model);
                        if (set) {
                            set.add(peerId.hashcode());
                        } else {
                            this.modelMap.set(
                                modelResp.model,
                                new Set([peerId.hashcode()])
                            );
                        }
                    }
                } catch (error) {}
            };

            // On peer join, request its model info.
            this.rpc.events.addEventListener("join", async (e: any) => {
                await requestModels([e.detail]).catch(ignoreTimeoutandAbort);
            });

            // Broadcast a ModelRequest to all peers.

            // Don't await this one because it will block the open to finish
            requestModels().catch(ignoreTimeoutandAbort);
        }
    }

    /**
     * Sends a prompt to the AI model via an RPC request.
     * If options.model is provided, the query is sent only to the peer supporting that model.
     */
    async query(
        prompt: string,
        options?: { timeout?: number; model?: string }
    ): Promise<ChatResponse | undefined> {
        const { timeout = 1e4, model: maybeModel } = options || {};
        if (!prompt) {
            return undefined;
        }
        let toPeers: string[] | undefined = undefined;
        const model = maybeModel ?? DEEP_SEEK_R1;

        if (this.supportedModels.includes(model)) {
            return new ChatResponse({
                response: await queryOllama(prompt, model),
            });
        }

        const peer = this.modelMap.get(model);

        const meInPeer = peer?.has(this.node.identity.publicKey.hashcode());
        if (meInPeer) {
            return new ChatResponse({
                response: await queryOllama(prompt, model),
            });
        }
        if (peer) {
            toPeers = [[...peer][Math.round(Math.random() * (peer.size - 1))]];
        }

        const responses = await this.rpc.request(
            new ChatQuery({ prompt, model }),
            {
                timeout,
                /*  mode: toPeers && toPeers.length > 0
                 ? new SilentDelivery({
                     to: toPeers,
                     redundancy: 1,
                 })
                 : undefined, */
            }
        );
        const response = responses[0]?.response as ChatResponse;
        if (response) {
            console.log("Response received:", response);
            return response;
        }
        throw new Error("No response received");
    }

    async waitForModel(model: string = "", timeout?: number): Promise<void> {
        // TODO event based
        const start = Date.now();
        while (Date.now() - start < (timeout || 10000)) {
            if (
                this.supportedModels.includes(model) ||
                this.modelMap.has(model)
            ) {
                return;
            }
            await delay(1e2);
        }
        throw new Error(`Timeout waiting for model ${model}`);
    }
}

abstract class AIRequest {}

@variant(0)
export class ChatQuery extends AIRequest {
    @field({ type: "string" })
    prompt: string;

    @field({ type: "string" })
    model: string;

    constructor(properties: { prompt: string; model: string }) {
        super();
        this.prompt = properties.prompt;
        this.model = properties.model;
    }
}

@variant(1)
export class ModelRequest extends AIRequest {
    // No additional fields required.
    constructor() {
        super();
    }
}

abstract class AIResponse {}

@variant(0)
export class ChatResponse extends AIResponse {
    @field({ type: "string" })
    response: string;

    constructor(properties: { response: string }) {
        super();
        this.response = properties.response;
    }
}

@variant(1)
export class ModelResponse extends AIResponse {
    @field({ type: "string" })
    model: string; // e.g. "deepseek-r1:1.5b"

    @field({ type: "string" })
    info: string; // additional model info if needed

    constructor(properties: { model: string; info: string }) {
        super();
        this.model = properties.model;
        this.info = properties.info;
    }
}

@variant(2)
export class MissingModel extends AIResponse {
    @field({ type: "string" })
    model: string; // e.g. "deepseek-r1:1.5b"

    constructor(properties: { model: string }) {
        super();
        this.model = properties.model;
    }
}
