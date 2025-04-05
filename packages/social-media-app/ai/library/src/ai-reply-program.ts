import { field, fixedArray, option, variant, vec } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { queryOllama } from "./ollama.js";
import { queryChatGPT } from "./chatgpt.js";
import { PublicSignKey, sha256Base64Sync } from "@peerbit/crypto";
import { SilentDelivery } from "@peerbit/stream-interface";
import { DEEP_SEEK_R1_7b } from "./model.js";
import { delay } from "@peerbit/time";
import { AbortError, TimeoutError } from "@peerbit/time";
import {
    Canvas,
    CanvasReference,
    CanvasValueReference,
    Element,
    getOwnedAndSubownedElementsQuery,
    getTextElementsQuery,
    Layout,
    ReplyingInProgresss,
    ReplyingNoLongerInProgresss,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { Query, Sort, WithContext } from "@peerbit/document";
import { createProfile } from "./profile.js";

// Utility to ignore specific errors.
const ignoreTimeoutandAbort = (error: Error) => {
    if (error instanceof TimeoutError) {
        // Ignore timeout errors
    } else if (error instanceof AbortError) {
        // Ignore abort errors
    } else {
        throw error;
    }
};

// Type for collecting request statistics.
export type RequestStats = {
    requestCount: number;
    totalLatency: number; // in milliseconds
    errorCount: number;
};

export type Args = {
    server?: boolean;
    onRequest?: (query: ChatQuery | ModelRequest, context?: any) => void;
} & (OpenAPIArgs | OLLamaArgs);

type OpenAPIArgs = {
    server: true;
    llm: "chatgpt";
    apiKey?: string;
};

type OLLamaArgs = {
    server: true;
    llm: "ollama";
};

@variant("canvas-ai-reply")
export class CanvasAIReply extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: RPC })
    rpc: RPC<ChatQuery | ModelRequest, AIResponse>;

    // Map to store model information: key = model name, value = peer identifier.
    private modelMap: Map<string, { peers: Set<string>; model: string }>;
    // List of models supported by this server (if running in server mode).
    public supportedModels: string[] = [];

    // New configuration for LLM.
    private llm: "ollama" | "chatgpt";
    private apiKey?: string;

    // New property for request statistics.
    private stats: RequestStats;

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
        this.stats = { requestCount: 0, totalLatency: 0, errorCount: 0 };
    }

    /**
     * Returns the current request statistics.
     */
    public getRequestStats() {
        const averageLatency =
            this.stats.requestCount > 0
                ? this.stats.totalLatency / this.stats.requestCount
                : 0;
        return {
            requestCount: this.stats.requestCount,
            averageLatency,
            errorCount: this.stats.errorCount,
        };
    }

    /**
     * Opens the RPC channel.
     * In server mode:
     *  - Registers a response handler that handles both chat and model requests.
     *  - Initializes the supportedModels list with a default ("deepseek-r1:7b").
     * In client mode:
     *  - Requests model info from peers and stores it in a map.
     */
    async open(args?: Args): Promise<void> {
        this.modelMap = new Map();

        // Set LLM configuration (defaulting to "ollama").
        this.llm = args?.llm || "ollama";

        if (args?.server) {
            await createProfile(this.node);
        }

        if (args?.server) {
            // Initialize default supported model.
            if (args.llm === "ollama") {
                this.supportedModels = [DEEP_SEEK_R1_7b];
            } else if (args.llm === "chatgpt") {
                this.supportedModels = ["gpt-4o"];
                this.apiKey = args?.apiKey
                    ? args.apiKey
                    : process.env.OPENAI_API_KEY || undefined;
                if (!this.apiKey) {
                    throw new Error("Missing ChatGPT API Key");
                }
            } else {
                throw new Error("Missing LLM Model source");
            }
        } else {
            // Client mode: request model info from peers.
            this.supportedModels = [];
        }

        await this.rpc.open({
            responseType: AIResponse,
            queryType: AIRequest,
            topic: sha256Base64Sync(this.id),
            responseHandler: args?.server
                ? async (query, context) => {
                      if (args?.onRequest) {
                          args.onRequest(query, context);
                      }
                      if (query instanceof ChatQuery) {
                          return this.handleChatQuery(query);
                      } else if (query instanceof ModelRequest) {
                          return new ModelResponse({
                              model: this.supportedModels.join(", "),
                              info: "Supported models by this peer",
                          });
                      }
                  }
                : undefined,
        });

        if (!args?.server) {
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
                            set.peers.add(peerId.hashcode());
                        } else {
                            this.modelMap.set(modelResp.model, {
                                model: modelResp.model,
                                peers: new Set([peerId.hashcode()]),
                            });
                        }
                    }
                } catch (error) {}
            };

            // On peer join, request its model info.
            this.rpc.events.addEventListener("join", async (e: any) => {
                await requestModels([e.detail]).catch(ignoreTimeoutandAbort);
            });

            // Broadcast a ModelRequest to all peers (non-blocking).
            requestModels().catch(ignoreTimeoutandAbort);
        }
    }

    private getPeersWithModel(model?: string) {
        if (model) {
            return this.modelMap.get(model);
        } else {
            const keys = [...this.modelMap.keys()];
            if (keys.length > 0) {
                return this.modelMap.get(keys[0]);
            }
        }
    }

    /**
     * Sends a prompt to the AI model via an RPC request.
     * If options.model is provided, the query is sent only to the peer supporting that model.
     */
    async query(
        to: CanvasReference | Canvas,
        options?: {
            context?: CanvasReference[];
            elementsQuery?: Query;
            canvasesQuery?: Query;
            timeout?: number;
            model?: string;
        }
    ): Promise<AIResponse | undefined> {
        const { timeout = 2e4, model: maybeModel } = options || {};
        const peers = this.getPeersWithModel(maybeModel);
        const meInPeer = peers?.peers?.has(
            this.node.identity.publicKey.hashcode()
        );
        if (meInPeer) {
            return this.handleChatQuery({
                to,
                context: options?.context || [],
                model: peers!.model,
                elementsQuery: options?.elementsQuery,
                canvasesQuery: options?.canvasesQuery,
            });
        }
        if (!peers?.peers || peers.peers.size === 0) {
            throw new Error(
                `No peers available for model ${peers?.model ?? "NO_MODEL"}`
            );
        }
        let toPeers = [
            [...peers.peers][
                Math.round(Math.random() * (peers.peers.size - 1))
            ],
        ];
        const responses = await this.rpc.request(
            new ChatQuery({
                to,
                context: options?.context || [],
                model: peers.model,
                canvasesQuery: options?.canvasesQuery,
                elementsQuery: options?.elementsQuery,
            }),
            {
                timeout,
                mode:
                    toPeers.length > 0
                        ? new SilentDelivery({
                              redundancy: 1,
                              to: toPeers,
                          })
                        : undefined,
            }
        );
        const response = responses[0]?.response as AIResponse;
        if (response) {
            console.log("Response received:", response);
            return response;
        }
        throw new Error("No response received");
    }

    /**
     * Handles a chat query by generating a reply using the appropriate LLM.
     * This method also measures the processing time and updates the request statistics.
     */
    async handleChatQuery(properties: {
        to: CanvasReference | Canvas;
        context: CanvasReference[] | Canvas[];
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }): Promise<AIResponse> {
        const startTime = Date.now();
        try {
            const model = properties.model || DEEP_SEEK_R1_7b;
            if (model && !this.supportedModels.includes(model)) {
                return new MissingModel({ model });
            }
            let canvasInstance =
                properties.to instanceof Canvas
                    ? properties.to
                    : await properties.to.load(this.node);
            canvasInstance = await this.node.open(canvasInstance, {
                existing: "reuse",
            });

            let contextInstances: Canvas[] = [];
            for (const context of properties.context) {
                let canvas =
                    context instanceof Canvas
                        ? context
                        : await context.load(this.node);
                canvas = await this.node.open(canvas, { existing: "reuse" });
                contextInstances.push(canvas);
            }
            // Choose the query function based on the LLM configuration.
            const queryFunction =
                this.llm === "chatgpt"
                    ? (text: string) => queryChatGPT(text, this.apiKey)
                    : (text: string) => queryOllama(text, model);
            await generateReply({
                to: canvasInstance,
                context: contextInstances,
                canvasesQuery: properties.canvasesQuery,
                elementsQuery: properties.elementsQuery,
                generator: queryFunction,
            });
            const latency = Date.now() - startTime;
            this.stats.requestCount++;
            this.stats.totalLatency += latency;
            return new QueryResponse();
        } catch (error) {
            this.stats.errorCount++;
            throw error;
        }
    }

    async waitForModel(options?: {
        model?: string;
        timeout?: number;
    }): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < (options?.timeout || 10000)) {
            if (options?.model) {
                if (
                    this.supportedModels.includes(options?.model) ||
                    this.modelMap.has(options?.model)
                ) {
                    return;
                }
            } else {
                if (
                    this.supportedModels.length > 0 ||
                    [...this.modelMap.values()].filter((x) => x.peers.size > 0)
                        .length > 0
                ) {
                    return;
                }
            }
            await delay(100);
        }
        throw new Error(
            `Timeout waiting for  ${
                options?.model ? "model " + options.model : "any model"
            }`
        );
    }
}

abstract class AIRequest {}

@variant(0)
export class ChatQuery extends AIRequest {
    @field({ type: CanvasReference })
    to: CanvasReference;

    @field({ type: vec(CanvasReference) })
    context: CanvasReference[];

    @field({ type: option(Query) })
    canvasesQuery?: Query;

    @field({ type: option(Query) })
    elementsQuery?: Query;

    @field({ type: option("string") })
    model?: string;

    constructor(properties: {
        to: CanvasReference | Canvas;
        context?: CanvasReference[] | Canvas[];
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }) {
        super();
        this.to =
            properties.to instanceof Canvas
                ? new CanvasValueReference({ canvas: properties.to })
                : properties.to;
        this.context = (properties.context || []).map((c) =>
            c instanceof Canvas ? new CanvasValueReference({ canvas: c }) : c
        );
        this.model = properties.model;
        this.canvasesQuery = properties.canvasesQuery;
        this.elementsQuery = properties.elementsQuery;
    }
}

@variant(1)
export class ModelRequest extends AIRequest {
    constructor() {
        super();
    }
}

abstract class AIResponse {}

@variant(0)
export class ModelResponse extends AIResponse {
    @field({ type: "string" })
    model: string;

    @field({ type: "string" })
    info: string;

    constructor(properties: { model: string; info: string }) {
        super();
        this.model = properties.model;
        this.info = properties.info;
    }
}

@variant(1)
export class MissingModel extends AIResponse {
    @field({ type: "string" })
    model: string;

    constructor(properties: { model: string }) {
        super();
        this.model = properties.model;
    }
}

@variant(2)
export class QueryResponse extends AIResponse {
    @field({ type: "u8" })
    status: number;

    constructor() {
        super();
        this.status = 0;
    }
}

const createContextFromElement = (
    element: WithContext<Element<StaticContent<StaticMarkdownText>>>
) => {
    const text = element.content.content.text.replace(/"/g, '\\"');
    return `{ from: ${element.publicKey.hashcode()}, message: "${text}" }`;
};

export const insertTextIntoCanvas = async (text: string, parent: Canvas) => {
    return parent.elements.put(
        new Element({
            content: new StaticContent({
                content: new StaticMarkdownText({ text }),
            }),
            location: Layout.zero(),
            publicKey: parent.node.identity.publicKey,
            parent,
        })
    );
};

export const insertTextReply = async (text: string, parent: Canvas) => {
    return parent.node
        .open(
            new Canvas({
                parent: parent,
                publicKey: parent.node.identity.publicKey,
            }),
            { existing: "reuse" }
        )
        .then(async (newCanvas) => {
            await newCanvas.load();
            await insertTextIntoCanvas(text, newCanvas);
            return parent.replies.put(newCanvas);
        });
};

type ReplyContext = string;

const generateTextContext = async (properties: {
    canvas: Canvas;
    elementsQuery?: Query;
    visited: Set<string>;
}): Promise<ReplyContext[]> => {
    const { canvas, visited } = properties;
    await canvas.load();
    const elements = await canvas.elements.index
        .iterate({
            query: [
                ...getOwnedAndSubownedElementsQuery(canvas),
                getTextElementsQuery(),
                ...(properties.elementsQuery ? [properties.elementsQuery] : []),
            ],
            sort: new Sort({ key: ["__context", "created"] }),
        })
        .all();

    const replyContext: ReplyContext[] = [];
    const createContextFromElement = (
        element: WithContext<Element<StaticContent<StaticMarkdownText>>>
    ) => {
        return `{ from: ${element.publicKey.hashcode()}, message: "${
            element.content.content.text
        }" }`;
    };
    for (const element of elements) {
        const el = element as WithContext<
            Element<StaticContent<StaticMarkdownText>>
        >;
        if (!visited.has(el.idString)) {
            visited.add(el.idString);
            replyContext.push(createContextFromElement(el));
        }
    }
    return replyContext;
};

const generateReply = async (properties: {
    to: Canvas;
    context: Canvas[];
    elementsQuery?: Query;
    canvasesQuery?: Query;
    generator: (text: string) => Promise<string>;
}): Promise<void> => {
    const {
        to,
        context: maybeContext,
        elementsQuery,
        canvasesQuery,
        generator,
    } = properties;
    try {
        await to.load();
        await to.messages.send(new ReplyingInProgresss({ reference: to }));

        let context = maybeContext;
        if (!context || context.length === 0) {
            context = to.path.length > 0 ? [await to.loadParent()] : [];
        }

        let visited = new Set<string>();
        const replyToTexts = await generateTextContext({
            canvas: to,
            visited,
            elementsQuery,
        });
        const contextTexts = (
            await Promise.all(
                context.map((x) =>
                    generateTextContext({ canvas: x, visited, elementsQuery })
                )
            )
        ).flat();

        // Build the aggregated context with metadata.
        let aggregatedContext = "Context for generating your reply. Note:\n";
        /* aggregatedContext +=
            "- 'Thread Parent Post' is the previous post in the conversation thread (metadata is provided only for speaker identification).\n"; */
        aggregatedContext +=
            "- 'from' refers to content created by the post's author (the from field is provided solely for identification purposes).\n\n";

        /*  if (parentTexts.length > 0) {
             aggregatedContext +=
                 "Thread Parent Post:\n" + parentTexts.join("\n") + "\n";
         } */

        if (contextTexts.length > 0) {
            aggregatedContext +=
                "\nRelated Posts (other responses in the conversation):\n" +
                contextTexts.join("\n") +
                "\n";
        }

        aggregatedContext +=
            "\nTarget Post (the post you should reply to):\n" +
            (replyToTexts.length > 0
                ? replyToTexts.join("\n")
                : "_Missing Target Content_") +
            "\n";

        // Construct the prompt with clear instructions.
        const promptText = `
You are a social media assistant and an user, answering questions for users, acting as an another user on the platform. It is very important that you act as another identity, hence answer questions with "you" instead of "I" or "me". You are just trying to answer question the best as you can given a target post and some context, which are other posts. Generate a thoughtful and engaging reply that continues the discussion appropriately. Keep your reply concise and directly address the target post's content. You will act as a different user in the conversation, like a friend or a colleague. For example, if someone asks, what is my name, you can say "I think your name is ...". Important you are referencing the person you are replying to as "you", and not "me" or "they". Reply in the same tone, or vibe as the target post and context.

Important:
- Each post in the context is represented as { from: <hash>, message: "<text>" } where "from" will be a hash of the users identity, and message will be the actual message content.
- The Target Post is the last one in the context. But you use the context too, to find information. Don't mention the word "Target post" or any other meta data related terms. Your goal is answering the question as best as you can and also bringing the discussion forward. If someone asks "How many days does a week have?" you should respond with "7" and not with the question again.

${aggregatedContext}

Your reply to the last, Target Post:\n
        `;

        const aiResponse = await generator(promptText);
        const thinkSplit = aiResponse.split("</think>");
        await insertTextReply(thinkSplit[thinkSplit.length - 1].trim(), to);
    } catch (error) {
        await insertTextReply("Error generating AI reply :(", to);
        console.error("Error generating AI reply:", error);
    } finally {
        await to.messages.send(
            new ReplyingNoLongerInProgresss({ reference: to })
        );
    }
};
