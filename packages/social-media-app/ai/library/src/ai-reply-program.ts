/* ============================================================================
 * canvas-ai-reply.ts
 * ==========================================================================*/

import { field, fixedArray, option, variant, vec } from "@dao-xyz/borsh";
import { Program, ProgramClient } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { PublicSignKey, sha256Base64Sync, sha256Sync } from "@peerbit/crypto";
import { SilentDelivery } from "@peerbit/stream-interface";
import { delay, AbortError, TimeoutError } from "@peerbit/time";

import {
    AddressReference,
    Canvas,
    CanvasReference,
    CanvasValueReference,
    Element,
    getOwnedElementsQuery,
    getTextElementsQuery,
    IndexableCanvas,
    IndexableElement,
    Layout,
    LOWEST_QUALITY,
    ReplyingInProgresss,
    ReplyingNoLongerInProgresss,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";

import { Query, Sort, WithIndexedContext } from "@peerbit/document";
import { createProfile } from "./profile.js";
import { defaultGigaReplicator, LifeCycle } from "./replication.js";
import { queryOllama } from "./ollama.js";
import { queryChatGPT } from "./chatgpt.js";
import { DEEP_SEEK_R1_1_5b, DEEP_SEEK_R1_7b } from "./model.js";

/* ----------------------------------------------------------------------------
 * small helpers
 * --------------------------------------------------------------------------*/

const ignoreTimeoutandAbort = (error: Error) => {
    if (error instanceof TimeoutError || error instanceof AbortError) return;
    throw error;
};

const DEFAULT_MAX_CHAR_LIMIT = 1000;
const DEFAULT_MAX_ITEM_LIMIT = 100;

/** Normalize any (Canvas|CanvasReference) -> resolved+indexed Canvas. */
async function resolveCanvas(
    canvasOrRef: Canvas | CanvasReference,
    node: ProgramClient
): Promise<WithIndexedContext<Canvas, IndexableCanvas>> {
    const ref =
        canvasOrRef instanceof CanvasReference
            ? canvasOrRef
            : new CanvasValueReference({ value: canvasOrRef });
    return ref.resolve(node);
}

async function resolveCanvases(
    items: (Canvas | CanvasReference)[],
    node: ProgramClient
): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
    return Promise.all(items.map((it) => resolveCanvas(it, node)));
}

/* ----------------------------------------------------------------------------
 * Context collection
 * --------------------------------------------------------------------------*/

async function getOrderedContextTexts(opts: {
    canvas: Canvas; // resolved/open
    elementsQuery?: Query;
    visited: Set<string>;
    maxChars?: number;
    maxItems?: number;
}): Promise<string[]> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHAR_LIMIT;
    const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEM_LIMIT;

    const iterator = opts.canvas.elements.index.iterate(
        {
            query: [
                ...getOwnedElementsQuery(opts.canvas),
                getTextElementsQuery(),
                ...(opts.elementsQuery ? [opts.elementsQuery] : []),
            ],
            sort: new Sort({ key: ["__context", "created"] }),
        },
        { remote: { eager: true } }
    );

    const texts: { text: string; order?: number; from: string }[] = [];
    let aggregatedLength = 0;
    let totalItems = 0;

    while (true) {
        const batch = await iterator.next(10);
        if (!batch?.length) break;

        for (const element of batch) {
            const el = element as WithIndexedContext<
                Element<StaticContent<StaticMarkdownText>>,
                IndexableElement
            >;

            if (opts.visited.has(el.idString)) continue;
            opts.visited.add(el.idString);

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
            if (totalItems >= maxItems || aggregatedLength >= maxChars) break;
        }

        if (totalItems >= maxItems || aggregatedLength >= maxChars) break;
    }

    await iterator.close();

    texts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return texts.map((t) => `{ from: ${t.from} message: ${t.text} }`);
}

async function buildAggregatedPrompt(options: {
    targetCanvas: Canvas; // resolved/open
    contextCanvases: Canvas[]; // resolved/open
    elementsQuery?: Query;
    maxChars?: number;
    maxItems?: number;
}): Promise<string> {
    const visited = new Set<string>();

    const targetTexts = await getOrderedContextTexts({
        canvas: options.targetCanvas,
        elementsQuery: options.elementsQuery,
        visited,
        maxChars: options.maxChars,
        maxItems: options.maxItems,
    });

    const contextTextsArrays = await Promise.all(
        options.contextCanvases.map((c) =>
            getOrderedContextTexts({
                canvas: c,
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
        "- 'from' refers to the author public-key hash of each post.\n\n";

    if (contextTexts.length > 0) {
        aggregated +=
            "\nRelated Posts (other responses):\n" +
            contextTexts.join("\n") +
            "\n";
    }

    aggregated +=
        "\nTarget Post (the post you should reply to):\n" +
        (targetTexts.length
            ? targetTexts.join("\n")
            : "_Missing Target Content_") +
        "\n";

    return aggregated;
}

/* ----------------------------------------------------------------------------
 * Orchestration
 * --------------------------------------------------------------------------*/

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
    const targetCanvas = await resolveCanvas(options.target, options.node);

    const contextCanvases = options.context?.length
        ? await resolveCanvases(options.context, options.node)
        : (targetCanvas.__indexed?.path?.length ?? 0) > 0
        ? [await targetCanvas.loadParent()]
        : [];

    const aggregatedContext = await buildAggregatedPrompt({
        targetCanvas,
        contextCanvases,
        elementsQuery: options.elementsQuery,
    });

    let intro = `You are a social media assistant answering as another user (use "you", not "I"). `;
    if (options.actAs) {
        intro += `Act on behalf of user with hash ${options.actAs.hashcode()}; prefer posts from this user when relevant. `;
    } else {
        intro += `Generate the reply in your own voice. `;
    }
    intro +=
        `Return a concise, thoughtful reply—no meta commentary. Avoid filler.\n\n` +
        `Each context line is { from: <hash>, message: "<text>" }.\n\n`;

    const prompt = `${intro}\n${aggregatedContext}\nYour reply (just the message):`;

    let progressInterval: ReturnType<typeof setInterval> | undefined;

    try {
        if (options.emitProgress) {
            progressInterval = setInterval(async () => {
                try {
                    await targetCanvas.messages.send(
                        new ReplyingInProgresss({ reference: targetCanvas })
                    );
                } catch {}
            }, 1000);
        }

        const aiResponse = await options.generator(prompt);

        // Strip common model prefixes
        let reply = aiResponse.trim();
        for (const delim of ["message:", "</think>"]) {
            const parts = reply.split(delim);
            reply = parts.pop()?.trim() ?? reply;
            if (parts.length > 0) break;
        }

        await options.outputFn(reply, targetCanvas);
    } finally {
        if (progressInterval) clearInterval(progressInterval);
        try {
            await targetCanvas.messages.send(
                new ReplyingNoLongerInProgresss({ reference: targetCanvas })
            );
        } catch {}
    }
}

/* ----------------------------------------------------------------------------
 * Program
 * --------------------------------------------------------------------------*/

export type RequestStats = {
    requestCount: number;
    totalLatency: number;
    errorCount: number;
};

export type OpenAPIArgs = { server: true; llm: "chatgpt"; apiKey?: string };
export type OLLamaArgs = {
    server: true;
    llm: "ollama";
    model?: typeof DEEP_SEEK_R1_1_5b | typeof DEEP_SEEK_R1_7b;
    apiKey?: string;
};
export type ServerConfig = OpenAPIArgs | OLLamaArgs;

export type Args = {
    replicate?: boolean;
    server?: boolean;
    onRequest?: (
        query: ChatQuery | ModelRequest | SuggestedReplyQuery,
        context?: any
    ) => void;
} & (OpenAPIArgs | OLLamaArgs);

@variant("canvas-ai-reply")
export class CanvasAIReply extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: RPC })
    rpc: RPC<AIRequest, AIResponse>;

    private modelMap: Map<string, { peers: Set<string>; model: string }>;
    public supportedModels: string[] = [];
    private serverConfig: ServerConfig | undefined;
    private stats: RequestStats;
    origin: LifeCycle | undefined;

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
        this.modelMap = new Map();
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

        // Allow `{ llm, ... }` without `server:true` by normalizing into server mode
        if (!args?.server && args && "llm" in args) {
            args = {
                server: true,
                llm: (args as any).llm,
                apiKey: "apiKey" in args ? (args as any).apiKey : undefined,
                model: "model" in args ? (args as any).model : undefined,
            } as any;
        }

        if (args?.server) {
            await createProfile(this.node);
            const llm = args.llm || "ollama";
            let apiKey: string | undefined;

            if (llm === "ollama") {
                const ollamaArgs = args as OLLamaArgs;
                this.supportedModels = ollamaArgs.model
                    ? [ollamaArgs.model]
                    : [DEEP_SEEK_R1_7b];
            } else if (llm === "chatgpt") {
                this.supportedModels = ["gpt-4o"];
                apiKey = args.apiKey ?? process.env.OPENAI_API_KEY ?? undefined;
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
                      args?.onRequest?.(query, context);

                      if (query instanceof ChatQuery) {
                          return this.handleChatQuery(query);
                      }
                      if (query instanceof ModelRequest) {
                          return new ModelResponse({
                              model: this.supportedModels.join(", "),
                              info: "Supported models by this peer",
                          });
                      }
                      if (query instanceof SuggestedReplyQuery) {
                          return this.handleSuggestedReplyQuery({
                              ...query,
                              actAs: context.from!,
                          });
                      }
                  }
                : undefined,
        });

        if (!args?.server) {
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
                        const fromPk = resp.from!;
                        const entry = this.modelMap.get(modelResp.model);
                        if (entry) entry.peers.add(fromPk.hashcode());
                        else
                            this.modelMap.set(modelResp.model, {
                                model: modelResp.model,
                                peers: new Set([fromPk.hashcode()]),
                            });
                    }
                } catch {}
            };

            this.rpc.events.addEventListener("join", async (e: any) => {
                await requestModels([e.detail]).catch(ignoreTimeoutandAbort);
            });
            requestModels().catch(ignoreTimeoutandAbort);
        }

        if (
            args?.replicate ||
            (args?.replicate === undefined && args?.server)
        ) {
            this.origin = defaultGigaReplicator(this.node);
            await this.origin.start();
        }
    }

    async close(from?: Program): Promise<boolean> {
        const closed = await super.close(from);
        if (closed) await this.origin?.stop();
        return closed;
    }

    private getPeersWithModel(model?: string) {
        if (model) return this.modelMap.get(model);
        const first = [...this.modelMap.keys()][0];
        return first ? this.modelMap.get(first) : undefined;
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
        const timeout = options?.timeout ?? 20000;
        const peers = this.getPeersWithModel(options?.model);

        // Serve locally if we can
        if (peers?.peers?.has(this.node.identity.publicKey.hashcode())) {
            return this.handleChatQuery({
                to,
                context: options?.context || [],
                model: peers.model,
                elementsQuery: options?.elementsQuery,
                canvasesQuery: options?.canvasesQuery,
            });
        }

        if (!peers?.peers?.size) {
            throw new Error(
                `No peers available for model ${peers?.model ?? "NO_MODEL"}`
            );
        }

        const toPeers = [
            [...peers.peers][Math.floor(Math.random() * peers.peers.size)],
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
                mode: new SilentDelivery({ redundancy: 1, to: toPeers }),
            }
        );

        return responses[0]?.response as AIResponse;
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
        const timeout = options?.timeout ?? 20000;
        const peers = this.getPeersWithModel(options?.model);

        // Serve locally if we can
        if (peers?.peers?.has(this.node.identity.publicKey.hashcode())) {
            return this.handleSuggestedReplyQuery({
                to,
                context: options?.context || [],
                canvasesQuery: options?.canvasesQuery,
                elementsQuery: options?.elementsQuery,
                model: peers.model,
                actAs: options?.actAs ?? this.node.identity.publicKey,
            });
        }

        if (!peers?.peers?.size) {
            throw new Error(
                `No peers available for model ${peers?.model ?? "NO_MODEL"}`
            );
        }

        const toPeers = [
            [...peers.peers][Math.floor(Math.random() * peers.peers.size)],
        ];

        const query = new SuggestedReplyQuery({
            to,
            context: options?.context || [],
            canvasesQuery: options?.canvasesQuery,
            elementsQuery: options?.elementsQuery,
            model: peers.model,
        }) as SuggestedReplyQuery & { actAs?: PublicSignKey };

        if (options?.actAs) query.actAs = options.actAs;

        const responses = await this.rpc.request(query, {
            timeout,
            mode: new SilentDelivery({ redundancy: 1, to: toPeers }),
        });

        return responses[0]?.response as SuggestedReplyResponse;
    }

    private resolveGenerator(model?: string) {
        const m = model || DEEP_SEEK_R1_7b;
        if (this.serverConfig?.llm === "chatgpt") {
            if (!("apiKey" in this.serverConfig) || !this.serverConfig.apiKey) {
                throw new Error("Missing ChatGPT API Key");
            }
            return (text: string) =>
                queryChatGPT(text, this.serverConfig!.apiKey!);
        }
        // default to ollama
        return (text: string) => queryOllama(text, m);
    }

    async handleChatQuery(props: {
        to: CanvasReference | Canvas;
        context: CanvasReference[] | Canvas[];
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }): Promise<AIResponse> {
        const start = Date.now();
        try {
            const model = props.model || DEEP_SEEK_R1_7b;
            if (model && !this.supportedModels.includes(model)) {
                return new MissingModel({ model });
            }

            await processReplyGeneration({
                node: this.node,
                target: props.to,
                context: props.context,
                emitProgress: true,
                elementsQuery: props.elementsQuery,
                canvasesQuery: props.canvasesQuery,
                generator: this.resolveGenerator(model),
                outputFn: async (reply, targetCanvas) => {
                    await insertTextIntoCanvas(reply, targetCanvas);
                },
            });

            this.stats.requestCount++;
            this.stats.totalLatency += Date.now() - start;
            return new QueryResponse();
        } catch (e) {
            this.stats.errorCount++;
            throw e;
        }
    }

    async handleSuggestedReplyQuery(props: {
        to: CanvasReference | Canvas;
        context: CanvasReference[] | Canvas[];
        actAs: PublicSignKey;
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }): Promise<SuggestedReplyResponse> {
        const start = Date.now();
        try {
            const model = props.model || DEEP_SEEK_R1_7b;
            if (model && !this.supportedModels.includes(model)) {
                return new SuggestedReplyResponse({
                    reply: `Missing model ${model}`,
                });
            }

            let replyText = "";
            await processReplyGeneration({
                node: this.node,
                actAs: props.actAs,
                target: props.to,
                context: props.context,
                emitProgress: false,
                elementsQuery: props.elementsQuery,
                canvasesQuery: props.canvasesQuery,
                generator: this.resolveGenerator(model),
                outputFn: async (reply) => {
                    replyText = reply;
                },
            });

            this.stats.requestCount++;
            this.stats.totalLatency += Date.now() - start;
            return new SuggestedReplyResponse({ reply: replyText });
        } catch (e) {
            this.stats.errorCount++;
            throw e;
        }
    }

    async waitForModel(options?: { model?: string; timeout?: number }) {
        const start = Date.now();
        const timeout = options?.timeout ?? 10000;

        while (Date.now() - start < timeout) {
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

/* ----------------------------------------------------------------------------
 * RPC shapes
 * --------------------------------------------------------------------------*/

abstract class AIRequest {}

@variant(0)
export class ChatQuery extends AIRequest {
    @field({ type: CanvasReference }) to: CanvasReference;
    @field({ type: vec(CanvasReference) }) context: CanvasReference[];
    @field({ type: option(Query) }) canvasesQuery?: Query;
    @field({ type: option(Query) }) elementsQuery?: Query;
    @field({ type: option("string") }) model?: string;

    constructor(props: {
        to: CanvasReference | Canvas;
        context?: CanvasReference[] | Canvas[];
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }) {
        super();
        this.to =
            props.to instanceof Canvas
                ? new CanvasValueReference({ value: props.to })
                : props.to;
        this.context = (props.context || []).map((c) =>
            c instanceof Canvas ? new CanvasValueReference({ value: c }) : c
        );
        this.model = props.model;
        this.canvasesQuery = props.canvasesQuery;
        this.elementsQuery = props.elementsQuery;
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
    @field({ type: CanvasReference }) to: CanvasReference;
    @field({ type: vec(CanvasReference) }) context: CanvasReference[];
    @field({ type: option(Query) }) canvasesQuery?: Query;
    @field({ type: option(Query) }) elementsQuery?: Query;
    @field({ type: option("string") }) model?: string;

    constructor(props: {
        to: CanvasReference | Canvas;
        context?: CanvasReference[] | Canvas[];
        canvasesQuery?: Query;
        elementsQuery?: Query;
        model?: string;
    }) {
        super();
        this.to =
            props.to instanceof Canvas
                ? new CanvasValueReference({ value: props.to })
                : props.to;
        this.context = (props.context || []).map((c) =>
            c instanceof Canvas ? new CanvasValueReference({ value: c }) : c
        );
        this.model = props.model;
        this.canvasesQuery = props.canvasesQuery;
        this.elementsQuery = props.elementsQuery;
    }
}

abstract class AIResponse {}

@variant(0)
export class ModelResponse extends AIResponse {
    @field({ type: "string" }) model: string;
    @field({ type: "string" }) info: string;
    constructor(props: { model: string; info: string }) {
        super();
        this.model = props.model;
        this.info = props.info;
    }
}

@variant(1)
export class MissingModel extends AIResponse {
    @field({ type: "string" }) model: string;
    constructor(props: { model: string }) {
        super();
        this.model = props.model;
    }
}

@variant(2)
export class QueryResponse extends AIResponse {
    @field({ type: "u8" }) status: number;
    constructor() {
        super();
        this.status = 0;
    }
}

@variant(3)
export class SuggestedReplyResponse extends AIResponse {
    @field({ type: "string" }) reply: string;
    constructor(props: { reply: string }) {
        super();
        this.reply = props.reply;
    }
}

/* ----------------------------------------------------------------------------
 * Write helpers (scope-aware); with backward-compatible overloads
 * --------------------------------------------------------------------------*/

/**
 * insertTextReply — Overloads:
 *  - (node, text, parent: Canvas|CanvasReference)
 *  - (text, parent: Canvas)  // legacy path
 */
export async function insertTextIntoCanvas(text: string, target: Canvas) {
    const scope = target.nearestScope; // safe after resolve
    return scope.elements.put(
        new Element({
            content: new StaticContent({
                content: new StaticMarkdownText({ text }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode(text)),
            }),
            location: Layout.zero(),
            publicKey: scope.node.identity.publicKey,
            canvasId: target.id,
        })
    );
}
