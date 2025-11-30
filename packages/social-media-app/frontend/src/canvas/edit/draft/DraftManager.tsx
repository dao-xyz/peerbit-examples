import React, { createContext, useContext, useMemo, useRef } from "react";
import { usePeer } from "@peerbit/react";
import {
    AddressReference,
    Canvas,
    getImmediateRepliesQuery,
    getOwnedElementsQuery,
    IndexableCanvas,
    ReplyKind,
    Scope,
} from "@giga-app/interface";
import { PrivateScope, PublicScope } from "../../useScope";
import { WithIndexedContext } from "@peerbit/document";
import { randomBytes } from "@peerbit/crypto";
import debounce from "lodash/debounce";
import type { DebouncedFunc } from "lodash";
import { useDebugConfig } from "../../../debug/DebugConfig";
import { emitDebugEvent } from "../../../debug/debug";
import { toBase64URL } from "@peerbit/crypto";

export type CanvasIx = WithIndexedContext<Canvas, IndexableCanvas>;
export type CanvasKey = Uint8Array;

type DraftRecord = {
    canvas?: CanvasIx;
    replyTo?: CanvasIx;
    isSaving: boolean;
};

type EnsureArgs =
    | { replyTo: CanvasIx; key?: CanvasKey }
    | { key: CanvasKey; replyTo?: CanvasIx };

export const toBucket = (key: CanvasKey) => Canvas.createIdString(key);
export const genKey = (): CanvasKey => randomBytes(32);

export type DraftAPI = {
    ensure(args: EnsureArgs): Promise<CanvasIx>;
    ensureForParent(parent: CanvasIx, key?: CanvasKey): Promise<CanvasIx>;

    get(key: CanvasKey): CanvasIx | undefined;
    getForParent(parent: CanvasIx): CanvasIx | undefined;

    setReplyTarget(key: CanvasKey, replyTo?: CanvasIx): void;
    getReplyTarget(key: CanvasKey): CanvasIx | undefined;

    publish(key: CanvasKey): Promise<void>;

    saveDebounced(key: CanvasKey): void;
    save(key: CanvasKey): Promise<void>;

    /** Union of active record IDs + ephemeral IDs (immediately updated for UI filtering). */
    listActiveIds(): Set<string>;
    isActiveId(idString: string): boolean;

    subscribe(cb: () => void): () => void;

    isPublishing?(key: CanvasKey): boolean;
    isSaving?(key: CanvasKey): boolean;

    abandon(key: CanvasKey): Promise<void>;

    debug: {
        dump(): any;
        clear(key?: CanvasKey): void;
    };
};

const DraftManagerCtx = createContext<DraftAPI | null>(null);
export const useDraftManager = () => {
    const ctx = useContext(DraftManagerCtx);
    if (!ctx)
        throw new Error(
            "useDraftManager must be used within DraftManagerProvider"
        );
    return ctx;
};

const RETIRE_TIMEOUT_MS = 5000;

export const DraftManagerProvider: React.FC<{
    children: React.ReactNode;
    debug?: boolean;
}> = ({ children, debug = false }) => {
    const { peer } = usePeer();
    const privateScope = PrivateScope.useScope();
    const publicScope = PublicScope.useScope();

    // Centralized debug options from DebugConfigProvider with backwards compatibility
    const debugOpts = useDebugConfig();
    const debugEnabled = debug || debugOpts.enabled;
    const parentFilter = debugOpts.parent;
    // Capture events if provider prop debug=true or if DebugConfig explicitly enables it.
    const captureEvents = debugEnabled || !!debugOpts.captureEvents;

    const shouldLogForParent = (parentId?: string) => {
        if (!debugEnabled) return false;
        if (!parentFilter) return true;
        return !!parentId && parentId === parentFilter;
    };

    const log = (...args: unknown[]) => {
        if (debugEnabled) console.debug("[DraftManager]", ...args);
    };

    const logEvt = (name: string, payload: Record<string, unknown>) => {
        if (!shouldLogForParent(payload.parentId as string | undefined)) return;
        try {
            console.debug("[DraftManager]", name, JSON.stringify(payload));
        } catch {}
        if (captureEvents)
            emitDebugEvent({ source: "DraftManager", name, ...payload });
    };

    const records = useRef(new Map<string, DraftRecord>());
    const parentIndex = useRef(new Map<string, string>());
    const debouncers = useRef(
        new Map<string, DebouncedFunc<() => Promise<void>>>()
    );
    const inflightEnsureByBucket = useRef(new Map<string, Promise<CanvasIx>>());
    const inflightEnsureByParent = useRef(new Map<string, Promise<CanvasIx>>());
    const publishQueue = useRef(new Map<string, Promise<void>>());
    // Track most recently published reply per parent to avoid recovering it as an editable draft
    const lastPublishedByParent = useRef(new Map<string, string>());
    const listeners = useRef(new Set<() => void>());
    const publishingFlags = useRef(new Set<string>());
    const retiringActive = useRef(
        new Map<string, ReturnType<typeof setTimeout>>()
    );

    /** IDs considered active immediately (before records has the CanvasIx). */
    const ephemeralActive = useRef(new Set<string>());

    const retireActiveSlowly = (idString: string) => {
        // Make the (soon-to-be-published) old draft invisible to DraftsRow immediately
        if (!retiringActive.current.has(idString)) {
            retiringActive.current.set(
                idString,
                setTimeout(() => {
                    retiringActive.current.delete(idString);
                    notify();
                }, RETIRE_TIMEOUT_MS)
            );
        }
    };

    const notify = () => {
        for (const fn of Array.from(listeners.current)) fn();
    };

    const primeDebouncer = (
        bucket: string,
        api: DraftAPI & { saveRaw: (bucket: string) => Promise<void> }
    ) => {
        if (!debouncers.current.has(bucket)) {
            debouncers.current.set(
                bucket,
                debounce(() => api.saveRaw(bucket), 120)
            );
        }
    };

    // Wait deterministically for private scope to be ready
    const waitForPrivateScope = async (timeoutMs = 5000) => {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
            if (privateScope?.address) return privateScope;
            await new Promise((r) => setTimeout(r, 60));
        }
        throw new Error("Private scope not ready");
    };

    /** Create a persisted draft, but flag it active *before* persistence hits indexes. */
    const createDraftPersisted = async (options?: {
        replyTo?: CanvasIx;
        id?: Uint8Array;
    }): Promise<CanvasIx> => {
        if (!peer) throw new Error("Peer not ready");
        // Drafts must live in PRIVATE scope only
        const home: Scope = await waitForPrivateScope();

        // Pre-reserve id so lists filter it out immediately
        const id = options?.id ?? randomBytes(32);
        const draft = new Canvas({
            id,
            publicKey: peer.identity.publicKey,
            selfScope: new AddressReference({ address: home.address }),
        });

        // Mark as active *optimistically* to avoid flicker in the DraftsRow
        ephemeralActive.current.add(draft.idString);
        notify();

        try {
            const [, created] = await home.getOrCreateReply(
                options?.replyTo,
                draft,
                { kind: new ReplyKind() }
            );
            const createdIx = await created.getSelfIndexedCoerced();
            if (!createdIx)
                throw new Error("Failed to index newly created draft");
            log("createDraftPersisted: created", {
                draftId: createdIx.idString,
                parentId: options?.replyTo?.idString,
                scope: home.address,
            });
            return createdIx;
        } catch (e) {
            // Creation failed → remove optimistic flag
            ephemeralActive.current.delete(draft.idString);
            notify();
            throw e;
        }
    };

    const recoverLatestForParent = async (
        parent: CanvasIx
    ): Promise<CanvasIx | undefined> => {
        try {
            // Ensure private scope is ready
            const home = await waitForPrivateScope().catch(() => undefined);
            // Open parent in PRIVATE scope context to ensure match
            const parentInPrivate = home
                ? await home.openWithSameSettings(parent)
                : parent;
            const children: CanvasIx[] = await privateScope.replies.index
                .iterate({ query: getImmediateRepliesQuery(parentInPrivate) })
                .all();
            /*   console.error("recoverLatestForParent", {
                  parent: parent.idString,
                  count: children.length,
                  ids: children.map((c) => c.idString),
              }); */
            // In private scope, replies are authored by the current user; avoid strict key match to prevent
            // recovery failures if the identity re-initializes between reloads.
            children.sort(
                (a, b) =>
                    Number(a.__context.modified) - Number(b.__context.modified)
            );
            const latest = children.at(-1);
            log("recoverLatestForParent ->", latest?.idString);
            return latest;
        } catch (e) {
            log("recover error", e);
            return undefined;
        }
    };

    const api = useMemo<
        DraftAPI & { saveRaw: (bucket: string) => Promise<void> }
    >(() => {
        // no localStorage draft pointers; rely on private scope only
        const API: DraftAPI & { saveRaw: (bucket: string) => Promise<void> } = {
            async ensure(args) {
                if ("replyTo" in args && args.replyTo) {
                    return API.ensureForParent(args.replyTo, args.key);
                }

                const rawKey = "key" in args ? args.key : genKey();
                const bucket = toBucket(rawKey);

                const hit = records.current.get(bucket)?.canvas;
                if (hit) return hit;

                const inflight = inflightEnsureByBucket.current.get(bucket);
                if (inflight) return inflight;

                const p = (async () => {
                    const created = await createDraftPersisted({
                        replyTo: args.replyTo,
                    });

                    // race check
                    const current = records.current.get(bucket)?.canvas;
                    if (current && current.idString !== created.idString) {
                        // current already set elsewhere; remove optimistic flag for created
                        ephemeralActive.current.delete(created.idString);
                        notify();
                        return current;
                    }

                    records.current.set(bucket, {
                        canvas: created,
                        replyTo: args.replyTo,
                        isSaving: false,
                    });
                    // move from ephemeral → definitive
                    ephemeralActive.current.delete(created.idString);
                    if (args.replyTo)
                        parentIndex.current.set(args.replyTo.idString, bucket);
                    primeDebouncer(bucket, API);
                    notify();
                    log("ensure(id): created", {
                        bucket,
                        draftId: created.idString,
                        parentId: args.replyTo?.idString,
                    });
                    return created;
                })().finally(() => {
                    if (inflightEnsureByBucket.current.get(bucket) === p) {
                        inflightEnsureByBucket.current.delete(bucket);
                    }
                });

                inflightEnsureByBucket.current.set(bucket, p);
                return p;
            },

            async ensureForParent(parent, key) {
                const pid = parent.idString;
                captureEvents &&
                    logEvt("ensureForParent:start", { parentId: pid });

                const requestedBucket = key ? toBucket(key) : undefined;
                const existingBucket = parentIndex.current.get(pid);

                // If caller explicitly requests a different bucket (optimistic rotation),
                // honor it by creating/returning a draft for that bucket and re-pointing
                // the parentIndex to it. This lets DraftSession rotate immediately.
                if (
                    requestedBucket &&
                    existingBucket &&
                    existingBucket !== requestedBucket
                ) {
                    // If we already have a record for the requested bucket, reuse it
                    const already =
                        records.current.get(requestedBucket)?.canvas;
                    if (already) {
                        parentIndex.current.set(pid, requestedBucket);
                        notify();
                        captureEvents &&
                            logEvt("ensureForParent:reuseRequested", {
                                parentId: pid,
                                bucket: requestedBucket,
                                draftId: already.idString,
                            });
                        return already;
                    }

                    // Otherwise create a fresh draft under the requested bucket
                    const created = await createDraftPersisted({
                        replyTo: parent,
                    });
                    records.current.set(requestedBucket, {
                        canvas: created,
                        replyTo: parent,
                        isSaving: false,
                    });
                    ephemeralActive.current.delete(created.idString);
                    parentIndex.current.set(pid, requestedBucket);
                    primeDebouncer(requestedBucket, API);
                    notify();
                    captureEvents &&
                        logEvt("ensureForParent:createdRequested", {
                            parentId: pid,
                            bucket: requestedBucket,
                            draftId: created.idString,
                        });
                    log("ensure(parent): created for requested bucket", {
                        parentId: pid,
                        bucket: requestedBucket,
                        draftId: created.idString,
                    });
                    return created;
                }

                // If we already have a bucket for this parent (and no different requested bucket),
                // return it as before.
                if (existingBucket) {
                    const found = records.current.get(existingBucket)?.canvas;
                    if (found) return found;
                }

                const inflight = inflightEnsureByParent.current.get(pid);
                if (inflight) return inflight;

                const p = (async () => {
                    // Try to recover latest draft in PRIVATE scope so refresh continues editing.
                    const recovered = await recoverLatestForParent(parent);
                    captureEvents &&
                        logEvt("recover:result", {
                            parentId: pid,
                            recoveredId: recovered?.idString,
                        });
                    // Avoid recovering the most recently published reply (not a draft)
                    const lastPub = lastPublishedByParent.current.get(pid);
                    const useRecovered =
                        recovered && recovered.idString !== lastPub;
                    if (useRecovered) {
                        const bucket =
                            existingBucket ??
                            (key ? toBucket(key) : toBucket(genKey()));
                        const now = parentIndex.current.get(pid);
                        if (now) {
                            const cur = records.current.get(now)?.canvas;
                            if (cur && cur.idString !== recovered.idString)
                                return cur;
                        }
                        records.current.set(bucket, {
                            canvas: recovered,
                            replyTo: parent,
                            isSaving: false,
                        });
                        ephemeralActive.current.delete(recovered.idString);
                        parentIndex.current.set(pid, bucket);
                        primeDebouncer(bucket, API);
                        notify();
                        captureEvents &&
                            logEvt("ensureForParent:recovered", {
                                parentId: pid,
                                bucket,
                                draftId: recovered.idString,
                            });
                        log("ensure(parent): recovered", {
                            parentId: pid,
                            bucket,
                            draftId: recovered.idString,
                        });
                        return recovered;
                    }

                    // No recovered draft; create fresh draft in PRIVATE scope
                    const bucket =
                        existingBucket ??
                        (key ? toBucket(key) : toBucket(genKey()));
                    const now = parentIndex.current.get(pid);
                    if (now) {
                        const ex = records.current.get(now)?.canvas;
                        if (ex) return ex;
                    }

                    const created = await createDraftPersisted({
                        replyTo: parent,
                    });

                    records.current.set(bucket, {
                        canvas: created,
                        replyTo: parent,
                        isSaving: false,
                    });
                    // move from ephemeral → definitive
                    ephemeralActive.current.delete(created.idString);
                    parentIndex.current.set(pid, bucket);
                    primeDebouncer(bucket, API);
                    notify();
                    captureEvents &&
                        logEvt("ensureForParent:created", {
                            parentId: pid,
                            bucket,
                            draftId: created.idString,
                        });
                    log("ensure(parent): created", {
                        parentId: pid,
                        bucket,
                        draftId: created.idString,
                    });
                    // no pointer persistence; no background switching

                    return created;
                })().finally(() => {
                    if (inflightEnsureByParent.current.get(pid) === p) {
                        inflightEnsureByParent.current.delete(pid);
                    }
                });

                inflightEnsureByParent.current.set(pid, p);
                return p;
            },

            get(key) {
                return records.current.get(toBucket(key))?.canvas;
            },

            getForParent(parent) {
                const bucket = parentIndex.current.get(parent.idString);
                if (!bucket) return undefined;
                return records.current.get(bucket)?.canvas;
            },

            setReplyTarget(key, replyTo) {
                const bucket = toBucket(key);
                const prev =
                    records.current.get(bucket) ??
                    ({ isSaving: false } as DraftRecord);
                records.current.set(bucket, {
                    ...prev,
                    replyTo,
                    canvas: prev.canvas,
                });
                if (replyTo) {
                    parentIndex.current.set(replyTo.idString, bucket);
                }
                notify();
            },

            getReplyTarget(key) {
                return records.current.get(toBucket(key))?.replyTo;
            },

            async publish(key) {
                const bucket = toBucket(key);
                const prev =
                    publishQueue.current.get(bucket) ?? Promise.resolve();

                // Perf state shared between phases
                let perfStart: number = 0;
                let perfMarks: Record<string, number> | undefined;

                const next = prev
                    .then(async () => {
                        const rec = records.current.get(bucket);
                        if (!rec?.canvas) return;

                        if (debugOpts.perfEnabled) {
                            perfStart = performance.now();
                            perfMarks = {};
                        }
                        const perfMark = (label: string) => {
                            if (!perfMarks) return;
                            perfMarks[label] = performance.now() - perfStart;
                        };

                        publishingFlags.current.add(bucket);
                        notify();

                        // Rotate first
                        const fresh = await createDraftPersisted({
                            replyTo: rec.replyTo,
                        });
                        perfMark("rotate");

                        const toPublish = rec.canvas;
                        captureEvents &&
                            logEvt("publish:rotate", {
                                bucket,
                                oldDraftId: toPublish.idString,
                                newDraftId: fresh.idString,
                                parentId: rec.replyTo?.idString,
                            });
                        log("publish: rotate", {
                            bucket,
                            oldDraftId: toPublish.idString,
                            newDraftId: fresh.idString,
                            parentId: rec.replyTo?.idString,
                        });
                        retireActiveSlowly(toPublish.idString);
                        records.current.set(bucket, { ...rec, canvas: fresh });
                        // no pointer persistence

                        // flush any pending local save and await it (flush may return a Promise
                        // because the debounced function calls async saveRaw). Awaiting ensures
                        // we don't proceed before local persistence/indexing logic has run.
                        await debouncers.current.get(bucket)?.flush?.();
                        perfMark("flushLocal");

                        log("publish: hasParent?", {
                            hasParent: !!rec.replyTo,
                        });
                        // Flush only this draft's canvas indexing if there are pending changes (targeted instead of global)
                        try {
                            await rec.canvas.nearestScope._hierarchicalReindex!.flush(
                                rec.canvas.idString
                            );
                            perfMark("preCanvasFlush");
                        } catch (e) {
                            console.warn(
                                "[DraftManager] publish: preCanvasFlush error",
                                e
                            );
                        }
                        if (rec.replyTo) {
                            try {
                                // Optimization: previously we flushed hierarchical reindex BEFORE upserting the reply (preParentFlush)
                                // to ensure parent indexes were up to date. Empirically this added latency without affecting
                                // correctness for publish because upsertReply itself does not rely on those pending index writes.
                                // We skip the pre flush now and rely on a single flush after upsertReply below.
                                captureEvents &&
                                    logEvt("publish:preFlush:skipped", {
                                        bucket,
                                        parentId: rec.replyTo.idString,
                                    });
                                const parent = rec.replyTo;
                                const draftScope = toPublish.nearestScope;
                                log("publish: syncing draft to parent", {
                                    elements:
                                        await rec.canvas.countOwnedElements(),
                                    draftId: toPublish.idString,
                                    parentId: parent.idString,
                                });
                                await parent.upsertReply(toPublish, {
                                    type: "sync",
                                    targetScope: parent.nearestScope,
                                    updateHome: "set",
                                    visibility: "both",
                                    kind: new ReplyKind(),
                                    debug,
                                });
                                perfMark("upsertReply");
                                // Targeted flushes to make both the parent and the reply readable immediately
                                await parent.nearestScope._hierarchicalReindex!.flush(
                                    parent.idString
                                );
                                try {
                                    await parent.nearestScope._hierarchicalReindex!.flush(
                                        toPublish.idString
                                    );
                                } catch {}
                                // Emit debug event after flush to ensure the consumer can navigate and read
                                // Use base64url(canvas.id) so tests can use it for both URL and DOM selectors
                                if (captureEvents) {
                                    logEvt("replyPublished", {
                                        replyId: toBase64URL(toPublish.id),
                                        parentId: parent.idString,
                                    });
                                }
                                // Remember last published for this parent to not recover it as draft
                                try {
                                    lastPublishedByParent.current.set(
                                        parent.idString,
                                        toPublish.idString
                                    );
                                } catch {}
                                perfMark("parentFlush");

                                // Drop the published draft from the private scope so it does not linger
                                // as a recoverable draft (and show up in DraftsRow) after refresh.
                                try {
                                    if (
                                        draftScope &&
                                        draftScope !== parent.nearestScope
                                    ) {
                                        await draftScope.remove(toPublish, {
                                            drop: true,
                                        });
                                        if (captureEvents) {
                                            logEvt("publish:cleanupDraft", {
                                                bucket,
                                                draftId: toPublish.idString,
                                                parentId: parent.idString,
                                            });
                                        }
                                    }
                                } catch (cleanupError) {
                                    console.warn(
                                        "[DraftManager] publish: cleanup error",
                                        cleanupError
                                    );
                                }
                            } catch (e) {
                                console.error(
                                    "[DraftManager] publish: sync error",
                                    e
                                );
                            }
                        } else {
                            log("publish: no parent to sync to");
                        }

                        // move from ephemeral → definitive
                        ephemeralActive.current.delete(fresh.idString);
                        notify();
                    })
                    .finally(() => {
                        publishingFlags.current.delete(bucket);
                        if (publishQueue.current.get(bucket) === next)
                            publishQueue.current.delete(bucket);
                        // 🔔 let subscribers recompute isPublishing=false
                        notify();
                        log("publish: done", { bucket });
                        try {
                            if (debugOpts.perfEnabled && perfMarks) {
                                const payload = {
                                    bucket,
                                    ...perfMarks,
                                    total: Object.keys(perfMarks).length
                                        ? perfMarks[
                                              Object.keys(
                                                  perfMarks
                                              ).pop() as string
                                          ]
                                        : 0,
                                } as any;
                                console.info("[Perf] publish timings", payload);
                                window.dispatchEvent(
                                    new CustomEvent("perf:publish", {
                                        detail: payload,
                                    })
                                );
                            }
                        } catch {}
                    });

                publishQueue.current.set(bucket, next);
                return next;
            },

            async save(key) {
                const bucket = toBucket(key);
                await API.saveRaw(bucket);
                // no pointer persistence on save
            },

            saveDebounced(key) {
                const bucket = toBucket(key);
                debouncers.current.get(bucket)?.();
            },

            async saveRaw(bucket: string) {
                const rec = records.current.get(bucket);
                if (!rec?.canvas || rec.isSaving) return;
                rec.isSaving = true;
                try {
                    // UI does actual persistence; flag only.
                } finally {
                    rec.isSaving = false;
                }
            },

            async abandon(key: CanvasKey) {
                const bucket = toBucket(key);

                // remove record + ephemeral/retiring
                const rec = records.current.get(bucket);
                if (rec?.canvas) {
                    const id = rec.canvas.idString;
                    // clear ephemeral/retiring flags for this canvas id
                    ephemeralActive.current.delete(id);
                    const t = retiringActive.current.get(id);
                    if (t) {
                        clearTimeout(t);
                        retiringActive.current.delete(id);
                    }

                    // also if the Canvas is empty remove from its scope
                    if (await rec.canvas.isEmpty()) {
                        log("abandon: removing empty draft", {
                            bucket,
                            draftId: id,
                        });
                        try {
                            await rec.canvas.nearestScope.remove(rec.canvas, {
                                drop: true,
                            });
                        } catch (error) {
                            console.error(
                                "Failed to remove abandoned draft from scope",
                                error
                            );
                        }
                    }
                }

                // drop queues / debouncers
                debouncers.current.get(bucket)?.cancel?.();
                debouncers.current.delete(bucket);
                publishQueue.current.delete(bucket);

                // unlink from parentIndex
                for (const [pid, b] of Array.from(
                    parentIndex.current.entries()
                )) {
                    if (b === bucket) parentIndex.current.delete(pid);
                }

                // finally drop the record
                records.current.delete(bucket);

                notify();
            },

            listActiveIds() {
                const all = new Set<string>(ephemeralActive.current);
                for (const r of records.current.values()) {
                    if (r.canvas) {
                        all.add(r.canvas.idString);
                    }
                }
                for (const id of retiringActive.current.keys()) {
                    all.add(id);
                }
                return all;
            },

            isActiveId(idString: string) {
                return (
                    ephemeralActive.current.has(idString) ||
                    (records.current.size > 0 &&
                        Array.from(records.current.values()).some(
                            (r) => r.canvas?.idString === idString
                        )) ||
                    retiringActive.current.has(idString)
                );
            },

            subscribe(cb: () => void) {
                listeners.current.add(cb);
                return () => listeners.current.delete(cb);
            },

            isPublishing(key) {
                return publishingFlags.current.has(toBucket(key));
            },

            isSaving(key) {
                const rec = records.current.get(toBucket(key));
                return !!rec?.isSaving;
            },

            debug: {
                dump: () => ({
                    records: Array.from(records.current.entries()).map(
                        ([bucket, rec]) => ({
                            bucket,
                            draftId: rec.canvas?.idString,
                            parentId: rec.replyTo?.idString,
                        })
                    ),
                    parentIndex: Array.from(parentIndex.current.entries()),
                    publishQueue: Array.from(publishQueue.current.keys()),
                    publishing: Array.from(publishingFlags.current.keys()),
                    ephemeralActive: Array.from(
                        ephemeralActive.current.values()
                    ),
                }),
                clear: (key?: CanvasKey) => {
                    const buckets = key
                        ? [toBucket(key)]
                        : Array.from(records.current.keys());
                    buckets.forEach((b) => {
                        const rec = records.current.get(b);
                        if (rec?.canvas) {
                            try {
                                rec.canvas.nearestScope
                                    ?.remove(rec.canvas, { drop: true })
                                    .catch(() => void 0);
                            } catch {}
                        }
                        records.current.delete(b);
                        debouncers.current.get(b)?.cancel?.();
                        debouncers.current.delete(b);
                        publishQueue.current.delete(b);
                    });
                    if (!key) {
                        parentIndex.current.clear();
                        ephemeralActive.current.clear();
                        [...retiringActive.current.values()].forEach(
                            clearTimeout
                        );
                        retiringActive.current.clear();
                    }
                    notify();
                },
            },
        };

        return API;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        peer?.identity.publicKey.hashcode(),
        privateScope?.address,
        publicScope?.address,
        debug,
        debugOpts.perfEnabled,
    ]);

    return (
        <DraftManagerCtx.Provider value={api}>
            {children}
        </DraftManagerCtx.Provider>
    );
};
