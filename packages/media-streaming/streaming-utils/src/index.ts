/**
    This file contains all the definitions for the databases related to media streaming and playback
 
    MediaStreamDB controls all the media sources in Tracks.
    Each Track is defined by its start and end time.
    Each Track contains a database of chunks which is the media
    Tracks can be of different types, like Video, Audio in different encodings

    E.g. A multiresolution stream with audia is done by having multiple tracks active at once. One track for each resolution,
    and one track for the audio.
    If a viewer only want to listen to the audio or specific resolution, they don't have to bother about the other tracks 
    since the viewer can choose to only "open" the tracks it is interested in
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         
    +-----------------------------------------------------------------------------------------------------------------+            
    |                                                                                                                 |            
    |    MediaStreamDB                                                                                                |            
    |    Host/Sender                                                                                                  |            
    |                                                                                                                 |            
    |                                        +------------------------+                                               |            
    |                                        |      Track<Video>      |                                               |            
    |                                        +------------------------+                                               |            
    |           +------------------------++-------------------------------------------------------------------+       |            
    |           |      Track<Video>      ||                           Track<Video>                            |       |            
    |           +------------------------++-------------------------------------------------------------------+       |            
    |           +------------------------+                                                                            |            
    |           |      Track<Audio>      |                                                                            |            
    |           +------------------------+                                                                            |            
    |                          +------------------------+                                                             |            
    |                          |      Track<Audio>      |                                                             |            
    |                          +------------------------+                                                             |            
    |                                                                                                                 |            
    |                                                                                                                 |            
    |     ---------------------------------------------------------------------------------------------------->       |            
    |                                                    Time                                                         |            
    |                                                                                                                 |            
    |                                                                                                                 |            
    +-----------------------------------------------------------------------------------------------------------------+            
                                                                                                                        
 */

import { field, variant, option, serialize, fixedArray } from "@dao-xyz/borsh";
import {
    PublicSignKey,
    toBase64,
    sha256Sync,
    fromBase64,
    sha256Base64Sync,
} from "@peerbit/crypto";
import {
    Documents,
    SearchRequest,
    Sort,
    SortDirection,
    IntegerCompare,
    Compare,
    IsNull,
    SearchOptions,
    ResultsIterator,
    Or,
    DocumentsChange,
    CustomDocumentDomain,
    createDocumentDomain,
    WithContext,
    WithIndexedContext,
} from "@peerbit/document";
import {
    id,
    IndexedResults,
    NotStartedError,
} from "@peerbit/indexer-interface";
import { ClosedError, Program, ProgramEvents } from "@peerbit/program";
import { concat, fromString } from "uint8arrays";
import { randomBytes } from "@peerbit/crypto";
import { delay, waitFor, AbortError, TimeoutError } from "@peerbit/time";
import PQueue from "p-queue";
import { equals } from "uint8arrays";
import { MAX_U64, ReplicationRangeIndexable } from "@peerbit/shared-log";
import { hrtime } from "@peerbit/time";
import { Timestamp } from "@peerbit/log";
import { MissingResponsesError } from "@peerbit/rpc";

const isClosedError = (error: any) => {
    if (
        error instanceof NotStartedError ||
        error instanceof ClosedError ||
        error instanceof AbortError
    ) {
        return true;
    }
    return false;
};

const throwCleanupFailures = (failures: unknown[], message: string) => {
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, message);
    }
};
export const hrtimeMicroSeconds = () => {
    const nano = hrtime.bigint();
    return nano / 1000n;
};

/* const hrTimeNow = hrtime.bigint();
const startTime = BigInt(Date.now()) * BigInt(1e6) - hrTimeNow;
const bigintNanoNow = () => startTime + hrtime.bigint(); */

/*
const utf8Encode = (value: string) => {
    const l = length(value);
    const arr = new Uint8Array(l);
    write(value, arr, 0);
    return arr;
};
 */

@variant(0)
export class Chunk {
    @field({ type: "u8" })
    private _type: 0 | 1 | 2;

    @field({ type: "u64" })
    private _time: bigint;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(props: {
        type?: "key" | "delta";
        chunk: Uint8Array;
        time: bigint | number;
    }) {
        this._type = 0;
        if (props.type == "key") {
            this._type = 1;
        } else {
            this._type = 2; // "delta"
        }
        this.chunk = props.chunk;
        this._time = BigInt(props.time);
    }

    get id(): string {
        return String(this.time);
    }

    get time() {
        return Number(this._time);
    }

    get timeBN() {
        return this._time;
    }
    get type(): "key" | "delta" | undefined {
        if (this._type === 0) {
            return undefined;
        }

        if (this._type === 1) {
            return "key";
        }

        if (this._type === 2) {
            return "delta";
        }
        throw new Error("Unexpected chunk type");
    }
}

@variant("media_chunk_indexable")
export class ChunkIndexable {
    @field({ type: "string" })
    id: string;

    @field({ type: option("string") })
    type: "key" | "delta" | undefined;

    @field({ type: "u64" })
    time: bigint;

    @field({ type: "u64" })
    timestamp: bigint;

    constructor(chunk: {
        id: string;
        type: "key" | "delta" | undefined;
        time: bigint | number;
        timestamp: bigint | number;
    }) {
        this.id = chunk.id;
        this.type = chunk.type;
        this.time = BigInt(chunk.time);
        this.timestamp = BigInt(chunk.timestamp);
    }
}

@variant(0)
export class VideoInfo {
    @field({ type: option("u32") })
    width: number;

    @field({ type: option("u32") })
    height: number;

    constructor(properties: { width: number; height: number }) {
        this.width = properties.width;
        this.height = properties.height;
    }
}

@variant(0)
export class MediaStreamInfo {
    @field({ type: VideoInfo })
    video: VideoInfo;

    constructor(properties: { video: VideoInfo }) {
        if (properties.video)
            this.video =
                properties.video instanceof VideoInfo
                    ? properties.video
                    : new VideoInfo(properties.video);
    }

    hashcode() {
        return toBase64(serialize(this));
    }
}

type Args = {
    sender: PublicSignKey;
    startTime: bigint;
    endTime?: bigint;
};

@variant("track-source")
export abstract class TrackSource {
    @field({ type: Documents })
    private _chunks: Documents<
        Chunk,
        ChunkIndexable,
        CustomDocumentDomain<"u64">
    >;

    constructor() {
        this._chunks = new Documents({
            id: randomBytes(32),
        });
    }

    get chunks() {
        return this._chunks;
    }

    sender: PublicSignKey;
    startTime: bigint;
    endTime?: bigint;

    async open(args: Args): Promise<void> {
        /*        
         console.log(
                    "LISTEN FROM",
                    args?.replicate,
                    shiftToU32(+new Date()),
                    "TO",
                    shiftToU32(+new Date()) + 24 * 60 * 60 * 1e3
                ); 
        */

        this.sender = args.sender;
        this.startTime = args.startTime;
        this.endTime = args.endTime;

        await this.chunks.open({
            type: Chunk,
            canPerform: async (props) => {
                const keys = await props.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(args.sender)) {
                        return true;
                    }
                }
                return false;
            },
            index: {
                type: ChunkIndexable,
                transform: (obj, ctx) => {
                    return new ChunkIndexable({
                        id: obj.id,
                        time: obj.timeBN,
                        type: obj.type,
                        timestamp: ctx.created,
                    });
                },
            },
            replicate: { type: "resume", default: false },
            domain: createDocumentDomain({
                resolution: "u64",
                canProjectToOneSegment: () => true, // TODO
                // nano seconds between the insertion
                mergeSegmentMaxDelta: 1e9, // 1 second of delta. I.e. if we buffer video from two segments and there is a gap of 1 second in walltime between the commit, we merge the segments
                fromEntry: (entry) => {
                    return entry.meta.clock.timestamp.wallTime;
                },
            }),
        });
    }

    async waitForReplicators(options?: { signal?: AbortSignal }) {
        await this.chunks.log.waitForReplicators({
            coverageThreshold: 0.1,
            signal: options?.signal,
        }); // TODO wait for replicators only for the domeain (time domain) of interest
    }

    async waitForStreamer() {
        try {
            await waitFor(
                async () =>
                    (await this.chunks.log.replicationIndex.count({
                        query: { hash: this.sender.hashcode() },
                    })) > 0,
                { timeout: 5e3 }
            );
        } catch (error) {
            throw new Error("Sender not available");
        }
    }

    /**
     *
     * @param time in this coordinate space
     */
    async iterate(
        time: number,
        options?: {
            local?: boolean;
            remote?: {
                eager?: boolean;
                replicate?: boolean;
                timeout?: number;
                retryMissingResponses?: boolean;
            };
            signal?: AbortSignal;
        }
    ) {
        if (options?.signal?.aborted) {
            throw new AbortError();
        }
        if (!Number.isFinite(time)) {
            throw new Error("Media seek time must be finite");
        }

        const localEnabled = options?.local ?? true;

        const normalizeTimeout = (
            value: number | undefined,
            fallback: number
        ) =>
            value == null || !Number.isFinite(value)
                ? fallback
                : Math.max(0, value);
        const requestedTimeout = options?.remote?.timeout;
        const initialRouteTimeout = normalizeTimeout(requestedTimeout, 2_000);
        const retryWindow = normalizeTimeout(requestedTimeout, 15_000);
        const routeController = new AbortController();
        const abortState: {
            iterator?: ResultsIterator<Chunk>;
            closePromise?: Promise<void>;
        } = {};
        const startAbortClose = () => {
            if (abortState.iterator == null) {
                return;
            }
            abortState.closePromise ??= abortState.iterator.close();
            void abortState.closePromise.catch(() => {
                // A later explicit close retries retained iterator cleanup.
            });
        };
        const onCallerAbort = () => {
            routeController.abort();
            startAbortClose();
        };
        options?.signal?.addEventListener("abort", onCallerAbort, {
            once: true,
        });
        if (options?.signal?.aborted) {
            onCallerAbort();
        }

        const requestedTime = BigInt(Math.max(0, Math.ceil(time)));
        let lastEmittedTime: bigint | undefined;
        const originHash = this.sender.hashcode();
        const getRemainingDomain = (): [bigint, bigint] => {
            const firstQueriedTime =
                lastEmittedTime == null ? requestedTime : lastEmittedTime + 1n;
            const lower = (this.startTime + firstQueriedTime) * 1000n;
            const endCoordinate =
                this.endTime == null ? MAX_U64 : this.endTime * 1000n;
            const upper =
                endCoordinate >= MAX_U64 ? MAX_U64 : endCoordinate + 1n;
            return [lower, upper];
        };
        const remainingDomainIsEmpty = () => {
            const [lower, upper] = getRemainingDomain();
            return lower >= upper;
        };

        const createRequest = (resumeAfter?: bigint, fetch?: number) => {
            const query = [
                new IntegerCompare({
                    key: "time",
                    compare:
                        resumeAfter == null
                            ? Compare.GreaterOrEqual
                            : Compare.Greater,
                    value: resumeAfter ?? requestedTime,
                }),
            ];
            if (this.endTime != null) {
                query.push(
                    new IntegerCompare({
                        key: "time",
                        compare: Compare.LessOrEqual,
                        value: this.endTime - this.startTime,
                    })
                );
            }
            return new SearchRequest({
                query,
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: "time",
                    }),
                ],
                fetch,
            });
        };

        const linkSignal = (parent?: AbortSignal, timeout?: number) => {
            if (parent == null && timeout == null) {
                return {
                    signal: undefined,
                    detach: () => {},
                };
            }
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            if (parent?.aborted) {
                forwardAbort();
            } else {
                parent?.addEventListener("abort", forwardAbort, {
                    once: true,
                });
            }
            const timeoutHandle =
                timeout == null || controller.signal.aborted
                    ? undefined
                    : setTimeout(
                          () => {
                              controller.abort(
                                  new TimeoutError(
                                      "Media route probe timed out"
                                  )
                              );
                          },
                          Math.max(1, timeout)
                      );
            timeoutHandle?.unref?.();
            return {
                signal: controller.signal,
                detach: () => {
                    if (timeoutHandle != null) {
                        clearTimeout(timeoutHandle);
                    }
                    parent?.removeEventListener("abort", forwardAbort);
                },
            };
        };

        const activeProbeRuns = new Set<Promise<void>>();
        const probesToClose = new Set<ResultsIterator<Chunk>>();
        let probeClosePromise: Promise<void> | undefined;
        const closeOwnedProbes = () => {
            probeClosePromise ??= (async () => {
                const probes = [...probesToClose];
                const results = await Promise.allSettled(
                    probes.map((probe) =>
                        Promise.resolve().then(() => probe.close())
                    )
                );
                const failures: unknown[] = [];
                for (let index = 0; index < results.length; index++) {
                    const result = results[index];
                    if (result.status === "fulfilled") {
                        probesToClose.delete(probes[index]);
                    } else {
                        failures.push(result.reason);
                    }
                }
                if (failures.length === 1) {
                    throw failures[0];
                }
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        "Failed to close one or more media route probes"
                    );
                }
            })().finally(() => {
                probeClosePromise = undefined;
            });
            return probeClosePromise;
        };
        const probeOrigin = async (
            timeout: number
        ): Promise<"productive" | "empty" | "missing"> => {
            if (routeController.signal.aborted) {
                throw new AbortError();
            }
            let finishProbeRun!: () => void;
            const probeRun = new Promise<void>((resolve) => {
                finishProbeRun = resolve;
            });
            activeProbeRuns.add(probeRun);
            try {
                const probeTimeout = Math.max(1, Math.floor(timeout));
                let probe: ResultsIterator<Chunk> | undefined;
                let result: "productive" | "empty" | "missing" = "missing";
                const linkedSignal = linkSignal(
                    routeController.signal,
                    probeTimeout
                );
                try {
                    probe = this.chunks.index.iterate(
                        createRequest(lastEmittedTime, 1),
                        {
                            local: false,
                            remote: {
                                from: [originHash],
                                reach: {
                                    eager: options?.remote?.eager ?? true,
                                },
                                replicate: false,
                                retryMissingResponses: false,
                                throwOnMissing: true,
                                timeout: probeTimeout,
                                signal: linkedSignal.signal,
                            } as any,
                        }
                    );
                    probesToClose.add(probe);
                    const chunks = await probe.next(1);
                    if (routeController.signal.aborted) {
                        throw new AbortError();
                    }
                    // Some iterator implementations translate an aborted
                    // request into an empty page. A page that only became
                    // empty because this probe's deadline fired is not proof
                    // that the canonical origin is cleanly exhausted.
                    result = linkedSignal.signal?.aborted
                        ? "missing"
                        : chunks.length > 0
                          ? "productive"
                          : "empty";
                } catch (error) {
                    if (routeController.signal.aborted) {
                        throw new AbortError();
                    }
                    if (
                        error instanceof MissingResponsesError ||
                        error instanceof TimeoutError ||
                        (error instanceof AbortError &&
                            linkedSignal.signal?.aborted)
                    ) {
                        result = "missing";
                    } else {
                        throw error;
                    }
                } finally {
                    try {
                        await probe?.close();
                        if (probe != null) {
                            probesToClose.delete(probe);
                        }
                    } finally {
                        linkedSignal.detach();
                    }
                }
                if (routeController.signal.aborted) {
                    throw new AbortError();
                }
                return result;
            } finally {
                activeProbeRuns.delete(probeRun);
                finishProbeRun();
            }
        };

        const discoverResponsiveRemotes = async (
            timeout: number,
            properties?: {
                acceptEmpty?: boolean;
            }
        ): Promise<string[]> => {
            const deadline = Date.now() + timeout;
            let firstRound = true;
            let missingBackoff = 100;

            while (firstRound || Date.now() < deadline) {
                firstRound = false;
                if (routeController.signal.aborted) {
                    throw new AbortError();
                }
                const remaining = Math.max(0, deadline - Date.now());
                if (remaining <= 0) {
                    break;
                }
                const probeResult = await probeOrigin(remaining);
                if (probeResult === "productive") {
                    return [originHash];
                }
                if (
                    properties?.acceptEmpty === true &&
                    probeResult === "empty"
                ) {
                    return [originHash];
                }
                if (probeResult === "empty") {
                    return [];
                }

                await delay(
                    Math.min(
                        missingBackoff,
                        Math.max(0, deadline - Date.now())
                    ),
                    {
                        signal: routeController.signal,
                    }
                );
                missingBackoff = Math.min(1_000, missingBackoff * 2);
            }
            return [];
        };

        const iteratorSignalCleanup = new WeakMap<
            ResultsIterator<Chunk>,
            () => void
        >();
        const createIterator = (
            responsiveRemotes: string[],
            resumeAfter?: bigint
        ) => {
            const pageTimeout = normalizeTimeout(
                options?.remote?.timeout,
                5_000
            );
            const linkedSignal = linkSignal(routeController.signal);
            try {
                const iterator = this.chunks.index.iterate(
                    createRequest(resumeAfter),
                    {
                        remote:
                            responsiveRemotes.length > 0
                                ? ({
                                      from: responsiveRemotes,
                                      reach: {
                                          eager: options?.remote?.eager ?? true,
                                      },
                                      replicate:
                                          options?.remote?.replicate ?? true,
                                      retryMissingResponses:
                                          options?.remote
                                              ?.retryMissingResponses ?? false,
                                      // The resilient wrapper can only refresh
                                      // stale routes if missing responders are
                                      // surfaced instead of looking exhausted.
                                      throwOnMissing: true,
                                      timeout: Math.max(1, pageTimeout),
                                      signal: linkedSignal.signal,
                                  } as any)
                                : false,
                        // A local cache is not evidence that a remote origin's
                        // requested interval is complete. Query it only when
                        // this node is itself the canonical origin.
                        local: senderIsLocal && localEnabled,
                        // Current document pagination forwards outer options
                        // to CollectNextRequest RPCs, while first-page options
                        // are nested under remote. Keep both paths aligned.
                        timeout: Math.max(1, pageTimeout),
                    } as any
                );
                iteratorSignalCleanup.set(iterator, linkedSignal.detach);
                return iterator;
            } catch (error) {
                linkedSignal.detach();
                throw error;
            }
        };
        const createExhaustedIterator = (): ResultsIterator<Chunk> => ({
            next: async () => [],
            done: () => true,
            pending: () => 0,
            first: async () => undefined,
            all: async () => [],
            close: async () => {},
            async *[Symbol.asyncIterator]() {},
        });

        const senderIsLocal = this.sender.equals(
            this.chunks.node.identity.publicKey
        );
        let activeRouteHashes: string[] = [];
        let activeIterator: ResultsIterator<Chunk>;
        let initiallyExhausted = false;
        try {
            if (remainingDomainIsEmpty()) {
                activeIterator = createExhaustedIterator();
                initiallyExhausted = true;
            } else {
                if (senderIsLocal && !localEnabled) {
                    throw new MissingResponsesError(
                        "The canonical media origin is local, but local reads are disabled",
                        [[originHash]]
                    );
                }
                const expectsRemoteRoute = !senderIsLocal;
                activeRouteHashes = expectsRemoteRoute
                    ? await discoverResponsiveRemotes(initialRouteTimeout, {
                          acceptEmpty: true,
                      })
                    : [];
                if (activeRouteHashes.length === 0 && !senderIsLocal) {
                    throw new MissingResponsesError(
                        "The canonical media origin did not respond",
                        [[originHash]]
                    );
                }
                activeIterator = createIterator(activeRouteHashes);
            }
        } catch (error) {
            routeController.abort();
            options?.signal?.removeEventListener("abort", onCallerAbort);
            while (activeProbeRuns.size > 0) {
                await Promise.all([...activeProbeRuns]);
            }
            try {
                await closeOwnedProbes();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Media route discovery and probe cleanup both failed"
                );
            }
            throw error;
        }

        const iteratorsToClose = new Set<ResultsIterator<Chunk>>();
        let closePromise: Promise<void> | undefined;
        const closeOwnedIterators = () => {
            closePromise ??= (async () => {
                const iterators = [...iteratorsToClose];
                const results = await Promise.allSettled(
                    iterators.map((iterator) => {
                        iteratorSignalCleanup.get(iterator)?.();
                        iteratorSignalCleanup.delete(iterator);
                        return Promise.resolve().then(() => iterator.close());
                    })
                );
                const failures: unknown[] = [];
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    if (result.status === "fulfilled") {
                        iteratorsToClose.delete(iterators[i]);
                    } else {
                        failures.push(result.reason);
                    }
                }
                if (failures.length === 1) {
                    throw failures[0];
                }
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        "Failed to close one or more media result iterators"
                    );
                }
            })().finally(() => {
                closePromise = undefined;
            });
            return closePromise;
        };

        let closed = false;
        let retryStartedAt: number | undefined;
        let exhaustionChecked = initiallyExhausted;

        const replaceActiveIterator = async (hashes: string[]) => {
            const iteratorToReplace = activeIterator;
            iteratorsToClose.add(iteratorToReplace);
            await closeOwnedIterators().catch(() => {
                // Retain failed cleanup for the public close() retry path.
            });
            if (
                closed ||
                routeController.signal.aborted ||
                activeIterator !== iteratorToReplace
            ) {
                return;
            }
            activeRouteHashes = hashes;
            activeIterator = createIterator(activeRouteHashes, lastEmittedTime);
            exhaustionChecked = false;
        };

        const refreshExhaustedRoute = async (): Promise<boolean> => {
            if (exhaustionChecked) {
                return false;
            }
            if (remainingDomainIsEmpty()) {
                exhaustionChecked = true;
                return false;
            }
            if (activeRouteHashes.length === 0) {
                // Only the canonical local sender can reach this path. Its
                // local index is authoritative for the requested interval.
                exhaustionChecked = true;
                return false;
            }

            // The document iterator can become done when its remote state
            // disappears, before CollectNextRequest surfaces a missing peer.
            // Re-probe the origin so an unanswered page never looks like EOF.
            const active = await probeOrigin(
                Math.max(1, Math.min(250, initialRouteTimeout))
            );
            if (active === "missing") {
                throw new MissingResponsesError(
                    "The canonical media origin stopped responding",
                    [[originHash]]
                );
            }

            if (active === "productive") {
                const previous = activeIterator;
                await replaceActiveIterator([originHash]);
                return activeIterator !== previous;
            }

            // A clean empty response from the canonical origin is the only
            // currently supported proof that the requested tail is exhausted.
            exhaustionChecked = true;
            return false;
        };

        const next = async (amount: number): Promise<Chunk[]> => {
            if (amount < 0) {
                throw new Error(
                    "Expecting to fetch a positive amount of element"
                );
            }
            // ResultsIterator.next(0) is a valid no-op. Passing it through to a
            // live iterator can repeatedly yield an empty, non-done page and
            // otherwise spin this recovery loop without an asynchronous edge.
            if (amount === 0 || closed) {
                return [];
            }
            if (remainingDomainIsEmpty()) {
                exhaustionChecked = true;
                return [];
            }

            let noProgressDeadline: number | undefined;
            let lastNoProgressRouteRefresh = Date.now();
            let noProgressBackoff = 10;

            while (!closed) {
                if (
                    noProgressDeadline != null &&
                    Date.now() >= noProgressDeadline
                ) {
                    throw new TimeoutError(
                        "Media chunk iterator made no progress"
                    );
                }
                try {
                    // The document iterator contract does not permit pulling
                    // again after done() becomes true. In particular, a
                    // terminal next() can reopen its done flag and look like a
                    // live empty page. Perform the one-time route refresh
                    // before asking the exhausted iterator for more data.
                    if (activeIterator.done()) {
                        if (await refreshExhaustedRoute()) {
                            continue;
                        }
                        return [];
                    }

                    const chunks = await activeIterator.next(amount);
                    if (closed) {
                        return [];
                    }
                    if (routeController.signal.aborted) {
                        throw new AbortError();
                    }
                    const unique = chunks.filter((chunk) => {
                        if (
                            lastEmittedTime != null &&
                            chunk.timeBN <= lastEmittedTime
                        ) {
                            return false;
                        }
                        lastEmittedTime = chunk.timeBN;
                        return true;
                    });
                    if (unique.length > 0) {
                        retryStartedAt = undefined;
                        exhaustionChecked = false;
                        return unique;
                    }

                    if (activeIterator.done()) {
                        if (await refreshExhaustedRoute()) {
                            continue;
                        }
                        return [];
                    }
                    const now = Date.now();
                    noProgressDeadline ??= now + retryWindow;
                    let remaining = Math.max(0, noProgressDeadline - now);

                    // Empty non-done pages are legitimate for live streams,
                    // but each retry yields and the whole call remains bounded
                    // by the configured route deadline.
                    if (
                        remaining > 0 &&
                        now - lastNoProgressRouteRefresh >= 500
                    ) {
                        const refreshed = await discoverResponsiveRemotes(
                            Math.min(500, remaining)
                        );
                        lastNoProgressRouteRefresh = Date.now();
                        if (refreshed.length > 0) {
                            await replaceActiveIterator(refreshed);
                            noProgressBackoff = 10;
                        }
                        remaining = Math.max(
                            0,
                            noProgressDeadline - Date.now()
                        );
                    }
                    if (remaining > 0) {
                        await delay(Math.min(noProgressBackoff, remaining), {
                            signal: routeController.signal,
                        });
                        noProgressBackoff = Math.min(
                            100,
                            noProgressBackoff * 2
                        );
                    }
                } catch (error) {
                    if (closed) {
                        return [];
                    }
                    if (
                        options?.signal?.aborted ||
                        (error instanceof TimeoutError === false &&
                            error instanceof MissingResponsesError === false)
                    ) {
                        throw error;
                    }

                    retryStartedAt ??= Date.now();
                    const remaining =
                        retryWindow - (Date.now() - retryStartedAt);
                    if (remaining <= 0) {
                        throw error;
                    }

                    let refreshed: string[];
                    try {
                        refreshed = await discoverResponsiveRemotes(remaining, {
                            acceptEmpty: true,
                        });
                    } catch (recoveryError) {
                        if (closed) {
                            return [];
                        }
                        throw recoveryError;
                    }
                    if (closed) {
                        return [];
                    }
                    if (refreshed.length === 0) {
                        throw error;
                    }
                    await replaceActiveIterator(refreshed);
                }
            }
            return [];
        };

        const resilientIterator: ResultsIterator<Chunk> = {
            next,
            done: () =>
                closed ||
                remainingDomainIsEmpty() ||
                (activeIterator.done() && exhaustionChecked),
            pending: () =>
                closed ||
                remainingDomainIsEmpty() ||
                (activeIterator.done() && exhaustionChecked)
                    ? 0
                    : activeIterator.pending(),
            first: async () => {
                try {
                    return (await next(1))[0];
                } finally {
                    await resilientIterator.close();
                }
            },
            all: async () => {
                try {
                    const chunks: Chunk[] = [];
                    while (!resilientIterator.done()) {
                        // Match the bounded drain behavior of the underlying
                        // document iterator instead of asking a remote peer
                        // for the maximum u32 batch in one allocation.
                        chunks.push(...(await next(100)));
                    }
                    return chunks;
                } finally {
                    await resilientIterator.close();
                }
            },
            close: async () => {
                if (!closed) {
                    closed = true;
                    routeController.abort();
                    options?.signal?.removeEventListener(
                        "abort",
                        onCallerAbort
                    );
                    iteratorsToClose.add(activeIterator);
                }
                const failures: unknown[] = [];
                try {
                    await closeOwnedIterators();
                } catch (error) {
                    failures.push(error);
                }
                try {
                    while (activeProbeRuns.size > 0) {
                        await Promise.all([...activeProbeRuns]);
                    }
                } catch (error) {
                    failures.push(error);
                }
                try {
                    await closeOwnedProbes();
                } catch (error) {
                    failures.push(error);
                }
                if (failures.length === 1) {
                    throw failures[0];
                }
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        "Failed to close the media result iterator"
                    );
                }
            },
            async *[Symbol.asyncIterator]() {
                try {
                    while (!resilientIterator.done()) {
                        for (const chunk of await next(1)) {
                            yield chunk;
                        }
                    }
                } finally {
                    await resilientIterator.close();
                }
            },
        };
        abortState.iterator = resilientIterator;
        if (options?.signal?.aborted) {
            startAbortClose();
        }
        return resilientIterator;
    }

    async last(options?: { signal?: AbortSignal }): Promise<Chunk | undefined> {
        try {
            return (
                await this.chunks.index.search(
                    new SearchRequest({
                        sort: [
                            new Sort({
                                direction: SortDirection.DESC,
                                key: "time",
                            }),
                        ],
                        fetch: 1,
                    }),
                    {
                        local: true,
                        remote: {
                            reach: { eager: true },
                        },
                        signal: options?.signal,
                    }
                )
            )?.[0];
        } catch (error) {
            if (options?.signal?.aborted) {
                throw error;
            }
            if (isClosedError(error)) {
                return undefined;
            }
            throw error;
        }
    }

    lastLivestreamingSegmentId: Uint8Array | undefined;
    lastLivestreamingSegmentStart: bigint | undefined;
    private replicationQueue: PQueue | undefined;

    private getReplicationQueue() {
        return (this.replicationQueue ??= new PQueue({ concurrency: 1 }));
    }

    async replicate(
        args: "live" | "streamer" | "all" | false,
        options?: { signal?: AbortSignal }
    ): Promise<void> {
        await this.getReplicationQueue().add(() =>
            this.replicateInQueue(args, options)
        );
    }

    private async replicateInQueue(
        args: "live" | "streamer" | "all" | false,
        options?: { signal?: AbortSignal }
    ): Promise<void> {
        if (args === "live") {
            /*  // get latest chunk 
             await this.waitForStreamer()
             const last = await this.last()
             let lastTime = last?.time || 0 */

            const livestreamingSegmentId =
                this.lastLivestreamingSegmentId ?? randomBytes(32);

            if (!this.sender.equals(this.chunks.node.identity.publicKey)) {
                await this.chunks.log.waitForReplicator(this.sender, {
                    signal: options?.signal,
                });
            }

            let last = await this.last({ signal: options?.signal });

            if (options?.signal?.aborted) {
                throw new AbortError();
            }

            // we add 1n because if we have a previous chunk we want to skip it (we want a live stream)
            // TODO this should perhaps actually do some buffering to ensure that we don't miss any chunks,
            // or can immediately play new chunks, for example in a live video stream we might need some earlier chunks to show the new ones
            let offset: bigint =
                (this.startTime + (last ? last.timeBN + 1n : 0n)) * 1000n;

            const livestreamingSegmentStart = hrtimeMicroSeconds();

            console.log(
                "Replicate live ",
                offset + " forward  " + 24 * 60 * 60 * 1e3 * 1e9,
                " now " +
                    livestreamingSegmentStart +
                    " hrtime " +
                    hrtime.bigint()
            );

            await this.chunks.log.replicate({
                id: livestreamingSegmentId,
                factor: 24 * 60 * 60 * 1e3 * 1e9,
                offset,
                normalized: false,
                strict: true,
            });

            // Publish process-local ownership only after the replication update
            // succeeds. An aborted wait/last probe therefore cannot leave an ID
            // whose segment was never created, and the serialized lane prevents
            // concurrent live starts from publishing competing IDs.
            this.lastLivestreamingSegmentId = livestreamingSegmentId;
            this.lastLivestreamingSegmentStart = livestreamingSegmentStart;
        } else {
            await this.endPreviousLivestreamSubscriptionInQueue();
            // Keep the sender's full range fixed so intersecting live
            // subscriptions participate in chunk leader selection.
            await this.chunks.log.replicate(
                args === "streamer" || args === "all"
                    ? { factor: 1, strict: true }
                    : (args ?? { factor: 1 })
            );
            return;
        }
    }

    async endPreviousLivestreamSubscription() {
        await this.getReplicationQueue().add(() =>
            this.endPreviousLivestreamSubscriptionInQueue()
        );
    }

    private async endPreviousLivestreamSubscriptionInQueue() {
        if (!this.lastLivestreamingSegmentId) {
            return;
        }

        /* console.log(
            "END SEGMENT",
            sha256Base64Sync(this.lastLivestreamingSegmentId)
        ); */

        let segment: { value: ReplicationRangeIndexable<"u64"> } | undefined;
        try {
            segment = (
                await this.chunks.log.replicationIndex
                    .iterate({ query: { id: this.lastLivestreamingSegmentId } })
                    .all()
            )?.[0];
        } catch (error) {
            if (this.chunks.log.closed || isClosedError(error)) {
                // The owning SharedLog has already retired this process-local
                // replication intent. There is no live segment left to shrink,
                // so do not retain impossible cleanup debt across peer stop.
                this.lastLivestreamingSegmentId = undefined;
                this.lastLivestreamingSegmentStart = undefined;
                return;
            }
            throw error;
        }

        if (!segment && this.chunks.log.closed) {
            // Closing can race the lookup without throwing: the retired
            // replication index may simply resolve an empty result. That is
            // equivalent to the closed-error path above; no live intent
            // remains that could be shortened on a retry.
            this.lastLivestreamingSegmentId = undefined;
            this.lastLivestreamingSegmentStart = undefined;
            return;
        }

        if (!segment) {
            throw new Error("Unexpected, missing livestreaming segment");
        }

        let now = hrtimeMicroSeconds();

        /* console.log("END SEGMENT", {
            hash: sha256Base64Sync(this.lastLivestreamingSegmentId),
            now: now,
            lastLivestreamingSegmentStart: this.lastLivestreamingSegmentStart,
            factor: BigInt(now - this.lastLivestreamingSegmentStart!),
        }); */

        try {
            await this.chunks.log.replicate({
                id: segment.value.id,
                offset: segment.value.start1,
                factor: (now - this.lastLivestreamingSegmentStart!) * 1000n, // TODO wthis is wrong potentially if we wrap around u32 and segment.value.start1 is before and now is after
                normalized: false,
                strict: true,
            });
        } catch (error) {
            if (!(this.chunks.log.closed || isClosedError(error))) {
                throw error;
            }
        }

        this.lastLivestreamingSegmentId = undefined;
        this.lastLivestreamingSegmentStart = undefined;
    }

    close() {
        return this.chunks.close();
    }

    abstract get mediaType(): "audio" | "video";
    abstract get description(): string;
}

@variant("audio-stream-db")
export class AudioStreamDB extends TrackSource {
    @field({ type: "u32" })
    sampleRate: number;

    @field({ type: "u8" })
    channels: number;

    constructor(properties: { sampleRate: number; channels?: number }) {
        super();
        this.sampleRate = properties.sampleRate;
        this.channels = properties.channels || 2;
    }

    get mediaType() {
        return "audio" as const;
    }

    get description() {
        return `Audio (Channels: ${this.channels} , Sample rate: ${this.sampleRate})`;
    }
}

const serializeConfig = (config: VideoDecoderConfig) => {
    const toSerialize = {
        ...config,
        ...(config.description
            ? {
                  description: toBase64(
                      new Uint8Array(config.description as ArrayBufferLike)
                  ),
              }
            : {}),
    };
    return JSON.stringify(toSerialize);
};
const parseConfig = (string: string): VideoDecoderConfig => {
    const config = JSON.parse(string);
    if (config.description) {
        config.description = fromBase64(config.description);
    }
    return config;
};

@variant("webscodecs-stream-db")
export class WebcodecsStreamDB extends TrackSource {
    @field({ type: "string" })
    decoderConfigJSON: string;

    constructor(props: { decoderDescription: VideoDecoderConfig }) {
        const decoderDescription = serializeConfig(props.decoderDescription);

        super(); // Streams addresses will depend on its config
        this.decoderConfigJSON = decoderDescription;
    }

    private _decoderDescriptionObject: any;
    get decoderDescription(): VideoDecoderConfig | undefined {
        if (!this.decoderConfigJSON) {
            return undefined;
        }
        return (
            this._decoderDescriptionObject ||
            (this._decoderDescriptionObject = parseConfig(
                this.decoderConfigJSON
            ))
        );
    }

    get mediaType() {
        return "video" as const;
    }

    get description() {
        return `Video (${this.decoderConfigJSON})`;
    }
}

@variant("track")
export class Track<
    T extends TrackSource = AudioStreamDB | WebcodecsStreamDB,
> extends Program<never> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: TrackSource })
    source: T; /// audio, video, whatever

    @field({ type: "u64" })
    private _startTime: bigint;

    @field({ type: option("u64") })
    private _endTime?: bigint; // when the track ended

    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: "bool" })
    private effects: false; // TODO effects, like transformation, scaling, filter, etc

    private _now?: () => bigint | number;
    private _globalTime?: bigint | number;

    constructor(properties: {
        id?: Uint8Array;
        sender: PublicSignKey;
        now?: () => bigint | number;
        globalTime?: bigint | number;
        start?: number | bigint;
        end?: number | bigint;
        source: T;
    }) {
        super();
        this.id = properties.id ?? randomBytes(32);
        this._now = properties.now;
        this._globalTime = properties.globalTime;
        this._startTime =
            properties.start != null
                ? typeof properties.start === "number"
                    ? BigInt(properties.start)
                    : properties.start
                : this.timeSinceStart();
        this._endTime =
            typeof properties.end === "number"
                ? BigInt(properties.end)
                : properties.end;
        this.source = properties.source;
        this.sender = properties.sender;
        this.effects = false;
    }

    private timeSinceStart() {
        if (this._now == null) {
            throw new Error("Can not set end time without start time");
        }
        if (this._globalTime == null) {
            throw new Error("Can not set end time without global time");
        }
        let now = this._now();
        let nowBigint = typeof now === "number" ? BigInt(Math.round(now)) : now;
        let globalTime =
            typeof this._globalTime === "number"
                ? BigInt(Math.round(this._globalTime))
                : this._globalTime;
        return nowBigint - globalTime;
    }

    setEnd(time?: bigint | number) {
        this._endTime = time != null ? BigInt(time) : this.timeSinceStart();
        this.source.endTime = this._endTime;
    }

    async open(args?: Args): Promise<void> {
        await this.source.open({
            ...args,
            sender: this.sender,
            startTime: this._startTime,
            endTime: this._endTime,
        });
        if (this.node.identity.publicKey.equals(this.sender)) {
            await this.source.replicate("streamer");
        }
    }

    get endTime(): number | undefined {
        return this._endTime == null ? undefined : Number(this._endTime);
    }

    get endTimeBigInt() {
        return this._endTime;
    }

    get duration() {
        if (this._endTime == null) {
            return "live";
        }
        return Number(this._endTime - this._startTime);
    }

    get startTime() {
        return Number(this._startTime);
    }

    get startTimeBigInt() {
        return this._startTime;
    }

    toString() {
        return `Track { time: ${this._startTime} - ${this._endTime}, description: (${this.source.description}) }`;
    }

    private _previousWallTime: bigint | undefined = undefined;
    private _previousLogical: number | undefined = undefined;
    async put(
        chunk: Chunk,
        options?: { target?: "all" | "replicators" | "none" }
    ) {
        const wallTime = (this._startTime + chunk.timeBN) * 1000n;
        let logical: number | undefined = undefined;
        if (wallTime === this._previousWallTime) {
            if (this._previousLogical == null) {
                this._previousLogical = 0;
            }
            this._previousLogical++;
            logical = this._previousLogical;
        } else {
            this._previousWallTime = wallTime;
            this._previousLogical = undefined;
        }
        await this.source.chunks.put(chunk, {
            target: options?.target,
            meta: {
                timestamp: new Timestamp({
                    wallTime,
                    logical,
                }),
                next: [],
            },
            unique: true,
        });
    }

    private _idString: string | undefined = undefined;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}

@variant("media_track_indexable")
class TrackIndexable {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    sender: string;

    @field({ type: "u64" })
    startTime: bigint;

    @field({ type: option("u64") })
    endTime: bigint | undefined;

    @field({ type: "u32" })
    duration: number;

    constructor(track: Track) {
        this.id = track.id;
        this.startTime = track.startTimeBigInt;
        this.endTime = track.endTimeBigInt;
        this.sender = track.sender.hashcode();
        this.duration = track.duration === "live" ? 0 : track.duration;
    }
}

export type TracksIterator = {
    time: () => number | "live";
    options: () => Track<WebcodecsStreamDB | AudioStreamDB>[];
    current: Map<string, TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>>;
    selectOption: (
        track: Track<WebcodecsStreamDB | AudioStreamDB>
    ) => Promise<void>;
    close: () => Promise<void>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    paused: boolean;
    isLagging: boolean;
};

type TrackWithBuffer<T extends TrackSource> = {
    track: Track<T>;
    iterator?: ResultsIterator<Chunk>;
    last?: number;
    close?: () => void | boolean | Promise<void | boolean>;
    open?: () => void | Promise<void>;
    closing?: boolean;
    chunks: Chunk[];
};

export type TrackChangeProcessor<
    T extends TrackSource = WebcodecsStreamDB | AudioStreamDB,
> = (
    properties: {
        force?: boolean;
        add?: Track<T>;
        remove?: Track<T>;
        current: Map<string, { track: Track<T> }>;
        options: Track<T>[];
    },
    progress: "live" | number,
    preloadTime: number
) => { add?: Track<T> | { track: Track<T>; when?: number }; remove?: Track<T> };

export const oneVideoAndOneAudioChangeProcessor: TrackChangeProcessor = (
    change,
    progress: "live" | number,
    preloadTime: number
) => {
    if (change.add) {
        let alreadyHave: Track | undefined = undefined;
        for (const [_id, track] of change.current) {
            if (
                track.track.source.constructor ===
                change.add!.source.constructor
            ) {
                alreadyHave = track.track;
                break;
            }
        }

        if (alreadyHave?.idString === change.add.idString) {
            return {
                add: undefined,
                remove: change.remove,
            };
        }

        if (change.force) {
            // replace
            return {
                remove: alreadyHave,
                add: change.add ? { track: change.add } : undefined,
            };
        } else {
            // TODO
            // this conditioin ensures that if we already have a stream but it has an endtime but the new stream does not, we switch
            // but we should not have to have this statement since if an enditme is set before now we should automatically end that track and poll for new tracks?
            if (alreadyHave) {
                if (alreadyHave.endTime == null) {
                    return {};
                }

                if (alreadyHave.endTime !== null) {
                    if (progress === "live") {
                        if (change.add.endTime == null) {
                            return {
                                remove: alreadyHave,
                                add: { track: change.add },
                            }; // always favor live streams
                        }
                    } else {
                        if (progress > alreadyHave.endTime) {
                            // we should definitely end the old track
                            return {
                                remove: alreadyHave,
                                add: { track: change.add },
                            };
                        }

                        // add new track early since we will start to play it soon
                        // but only if the end time is undefined or it is later than the current track
                        if (
                            change.add.startTime - preloadTime < progress &&
                            (change.add.endTime == null ||
                                change.add.endTime > alreadyHave.endTime)
                        ) {
                            let when =
                                alreadyHave?.endTime != null &&
                                alreadyHave?.endTime > change.add.startTime
                                    ? alreadyHave.endTime
                                    : undefined;
                            return {
                                add:
                                    when != null
                                        ? { track: change.add, when }
                                        : change.add,
                            };
                        }
                    }
                    return {};
                }

                if (
                    change.add.endTime != null &&
                    change.add.endTime <= alreadyHave.endTime
                ) {
                    return {}; // old track is to be added, but we don't want to add it so we return nothing
                }
            }
            return change;
        }
    }

    if (change.remove) {
        // if removing one track, maybe start another
        if (change.force) {
            return change;
        } else {
            const replaceWith = change.options.find(
                (x) =>
                    x.source.constructor === change.remove!.source.constructor
            );
            if (replaceWith) {
                return {
                    add: replaceWith,
                    remove: change.remove,
                };
            }
            return change;
        }
    }

    return change;
};

type MaxTimeEvent = { maxTime: number };
type ReplicationRangeEvent = { hash: string; track: Track };
type MediaTrackLease = {
    track: Track<WebcodecsStreamDB | AudioStreamDB>;
    references: number;
    owned: boolean;
    keepOpen: boolean;
    liveReferences: number;
    liveReplicationStarted: boolean;
    liveQueue: PQueue;
    trackQueue: PQueue;
};

type MediaTrackLeaseHandle = {
    track: Track<WebcodecsStreamDB | AudioStreamDB>;
    acquireLivestream: (options?: { signal?: AbortSignal }) => Promise<void>;
    release: () => Promise<void>;
};

type DefaultReplicationLease = {
    handle: MediaTrackLeaseHandle;
    replicated: boolean;
};

export interface MediaStreamDBEvents extends ProgramEvents {
    maxTime: CustomEvent<MaxTimeEvent>;
    replicationChange: CustomEvent<ReplicationRangeEvent>;
}

@variant("media-streams")
export class MediaStreamDB extends Program<{}, MediaStreamDBEvents> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    @field({ type: Documents })
    tracks: Documents<Track<AudioStreamDB | WebcodecsStreamDB>, TrackIndexable>;

    maxTime: number | undefined = undefined;
    private maxTimeSubscriptionCount = 0;
    private trackLeases: Map<string, MediaTrackLease> = new Map();
    private trackLeaseQueues: Map<string, PQueue> = new Map();
    private activeMediaConsumers = new Set<() => Promise<void>>();
    private defaultReplicationLeases: Map<string, DefaultReplicationLease> =
        new Map();
    private defaultReplicationLeaseQueue = new PQueue({ concurrency: 1 });
    private defaultReplicationClosing = false;
    private mediaResourcesClosing = false;
    private mediaResourcesClosePromise: Promise<void> | undefined;
    private replicationInfoSubscription:
        | {
              references: number;
              ready: Promise<void>;
              stop: () => Promise<void>;
              subscribe: (
                  callback: (change: ReplicationRangeEvent) => void
              ) => () => void;
          }
        | undefined;
    private openedTracks: Map<
        string,
        Track<WebcodecsStreamDB | AudioStreamDB>
    > = new Map();

    constructor(owner: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super();
        this.id = randomBytes(32);
        this.owner = owner;
        this.tracks = new Documents({
            id: sha256Sync(
                concat([
                    new TextEncoder().encode("media-streams"),
                    this.id,
                    sha256Sync(this.owner.bytes),
                ])
            ),
        });
    }

    private _trackChangeListener: (
        change: CustomEvent<
            DocumentsChange<
                Track<AudioStreamDB | WebcodecsStreamDB>,
                TrackIndexable
            >
        >
    ) => void;

    private replicateTracksByDefault: boolean = false;

    private assertMediaResourceAdmissionOpen() {
        if (this.mediaResourcesClosing || this.closed) {
            throw new ClosedError(
                "Media stream is closing and can not admit new consumers"
            );
        }
    }

    private isNonFinalParentRelease(from?: Program) {
        const parentIndex = this.parents?.findIndex(
            (parent) => parent === from
        );
        return (
            parentIndex != null &&
            parentIndex >= 0 &&
            (this.parents?.length ?? 0) > 1
        );
    }

    async open(args?: { replicate?: "all" | "owned" | false }): Promise<void> {
        this.openedTracks = new Map();
        // Program clones are deserialized without running field initializers.
        // Recreate process-local ownership and lifecycle state on every open.
        this.maxTimeSubscriptionCount = 0;
        this.trackLeases = new Map();
        this.trackLeaseQueues = new Map();
        this.activeMediaConsumers = new Set();
        this.defaultReplicationLeases = new Map();
        this.defaultReplicationLeaseQueue = new PQueue({ concurrency: 1 });
        this.defaultReplicationClosing = false;
        this.mediaResourcesClosing = false;
        this.mediaResourcesClosePromise = undefined;
        this.replicationInfoSubscription = undefined;
        this.replicateTracksByDefault = false;
        if (args?.replicate) {
            this.replicateTracksByDefault =
                args?.replicate === "all"
                    ? true
                    : this.owner.equals(this.node.identity.publicKey);
        }

        await this.tracks.open({
            type: Track,
            canPerform: async (props) => {
                const keys = await props.entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(this.owner)) {
                        return true;
                    }
                }
                return false;
            },
            canOpen: (_) => Promise.resolve(false),
            replicate: {
                factor: 1,
            },
            index: {
                type: TrackIndexable,
            },
        });
    }

    async afterOpen(): Promise<void> {
        await super.afterOpen();
        if (this.replicateTracksByDefault) {
            this._trackChangeListener = (ev) => {
                void (async () => {
                    for (const added of ev.detail.added) {
                        await this.ensureDefaultTrackReplication(added);
                    }

                    for (const removed of ev.detail.removed) {
                        await this.releaseDefaultTrackReplication(
                            removed.idString
                        );
                    }
                })().catch((error) => {
                    if (
                        !this.defaultReplicationClosing &&
                        !isClosedError(error)
                    ) {
                        console.error(
                            "Failed to update default media replication",
                            error
                        );
                    }
                });
            };

            this.tracks.events.addEventListener(
                "change",
                this._trackChangeListener
            );

            // open all local tracks
            for (const track of await this.tracks.index
                .iterate({}, { local: true, remote: false })
                .all()) {
                await this.ensureDefaultTrackReplication(track);
            }
        }
    }

    async getLatest(
        options?: SearchOptions<
            Track<AudioStreamDB | WebcodecsStreamDB>,
            any,
            any,
            any
        >
    ): Promise<
        WithIndexedContext<
            Track<AudioStreamDB | WebcodecsStreamDB>,
            TrackIndexable
        >[]
    > {
        const tracks = await this.tracks.index.search(
            new SearchRequest({
                query: [
                    new IsNull({
                        key: "endTime",
                    }),
                ],
                sort: [
                    new Sort({
                        key: "startTime",
                        direction: SortDirection.DESC,
                    }),
                ],
            }),
            {
                ...options,
                remote: {
                    reach: { eager: true },
                    ...(typeof options?.remote === "object"
                        ? options?.remote
                        : {}),
                },
            }
        );

        return tracks;
    }

    private _idString: string | undefined = undefined;

    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }

    private addToOpenTrack(track: Track<any>) {
        const existing = this.openedTracks.get(track.address);
        if (!existing || existing.closed) {
            this.openedTracks.set(track.address, track);
        }
    }

    private removeTrackChild(track: Track<any>) {
        const childIndex = this.children?.indexOf(track) ?? -1;
        if (childIndex >= 0) {
            this.children.splice(childIndex, 1);
        }
    }

    private async releaseTrackParent(track: Track<any>) {
        if (track.parents?.includes(this)) {
            await track.close(this);
        }
        this.removeTrackChild(track);
    }

    private getTrackLeaseQueue(trackId: string) {
        let queue = this.trackLeaseQueues.get(trackId);
        if (!queue) {
            queue = new PQueue({ concurrency: 1 });
            this.trackLeaseQueues.set(trackId, queue);
        }
        return queue;
    }

    private retireTrackLeaseQueue(trackId: string, queue: PQueue) {
        void queue
            .onIdle()
            .then(() => {
                if (
                    this.trackLeaseQueues.get(trackId) === queue &&
                    !this.trackLeases.has(trackId)
                ) {
                    this.trackLeaseQueues.delete(trackId);
                }
            })
            .catch(() => {});
    }

    private async waitForTrackLeaseQueues() {
        while (true) {
            const snapshot = [...this.trackLeaseQueues.entries()];
            await Promise.all(snapshot.map(([, queue]) => queue.onIdle()));
            const current = [...this.trackLeaseQueues.entries()];
            if (
                current.every(
                    ([trackId, queue]) =>
                        snapshot.some(
                            ([candidateId, candidateQueue]) =>
                                candidateId === trackId &&
                                candidateQueue === queue
                        ) &&
                        queue.pending === 0 &&
                        queue.size === 0
                )
            ) {
                return;
            }
        }
    }

    private async acquireTrackLease(
        track: Track<WebcodecsStreamDB | AudioStreamDB>,
        keepOpen = false
    ): Promise<MediaTrackLeaseHandle> {
        const trackId = track.idString;
        const trackQueue = this.getTrackLeaseQueue(trackId);
        let lease: MediaTrackLease | undefined;
        try {
            const acquired = await trackQueue.add(async () => {
                // Admission may have queued before a final close/drop fenced the
                // stream. Check inside the serialized section so that queued work
                // can not reopen a track behind the teardown barrier.
                this.assertMediaResourceAdmissionOpen();
                let current = this.trackLeases.get(trackId);
                if (current && !current.track.closed) {
                    current.references++;
                    current.keepOpen ||= keepOpen;
                    return current;
                }
                if (current) {
                    this.trackLeases.delete(trackId);
                    if (
                        this.openedTracks.get(current.track.address) ===
                        current.track
                    ) {
                        this.openedTracks.delete(current.track.address);
                    }
                }

                const openTrack = await this.node.open(track, {
                    existing: "reuse",
                    parent: this as any,
                    args: {
                        sender: this.owner,
                        startTime: track.startTimeBigInt,
                    },
                });
                const owned = openTrack.parents?.includes(this) === true;
                if (owned) {
                    this.addToOpenTrack(openTrack);
                }
                current = {
                    track: openTrack,
                    references: 1,
                    owned,
                    keepOpen,
                    liveReferences: 0,
                    liveReplicationStarted: false,
                    liveQueue: new PQueue({ concurrency: 1 }),
                    trackQueue,
                };
                this.trackLeases.set(trackId, current);
                return current;
            });
            if (acquired) {
                lease = acquired;
            }
        } catch (error) {
            this.retireTrackLeaseQueue(trackId, trackQueue);
            throw error;
        }
        if (!lease) {
            throw new Error("Media track lease acquisition was cleared");
        }

        let referenceReleased = false;
        let liveReferenceAcquired = false;
        let liveReferenceReleased = false;
        const acquireLivestream = async (options?: {
            signal?: AbortSignal;
        }) => {
            await lease.liveQueue.add(async () => {
                let shouldStart = false;
                await lease.trackQueue.add(() => {
                    if (
                        this.trackLeases.get(trackId) !== lease ||
                        referenceReleased
                    ) {
                        throw new ClosedError(
                            "Media track lease has already been released"
                        );
                    }
                    if (liveReferenceAcquired && !liveReferenceReleased) {
                        return;
                    }
                    if (liveReferenceReleased) {
                        throw new ClosedError(
                            "Media track livestream lease has already been released"
                        );
                    }
                    shouldStart =
                        lease.liveReferences === 0 &&
                        !lease.liveReplicationStarted;
                    lease.liveReferences++;
                    liveReferenceAcquired = true;
                });
                if (!shouldStart) {
                    return;
                }
                try {
                    await lease.track.source.replicate("live", options);
                    await lease.trackQueue.add(() => {
                        if (this.trackLeases.get(trackId) !== lease) {
                            throw new ClosedError(
                                "Media track lease was retired during live startup"
                            );
                        }
                        lease.liveReplicationStarted = true;
                    });
                } catch (error) {
                    await lease.trackQueue.add(() => {
                        if (
                            this.trackLeases.get(trackId) === lease &&
                            liveReferenceAcquired &&
                            !liveReferenceReleased
                        ) {
                            lease.liveReferences = Math.max(
                                0,
                                lease.liveReferences - 1
                            );
                            liveReferenceAcquired = false;
                        }
                    });
                    throw error;
                }
            });
        };
        const release = async () => {
            try {
                await lease.liveQueue.add(async () => {
                    let shouldEnd = false;
                    const retained = await lease.trackQueue.add(() => {
                        if (this.trackLeases.get(trackId) !== lease) {
                            return false;
                        }
                        if (!referenceReleased) {
                            lease.references = Math.max(
                                0,
                                lease.references - 1
                            );
                            referenceReleased = true;
                        }
                        if (liveReferenceAcquired && !liveReferenceReleased) {
                            lease.liveReferences = Math.max(
                                0,
                                lease.liveReferences - 1
                            );
                            liveReferenceReleased = true;
                        }
                        shouldEnd =
                            lease.liveReferences === 0 &&
                            lease.liveReplicationStarted;
                        return true;
                    });
                    if (!retained) {
                        return;
                    }
                    if (shouldEnd) {
                        await lease.track.source.endPreviousLivestreamSubscription();
                        await lease.trackQueue.add(() => {
                            if (
                                this.trackLeases.get(trackId) === lease &&
                                lease.liveReferences === 0
                            ) {
                                lease.liveReplicationStarted = false;
                            }
                        });
                    }
                    await lease.trackQueue.add(async () => {
                        if (
                            this.trackLeases.get(trackId) !== lease ||
                            lease.references !== 0
                        ) {
                            return;
                        }
                        if (lease.keepOpen && lease.owned) {
                            return;
                        }
                        if (lease.owned) {
                            // Delete ownership only after close succeeds so callers can
                            // retry a failed nested cleanup without losing the handle.
                            await this.releaseTrackParent(lease.track);
                        }
                        this.trackLeases.delete(trackId);
                        if (
                            this.openedTracks.get(lease.track.address) ===
                            lease.track
                        ) {
                            this.openedTracks.delete(lease.track.address);
                        }
                    });
                });
            } finally {
                this.retireTrackLeaseQueue(trackId, lease.trackQueue);
            }
        };

        return { track: lease.track, acquireLivestream, release };
    }

    private async ensureDefaultTrackReplication(
        track: Track<WebcodecsStreamDB | AudioStreamDB>
    ) {
        const trackId = track.idString;
        const openTrack = await this.defaultReplicationLeaseQueue.add(
            async () => {
                if (this.defaultReplicationClosing) {
                    return undefined;
                }
                let current = this.defaultReplicationLeases.get(trackId);
                if (current?.handle.track.closed) {
                    await current.handle.release();
                    this.defaultReplicationLeases.delete(trackId);
                    current = undefined;
                }
                if (!current) {
                    current = {
                        handle: await this.acquireTrackLease(track),
                        replicated: false,
                    };
                    this.defaultReplicationLeases.set(trackId, current);
                }
                if (!current.replicated) {
                    try {
                        await current.handle.track.source.replicate("all");
                        current.replicated = true;
                    } catch (error) {
                        try {
                            await current.handle.release();
                            if (
                                this.defaultReplicationLeases.get(trackId) ===
                                current
                            ) {
                                this.defaultReplicationLeases.delete(trackId);
                            }
                        } catch (cleanupError) {
                            throw new AggregateError(
                                [error, cleanupError],
                                "Failed to start and release default media replication"
                            );
                        }
                        throw error;
                    }
                }
                return current.handle.track;
            }
        );
        if (!openTrack && !this.defaultReplicationClosing) {
            throw new Error("Default media replication was cleared");
        }
        return openTrack;
    }

    private async releaseDefaultTrackReplication(trackId: string) {
        await this.defaultReplicationLeaseQueue.add(async () => {
            const current = this.defaultReplicationLeases.get(trackId);
            if (!current) {
                return;
            }
            await current.handle.release();
            if (this.defaultReplicationLeases.get(trackId) === current) {
                this.defaultReplicationLeases.delete(trackId);
            }
        });
    }

    private async closeDefaultTrackReplications() {
        // Fence future change events before queueing the teardown. The queued
        // barrier runs after any admission already in progress, so it also
        // releases leases created immediately before close.
        this.defaultReplicationClosing = true;
        const failures = await this.defaultReplicationLeaseQueue.add(
            async () => {
                const releaseFailures: unknown[] = [];
                for (const [trackId, current] of [
                    ...this.defaultReplicationLeases.entries(),
                ]) {
                    try {
                        await current.handle.release();
                        if (
                            this.defaultReplicationLeases.get(trackId) ===
                            current
                        ) {
                            this.defaultReplicationLeases.delete(trackId);
                        }
                    } catch (error) {
                        releaseFailures.push(error);
                    }
                }
                return releaseFailures;
            }
        );
        await this.defaultReplicationLeaseQueue.onIdle();
        throwCleanupFailures(
            failures ?? [new Error("Default replication cleanup was cleared")],
            "Failed to close default media replication tracks"
        );
    }

    maybeUpdateMaxTime(
        maybeNewMaxTime?: number,
        onChange?: (maybeNewMaxtime: number) => void
    ) {
        if (
            maybeNewMaxTime != null &&
            (this.maxTime == null || maybeNewMaxTime > this.maxTime)
        ) {
            this.maxTime = maybeNewMaxTime;
            onChange?.(this.maxTime);
            this.events.dispatchEvent(
                new CustomEvent<MaxTimeEvent>("maxTime", {
                    detail: { maxTime: this.maxTime },
                })
            );
        }
    }

    listenForMaxTimeChanges(keepTracksOpen: boolean | undefined) {
        this.assertMediaResourceAdmissionOpen();
        this.maxTimeSubscriptionCount++;
        const scanController = new AbortController();
        let scanPromise: Promise<void> | undefined;
        let scanPending = false;
        let stopped = false;
        let finalized = false;
        let stopPromise: Promise<void> | undefined;
        const trackSubscriptions = new Map<
            string,
            {
                track: Track<WebcodecsStreamDB | AudioStreamDB>;
                refresh: () => Promise<void>;
                cleanup: () => Promise<void>;
            }
        >();

        const scan = async () => {
            if (stopped || this.tracks.closed) {
                return;
            }
            try {
                const notClosed: Track[] = await this.tracks.index.search(
                    new SearchRequest({
                        query: [
                            new IsNull({
                                key: "endTime",
                            }),
                        ],
                    }),
                    {
                        local: true,
                        remote: {
                            reach: { eager: true },
                        },
                        signal: scanController.signal,
                    }
                );
                const seenTrackIds = new Set<string>();
                if (notClosed.length > 0) {
                    for (const track of notClosed) {
                        if (stopped) {
                            return;
                        }
                        const trackId = track.idString;
                        seenTrackIds.add(trackId);
                        let subscription = trackSubscriptions.get(trackId);
                        if (!subscription || subscription.track.closed) {
                            if (subscription) {
                                await subscription.cleanup();
                                trackSubscriptions.delete(trackId);
                            }
                            const lease = await this.acquireTrackLease(
                                track,
                                keepTracksOpen === true
                            );
                            if (stopped) {
                                await lease.release();
                                return;
                            }
                            const openTrack = lease.track;
                            const refresh = async () => {
                                const last = await openTrack.source.last({
                                    signal: scanController.signal,
                                });
                                if (!stopped) {
                                    this.maybeUpdateMaxTime(
                                        openTrack.startTime + (last?.time ?? 0)
                                    );
                                }
                            };
                            const joinListener = () => {
                                void refresh().catch((error) => {
                                    if (!stopped && !isClosedError(error)) {
                                        console.error(
                                            "Failed to refresh media max time",
                                            error
                                        );
                                    }
                                });
                            };
                            const changeListener = (props: {
                                detail: { added: Chunk[] };
                            }) => {
                                if (stopped || !props.detail.added) {
                                    return;
                                }
                                for (const chunk of props.detail.added) {
                                    this.maybeUpdateMaxTime(
                                        openTrack.startTime + chunk.time
                                    );
                                }
                            };
                            openTrack.source.chunks.log.events.addEventListener(
                                "replicator:join",
                                joinListener
                            );
                            openTrack.source.chunks.events.addEventListener(
                                "change",
                                changeListener
                            );
                            let listenersRemoved = false;
                            const cleanup = async () => {
                                if (!listenersRemoved) {
                                    listenersRemoved = true;
                                    openTrack.source.chunks.log.events.removeEventListener(
                                        "replicator:join",
                                        joinListener
                                    );
                                    openTrack.source.chunks.events.removeEventListener(
                                        "change",
                                        changeListener
                                    );
                                }
                                await lease.release();
                            };
                            subscription = {
                                track: openTrack,
                                refresh,
                                cleanup,
                            };
                            trackSubscriptions.set(trackId, subscription);
                        }
                        await subscription.refresh();
                    }
                } else {
                    // check closed
                    const latestClosed = (
                        await this.tracks.index.search(
                            new SearchRequest({
                                sort: [
                                    new Sort({
                                        direction: SortDirection.DESC,
                                        key: "endTime",
                                    }),
                                ],
                                fetch: 1,
                            }),
                            {
                                local: true,
                                remote: {
                                    reach: { eager: true },
                                },
                                signal: scanController.signal,
                            }
                        )
                    )[0];

                    if (latestClosed?.endTime != null) {
                        this.maybeUpdateMaxTime(latestClosed.endTime);
                    }
                }

                for (const [trackId, subscription] of trackSubscriptions) {
                    if (!seenTrackIds.has(trackId)) {
                        await subscription.cleanup();
                        trackSubscriptions.delete(trackId);
                    }
                }
            } catch (error) {
                if (
                    stopped ||
                    scanController.signal.aborted ||
                    isClosedError(error)
                ) {
                    // ignore
                    return;
                }
                throw error;
            }
        };

        const reportScanFailure = (error: unknown) => {
            if (!stopped && !isClosedError(error)) {
                console.error("Failed to scan media max time", error);
            }
        };
        const requestScan = (): Promise<void> => {
            if (stopped) {
                return Promise.resolve();
            }
            // Bursty document/replicator events need at most one follow-up
            // scan. A boolean pending edge prevents an unbounded queue of
            // identical full-index reads.
            scanPending = true;
            if (!scanPromise) {
                const running = (async () => {
                    while (scanPending && !stopped) {
                        scanPending = false;
                        await scan();
                    }
                })();
                const tracked = running.finally(() => {
                    if (scanPromise === tracked) {
                        scanPromise = undefined;
                        if (scanPending && !stopped) {
                            void requestScan().catch(reportScanFailure);
                        }
                    }
                });
                scanPromise = tracked;
            }
            return scanPromise;
        };
        const joinListener = () => {
            void requestScan().catch(reportScanFailure);
        };
        this.tracks.log.events.addEventListener(
            "replicator:join",
            joinListener
        );

        this.tracks.events.addEventListener("change", joinListener);
        const stop = () => {
            if (!stopPromise) {
                stopPromise = (async () => {
                    stopped = true;
                    scanPending = false;
                    scanController.abort("Stopped");
                    this.tracks.log.events.removeEventListener(
                        "replicator:join",
                        joinListener
                    );
                    this.tracks.events.removeEventListener(
                        "change",
                        joinListener
                    );
                    // The scan error is already exposed through `ready` (or
                    // logged by the refresh listener). Teardown must still
                    // progress past that settled failure so it can release the
                    // exact listeners and leases retained by the monitor.
                    await scanPromise?.catch(() => {});
                    const subscriptions = [...trackSubscriptions.entries()];
                    const results = await Promise.allSettled(
                        subscriptions.map(([, value]) => value.cleanup())
                    );
                    const failures: unknown[] = [];
                    results.forEach((result, index) => {
                        if (result.status === "fulfilled") {
                            trackSubscriptions.delete(subscriptions[index][0]);
                        } else {
                            failures.push(result.reason);
                        }
                    });
                    throwCleanupFailures(
                        failures,
                        "Failed to stop max-time track subscriptions"
                    );
                    if (!finalized) {
                        finalized = true;
                        this.maxTimeSubscriptionCount = Math.max(
                            0,
                            this.maxTimeSubscriptionCount - 1
                        );
                        if (this.maxTimeSubscriptionCount === 0) {
                            this.maxTime = undefined;
                        }
                    }
                    this.activeMediaConsumers.delete(stop);
                })().catch((error) => {
                    stopPromise = undefined;
                    this.activeMediaConsumers.add(stop);
                    throw error;
                });
            }
            return stopPromise;
        };
        this.activeMediaConsumers.add(stop);
        const ready = requestScan().catch(async (error) => {
            try {
                await stop();
            } catch {
                // Preserve the startup error; retained cleanup is retried by
                // stop() or MediaStreamDB.close().
            }
            throw error;
        });
        void ready.catch(() => {});
        return { stop, ready };
    }

    private startReplicationInfoSubscription() {
        let stopped = false;
        let stopPromise: Promise<void> | undefined;
        const scanController = new AbortController();
        const subscribers = new Map<
            (change: ReplicationRangeEvent) => void,
            { delivered: Set<string>; references: number }
        >();
        const snapshot = new Map<string, ReplicationRangeEvent>();
        const changeKey = (change: ReplicationRangeEvent) =>
            `${change.track.idString}:${change.hash}`;
        const notifySubscriber = (
            callback: (change: ReplicationRangeEvent) => void,
            change: ReplicationRangeEvent
        ) => {
            try {
                const result = callback(change) as unknown;
                if (result instanceof Promise) {
                    void result.catch((error) =>
                        console.error(
                            "Failed to handle media replication change",
                            error
                        )
                    );
                }
            } catch (error) {
                console.error(
                    "Failed to handle media replication change",
                    error
                );
            }
        };
        const dispatchReplicationChangeEvent = (change: {
            hash: string;
            track: Track;
        }) => {
            if (stopped) {
                return;
            }
            const key = changeKey(change);
            snapshot.set(key, change);
            for (const [callback, subscriber] of subscribers) {
                subscriber.delivered.add(key);
                notifySubscriber(callback, change);
            }
            this.events.dispatchEvent(
                new CustomEvent<ReplicationRangeEvent>("replicationChange", {
                    detail: change,
                })
            );
        };

        const createReplicationChangeListener =
            (track: Track) =>
            (ev: { detail: { publicKey: PublicSignKey | string } }) => {
                dispatchReplicationChangeEvent({
                    hash:
                        ev.detail.publicKey instanceof PublicSignKey
                            ? ev.detail.publicKey.hashcode()
                            : ev.detail.publicKey,
                    track,
                });
            };

        const trackSubscriptions = new Map<
            string,
            {
                track: Track<WebcodecsStreamDB | AudioStreamDB>;
                cleanup: () => Promise<void>;
            }
        >();
        let scanPromise: Promise<void> | undefined;
        let scanPending = false;
        const scanLocalTracks = async () => {
            if (stopped) {
                return;
            }
            let allTracks: Track[];
            try {
                allTracks = await this.tracks.index
                    .iterate(
                        {},
                        {
                            local: true,
                            remote: false,
                            signal: scanController.signal,
                        }
                    )
                    .all();
            } catch (error) {
                if (
                    stopped ||
                    scanController.signal.aborted ||
                    isClosedError(error)
                ) {
                    return;
                }
                throw error;
            }
            if (stopped) {
                return;
            }
            const seenTrackIds = new Set<string>();
            for (const track of allTracks) {
                if (stopped) {
                    return;
                }
                const trackId = track.idString;
                seenTrackIds.add(trackId);
                let subscription = trackSubscriptions.get(trackId);
                if (subscription && !subscription.track.closed) {
                    continue;
                }
                if (subscription) {
                    await subscription.cleanup();
                    trackSubscriptions.delete(trackId);
                }
                const lease = await this.acquireTrackLease(track);
                if (stopped) {
                    await lease.release();
                    return;
                }
                const openTrack = lease.track;
                const replicationInfoListener =
                    createReplicationChangeListener(openTrack);
                openTrack.source.chunks.log.events.addEventListener(
                    "replication:change",
                    replicationInfoListener
                );
                let listenerRemoved = false;
                const cleanup = async () => {
                    if (!listenerRemoved) {
                        listenerRemoved = true;
                        openTrack.source.chunks.log.events.removeEventListener(
                            "replication:change",
                            replicationInfoListener
                        );
                    }
                    await lease.release();
                };
                subscription = { track: openTrack, cleanup };
                trackSubscriptions.set(trackId, subscription);
                try {
                    const replicationInfo: IndexedResults<
                        ReplicationRangeIndexable<"u64">
                    > = await openTrack.source.chunks.log.replicationIndex
                        .iterate()
                        .all();
                    for (const info of replicationInfo) {
                        replicationInfoListener({
                            detail: { publicKey: info.value.hash },
                        });
                    }
                } catch (error) {
                    try {
                        await cleanup();
                        trackSubscriptions.delete(trackId);
                    } catch (cleanupError) {
                        throw new AggregateError(
                            [error, cleanupError],
                            "Failed to read and release media replication information"
                        );
                    }
                    throw error;
                }
            }

            for (const [trackId, subscription] of trackSubscriptions) {
                if (!seenTrackIds.has(trackId)) {
                    await subscription.cleanup();
                    trackSubscriptions.delete(trackId);
                    for (const [key, change] of snapshot) {
                        if (change.track.idString === trackId) {
                            snapshot.delete(key);
                        }
                    }
                }
            }
        };
        const reportScanFailure = (error: unknown) => {
            if (!stopped && !isClosedError(error)) {
                console.error(
                    "Failed to refresh media replication information",
                    error
                );
            }
        };
        const requestScan = (): Promise<void> => {
            if (stopped) {
                return Promise.resolve();
            }
            scanPending = true;
            if (!scanPromise) {
                const running = (async () => {
                    while (scanPending && !stopped) {
                        scanPending = false;
                        await scanLocalTracks();
                    }
                })();
                const tracked = running.finally(() => {
                    if (scanPromise === tracked) {
                        scanPromise = undefined;
                        if (scanPending && !stopped) {
                            void requestScan().catch(reportScanFailure);
                        }
                    }
                });
                scanPromise = tracked;
            }
            return scanPromise;
        };
        const localTrackListener = () => {
            void requestScan().catch(reportScanFailure);
        };
        this.tracks.events.addEventListener("change", localTrackListener);
        this.tracks.log.events.addEventListener(
            "replicator:join",
            localTrackListener
        );

        const stop = () => {
            if (!stopPromise) {
                stopPromise = (async () => {
                    stopped = true;
                    scanPending = false;
                    scanController.abort("Stopped");
                    this.tracks.events.removeEventListener(
                        "change",
                        localTrackListener
                    );
                    this.tracks.log.events.removeEventListener(
                        "replicator:join",
                        localTrackListener
                    );
                    // A failed initial/background scan must not permanently
                    // poison the cleanup path. Its error has already reached
                    // `ready` or the event listener; retain cleanup failures,
                    // not the stale scan rejection, for exact retries.
                    await scanPromise?.catch(() => {});
                    const subscriptions = [...trackSubscriptions.entries()];
                    const results = await Promise.allSettled(
                        subscriptions.map(([, value]) => value.cleanup())
                    );
                    const failures: unknown[] = [];
                    results.forEach((result, index) => {
                        if (result.status === "fulfilled") {
                            trackSubscriptions.delete(subscriptions[index][0]);
                        } else {
                            failures.push(result.reason);
                        }
                    });
                    throwCleanupFailures(
                        failures,
                        "Failed to stop replication-info subscriptions"
                    );
                    subscribers.clear();
                    snapshot.clear();
                })().catch((error) => {
                    stopPromise = undefined;
                    throw error;
                });
            }
            return stopPromise;
        };
        const ready = requestScan();
        const subscribe = (
            callback: (change: ReplicationRangeEvent) => void
        ) => {
            let subscriber = subscribers.get(callback);
            if (subscriber) {
                subscriber.references++;
            } else {
                subscriber = { delivered: new Set<string>(), references: 1 };
                subscribers.set(callback, subscriber);
            }
            void ready
                .then(() => {
                    const current = subscribers.get(callback);
                    if (!current) {
                        return;
                    }
                    for (const [key, change] of snapshot) {
                        if (!current.delivered.has(key)) {
                            current.delivered.add(key);
                            notifySubscriber(callback, change);
                        }
                    }
                })
                .catch(() => {});
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                const current = subscribers.get(callback);
                if (!current) {
                    return;
                }
                current.references = Math.max(0, current.references - 1);
                if (current.references === 0) {
                    subscribers.delete(callback);
                }
            };
        };
        void ready.catch(() => {});
        return { stop, ready, subscribe };
    }

    listenForReplicationInfo(
        onChange?: (change: ReplicationRangeEvent) => void
    ) {
        this.assertMediaResourceAdmissionOpen();
        let subscription = this.replicationInfoSubscription;
        if (!subscription || subscription.references === 0) {
            const started = this.startReplicationInfoSubscription();
            subscription = {
                references: 0,
                ready: started.ready,
                stop: started.stop,
                subscribe: started.subscribe,
            };
            this.replicationInfoSubscription = subscription;
        }
        subscription.references++;

        const unsubscribe = onChange
            ? subscription.subscribe(onChange)
            : undefined;
        let unsubscribed = false;
        let referenceReleased = false;
        let finalized = false;
        let stopPromise: Promise<void> | undefined;
        const stop = () => {
            if (!stopPromise) {
                stopPromise = (async () => {
                    if (!unsubscribed) {
                        unsubscribed = true;
                        unsubscribe?.();
                    }
                    if (!referenceReleased) {
                        subscription.references = Math.max(
                            0,
                            subscription.references - 1
                        );
                        referenceReleased = true;
                    }
                    if (subscription.references === 0) {
                        // Retain the exact underlying subscription until its
                        // final cleanup succeeds, so a failed release retries
                        // listeners and leases instead of forgetting them.
                        await subscription.stop();
                        if (this.replicationInfoSubscription === subscription) {
                            this.replicationInfoSubscription = undefined;
                        }
                    }
                    if (!finalized) {
                        finalized = true;
                        this.activeMediaConsumers.delete(stop);
                    }
                })().catch((error) => {
                    stopPromise = undefined;
                    this.activeMediaConsumers.add(stop);
                    throw error;
                });
            }
            return stopPromise;
        };
        this.activeMediaConsumers.add(stop);
        void subscription.ready.catch(() => {});
        return { stop, ready: subscription.ready };
    }

    /**
     *
     * @param progress [0,1] (the progress bar)
     */
    async iterate(
        progress: number | "live",
        opts?: {
            debug?: boolean;
            bufferTime?: number; // how much time to buffer
            bufferSize?: number | ((queuedChunks: number) => number); // if below bufferTime how big chunks should we buffer from remote
            preloadingBufferSize?: number; // how much time to buffer from remote before starting playing
            preload?: number; /// how much preload time
            keepTracksOpen?: boolean;
            changeProcessor?: TrackChangeProcessor;
            onProgress?: (properties: {
                track: Track;
                chunk: Chunk;
            }) => void | Promise<void>;
            onUnderflow?: () => void;
            onMaxTimeChange?: (properties: {
                maxTime: number;
            }) => void | Promise<void>;
            onTrackOptionsChange?: (options: Track[]) => void;
            onTracksChange?: (tracks: Track[]) => void;
            onReplicationChange?: (properties: {
                hash: string;
                track: Track;
            }) => void;
            onClose?: () => void;
            replicate?: boolean;
            closeOnEnd?: boolean;
            signal?: AbortSignal;
        }
    ): Promise<TracksIterator> {
        this.assertMediaResourceAdmissionOpen();
        if (opts?.signal?.aborted) {
            throw new AbortError();
        }
        const withCallerAbort = <T>(operation: Promise<T>): Promise<T> => {
            const signal = opts?.signal;
            if (!signal) {
                return operation;
            }
            if (signal.aborted) {
                void operation.catch(() => {});
                return Promise.reject(new AbortError());
            }
            return new Promise<T>((resolve, reject) => {
                let settled = false;
                const cleanup = () =>
                    signal.removeEventListener("abort", onAbort);
                const onAbort = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    cleanup();
                    reject(new AbortError());
                };
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                operation.then(
                    (value) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        cleanup();
                        resolve(value);
                    },
                    (error) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        cleanup();
                        reject(error);
                    }
                );
            });
        };
        const bufferTime = (opts?.bufferTime ?? 6e3) * 1e3; // micro seconds
        let bufferSizeInvocations = 0;
        const bufferSize =
            opts?.bufferSize == null
                ? (_number: number) => {
                      bufferSizeInvocations++;
                      return Math.min(10 * bufferSizeInvocations, 160);
                  }
                : typeof opts?.bufferSize === "number"
                  ? () => opts.bufferSize as number
                  : opts.bufferSize;
        const preloadingBufferSize = opts?.preloadingBufferSize ?? 60;
        const openTrackQueue = new PQueue({ concurrency: 1 });
        const changeProcessor =
            opts?.changeProcessor || oneVideoAndOneAudioChangeProcessor;
        let close: () => void | Promise<void>;
        let play: () => void | Promise<void>;
        let pause: () => void | Promise<void>;
        let mediaTime: () => number | "live";
        let paused = true;
        let requestedPaused = true;
        let session = 0;
        let playing = false;
        let startPlayAt: number | undefined = undefined;
        const currentTracks: Map<
            string,
            TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>
        > = new Map();
        const pendingTrackClosures = new Set<
            TrackWithBuffer<WebcodecsStreamDB | AudioStreamDB>
        >();
        const consumedTracks: Set<string> = new Set();

        const currentTrackOptions: Track[] = [];
        let tracksStatePublished = false;
        let trackOptionsStatePublished = false;
        const publishTracksChange = (tracks: Track[]): unknown => {
            if (!opts?.onTracksChange) {
                return;
            }
            const previousState = tracksStatePublished;
            tracksStatePublished = tracks.length > 0;
            try {
                return opts.onTracksChange(tracks) as unknown;
            } catch (error) {
                // A re-entrant close already captured the attempted state,
                // while an ordinary synchronous failure still needs the prior
                // state retained so terminal cleanup can retry its final view.
                tracksStatePublished = previousState;
                throw error;
            }
        };
        const publishTrackOptionsChange = (tracks: Track[]): unknown => {
            if (!opts?.onTrackOptionsChange) {
                return;
            }
            const previousState = trackOptionsStatePublished;
            trackOptionsStatePublished = tracks.length > 0;
            try {
                return opts.onTrackOptionsChange(tracks) as unknown;
            } catch (error) {
                trackOptionsStatePublished = previousState;
                throw error;
            }
        };
        const invokeTerminalNotification = (
            notification: () => unknown,
            description: string
        ) => {
            const result = notification();
            if (
                result != null &&
                typeof (result as PromiseLike<unknown>).then === "function"
            ) {
                void Promise.resolve(result).catch((error) =>
                    console.error(
                        `Async media iterator ${description} notification failed`,
                        error
                    )
                );
            }
        };
        const filterTracksInTime = (tracks: Track[]) => {
            let currentTime = mediaTime();
            const filterered: Track[] = [];
            for (const track of tracks) {
                if (currentTime === "live") {
                    if (track.endTime == null) {
                        filterered.push(track);
                    }
                } else {
                    if (track.startTime <= currentTime) {
                        if (
                            track.endTime == null ||
                            track.endTime >= currentTime
                        ) {
                            filterered.push(track);
                        }
                    }
                }
            }
            return filterered;
        };

        let closed = false;
        const isInactiveSession = (requestedSession: number) =>
            closed || paused || requestedSession !== session;

        const latestPendingFrame: Map<string, { time: number; track: Track }> =
            new Map();
        const latestPlayedFrame: Map<string, { time: number; track: Track }> =
            new Map();
        let pendingRecordedProgressDelivery: Promise<void> | undefined;
        let recordedMetadataExhausted = false;
        let closeOnEndAttempt: Promise<void> | undefined;

        const startTimer: () => void = () => {
            if (startPlayAt != null) {
                return;
            }
            startPlayAt = Number(hrtimeMicroSeconds());
        };

        // Find max media time
        // That is the media time corresponding to the track with the latest chunk
        let startProgressBarMediaTime: () => number | "live" | undefined;

        let laggingSources: Map<string, number> = new Map();
        let laggiestTime: number | undefined = undefined;
        let isLagging = (trackId: string) => {
            return false as any; //laggingSources.get(trackId) === laggiestTime
        };

        let accumulatedLag: number = 0;

        const maxtimeListener = (ev: { detail: { maxTime: number } }) => {
            try {
                const result = opts?.onMaxTimeChange?.({
                    maxTime: ev.detail.maxTime,
                });
                if (result instanceof Promise) {
                    void result.catch((error) =>
                        console.error(
                            "Failed to handle media max-time change",
                            error
                        )
                    );
                }
            } catch (error) {
                console.error("Failed to handle media max-time change", error);
            }
        };

        this.events.addEventListener("maxTime", maxtimeListener);

        const totalLag = (now = Number(hrtimeMicroSeconds())) => {
            const currentLag = laggiestTime != null ? now - laggiestTime : 0;
            const totalLag = currentLag + accumulatedLag;
            return totalLag;
        };

        const setLaggyTrack = (trackId: string) => {
            const lagStartAt = Number(hrtimeMicroSeconds());
            laggingSources.set(trackId, lagStartAt);
            if (laggiestTime == null || lagStartAt < laggiestTime) {
                // TODO second condition never fulfilled?
                laggiestTime = lagStartAt;
            }
        };
        const deleteLaggyTrack = (trackId: string) => {
            const thisLagTime = laggingSources.get(trackId);
            if (thisLagTime == null) {
                return;
            }
            laggingSources.delete(trackId);
            if (laggiestTime !== thisLagTime) {
                return;
            }
            const newLaggistTime =
                laggingSources.size > 0
                    ? Math.min(...laggingSources.values())
                    : undefined;
            accumulatedLag +=
                (newLaggistTime != null
                    ? newLaggistTime
                    : Number(hrtimeMicroSeconds())) - thisLagTime;
            laggiestTime = newLaggistTime;
        };

        let onPending = async (properties: {
            track: Track;
            chunk: Chunk;
        }): Promise<void> => {
            const { latest: isLatest, track: latestTrack } = updateLatestFrame(
                latestPendingFrame,
                properties.track,
                properties.chunk.time
            );

            if (
                !isLatest &&
                latestTrack.startTime < properties.track.startTime
            ) {
                // if the frame to add to the buffer is not the latest and also the start time for the latest is earlier, skip this. TODO this logic does not make sense if we have  a covering track ?
                // here we might end up if we do preloading and we end up with frames we dont need!
                opts?.debug &&
                    console.log("---------> skip pending: ", {
                        currentPlayedTime:
                            properties.chunk.time + properties.track.startTime,
                        startTime: properties.track.startTime,
                        latestPendingFrame: latestPendingFrame.get(
                            properties.track.source.mediaType
                        )?.time,
                        latestPlayedFrame: latestPlayedFrame.get(
                            properties.track.source.mediaType
                        )?.time,
                        track: properties.track.toString(),
                        latestTrack: latestTrack.toString(),
                    });
                return;
            }

            const currentPlayedTime =
                properties.chunk.time + properties.track.startTime;

            //    console.log("--------- > on pending: ", { currentPlayedTime, startTime: properties.track.startTime })

            if (!latestPlayedFrame.has(properties.track.source.mediaType)) {
                // we do this beacuse if we want to calcualte the distance between the latest pending and latest played we dont want to calcuilate it towards 0
                // because if latest pending is 100s and latest played frame is not set, then the differenc would be 100s which is actually not what is in the buffer
                latestPlayedFrame.set(properties.track.source.mediaType, {
                    track: properties.track,
                    time:
                        properties.track.startTime + properties.chunk.time - 1,
                });
            }

            let currentTrack = currentTracks.get(properties.track.idString);
            if (!currentTrack) {
                if (!closed) {
                    console.warn(
                        "Unexpected missing track buffer: " +
                            properties.track.toString()
                    );
                }
                return;
            }
            currentTrack.chunks.push(properties.chunk);

            this.maybeUpdateMaxTime?.(currentPlayedTime);
        };

        let onProgressWrapped: (properties: {
            track: Track;
            chunk: Chunk;
        }) => void | Promise<void> = async (properties) => {
            // console.log("on progress", properties.track.startTime + properties.chunk.time, properties.track.source.mediaType)
            return opts?.onProgress?.(properties);
        };

        let stopReplicationInfoSubscription: (() => Promise<void>) | undefined =
            undefined;
        let stopMaxTimeSync: (() => Promise<void>) | undefined = undefined;

        const stopIteratorSubscriptions = async () => {
            const subscriptions = [
                stopReplicationInfoSubscription,
                stopMaxTimeSync,
            ].filter((stop): stop is () => Promise<void> => !!stop);
            const results = await Promise.allSettled(
                subscriptions.map((stop) => stop())
            );
            const failures: unknown[] = [];
            results.forEach((result, index) => {
                if (result.status === "fulfilled") {
                    if (
                        stopReplicationInfoSubscription === subscriptions[index]
                    ) {
                        stopReplicationInfoSubscription = undefined;
                    }
                    if (stopMaxTimeSync === subscriptions[index]) {
                        stopMaxTimeSync = undefined;
                    }
                } else {
                    failures.push(result.reason);
                }
            });
            throwCleanupFailures(
                failures,
                "Failed to stop media iterator subscriptions"
            );
        };

        let preloadTime = opts?.preload != null ? opts.preload * 1e3 : 3e6; // microseconds
        let preloadEndAt = Number(hrtimeMicroSeconds()) + preloadTime;
        const preloadIsDone = () => {
            // waited enough time or there are two pending tracks queues with frames of multiple types
            return (
                Number(hrtimeMicroSeconds()) > preloadEndAt ||
                new Set(
                    [...currentTracks.values()]
                        .filter((x) => x.chunks.length > preloadingBufferSize)
                        .map((x) => x.track.source.mediaType)
                ).size >= 2
            );
        };

        try {
            if (opts?.onReplicationChange) {
                const replicationInfo = this.listenForReplicationInfo(
                    opts.onReplicationChange
                );
                stopReplicationInfoSubscription = () => replicationInfo.stop();
                await withCallerAbort(replicationInfo.ready);
            }

            if (this.maxTime != null) {
                await withCallerAbort(
                    Promise.resolve(
                        opts?.onMaxTimeChange?.({ maxTime: this.maxTime })
                    )
                );
            }

            if (typeof progress === "number" && progress < 1) {
                const maxTimeSubscription = this.listenForMaxTimeChanges(
                    opts?.keepTracksOpen
                );
                stopMaxTimeSync = () => maxTimeSubscription.stop();
                await withCallerAbort(maxTimeSubscription.ready);
                startProgressBarMediaTime = () => {
                    if (this.maxTime != null) {
                        return Math.round(progress * this.maxTime);
                    }
                    return undefined;
                };
            } else {
                startProgressBarMediaTime = () => "live";
            }
        } catch (error) {
            this.events.removeEventListener("maxTime", maxtimeListener);
            await stopIteratorSubscriptions().catch(() => {});
            throw error;
        }

        const maybeCloseOnRecordedEnd = (requestedSession: number) => {
            if (
                !opts?.closeOnEnd ||
                startProgressBarMediaTime() === "live" ||
                !recordedMetadataExhausted ||
                isInactiveSession(requestedSession) ||
                currentTracks.size > 0 ||
                currentTrackOptions.length > 0
            ) {
                return Promise.resolve();
            }
            if (closeOnEndAttempt) {
                return closeOnEndAttempt;
            }

            let attempt!: Promise<void>;
            attempt = (async () => {
                await openTrackQueue.onIdle();
                if (
                    isInactiveSession(requestedSession) ||
                    !recordedMetadataExhausted ||
                    currentTracks.size > 0 ||
                    currentTrackOptions.length > 0
                ) {
                    return;
                }
                await closeCtrl();
            })().finally(() => {
                if (closeOnEndAttempt === attempt) {
                    closeOnEndAttempt = undefined;
                }
            });
            closeOnEndAttempt = attempt;
            return attempt;
        };

        const scheduleMaybeCloseOnRecordedEnd = (requestedSession: number) => {
            void maybeCloseOnRecordedEnd(requestedSession).catch((error) => {
                console.error("Failed to close media iterator at end", error);
            });
        };

        const selectOption = async (track: Track) => {
            if (await removeTrack({ track, clearPending: true })) {
                return; // track was already selected, now unselected
            }

            return maybeChangeTrack({ add: track, force: true });
        };

        const removeTrack = async (properties: {
            track: Track;
            ended?: boolean;
            clearPending?: boolean;
        }) => {
            const removalSession = session;
            // Retain the exact resource before invoking any user callback.
            // If notification or cleanup fails, pause/close can retry it.
            const trackToRemove = currentTracks.get(properties.track.idString);
            if (trackToRemove) {
                pendingTrackClosures.add(trackToRemove);
            }

            // remove track in options if ended
            if (properties.ended) {
                const trackOptionIndex = currentTrackOptions.findIndex((x) =>
                    equals(x.id, properties.track.id)
                );
                if (trackOptionIndex >= 0) {
                    currentTrackOptions.splice(trackOptionIndex, 1);
                    publishTrackOptionsChange(currentTrackOptions);
                    opts?.debug &&
                        console.log(
                            "REMOVE TRACK OPTION",
                            properties.track.toString(),
                            properties.ended
                        );
                }
            }

            // remove track in process if we have it
            if (trackToRemove) {
                const retainBufferedTail =
                    properties.ended === true &&
                    properties.clearPending !== true &&
                    trackToRemove.chunks.length > 0;
                // make sure the we dont skip frames to buffer
                // latestPendingFrame.get(change.add.source.mediaType) will set a threshold where earlier frames are not seem to be worth buffering
                // but force changing track means that we want to replicate the buffer by type to something else
                latestPendingFrame.delete(properties.track.source.mediaType);

                if (
                    properties.clearPending ||
                    trackToRemove.chunks.length === 0
                ) {
                    console.log("RM TRACK FINALIZE", {
                        track: properties.track.toString(),
                        pendingFrames: currentTracks.get(
                            properties.track.idString
                        )?.chunks.length,
                    });

                    currentTracks.delete(properties.track.idString);
                    publishTracksChange(
                        [...currentTracks.values()].map((x) => x.track)
                    );
                }

                deleteLaggyTrack(trackToRemove.track.idString);

                await trackToRemove.close?.();
                pendingTrackClosures.delete(trackToRemove);
                if (
                    retainBufferedTail &&
                    currentTracks.get(properties.track.idString) ===
                        trackToRemove
                ) {
                    // Do not expose the tail as terminal until its exact
                    // listener/lease cleanup has succeeded: the render loop
                    // can otherwise race a second close against this one.
                    if (trackToRemove.chunks.length === 0) {
                        currentTracks.delete(properties.track.idString);
                        publishTracksChange(
                            [...currentTracks.values()].map((x) => x.track)
                        );
                    } else {
                        // onProgress still owns the buffered tail. Keep it
                        // playable, but let the render loop retire it as soon
                        // as the callback commits and drains the buffer.
                        trackToRemove.closing = true;
                    }
                }
                /*  console.log("REMOVE TRACK", {
                     startTime: track.startTime,
                     endTime: track.endTime,
                     ended,
                     index,
                     currentTracksLength: currentTracks.length,
                     currentTrackOptionsLength: currentTrackOptions.length,
                 }); */

                if (properties.ended) {
                    scheduleMaybeCloseOnRecordedEnd(removalSession);
                }
                return true;
            }

            if (properties.ended) {
                scheduleMaybeCloseOnRecordedEnd(removalSession);
            }
            return false;
        };

        const pauseAfterProgressFailure = async (error: unknown) => {
            console.error(
                "Media progress callback failed; playback paused",
                error
            );
            try {
                await pauseCtrl();
            } catch (pauseError) {
                console.error(
                    "Failed to pause media playback after a progress callback error",
                    pauseError
                );
            }
        };

        const renderLoop = async (currentSession: number) => {
            if (isInactiveSession(currentSession)) {
                return;
            }
            let isLive = startProgressBarMediaTime() === "live";

            outer: for (const [trackId, { track, chunks }] of currentTracks) {
                let spliceSize = 0;

                if (!isLive && startPlayAt != null) {
                    let laggingStartTime = laggingSources.get(trackId);

                    if (chunks.length === 0 && laggingStartTime == null) {
                        opts?.onUnderflow?.();
                        setLaggyTrack(trackId);
                    } else if (chunks.length > 0 && laggingStartTime != null) {
                        deleteLaggyTrack(trackId);
                    }
                }

                for (const chunk of chunks) {
                    // A rapid pause -> play can make `paused` false again while
                    // this retired render loop is still resuming from an async
                    // progress callback. Fence by the owning session as well so
                    // an old loop cannot emit buffered frames into its replacement.
                    if (isInactiveSession(currentSession)) {
                        break outer;
                    }

                    let isLive = startProgressBarMediaTime() === "live";
                    if (chunks.length - spliceSize < 0) {
                        // TODO larger value to prevent hiccups?
                        break;
                    }

                    if (isLive) {
                        /* console.log("PUSH LIVE", pendingFrames.length); */
                        try {
                            await onProgressWrapped({
                                chunk,
                                track,
                            });
                        } catch (error) {
                            if (isInactiveSession(currentSession)) {
                                break outer;
                            }
                            // A live source may advance before an explicit
                            // replay, so do not promise exact retry semantics;
                            // do guarantee a truthful paused state and no hot
                            // failure loop.
                            await pauseAfterProgressFailure(error);
                            break outer;
                        }
                        spliceSize++;
                    } else {
                        const startAt = track.startTime + chunk.time;
                        const currentTime = mediaTime();
                        const isLaterThanStartProgress = () => {
                            let time = startProgressBarMediaTime();
                            if (typeof time !== "number") {
                                throw new Error("Unexpected");
                            }
                            return startAt >= time;
                        };

                        const isReadyToPlay =
                            startAt <= (currentTime as number);

                        if (isLaterThanStartProgress()) {
                            let donePreloading = preloadIsDone();
                            if (donePreloading) {
                                startTimer();
                            }
                            if (
                                donePreloading &&
                                (isReadyToPlay ||
                                    /*  startPlayAt == null || */
                                    isLagging(track.idString))
                            ) {
                                // Pause/play can start a replacement render
                                // loop while an async progress callback from
                                // the retired loop is still settling. Let the
                                // replacement rendezvous with that exact
                                // delivery before deciding whether the frame
                                // was committed or must be retried.
                                await pendingRecordedProgressDelivery?.catch(
                                    () => {}
                                );
                                if (isInactiveSession(currentSession)) {
                                    break outer;
                                }

                                const committedFrame = latestPlayedFrame.get(
                                    track.source.mediaType
                                );
                                if (
                                    committedFrame?.time === startAt &&
                                    committedFrame.track.idString ===
                                        track.idString
                                ) {
                                    // The previous session completed this
                                    // callback while the replacement was
                                    // buffering. Consume its refetched copy
                                    // without delivering it twice.
                                    spliceSize++;
                                    continue;
                                }

                                let delivery!: Promise<void>;
                                delivery = Promise.resolve()
                                    .then(() =>
                                        onProgressWrapped({
                                            chunk,
                                            track,
                                        })
                                    )
                                    .then(() => {
                                        // Callback fulfillment is the commit
                                        // point. A rejected delivery remains
                                        // eligible for a replacement session.
                                        updateLatestFrame(
                                            latestPlayedFrame,
                                            track,
                                            chunk.time
                                        );
                                    })
                                    .finally(() => {
                                        if (
                                            pendingRecordedProgressDelivery ===
                                            delivery
                                        ) {
                                            pendingRecordedProgressDelivery =
                                                undefined;
                                        }
                                    });
                                pendingRecordedProgressDelivery = delivery;
                                try {
                                    await delivery;
                                } catch (error) {
                                    if (isInactiveSession(currentSession)) {
                                        break outer;
                                    }
                                    // A user callback failure must not leave an
                                    // iterator reporting "playing" after its
                                    // render loop has stopped. Fence and drain
                                    // this session through the normal control
                                    // path; an explicit play() can then retry
                                    // the still-uncommitted frame without a hot
                                    // automatic retry loop.
                                    await pauseAfterProgressFailure(error);
                                    break outer;
                                }
                                spliceSize++;
                            } else {
                                /*  console.log("SKIP", {
                                     startAt,
                                     currentTime,
                                     isReadyToPlay,
                                     startPlayAt,
                                     chunkLength: chunks.length,
                                     track: track.toString(),
                                     isLagging: isLagging(track.address)
                                 }) */
                                break;
                            }
                        } else {
                            opts?.debug && console.log("SKIP OLD FRAME");
                            spliceSize++; // ignore old frames
                        }
                    }
                }
                if (isInactiveSession(currentSession)) {
                    break outer;
                }
                if (spliceSize > 0) {
                    chunks.splice(0, spliceSize);

                    // if we are not expecting more frames, delete the buffer
                    // if we dont do this the iterator will think that this track is lagging
                    const currentTrack = currentTracks.get(track.idString);
                    const recordedTrackExhausted =
                        currentTrack?.closing === true;
                    if (
                        chunks.length === 0 &&
                        (recordedTrackExhausted || currentTrack == null)
                    ) {
                        opts?.debug &&
                            console.log("RM track after empty buffer", trackId);

                        await removeTrack({
                            track,
                            ended: true,
                            clearPending: true,
                        });
                    }
                }
            }

            !isInactiveSession(currentSession) &&
                requestAnimationFrame(() => {
                    void renderLoop(currentSession).catch((error) => {
                        if (!isClosedError(error) && !closed) {
                            console.error("Media render loop failed", error);
                        }
                    });
                });
        };

        const addTrackAsOption = (track: Track) => {
            const exists = currentTrackOptions.find((x) =>
                equals(x.id, track!.id)
            );
            if (!exists) {
                console.log(
                    "ADD TRACK OPTION",
                    track.toString(),
                    track.idString,
                    currentTrackOptions.length
                );
                currentTrackOptions.push(track);

                publishTrackOptionsChange([...currentTrackOptions]);
            }
        };

        const updateLatestFrame = (
            map: Map<string, { time: number; track: Track }>,
            track: Track<WebcodecsStreamDB | AudioStreamDB>,
            timeMicroseconds: number
        ) => {
            const latest = map.get(track.source.mediaType);
            const mediaTime = timeMicroseconds + track.startTime;
            if (latest == null || latest.time < mediaTime) {
                map.set(track.source.mediaType, { time: mediaTime, track });
                return { latest: true, track };
            }
            return { latest: false, track: latest.track };
        };

        const maybeChangeTrack = async (change: {
            force?: boolean;
            add?: Track;
            remove?: Track;
            isOption?: boolean;
        }) => {
            // we open track in single queue so we dont re-open and re-listen for same track twice,
            // TODO make parallelizable
            const requestedSession = session;
            return openTrackQueue.add(async () => {
                if (isInactiveSession(requestedSession)) {
                    return;
                }
                // remove existing track if we got a new track with same id that has a endtime set before the currentTime
                try {
                    if (change.add && change.add.endTime != null) {
                        const mediaTimeForType = mediaTime();
                        const existing = currentTrackOptions.find((x) =>
                            equals(x.id, change.add!.id)
                        );
                        if (existing) {
                            // update end time of existing track
                            existing.setEnd(change.add.endTimeBigInt);

                            // remove track if it has ended OR there is a live track in the options and this track is no longer live
                            if (
                                (mediaTimeForType !== "live" &&
                                    change.add.endTime < mediaTimeForType) ||
                                (mediaTimeForType === "live" &&
                                    change.add &&
                                    currentTrackOptions.find(
                                        (x) =>
                                            x.constructor ===
                                                change.add!.constructor &&
                                            x.endTime == null
                                    ))
                            ) {
                                await removeTrack({
                                    track: existing,
                                    ended: true,
                                });
                                console.log(
                                    "RM TRACK ENDED",
                                    change.add.startTime,
                                    change.add.endTime,
                                    mediaTimeForType,
                                    !!currentTrackOptions.find((x) =>
                                        equals(x.id, change.add!.id)
                                    )
                                );
                                return;
                            }
                        }
                    }

                    !change.isOption &&
                        change.add &&
                        addTrackAsOption(change.add);

                    const filteredChange = changeProcessor(
                        {
                            force: change.force,
                            current: currentTracks,
                            options: currentTrackOptions,
                            add: change.add,
                            remove: change.remove,
                        },
                        mediaTime(),
                        preloadTime
                    );

                    if (filteredChange.add || filteredChange.remove) {
                        console.log("MAYBE CHANGE?", {
                            add: filteredChange.add?.toString(),
                            remove: filteredChange.remove?.toString(),
                        });
                    }

                    if (filteredChange.add) {
                        /*   console.log("ADD TRACK FILTER", {
                              track: (filteredChange.add instanceof Track
                                  ? filteredChange.add
                                  : filteredChange.add.track
                              ).toString(),
                          }); */
                        let when =
                            filteredChange.add instanceof Track
                                ? undefined
                                : filteredChange.add.when;
                        await addTrack(
                            filteredChange.add instanceof Track
                                ? filteredChange.add
                                : filteredChange.add.track,
                            when,
                            requestedSession
                        );
                    }
                    if (filteredChange.remove) {
                        /*  console.log("RM TRACK FILTER", {
                             track: filteredChange.remove.toString(),
                         }); */
                        await removeTrack({
                            track: filteredChange.remove,
                            clearPending: true,
                        });
                    }
                } catch (error) {
                    if (
                        !isInactiveSession(requestedSession) &&
                        !pauseController.signal.aborted &&
                        !isClosedError(error)
                    ) {
                        console.error("Failed to change media track", error);
                    }
                    throw error;
                }
            });
        };
        const addTrack = async (
            track: Track,
            when: number | undefined,
            requestedSession: number
        ) => {
            if (isInactiveSession(requestedSession)) {
                return;
            }
            const runningTrack = currentTracks.get(track.idString);
            if (runningTrack) {
                // console.log("already running cant add ", track.toString())
                return;
            }

            // is thids clause really needed?
            if (track.endTime != null) {
                const lastPendingFrameTime = latestPendingFrame.get(
                    track.source.mediaType
                );
                if (
                    lastPendingFrameTime != null &&
                    lastPendingFrameTime.time > track.endTime
                ) {
                    return;
                }
            }
            consumedTracks.add(track.idString);

            let close: () => void | Promise<void>;
            let open: () => void | Promise<void>;
            const requestedTrack = track;
            let lease: MediaTrackLeaseHandle;
            try {
                lease = await this.acquireTrackLease(
                    requestedTrack,
                    opts?.keepTracksOpen === true
                );
            } catch (error) {
                consumedTracks.delete(requestedTrack.idString);
                throw error;
            }
            track = lease.track;

            if (isInactiveSession(requestedSession)) {
                consumedTracks.delete(requestedTrack.idString);
                await lease.release();
                return;
            }

            console.log("ADD TRACK", {
                closed,
                track: track.toString(),
                currentTrackSize: currentTracks.size,
            });

            if (startProgressBarMediaTime() === "live") {
                let listener = async (
                    change: CustomEvent<DocumentsChange<Chunk, ChunkIndexable>>
                ) => {
                    for (const chunk of change.detail.added) {
                        await onPending({ chunk, track });
                    }
                };

                close = () => {
                    track.source.chunks.events.removeEventListener(
                        "change",
                        listener
                    );
                };
                open = async () => {
                    close();
                    track.source.chunks.events.addEventListener(
                        "change",
                        listener
                    );
                    await lease.acquireLivestream({
                        signal: pauseController.signal,
                    });
                };
            } else {
                let iterator: ResultsIterator<Chunk> | undefined = undefined;
                const createIterator = async () => {
                    const progressStartInMediaTime =
                        startProgressBarMediaTime();
                    if (typeof progressStartInMediaTime == "number") {
                        let currentTime = mediaTime();
                        let currentTimeNumber =
                            typeof currentTime === "number" ? currentTime : 0;
                        const latestPlayedTime = latestPlayedFrame.get(
                            track.source.mediaType
                        )?.time;
                        // Wall-clock media time can advance a little beyond the
                        // last callback that completed before pause. Resume the
                        // source immediately after that delivered frame so the
                        // gap is caught up rather than silently skipped.
                        const resumeMediaTime =
                            latestPlayedTime == null
                                ? currentTimeNumber
                                : latestPlayedTime + 1;
                        // we  need to subtrackt track.startTime to make mediaTime to be relative to the track time
                        let whenPredefined = when ?? 0;
                        let startTimeInTrack = Math.max(
                            Math.max(
                                whenPredefined,
                                progressStartInMediaTime,
                                resumeMediaTime
                            ) - track.startTime,
                            0
                        );
                        return track.source.iterate(startTimeInTrack, {
                            local: true,
                            remote: {
                                replicate: opts?.replicate ?? true,
                            },
                            signal: pauseController.signal,
                        });
                    }
                    return undefined;
                };

                const bufferLoop = async (currentSession: number) => {
                    if (!iterator) {
                        iterator = await createIterator();
                    }

                    let timeLeftOnBuffer = 0;
                    const loopCondition = () => {
                        let chunks = trackWithBuffer.chunks;
                        if (chunks) {
                            let lastChunk = chunks[chunks.length - 1];
                            let firstChunk = chunks[0];
                            if (lastChunk) {
                                timeLeftOnBuffer =
                                    lastChunk.time - firstChunk.time;
                            } else {
                                timeLeftOnBuffer = 0;
                            }
                        }

                        /*   timeLeftOnBuffer = 
                              (latestPendingFrame.get(track.source.mediaType) ||
                                  0) -
                              (latestPlayedFrame.get(track.source.mediaType) ||
                                  0); */
                        return (
                            timeLeftOnBuffer < bufferTime &&
                            !iterator?.done() &&
                            !closed
                        );
                    };
                    try {
                        while (
                            loopCondition() &&
                            iterator &&
                            iterator.done() !== true &&
                            !track.closed
                        ) {
                            // buffer bufferTime worth of video
                            if (session !== currentSession) {
                                return;
                            }

                            opts?.debug &&
                                console.log(
                                    "Start BUFFERING",
                                    bufferSize(trackWithBuffer.chunks.length)
                                );

                            const newChunks = await iterator.next(
                                bufferSize(trackWithBuffer.chunks.length)
                            );
                            opts?.debug &&
                                console.log(
                                    "End BUFFERING",
                                    bufferSize(trackWithBuffer.chunks.length)
                                );

                            if (newChunks.length > 0) {
                                opts?.debug &&
                                    console.log("BUFFERING", {
                                        timeLeftOnBuffer,
                                        bufferTime,
                                        track: track.toString(),
                                        chunks: newChunks.length,
                                        minT: newChunks[0].time,
                                        maxT: newChunks[newChunks.length - 1]
                                            .time,
                                    });
                                for (const chunk of newChunks) {
                                    await onPending({ chunk, track });
                                }
                            }

                            if (
                                !newChunks ||
                                newChunks.length === 0 ||
                                iterator?.done()
                            ) {
                                // TODO? prevent tracks to be reused by setting latest media time to the end time of the track
                                /* updateLatestFrame(
                                    latestPendingFrame,
                                    track,
                                    track.duration === "live"
                                        ? 0
                                        : track.duration
                                );

                                updateLatestFrame(
                                    latestPlayedFrame,
                                    track,
                                    track.duration === "live"
                                        ? 0
                                        : track.duration
                                ); */

                                if (preloadIsDone()) {
                                    startTimer();
                                }

                                opts?.debug &&
                                    console.log("RM TRACK NO MORE CHUNKS", {
                                        deleteImmediately:
                                            trackWithBuffer.chunks.length === 0,
                                        done: iterator?.done(),
                                        pendingFrames:
                                            trackWithBuffer.chunks.length,
                                        track: track.toString(),
                                        address: track.address,
                                    });

                                if (trackWithBuffer.chunks.length === 0) {
                                    return removeTrack({
                                        track,
                                        ended: true,
                                        clearPending: true,
                                    });
                                } else {
                                    trackWithBuffer.closing = true;
                                    // Rendering owns the buffered tail now;
                                    // polling an exhausted iterator again can
                                    // otherwise spin until pause/close.
                                    return;
                                }
                            }
                        }
                    } catch (error) {
                        if (error instanceof AbortError === false) {
                            console.error("Failed to buffer", error);
                        }
                        throw error;
                    }

                    if (session !== currentSession) {
                        return;
                    }

                    const timeTillRunningOutOfFrames = Math.max(
                        (timeLeftOnBuffer - bufferTime) / 1e3,
                        0
                    );

                    /*  opts?.debug &&
                         console.log("---> ", {
                             delay: timeTillRunningOutOfFrames,
                             bufferTime,
                             timeLeftOnBuffer,
                             latestPending:
                                 latestPendingFrame.get(
                                     track.source.mediaType
                                 ) || 0,
                             latestPlayed:
                                 latestPlayedFrame.get(track.source.mediaType) ||
                                 track.startTimeBigInt,
                         }); */

                    delay(timeTillRunningOutOfFrames, {
                        signal: pauseController.signal,
                    })
                        .then(() => bufferLoop(currentSession))
                        .catch((e) => {
                            if (
                                e instanceof AbortError ||
                                isClosedError(e) ||
                                e.message === "Not started" ||
                                closed ||
                                session !== currentSession
                            ) {
                                // Handling closing errors better
                                return;
                            }
                            console.error("Error in buffer loop", e);
                        });
                };

                open = () => {
                    /*  track.source.chunks.log.events.addEventListener(
                         "replication:change",
                         replicationChangeListener
                     ); */
                    console.log("open!");
                    const currentSession = session;
                    void bufferLoop(currentSession).catch((e) => {
                        if (
                            e instanceof AbortError ||
                            isClosedError(e) ||
                            e.message === "Not started" ||
                            closed ||
                            session !== currentSession
                        ) {
                            // Handling closing errors better
                            return;
                        }
                        console.error("Error in buffer loop", e);
                    });
                };
                close = () => {
                    /* track.source.chunks.log.events.removeEventListener(
                        "replication:change",
                        replicationChangeListener
                    ); */
                    return iterator?.close();
                };
            }

            let nestedResourcesClosed = false;
            let leaseReleased = false;
            const trackWithBuffer: TrackWithBuffer<any> = {
                track,
                open,
                close: async () => {
                    if (!nestedResourcesClosed) {
                        await close();
                        nestedResourcesClosed = true;
                    }
                    if (!leaseReleased) {
                        await lease.release();
                        leaseReleased = true;
                    }
                    return track.closed;
                },
                chunks: [],
            };
            currentTracks.set(trackWithBuffer.track.idString, trackWithBuffer);
            let admitted = false;
            try {
                await open();
                if (isInactiveSession(requestedSession)) {
                    return;
                }
                publishTracksChange(
                    [...currentTracks.values()].map((x) => x.track)
                );
                admitted = true;
            } finally {
                if (!admitted) {
                    if (
                        currentTracks.get(trackWithBuffer.track.idString) ===
                        trackWithBuffer
                    ) {
                        currentTracks.delete(trackWithBuffer.track.idString);
                    }
                    consumedTracks.delete(trackWithBuffer.track.idString);
                    pendingTrackClosures.add(trackWithBuffer);
                    try {
                        await trackWithBuffer.close?.();
                        pendingTrackClosures.delete(trackWithBuffer);
                    } catch {
                        // The retained closure is retried by pause/close or by
                        // MediaStreamDB.close() through the iterator owner.
                    }
                }
            }
        };

        const scheduleTrackLoop = async (
            fromSession: number,
            preloadEnd: number
        ) => {
            if (isInactiveSession(fromSession)) {
                return;
            }

            const tracksToRemove: [
                Track<WebcodecsStreamDB | AudioStreamDB>,
                boolean,
            ][] = [];

            for (const track of currentTrackOptions) {
                if (
                    currentTracks.has(track.idString) ||
                    consumedTracks.has(track.idString)
                ) {
                    continue;
                }

                const currentTime = mediaTime();
                if (currentTime === "live") {
                    await maybeChangeTrack({ add: track, isOption: true });
                } else {
                    if (
                        track.startTime - preloadTime <= currentTime || // ready to play (- preload because we want to load the track earlier since it will take some time to fetch the frames)
                        (currentTracks.size === 0 && startPlayAt == null) // no tracks playing and not started playing yet
                    ) {
                        if (
                            track.endTime == null ||
                            track.endTime > currentTime
                        ) {
                            await maybeChangeTrack({
                                add: track,
                                isOption: true,
                            });
                        } else {
                            tracksToRemove.push([
                                track,
                                track.endTime < currentTime,
                            ]);
                        }
                    }
                }
            }

            for (const [track, ended] of tracksToRemove) {
                await removeTrack({ track, ended });
            }

            if (!isInactiveSession(fromSession)) {
                requestAnimationFrame(() => {
                    void scheduleTrackLoop(fromSession, preloadEnd).catch(
                        (error) => {
                            if (!isClosedError(error) && !closed) {
                                console.error(
                                    "Media track scheduling failed",
                                    error
                                );
                            }
                        }
                    );
                });
            }
        };

        let pauseController = new AbortController();
        let pendingPlayController: AbortController | undefined;
        let ownerClosePromise: Promise<void> | undefined;

        const closeListener = (event: CustomEvent<Program>) => {
            // Child-program close events bubble through parents. A track lease
            // release must not be mistaken for this MediaStreamDB closing.
            if (event.detail !== this) {
                return;
            }
            pauseController.abort("Closed");
            void closeFromOwner().catch((error) => {
                if (!isClosedError(error)) {
                    console.error("Failed to close media iterator", error);
                }
            });
        };

        let startProgressBarMediaTimeValue = startProgressBarMediaTime();
        if (startProgressBarMediaTimeValue === "live") {
            const processTrackChange = async (
                change: CustomEvent<DocumentsChange<Track, TrackIndexable>>
            ) => {
                if (change.detail.added) {
                    for (const added of change.detail.added) {
                        await maybeChangeTrack({ add: added }); // TODO only add trackes we want to listen on
                    }
                }
                if (change.detail.removed) {
                    for (const remove of change.detail.removed) {
                        await maybeChangeTrack({ remove: remove });
                    }
                }
            };
            const listener = (
                change: CustomEvent<DocumentsChange<Track, TrackIndexable>>
            ) => {
                void processTrackChange(change).catch((error) => {
                    if (
                        !closed &&
                        !pauseController.signal.aborted &&
                        !isClosedError(error)
                    ) {
                        console.error(
                            "Failed to process a live media track change",
                            error
                        );
                    }
                });
            };

            close = () =>
                this.tracks.events.removeEventListener("change", listener);
            pause = close;
            play = async () => {
                this.tracks.events.removeEventListener("change", listener);
                this.tracks.events.addEventListener("change", listener);

                await this.getLatest({
                    signal: pauseController.signal,
                }).then(async (tracks) => {
                    //  const openTracks = await Promise.all(tracks.map(async (x) => { const openTrack = await this.node.open(x); openTrack.source.chunks.log.waitForReplicator(this.owner); return openTrack }))
                    /* console.log("LATEST", tracks); */
                    return processTrackChange(
                        new CustomEvent("change", {
                            detail: { added: tracks, removed: [] },
                        })
                    );
                });
            };
            mediaTime = () => "live";
        } else {
            let playbackTime = startProgressBarMediaTimeValue;
            // create a iterator that goes from `progressBarMediaTime` and forward
            // for every overlapping track, open it, and iterate until the end

            const createIterator = (progressValue: number) => {
                if (progressValue == null) {
                    return undefined;
                }

                return this.tracks.index.iterate(
                    typeof progressValue === "number"
                        ? new SearchRequest({
                              query: [
                                  new Or([
                                      new IsNull({
                                          key: "endTime",
                                      }),
                                      new IntegerCompare({
                                          key: "endTime",
                                          compare: Compare.Greater,
                                          value: progressValue,
                                      }),
                                  ]),
                              ],
                              sort: [
                                  new Sort({
                                      direction: SortDirection.ASC,
                                      key: "startTime",
                                  }),
                              ],
                          })
                        : new SearchRequest({
                              query: [
                                  new IsNull({
                                      key: "endTime",
                                  }),
                              ],
                          }),
                    {
                        local: true,
                        remote: {
                            replicate: opts?.replicate ?? true,
                        },
                        signal: pauseController.signal,
                    }
                );
            };

            let tracksIterator: ReturnType<typeof createIterator> | undefined =
                undefined;
            let pendingTracksIteratorClosure:
                | ReturnType<typeof createIterator>
                | undefined;
            const closeTracksIterator = async () => {
                if (tracksIterator) {
                    pendingTracksIteratorClosure ??= tracksIterator;
                    tracksIterator = undefined;
                }
                if (pendingTracksIteratorClosure) {
                    await pendingTracksIteratorClosure.close();
                    pendingTracksIteratorClosure = undefined;
                }
            };

            const bufferLoop = async (currentSession: number) => {
                // buffer tracks that are to start, or should start with at least bufferTime
                const progressValue = startProgressBarMediaTime();
                let nextCheckTime = 100; // milliseconds;

                if (typeof progressValue === "number") {
                    if (!tracksIterator) {
                        // A terminal playback metadata snapshot is final for a
                        // close-on-end iterator. Reopening it from the original
                        // progress value can resurrect an already-consumed
                        // track option while a future option is still waiting
                        // to start, permanently blocking the close gate.
                        if (opts?.closeOnEnd && recordedMetadataExhausted) {
                            scheduleMaybeCloseOnRecordedEnd(currentSession);
                            return;
                        }
                        // The initial progress value seeds playback once. A
                        // pause closes this metadata iterator too, but reopening
                        // it must preserve the media time captured by pause().
                        // Resetting on every iterator recreation replays the
                        // already-delivered prefix after pause -> play.
                        playbackTime ??= progressValue;
                        recordedMetadataExhausted = false;
                        tracksIterator = createIterator(progressValue);
                    }

                    const bufferAhead = 1e6; // microseconds
                    const bufferTo = progressValue + bufferAhead;
                    nextCheckTime = bufferAhead / 1e3; // microseconds to milliseconds

                    while (tracksIterator != null) {
                        if (session !== currentSession) {
                            return;
                        }
                        const current = await tracksIterator.next(1);
                        if (isInactiveSession(currentSession)) {
                            return;
                        }
                        if (current.length === 0) {
                            if (tracksIterator.done()) {
                                recordedMetadataExhausted = true;
                                await closeTracksIterator();
                                scheduleMaybeCloseOnRecordedEnd(currentSession);
                                if (opts?.closeOnEnd) {
                                    return;
                                }
                            }
                            // Empty non-terminal pages are legal while remote
                            // metadata is still recovering. Keep the iterator
                            // and retry after the positive buffer-loop delay.
                            break;
                        }
                        for (const track of current) {
                            opts?.debug &&
                                console.log("ADD OPTION", track.startTime);
                            addTrackAsOption(track);
                        }

                        const last = current[current.length - 1];
                        if (last.startTime > bufferTo) {
                            nextCheckTime = (last.startTime - bufferTo) / 1e3; // microseconds to milliseconds
                            break;
                        }
                    }
                }

                delay(nextCheckTime, { signal: pauseController.signal })
                    .then(() => bufferLoop(currentSession))
                    .catch((e) => {
                        if (
                            e instanceof AbortError ||
                            isClosedError(e) ||
                            closed ||
                            session !== currentSession
                        ) {
                            return;
                        }
                        console.error("Media track buffer loop failed", e);
                    });
            };

            // TODO

            pause = async () => {
                if (playing) {
                    playing = false;
                    if (playbackTime == undefined) {
                        playbackTime = 0;
                    }

                    playbackTime = mediaTime() as number;
                    accumulatedLag = 0;
                    laggiestTime = undefined;
                    laggingSources.clear();
                    startPlayAt = undefined;
                }
                await closeTracksIterator();
            };

            close = async () => {
                /* console.log("CLOSE TRACKS"); */
                await pause();
            };

            play = async () => {
                await closeTracksIterator();
                playing = true;
                await bufferLoop(session);
            };

            mediaTime = () => {
                if (playbackTime == undefined) {
                    playbackTime = 0;
                }
                let now = Number(hrtimeMicroSeconds());
                const time =
                    -totalLag(now) +
                    playbackTime +
                    (startPlayAt != null ? now - startPlayAt! : 0);
                return time;
            };
        }

        const closeCurrentTracks = async () => {
            const tracks = [...currentTracks.values()];
            currentTracks.clear();
            for (const track of tracks) {
                consumedTracks.delete(track.track.idString);
                pendingTrackClosures.add(track);
            }
            const pending = [...pendingTrackClosures];
            const results = await Promise.allSettled(
                pending.map((track) =>
                    Promise.resolve().then(() => track.close?.())
                )
            );
            const failures: unknown[] = [];
            results.forEach((result, index) => {
                if (result.status === "fulfilled") {
                    pendingTrackClosures.delete(pending[index]);
                } else {
                    failures.push(result.reason);
                }
            });
            throwCleanupFailures(
                failures,
                "Failed to close media iterator track resources"
            );
        };

        const doPlayCtrl = async (controller: AbortController) => {
            if (pendingPlayController === controller) {
                pendingPlayController = undefined;
            }
            if (closed || !paused || controller.signal.aborted) {
                return;
            }
            // A previous cleanup failure remains fenced and retryable. Do not
            // admit replacement tracks until that debt is cleared.
            await closeCurrentTracks();
            if (closed || controller.signal.aborted) {
                return;
            }
            pauseController = controller;
            this.events.addEventListener("close", closeListener);
            session++;
            paused = false;
            const requestedSession = session;
            try {
                await play();
                if (isInactiveSession(requestedSession)) {
                    return;
                }
                await scheduleTrackLoop(
                    requestedSession,
                    Number(hrtimeMicroSeconds()) + 1e6
                );
                if (!isInactiveSession(requestedSession)) {
                    void renderLoop(requestedSession).catch((error) => {
                        if (!isClosedError(error) && !closed) {
                            console.error("Media render loop failed", error);
                        }
                    });
                }
            } catch (error) {
                const interrupted = controller.signal.aborted;
                controller.abort("Playback failed");
                if (session === requestedSession) {
                    session++;
                    paused = true;
                }
                await Promise.allSettled([
                    Promise.resolve().then(() => pause()),
                    openTrackQueue.onIdle(),
                ]);
                await closeCurrentTracks().catch(() => {});
                this.events.removeEventListener("close", closeListener);
                if (interrupted) {
                    return;
                }
                throw error;
            }
        };

        const doPauseCtrl = async () => {
            pauseController.abort("Paused");
            if (!paused) {
                session++;
                paused = true;
            }
            const results = await Promise.allSettled([
                Promise.resolve().then(() => pause()),
                openTrackQueue.onIdle(),
            ]);
            const failures = results
                .filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected"
                )
                .map((result) => result.reason);
            try {
                await closeCurrentTracks();
            } catch (error) {
                failures.push(error);
            }
            throwCleanupFailures(
                failures,
                "Failed to pause media iterator cleanly"
            );
        };

        let closeHadTracks = false;
        let closeHadOptions = false;
        let closeFenced = false;
        let closeTailPrepared = false;
        let closeTailComplete = false;
        let closeTracksNotified = false;
        let closeOptionsNotified = false;
        let closeNotified = false;
        const fenceClose = () => {
            if (closeFenced) {
                return;
            }
            closeFenced = true;
            closeHadTracks = tracksStatePublished;
            closeHadOptions = trackOptionsStatePublished;
            session++;
            closed = true;
            paused = true;
            requestedPaused = true;
            pauseController.abort("Closed");
            pendingPlayController?.abort("Closed");
        };
        const doCloseCtrl = async () => {
            fenceClose();
            const failures: unknown[] = [];
            const attempt = async (cleanup: () => void | Promise<void>) => {
                try {
                    await cleanup();
                } catch (error) {
                    if (error instanceof AggregateError) {
                        failures.push(...error.errors);
                    } else {
                        failures.push(error);
                    }
                }
            };
            await attempt(stopIteratorSubscriptions);
            await attempt(async () => {
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => close()),
                    openTrackQueue.onIdle(),
                ]);
                const nestedFailures = results
                    .filter(
                        (result): result is PromiseRejectedResult =>
                            result.status === "rejected"
                    )
                    .map((result) => result.reason);
                throwCleanupFailures(
                    nestedFailures,
                    "Failed to stop media playback work"
                );
            });
            await attempt(closeCurrentTracks);
            throwCleanupFailures(
                failures,
                "Failed to close media iterator cleanly"
            );

            if (closeTailComplete) {
                return;
            }
            if (!closeTailPrepared) {
                closeTailPrepared = true;
                currentTrackOptions.splice(0, currentTrackOptions.length);
                this.events.removeEventListener("close", closeListener);
                this.events.removeEventListener("maxTime", maxtimeListener);
                callerAbortListener &&
                    opts?.signal?.removeEventListener(
                        "abort",
                        callerAbortListener
                    );
            }

            const notifications: Promise<void>[] = [];
            if (!closeTracksNotified) {
                if (!closeHadTracks || !opts?.onTracksChange) {
                    closeTracksNotified = true;
                } else {
                    notifications.push(
                        Promise.resolve()
                            .then(() =>
                                invokeTerminalNotification(
                                    () => publishTracksChange([]),
                                    "tracks"
                                )
                            )
                            .then(() => {
                                closeTracksNotified = true;
                            })
                    );
                }
            }
            if (!closeOptionsNotified) {
                if (!closeHadOptions || !opts?.onTrackOptionsChange) {
                    closeOptionsNotified = true;
                } else {
                    notifications.push(
                        Promise.resolve()
                            .then(() =>
                                invokeTerminalNotification(
                                    () => publishTrackOptionsChange([]),
                                    "track-options"
                                )
                            )
                            .then(() => {
                                closeOptionsNotified = true;
                            })
                    );
                }
            }
            if (!closeNotified) {
                if (!opts?.onClose) {
                    closeNotified = true;
                } else {
                    notifications.push(
                        Promise.resolve()
                            .then(() =>
                                invokeTerminalNotification(
                                    () => opts.onClose!(),
                                    "close"
                                )
                            )
                            .then(() => {
                                closeNotified = true;
                            })
                    );
                }
            }
            const notificationResults = await Promise.allSettled(notifications);
            throwCleanupFailures(
                notificationResults
                    .filter(
                        (result): result is PromiseRejectedResult =>
                            result.status === "rejected"
                    )
                    .map((result) => result.reason),
                "Failed to notify media iterator closure"
            );
            closeTailComplete = true;
            this.activeMediaConsumers.delete(closeFromOwner);
        };

        const controlQueue = new PQueue({ concurrency: 1 });
        let controlIntent = 0;
        const playCtrl = async () => {
            if (closed) {
                return;
            }
            const intent = ++controlIntent;
            let controller = pendingPlayController ?? pauseController;
            if (requestedPaused || controller.signal.aborted) {
                controller = new AbortController();
                pendingPlayController = controller;
            }
            requestedPaused = false;
            try {
                await controlQueue.add(() => doPlayCtrl(controller));
            } catch (error) {
                if (controlIntent === intent) {
                    requestedPaused = true;
                }
                throw error;
            }
        };
        const pauseCtrl = async () => {
            controlIntent++;
            requestedPaused = true;
            // Fence in-flight and not-yet-started reads before waiting behind
            // them in the serialized control queue.
            pauseController.abort("Paused");
            pendingPlayController?.abort("Paused");
            await controlQueue.add(doPauseCtrl);
        };
        const closeCtrl = async () => {
            controlIntent++;
            requestedPaused = true;
            fenceClose();
            await controlQueue.add(doCloseCtrl);
        };
        function closeFromOwner() {
            if (!ownerClosePromise) {
                const closing = closeCtrl();
                ownerClosePromise = closing;
                void closing.catch(() => {
                    if (ownerClosePromise === closing) {
                        ownerClosePromise = undefined;
                    }
                });
            }
            return ownerClosePromise!;
        }
        const callerAbortListener = () => {
            fenceClose();
            void closeFromOwner().catch((error) => {
                if (!isClosedError(error)) {
                    console.error(
                        "Failed to close an aborted media iterator",
                        error
                    );
                }
            });
        };
        try {
            // The async setup above can overlap a final stream close/drop. Make
            // admission and registration adjacent so teardown either sees this
            // exact closer or this setup rejects and retires itself.
            this.assertMediaResourceAdmissionOpen();
            opts?.signal?.addEventListener("abort", callerAbortListener, {
                once: true,
            });
            this.activeMediaConsumers.add(closeFromOwner);
            if (opts?.signal?.aborted) {
                callerAbortListener();
                await closeFromOwner();
                throw new AbortError();
            }
            await playCtrl();
            if (opts?.signal?.aborted) {
                await closeFromOwner();
                throw new AbortError();
            }
            // A final close/drop can begin while the initial play operation is
            // awaiting remote metadata. Do not return a handle that teardown
            // has already fenced and closed.
            this.assertMediaResourceAdmissionOpen();
        } catch (error) {
            await closeFromOwner().catch(() => {});
            throw error;
        }

        return {
            time: () => mediaTime(), // startProgressBarMediaTime === 'live' ? 'live' : latestPlayedFrameTime(),
            options: () => filterTracksInTime(currentTrackOptions),
            current: currentTracks,
            play: playCtrl,
            pause: pauseCtrl,
            get paused() {
                return requestedPaused;
            },
            selectOption,
            close: closeFromOwner,
            get isLagging() {
                return laggiestTime != null;
            },
        };
    }

    async getReplicatedRanges(): Promise<ReplicationRangeIndexable<any>[]> {
        // for all open tracks fetch all my segments are return them
        const ret: ReplicationRangeIndexable<any>[] = [];
        for (const [_address, track] of this.openedTracks) {
            const ranges =
                await track.source.chunks.log.getMyReplicationSegments();
            for (const range of ranges) {
                ret.push(range);
            }
        }
        return ret;
    }

    private async closeOpenTracks() {
        const failures: unknown[] = [];
        for (const [address, track] of [...this.openedTracks]) {
            const pendingLiveEnd = [...this.trackLeases.values()].some(
                (lease) => lease.track === track && lease.liveReplicationStarted
            );
            if (pendingLiveEnd) {
                // A registered consumer already owns the exact retry for a
                // failed live-subscription shutdown. Retiring the generic
                // track handle here would make that closer appear successful
                // on its next attempt while silently discarding the debt.
                continue;
            }
            try {
                await this.releaseTrackParent(track);
                if (this.openedTracks.get(address) === track) {
                    this.openedTracks.delete(address);
                }
                for (const [trackId, lease] of this.trackLeases) {
                    if (lease.track === track) {
                        this.trackLeases.delete(trackId);
                        this.retireTrackLeaseQueue(trackId, lease.trackQueue);
                    }
                }
            } catch (error) {
                // Preserve the owned handle so a repeated close/drop retries
                // the exact resource that failed.
                failures.push(error);
            }
        }
        throwCleanupFailures(failures, "Failed to close media tracks");
    }

    private async closeActiveMediaConsumers() {
        const consumers = [...this.activeMediaConsumers];
        const results = await Promise.allSettled(
            consumers.map((close) => Promise.resolve().then(() => close()))
        );
        const failures: unknown[] = [];
        results.forEach((result, index) => {
            const close = consumers[index];
            if (result.status === "fulfilled") {
                this.activeMediaConsumers.delete(close);
            } else {
                // A closer may remove itself before nested cleanup rejects.
                // Retain it so the next close call can retry the debt.
                this.activeMediaConsumers.add(close);
                failures.push(result.reason);
            }
        });
        await this.waitForTrackLeaseQueues();
        throwCleanupFailures(failures, "Failed to close media consumers");
    }

    private async drainMediaResources() {
        const failures: unknown[] = [];
        const attempt = async (cleanup: () => Promise<void>) => {
            try {
                await cleanup();
            } catch (error) {
                if (error instanceof AggregateError) {
                    failures.push(...error.errors);
                } else {
                    failures.push(error);
                }
            }
        };
        await attempt(() => this.closeActiveMediaConsumers());
        await attempt(() => this.closeDefaultTrackReplications());
        await attempt(() => this.closeOpenTracks());
        throwCleanupFailures(failures, "Failed to close media resources");
    }

    private closeMediaResources() {
        if (this.mediaResourcesClosePromise) {
            return this.mediaResourcesClosePromise;
        }
        this.mediaResourcesClosing = true;
        const closing = this.drainMediaResources();
        this.mediaResourcesClosePromise = closing;
        void closing.catch(() => {
            // Keep exact failed handles in their owning maps, but allow the
            // next terminal call to retry the drain while those sources are
            // still open.
            if (this.mediaResourcesClosePromise === closing) {
                this.mediaResourcesClosePromise = undefined;
            }
        });
        return closing;
    }

    public async setEnd(track: Track<any>, time?: bigint | number) {
        if (track.endTime == null) {
            track.setEnd(
                typeof time === "number" ? BigInt(Math.ceil(time)) : time
            );
            await this.tracks.put(track, {
                target: "replicators",
            });
        }
    }

    async close(args?: any) {
        if (args && !this.parents?.includes(args) && !this.closed) {
            // Let Program report the invalid parent without tearing down
            // resources still owned by legitimate parents.
            return super.close(args);
        }
        if (!this.closed && this.isNonFinalParentRelease(args)) {
            // A non-final parent release must leave shared consumers alive.
            return super.close(args);
        }
        // This is a final close according to the same synchronous parent rule
        // used by Program. Fence Handler reuse before the first await, then
        // drain live consumers while their child track programs are still
        // open. A failed drain remains retryable and never delegates to the
        // base close prematurely.
        this.preventParentAttachments();
        this._trackChangeListener &&
            this.tracks.events.removeEventListener(
                "change",
                this._trackChangeListener
            );
        await this.closeMediaResources();
        const closed = await super.close(args);
        if (!closed) {
            throw new Error(
                "Media stream final close became non-final after its attachment fence"
            );
        }
        return closed;
    }

    async drop(args?: any) {
        if (args && !this.parents?.includes(args)) {
            return super.drop(args);
        }
        if (this.isNonFinalParentRelease(args)) {
            // A non-final parent release must leave shared consumers alive.
            return super.drop(args);
        }
        // Destructive media cleanup runs before Program.drop() can establish
        // its own terminal fence. Block concurrent parent adoption across that
        // outer cleanup window.
        this.preventParentAttachments();
        this.mediaResourcesClosing = true;
        await this.closeMediaResources();
        return super.drop(args);
    }
}

@variant("media_stream_db_indexable")
class MediaStreamDBIndexable {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    owner: PublicSignKey;

    constructor(mediaStream: MediaStreamDB) {
        this.id = mediaStream.id;
        this.owner = mediaStream.owner;
    }
}

/**
 * A database containing media streams so we can replicate any streams
 */
@variant("media-streams-library")
export class MediaStreamDBs extends Program {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: option(PublicSignKey) })
    owner?: PublicSignKey;

    @field({ type: Documents })
    mediaStreams: Documents<MediaStreamDB, MediaStreamDBIndexable>;

    constructor(props?: { id?: Uint8Array; owner?: PublicSignKey }) {
        super();
        const id = props?.id || sha256Sync(fromString("media-streams-library"));
        this.owner = props?.owner;

        this.id = id;

        this.mediaStreams = new Documents({
            id: sha256Sync(concat([this.id, fromString("media-streams")])),
        });
    }

    private _idString: string | undefined = undefined;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }

    private _replicateOptions: "all" | "owned" | false = false;
    private replicatedStreams: Map<string, MediaStreamDB> = new Map();
    private replicatedStreamQueue = new PQueue({ concurrency: 1 });
    private replicatedStreamsClosing = false;
    private replicatedStreamsClosePromise: Promise<void> | undefined;

    private _streamListener: (
        args: CustomEvent<
            DocumentsChange<MediaStreamDB, MediaStreamDBIndexable>
        >
    ) => void;

    private shouldReplicateStream() {
        return (
            this._replicateOptions === "all" ||
            (this._replicateOptions === "owned" &&
                !!this.owner &&
                this.node.identity.publicKey.equals(this.owner))
        );
    }

    private isNonFinalParentRelease(from?: Program) {
        const parentIndex = this.parents?.findIndex(
            (parent) => parent === from
        );
        return (
            parentIndex != null &&
            parentIndex >= 0 &&
            (this.parents?.length ?? 0) > 1
        );
    }

    private async closeReplicatedStreamHandle(current: MediaStreamDB) {
        if (current.parents?.includes(this)) {
            await current.close(this);
            return;
        }
        if (current.closed) {
            // MediaStreamDB closes its process-local consumers after
            // Program.close() has detached the final parent. If that cleanup
            // failed, the retained handle is closed but still owns retry debt.
            await current.close();
        }
    }

    private forgetReplicatedStreamHandle(
        streamId: string,
        current: MediaStreamDB
    ) {
        let childIndex = this.children?.indexOf(current) ?? -1;
        while (childIndex >= 0) {
            this.children.splice(childIndex, 1);
            childIndex = this.children.indexOf(current);
        }
        if (this.replicatedStreams.get(streamId) === current) {
            this.replicatedStreams.delete(streamId);
        }
    }

    private async ensureReplicatedStream(stream: MediaStreamDB) {
        const streamId = stream.idString;
        return this.replicatedStreamQueue.add(async () => {
            if (this.replicatedStreamsClosing) {
                return undefined;
            }
            const current = this.replicatedStreams.get(streamId);
            if (current && !current.closed) {
                return current;
            }
            if (current) {
                await this.closeReplicatedStreamHandle(current);
                this.forgetReplicatedStreamHandle(streamId, current);
            }

            // Dynamic document values are not static Program fields, so make
            // the library an explicit Peerbit parent. This gives reused root
            // programs a non-owning parent reference and makes programs first
            // opened here close with the library.
            const opened = await this.node.open<MediaStreamDB>(stream, {
                args: {
                    replicate: this._replicateOptions,
                },
                existing: "reuse",
                parent: this as any,
            });
            this.replicatedStreams.set(streamId, opened);
            if (this.replicatedStreamsClosing) {
                // Delete the retained handle only after close succeeds; the
                // queued close barrier retries it after a transient failure.
                await this.closeReplicatedStreamHandle(opened);
                this.forgetReplicatedStreamHandle(streamId, opened);
                return undefined;
            }
            return opened;
        });
    }

    private async releaseReplicatedStream(streamId: string) {
        await this.replicatedStreamQueue.add(async () => {
            const current = this.replicatedStreams.get(streamId);
            if (!current) {
                return;
            }
            await this.closeReplicatedStreamHandle(current);
            this.forgetReplicatedStreamHandle(streamId, current);
        });
    }

    private async drainReplicatedStreams() {
        this.replicatedStreamsClosing = true;
        const failures = await this.replicatedStreamQueue.add(async () => {
            const releaseFailures: unknown[] = [];
            for (const [streamId, current] of [
                ...this.replicatedStreams.entries(),
            ]) {
                try {
                    await this.closeReplicatedStreamHandle(current);
                    this.forgetReplicatedStreamHandle(streamId, current);
                } catch (error) {
                    releaseFailures.push(error);
                }
            }
            return releaseFailures;
        });
        await this.replicatedStreamQueue.onIdle();
        throwCleanupFailures(
            failures ?? [new Error("Replicated stream cleanup was cleared")],
            "Failed to close replicated media streams"
        );
    }

    private closeReplicatedStreams() {
        if (this.replicatedStreamsClosePromise) {
            return this.replicatedStreamsClosePromise;
        }
        this.replicatedStreamsClosing = true;
        const closing = this.drainReplicatedStreams();
        this.replicatedStreamsClosePromise = closing;
        void closing.catch(() => {
            if (this.replicatedStreamsClosePromise === closing) {
                this.replicatedStreamsClosePromise = undefined;
            }
        });
        return closing;
    }

    async open(args?: { replicate: "all" | "owned" | false }) {
        this._replicateOptions = args?.replicate || false;
        this.replicatedStreams = new Map();
        this.replicatedStreamQueue = new PQueue({ concurrency: 1 });
        this.replicatedStreamsClosing = false;
        this.replicatedStreamsClosePromise = undefined;

        await this.mediaStreams.open({
            type: MediaStreamDB,
            index: {
                type: MediaStreamDBIndexable,
            },
            replicate:
                this._replicateOptions !== false
                    ? {
                          factor: 1,
                      }
                    : false,
            canOpen: () => false, // we do it manually below
        });
    }

    async afterOpen(): Promise<void> {
        await super.afterOpen();
        if (this.shouldReplicateStream()) {
            this._streamListener = (ev) => {
                void (async () => {
                    for (const added of ev.detail.added) {
                        await this.ensureReplicatedStream(added);
                    }
                    for (const removed of ev.detail.removed) {
                        await this.releaseReplicatedStream(removed.idString);
                    }
                })().catch((error) => {
                    if (
                        !this.replicatedStreamsClosing &&
                        !isClosedError(error)
                    ) {
                        console.error(
                            "Failed to update replicated media streams",
                            error
                        );
                    }
                });
            };
            this.mediaStreams.events.addEventListener(
                "change",
                this._streamListener
            );

            // open all local streams
            for (const stream of await this.mediaStreams.index
                .iterate({}, { local: true, remote: false })
                .all()) {
                await this.ensureReplicatedStream(stream);
            }
        }
    }

    async close(from?: Program): Promise<boolean> {
        if (from && !this.parents?.includes(from) && !this.closed) {
            return super.close(from);
        }
        if (!this.closed && this.isNonFinalParentRelease(from)) {
            return super.close(from);
        }
        this.preventParentAttachments();
        this.replicatedStreamsClosing = true;
        this._streamListener &&
            this.mediaStreams.events.removeEventListener(
                "change",
                this._streamListener
            );
        await this.closeReplicatedStreams();
        const closed = await super.close(from);
        if (!closed) {
            throw new Error(
                "Media stream library final close became non-final after its attachment fence"
            );
        }
        return closed;
    }

    async drop(from?: Program): Promise<boolean> {
        if (from && !this.parents?.includes(from)) {
            return super.drop(from);
        }
        if (this.isNonFinalParentRelease(from)) {
            return super.drop(from);
        }

        // closeReplicatedStreams is irreversible process-local teardown and
        // runs before the base drop. Fence parent admission first so a newly
        // attached owner cannot turn the later base call into a non-final
        // release after its handles are already gone.
        this.preventParentAttachments();

        // Replicated document values are runtime handles, not owned library
        // data. Release those parents before Program.drop() recursively drops
        // the library's actual children (such as the Documents database).
        this._streamListener &&
            this.mediaStreams.events.removeEventListener(
                "change",
                this._streamListener
            );
        await this.closeReplicatedStreams();
        return super.drop(from);
    }
}
