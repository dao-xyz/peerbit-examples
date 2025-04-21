import { field, fixedArray, option, variant, vec } from "@dao-xyz/borsh";
import { Program, ProgramClient } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { queryOllama } from "./ollama.js";
import { queryChatGPT } from "./chatgpt.js";
import { PublicSignKey, sha256Base64Sync, sha256Sync } from "@peerbit/crypto";
import { SilentDelivery } from "@peerbit/stream-interface";
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
    LOWEST_QUALITY,
    ReplyingInProgresss,
    ReplyingNoLongerInProgresss,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { Query, Sort, WithContext } from "@peerbit/document";
import { createProfile } from "./profile.js";
import { DEEP_SEEK_R1_1_5b, DEEP_SEEK_R1_7b } from "./model.js";

// Utility to ignore specific errors.
const ignoreTimeoutandAbort = (error: Error) => {
    if (error instanceof TimeoutError || error instanceof AbortError) {
        // Ignore timeout and abort errors.
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
    onRequest?: (
        query: ChatQuery | ModelRequest | SuggestedReplyQuery,
        context?: any
    ) => void;
} & (OpenAPIArgs | OLLamaArgs);

export type OpenAPIArgs = { server: true; llm: "chatgpt"; apiKey?: string };
export type OLLamaArgs = {
    server: true;
    llm: "ollama";
    model?: typeof DEEP_SEEK_R1_1_5b | typeof DEEP_SEEK_R1_7b;
    apiKey?: string;
};
export type ServerConfig = OpenAPIArgs | OLLamaArgs;

/**
 * Helper function to resolve a canvas reference into an open canvas.
 */
async function resolveCanvas(
    canvasOrRef: Canvas | CanvasReference,
    node: any
): Promise<Canvas> {
    let canvas: Canvas =
        canvasOrRef instanceof Canvas
            ? canvasOrRef
            : await canvasOrRef.load(node);
    return node.open(canvas, { existing: "reuse" });
}

/**
 * Given an array of canvases or canvas references, load and open each one.
 */
async function resolveCanvases(
    canvases: (Canvas | CanvasReference)[],
    node: any
): Promise<Canvas[]> {
    return Promise.all(canvases.map((c) => resolveCanvas(c, node)));
}
const DEFAULT_MAX_CHAR_LIMIT = 1000;
const DEFAULT_MAX_ITEM_LIMIT = 100;

/**
 * Instead of fetching all context elements at once,
 * this helper gathers context texts from a given canvas in batches.
 * Optionally stops when a maximum character length or item count is reached.
 */
async function getOrderedContextTexts(options: {
    canvas: Canvas;
    elementsQuery?: Query;
    visited: Set<string>;
    maxChars?: number; // maximum total characters to aggregate
    maxItems?: number; // maximum number of context elements
}): Promise<string[]> {
    let maxChars = options.maxChars || DEFAULT_MAX_CHAR_LIMIT;
    let maxItems = options.maxItems || DEFAULT_MAX_ITEM_LIMIT;

    await options.canvas.load();
    const iterator = options.canvas.elements.index.iterate(
        {
            query: [
                ...getOwnedAndSubownedElementsQuery(options.canvas),
                getTextElementsQuery(),
                ...(options.elementsQuery ? [options.elementsQuery] : []),
            ],
            sort: new Sort({ key: ["__context", "created"] }),
        },
        {
            remote: { eager: true },
        }
    );

    const texts: { text: string; order?: number; from: string }[] = [];
    let aggregatedLength = 0;
    let totalItems = 0;
    while (true) {
        // Fetch the next 10 elements.
        const batch = await iterator.next(10);
        if (!batch || batch.length === 0) break;
        for (const element of batch) {
            const el = element as WithContext<
                Element<StaticContent<StaticMarkdownText>>
            >;
            if (!options.visited.has(el.idString)) {
                options.visited.add(el.idString);
                // Prepare the text and sort order.
                const text = el.content.content.text.replace(/"/g, '\\"');
                const order =
                    el.location && typeof el.location.y === "number"
                        ? el.location.y
                        : undefined;
                const from = el.publicKey.hashcode();
                const formatted = `{ from: ${from} message: ${text} }`;
                texts.push({ text, order, from });
                aggregatedLength += formatted.length;
                totalItems++;
                if (totalItems >= maxItems || aggregatedLength >= maxChars) {
                    break;
                }
            }
        }
        if (totalItems >= maxItems || aggregatedLength >= maxChars) {
            break;
        }
    }
    await iterator.close();
    // Sort the texts by their order if available.
    texts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // Format the texts.
    return texts.map((t) => `{ from: ${t.from} message: ${t.text} }`);
}

/**
 * Builds the aggregated prompt for the AI generator.
 * It combines the target canvas texts and texts from related contexts.
 * Optionally, it limits the total context using the maxChars (or maxItems) parameter.
 */
async function buildAggregatedPrompt(options: {
    targetCanvas: Canvas;
    contextCanvases: Canvas[];
    elementsQuery?: Query;
    maxChars?: number; // maximum characters for the aggregated context
    maxItems?: number; // maximum number of context items
}): Promise<string> {
    let visited = new Set<string>();
    // Get texts from the target canvas.
    const targetTexts = await getOrderedContextTexts({
        canvas: options.targetCanvas,
        elementsQuery: options.elementsQuery,
        visited,
        maxChars: options.maxChars,
        maxItems: options.maxItems,
    });
    // Get texts from each context canvas.
    const contextTextsArrays = await Promise.all(
        options.contextCanvases.map((canvas) =>
            getOrderedContextTexts({
                canvas,
                elementsQuery: options.elementsQuery,
                visited,
                maxChars: options.maxChars,
                maxItems: options.maxItems,
            })
        )
    );
    const contextTexts = contextTextsArrays.flat();

    let aggregated = "Context for generating your reply. Note:\n";
    aggregated +=
        "- 'from' refers to content created by the post's author (for identification purposes).\n\n";
    if (contextTexts.length > 0) {
        aggregated +=
            "\nRelated Posts (other responses):\n" +
            contextTexts.join("\n") +
            "\n";
    }
    aggregated +=
        "\nTarget Post (the post you should reply to):\n" +
        (targetTexts.length > 0
            ? targetTexts.join("\n")
            : "_Missing Target Content_") +
        "\n";
    return aggregated;
}

/**
 * Core function that prepares the context and calls the AI generator.
 * The 'outputFn' parameter determines how the final reply is handled:
 * - For chat queries, the output is inserted in the canvas.
 * - For suggested reply queries, the output is returned.
 *
 * An optional `actAs` key instructs the generator to act on behalf of a specific user.
 */
async function processReplyGeneration(options: {
    node: ProgramClient;
    actAs?: PublicSignKey;
    emitProgress?: boolean;
    target: Canvas | CanvasReference;
    context: (Canvas | CanvasReference)[];
    elementsQuery?: Query;
    canvasesQuery?: Query;
    generator: (prompt: string) => Promise<string>;
    outputFn: (reply: string, target: Canvas) => Promise<void>;
}): Promise<void> {
    // Resolve the target and context canvases.
    const targetCanvas = await resolveCanvas(options.target, options.node);
    const contextCanvases =
        options.context && options.context.length > 0
            ? await resolveCanvases(options.context, options.node)
            : targetCanvas.path.length > 0
            ? [await targetCanvas.loadParent()]
            : [];

    const aggregatedContext = await buildAggregatedPrompt({
        targetCanvas,
        contextCanvases,
        elementsQuery: options.elementsQuery,
    });

    // Build initial instructions.
    let promptIntro = `You are a social media assistant answering as another user (refer to the other person as "you" rather than "I"). `;
    if (options.actAs) {
        promptIntro += `Your reply is being generated on behalf of the user (acting as the user) with "from" value of ${options.actAs.hashcode()}. Use only posts created by this user when considering the context. `;
    } else {
        promptIntro += `Generate your response in your own voice. `;
    }
    promptIntro += `Given a target post and context, generate a concise, thoughtful reply that continues the conversation naturally.\n\n`;
    promptIntro += `Important:\n- Each context post is represented as { from: <hash>, message: "<text>" }.\n- Do not include any meta commentary about the target post.\n\n`;

    const prompt = `
${promptIntro}
${aggregatedContext}
Your reply to the target post without any meta commentary or reasoning. Don't be too accomodating and aswer "please" "how can I assist" etc. Just the answer:
  `;

    // --- Start reply in progress interval ---
    let progressInterval: ReturnType<typeof setInterval> | undefined;
    try {
        // Send a periodic in-progress notification every second.
        progressInterval = options?.emitProgress
            ? setInterval(async () => {
                  try {
                      await targetCanvas.messages.send(
                          new ReplyingInProgresss({ reference: targetCanvas })
                      );
                  } catch (err) {
                      // Optionally log or handle errors in sending in-progress messages.
                  }
              }, 1000)
            : undefined;

        // Call the AI generator and process the reply text.
        const aiResponse = await options.generator(prompt);

        // some trimming because some moodels add some extra text and stuff we dont need
        let reply = "";
        const delimiters = ["message:", "</think>"]; // deepseek r1 seems to emit </think> tag
        for (const delim of delimiters) {
            let split = aiResponse.split(delim);
            reply = split.pop()?.trim() || "";
            if (split.length > 0) {
                break; // assume only one delimiter is needed, if any
            }
        }

        await options.outputFn(reply, targetCanvas);
    } finally {
        if (progressInterval) {
            clearInterval(progressInterval);
        }
        // Notify that reply generation is no longer in progress.
        try {
            await targetCanvas.messages.send(
                new ReplyingNoLongerInProgresss({ reference: targetCanvas })
            );
        } catch (err) {
            // Optionally log or handle errors.
        }
    }
}

//
// ─── THE MAIN CLASS ────────────────────────────────────────────────────────────
//

@variant("canvas-ai-reply")
export class CanvasAIReply extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;
    @field({ type: RPC })
    rpc: RPC<AIRequest, AIResponse>;

    // Model map and supported models.
    private modelMap: Map<string, { peers: Set<string>; model: string }>;
    public supportedModels: string[] = [];

    // LLM configuration.
    private serverConfig: ServerConfig | undefined;
    // Request statistics.
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

    async open(args?: Args): Promise<void> {
        this.modelMap = new Map();
        if (!args?.server && args) {
            if ("llm" in args) {
                args = {
                    server: true,
                    llm: args.llm,
                    apiKey: "apiKey" in args ? args.apiKey : undefined,
                    model: "model" in args ? args.model : undefined,
                };
            }
        }

        if (args?.server) {
            console.log(
                "Launching AI Reply server: " +
                    args.llm +
                    ", apikey provided: " +
                    !!args["apiKey"] +
                    ", model provided: " +
                    args["model"]
            );
            await createProfile(this.node);
            const llm = args?.llm || "ollama";
            let apiKey: string | undefined = undefined;
            if (args.llm === "ollama") {
                this.supportedModels = args.model
                    ? [args.model]
                    : [DEEP_SEEK_R1_7b];
            } else if (args.llm === "chatgpt") {
                this.supportedModels = ["gpt-4o"];
                apiKey = args?.apiKey
                    ? args.apiKey
                    : process.env.OPENAI_API_KEY || undefined;
                if (!apiKey) throw new Error("Missing ChatGPT API Key");
            } else {
                throw new Error("Missing LLM Model source");
            }
            this.serverConfig = { server: true, llm, apiKey };
        } else {
            this.supportedModels = [];
        }
        await this.rpc.open({
            responseType: AIResponse,
            queryType: AIRequest,
            topic: sha256Base64Sync(this.id),
            responseHandler: args?.server
                ? async (query, context) => {
                      if (args?.onRequest) args.onRequest(query, context);
                      if (query instanceof ChatQuery) {
                          return this.handleChatQuery(query);
                      } else if (query instanceof ModelRequest) {
                          return new ModelResponse({
                              model: this.supportedModels.join(", "),
                              info: "Supported models by this peer",
                          });
                      } else if (query instanceof SuggestedReplyQuery) {
                          return this.handleSuggestedReplyQuery({
                              ...query,
                              actAs: context.from!,
                          });
                      }
                  }
                : undefined,
        });
        if (!args?.server) {
            // Request model info from peers.
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
            this.rpc.events.addEventListener("join", async (e: any) => {
                await requestModels([e.detail]).catch(ignoreTimeoutandAbort);
            });
            requestModels().catch(ignoreTimeoutandAbort);
        }
    }

    private getPeersWithModel(model?: string) {
        if (model) return this.modelMap.get(model);
        const keys = [...this.modelMap.keys()];
        return keys.length > 0 ? this.modelMap.get(keys[0]) : undefined;
    }

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
        const { timeout = 20000, model: maybeModel } = options || {};
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
                        ? new SilentDelivery({ redundancy: 1, to: toPeers })
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

    async suggest(
        to: CanvasReference | Canvas,
        options?: {
            context?: CanvasReference[];
            elementsQuery?: Query;
            canvasesQuery?: Query;
            timeout?: number;
            model?: string;
            actAs?: PublicSignKey;
        }
    ): Promise<SuggestedReplyResponse> {
        const { timeout = 20000, model: maybeModel, actAs } = options || {};
        const peers = this.getPeersWithModel(maybeModel);
        const meInPeer = peers?.peers?.has(
            this.node.identity.publicKey.hashcode()
        );
        if (meInPeer) {
            // When running locally, pass the actAs parameter to the handler.
            return this.handleSuggestedReplyQuery({
                to,
                context: options?.context || [],
                canvasesQuery: options?.canvasesQuery,
                elementsQuery: options?.elementsQuery,
                model: peers!.model,
                actAs: actAs ? actAs : this.node.identity.publicKey,
            });
        }
        if (!peers?.peers || peers.peers.size === 0) {
            throw new Error(
                `No peers available for model ${peers?.model ?? "NO_MODEL"}`
            );
        }
        // If not available locally, pick a random peer to send the request.
        let toPeers = [
            [...peers.peers][
                Math.round(Math.random() * (peers.peers.size - 1))
            ],
        ];
        // Create a new SuggestedReplyQuery.
        const query = new SuggestedReplyQuery({
            to,
            context: options?.context || [],
            canvasesQuery: options?.canvasesQuery,
            elementsQuery: options?.elementsQuery,
            model: peers!.model,
        }) as SuggestedReplyQuery & { actAs?: PublicSignKey };
        if (actAs) {
            query.actAs = actAs;
        }
        const responses = await this.rpc.request(query, {
            timeout,
            mode: new SilentDelivery({ redundancy: 1, to: toPeers }),
        });
        const response = responses[0]?.response as SuggestedReplyResponse;
        if (response) {
            return response;
        }
        throw new Error("No response received");
    }

    private resolveGenerator = (
        model: string
    ): ((string: string) => Promise<string>) => {
        return this.serverConfig!.llm === "ollama" || !this.serverConfig!.llm
            ? (text: string) => queryOllama(text, model || DEEP_SEEK_R1_7b)
            : this.serverConfig?.llm === "chatgpt"
            ? (text: string) => {
                  if (
                      "apiKey" in this.serverConfig! === false ||
                      !this.serverConfig.apiKey
                  )
                      throw new Error("Missing ChatGPT API Key");
                  return queryChatGPT(text, this.serverConfig.apiKey);
              }
            : () => {
                  throw new Error("Missing LLM Model source");
              };
    };

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
            // Use processReplyGeneration to reuse common steps.
            await processReplyGeneration({
                node: this.node,
                target: properties.to,
                emitProgress: true,
                context: properties.context,
                elementsQuery: properties.elementsQuery,
                canvasesQuery: properties.canvasesQuery,
                generator: this.resolveGenerator(model),
                outputFn: async (reply: string, targetCanvas: Canvas) => {
                    await insertTextReply(reply, targetCanvas);
                },
            });
            this.stats.requestCount++;
            this.stats.totalLatency += Date.now() - startTime;
            return new QueryResponse();
        } catch (error) {
            this.stats.errorCount++;
            throw error;
        }
    }

    async handleSuggestedReplyQuery(properties: {
        to: CanvasReference | Canvas;
        context: CanvasReference[] | Canvas[];
        actAs: PublicSignKey;
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }): Promise<SuggestedReplyResponse> {
        const startTime = Date.now();
        try {
            const model = properties.model || DEEP_SEEK_R1_7b;
            if (model && !this.supportedModels.includes(model)) {
                return new SuggestedReplyResponse({
                    reply: `Missing model ${model}`,
                });
            }
            // Here we call the same processing function but with a different outputFn.
            let replyText = "";
            await processReplyGeneration({
                node: this.node,
                actAs: properties.actAs,
                emitProgress: false,
                target: properties.to,
                context: properties.context,
                elementsQuery: properties.elementsQuery,
                canvasesQuery: properties.canvasesQuery,
                generator: this.resolveGenerator(model),
                outputFn: async (reply: string, _targetCanvas: Canvas) => {
                    replyText = reply;
                },
            });
            this.stats.requestCount++;
            this.stats.totalLatency += Date.now() - startTime;
            return new SuggestedReplyResponse({ reply: replyText });
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
                    this.supportedModels.includes(options.model) ||
                    this.modelMap.has(options.model)
                ) {
                    return;
                }
            } else if (
                this.supportedModels.length > 0 ||
                [...this.modelMap.values()].some((x) => x.peers.size > 0)
            ) {
                return;
            }
            await delay(100);
        }
        throw new Error(
            `Timeout waiting for ${
                options?.model ? "model " + options.model : "any model"
            }`
        );
    }
}

//
// ─── RPC REQUEST/RESPONSE TYPES ─────────────────────────────
//

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

@variant(2)
export class SuggestedReplyQuery extends AIRequest {
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

@variant(3)
export class SuggestedReplyResponse extends AIResponse {
    @field({ type: "string" })
    reply: string;
    constructor(properties: { reply: string }) {
        super();
        this.reply = properties.reply;
    }
}

export const insertTextIntoCanvas = async (text: string, parent: Canvas) => {
    await parent.load();
    return parent.elements.put(
        new Element({
            content: new StaticContent({
                content: new StaticMarkdownText({ text }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode(text)),
            }),
            location: Layout.zero(),
            publicKey: parent.node.identity.publicKey,
            parent,
        })
    );
};

export const insertTextReply = async (text: string, parent: Canvas) => {
    await parent.load();
    return parent.node
        .open(
            new Canvas({ parent, publicKey: parent.node.identity.publicKey }),
            { existing: "reuse" }
        )
        .then(async (newCanvas) => {
            await newCanvas.load();
            await insertTextIntoCanvas(text, newCanvas);
            return parent.createReply(newCanvas);
        });
};
