import { useLocation } from "react-router";
import {
    useLayoutEffect,
    useEffect,
    createContext,
    useContext,
    useRef,
    useState,
} from "react";
import type { WithContext } from "@peerbit/document";
import type { Canvas as CanvasDB } from "@giga-app/interface";

/* 1 ────────────────────────────────────────────────────────────────────────── */
export interface FeedSnapshot {
    queryParams?: string; // query params of the current location
    rootId: string; // idString of the canvas you were inside
    anchorId: string; // first reply visible when you left
    offsetY: number; // pixels between viewport‑top and anchor‑top
    loadedUntil: number; // how many replies had been fetched
}

type MinimalLocation = { key: string; pathname: string; search: string };

const idxKey = () => {
    try {
        const idx = (window.history.state as any)?.idx;
        return typeof idx === "number" ? `idx:${idx}` : undefined;
    } catch {
        return undefined;
    }
};

const canonicalizeSearch = (search: string) => {
    const params = new URLSearchParams(search);
    // Treat the default view (`v=feed`) as absent so REPLACEs that only add this
    // param still resolve to the same snapshot key.
    if (params.get("v") === "feed") params.delete("v");

    const entries = Array.from(params.entries()).sort(([ak, av], [bk, bv]) => {
        const keyCmp = ak.localeCompare(bk);
        return keyCmp !== 0 ? keyCmp : av.localeCompare(bv);
    });
    const canonical = new URLSearchParams();
    for (const [k, v] of entries) canonical.append(k, v);

    const qs = canonical.toString();
    return qs ? `?${qs}` : "";
};

const urlKey = (loc: MinimalLocation) =>
    `url:${loc.pathname}${canonicalizeSearch(loc.search)}`;

const keysForLocation = (loc: MinimalLocation) => {
    const keys = [urlKey(loc)];
    const k = idxKey();
    if (k) keys.unshift(k);
    return keys;
};

const cache = new Map<string, FeedSnapshot>();
export const saveSnapshot = (loc: MinimalLocation, snap: FeedSnapshot) => {
    for (const k of keysForLocation(loc)) cache.set(k, snap);
};
export const getSnapshot = (loc: MinimalLocation) => {
    for (const k of keysForLocation(loc)) {
        const snap = cache.get(k);
        if (snap) return snap;
    }
    return undefined;
};
export const consumeSnapshot = (loc: MinimalLocation) => {
    for (const k of keysForLocation(loc)) cache.delete(k);
};

/* 2 ────────────────────────────────────────────────────────────────────────── */
interface LeaveArgs {
    replies: { reply: WithContext<CanvasDB> }[]; // processedReplies
    replyRefs: (HTMLDivElement | null)[]; // ↕ same length
    feedRoot?: CanvasDB;
}
export function useLeaveSnapshot(args: LeaveArgs) {
    const location = useLocation();
    const { replies, replyRefs, feedRoot } = args;
    return (from: CanvasDB) => {
        if (!feedRoot) return;

        const idx = replies.findIndex(
            (r) => r.reply.idString === from.idString
        );
        if (idx === -1) return;

        const node = replyRefs[idx];
        if (!node) return;
        const nodeTop = node.getBoundingClientRect().top; // << screen-relative

        saveSnapshot(location, {
            queryParams: location.search,
            rootId: feedRoot.idString,
            anchorId: from.idString,
            offsetY: nodeTop, // screen relative
            loadedUntil: replies.length,
        });
    };
}

/* 3 ────────────────────────────────────────────────────────────────────────── */
interface RestoreArgs {
    replies: { reply: { idString: string } }[] | undefined;
    loadMore: (n?: number) => Promise<boolean>;
    hasMore: () => boolean;
    iteratorId?: string;
    replyRefs: (HTMLDivElement | null)[];
    setView: (v: string) => void;
    setViewRootById: (id: string) => void;
    onSnapshot: (snap: FeedSnapshot) => void;
    onRestore: (snap: FeedSnapshot) => void;
    isReplyVisible: (id: string) => boolean;
    debug?: boolean;
    enabled?: boolean; // if false, no restoration happens
}

const nextFrame = () =>
    new Promise<void>((r) => requestAnimationFrame(() => r()));

const tag = "[restore]"; // ⇠ easy filter

export function useRestoreFeed(a: RestoreArgs) {
    const location = useLocation();
    const id = `${idxKey() ?? ""}|${urlKey(location)}`;
    const snapRef = useRef<FeedSnapshot | undefined>(undefined);
    const doneRef = useRef(false);
    const [restoring, setRestoring] = useState(false);
    const log = (...args: any[]) => {
        if (!a.debug) return;
        // eslint-disable-next-line no-console
        console.log(...args);
    };

    /* ────────────────────────────────────────────────────────────────── */
    /* 1. restore view & root (once)                                     */
    /* ────────────────────────────────────────────────────────────────── */
    useLayoutEffect(() => {
        const next = getSnapshot(location);
        const current = snapRef.current;
        const setParams = (snap: FeedSnapshot) => {
            if (snap.queryParams) {
                try {
                    const url = new URL(window.location.href);
                    const hash = url.hash || "";
                    const qIndex = hash.indexOf("?");
                    const base =
                        qIndex === -1 ? hash : hash.substring(0, qIndex);
                    const nextQuery = snap.queryParams.startsWith("?")
                        ? snap.queryParams
                        : `?${snap.queryParams}`;
                    const nextHash = base + nextQuery;
                    if (url.hash === nextHash) return;
                    url.hash = nextHash;
                    // Preserve existing history state; react-router stores keys there.
                    window.history.replaceState(
                        window.history.state,
                        "",
                        url.toString()
                    );
                } catch {
                    /* ignore */
                }
            }
        };
        if (current !== next && next) {
            // set query params again
            setParams(next);

            a.onSnapshot(next);
        }
        setRestoring(!!next);
        snapRef.current = next;
        doneRef.current = false;

        if (snapRef.current && !doneRef.current) {
            log(tag, "restore view/root", snapRef.current);
            setParams(snapRef.current);
            a.setViewRootById(snapRef.current.rootId);
        }
    }, [id]);

    /* ────────────────────────────────────────────────────────────────── */
    /* 2. fetch missing pages                                            */
    /* ────────────────────────────────────────────────────────────────── */
    const fetching = useRef(false);
    const lenRef = useRef(0);
    const repliesRef = useRef(a.replies);
    // Keep these refs in sync *synchronously* so layout effects don't see stale values.
    lenRef.current = a.replies?.length || 0;
    repliesRef.current = a.replies;

    const loadMoreAndWait = async (n?: number): Promise<boolean> => {
        const before = lenRef.current;
        const maxWaitTime = 5e3; // ms
        log(tag, "loadMore()", { n });
        let didLoad = false;
        try {
            didLoad = await a.loadMore(n);
        } catch (error) {
            log(tag, "loadMore() threw", error);
            return false;
        }
        if (!didLoad) return false;
        let t0 = Date.now();
        while (lenRef.current === before) {
            await nextFrame();
            if (Date.now() - t0 > maxWaitTime) {
                log(tag, "loadMore() timeout");
                return false;
            }
        }

        log(tag, `loadMore finished – list grew`, {
            before,
            after: lenRef.current,
        });

        return lenRef.current > before;
    };

    const needMore = () => {
        const snap = snapRef.current;
        if (!snap) return false;
        const replies = repliesRef.current ?? [];
        const found = replies.some((r) => r.reply.idString === snap.anchorId);
        if (a.debug) {
            log(tag, "needMore?", {
                len: lenRef.current,
                loadedUntil: snap.loadedUntil,
                found,
                lookingFor: snap.anchorId,
            });
        }

        return (
            lenRef.current < snap.loadedUntil ||
            !replies.some((r) => r.reply.idString === snap.anchorId)
        );
    };

    useEffect(() => {
        if (!a.enabled) {
            log(tag, "Restoration disabled");
            return;
        }

        const snap = snapRef.current;

        if (!snap || doneRef.current || fetching.current) return;

        // Avoid kicking off the restore loop before the stream iterator is ready.
        // When `iteratorId` is missing, the provider can still be returning stubbed loadMore/empty lists.
        if (!a.iteratorId) return;

        if (!needMore()) return;

        log(tag, "start fetching loop", { snap });
        fetching.current = true;

        (async () => {
            try {
                let guard = 0;
                const maxIterations = 200; // safety against broken iterators
                while (
                    guard++ < maxIterations &&
                    !doneRef.current &&
                    needMore()
                ) {
                    if (!a.hasMore()) {
                        // `hasMore()` can transiently return false while the iterator is still initializing.
                        // Prefer `loadMore()` as the authoritative signal (it returns false when exhausted).
                        log(
                            tag,
                            "hasMore() returned false; attempting loadMore anyway"
                        );
                    }
                    const currentLen = lenRef.current;
                    const remaining = Math.max(
                        0,
                        snap.loadedUntil - currentLen
                    );
                    // Prefer a single big fetch to reach the previous depth quickly.
                    // If we already reached loadedUntil but the anchor is still missing, fetch a small extra batch.
                    const n = remaining > 0 ? remaining : 25;
                    log(tag, `loop ${guard}/${maxIterations}`, {
                        currentLen,
                        remaining,
                        n,
                    });
                    const grew = await loadMoreAndWait(n);
                    if (!grew) {
                        log(tag, "loadMore produced no growth; stopping");
                        break;
                    }
                }
                log(tag, "fetching loop done");
            } finally {
                fetching.current = false;
            }
        })().catch((error) => {
            fetching.current = false;
            log(tag, "fetching loop crashed", error);
        });
    }, [id, a.enabled, a.iteratorId]);

    /* ────────────────────────────────────────────────────────────────── */
    /* 3. scroll correction                                              */
    /* ────────────────────────────────────────────────────────────────── */
    useEffect(() => {
        if (doneRef.current) return;
        const snap = snapRef.current;
        if (!snap) return;

        let cancelled = false;
        const tolerancePx = 2;
        const settleFramesRequired = 2;
        const maxWaitMs = 30_000; // allow time to fetch/paint deep items
        let settled = 0;
        const t0 = performance.now();

        const finish = () => {
            if (doneRef.current) return;
            doneRef.current = true;
            consumeSnapshot(location);
            setRestoring(false);
            a.onRestore(snap);
        };

        const tick = () => {
            if (cancelled || doneRef.current) return;
            const elapsed = performance.now() - t0;
            if (elapsed > maxWaitMs) {
                log(tag, "scroll correction timeout");
                finish();
                return;
            }

            const replies = repliesRef.current ?? [];
            const idx = replies.findIndex(
                (r) => r.reply.idString === snap.anchorId
            );
            if (idx === -1) {
                requestAnimationFrame(tick);
                return;
            }

            const node = a.replyRefs[idx];
            if (!node) {
                requestAnimationFrame(tick);
                return;
            }

            const reply = replies[idx];
            if (!reply || !a.isReplyVisible(reply.reply.idString)) {
                requestAnimationFrame(tick);
                return;
            }

            const delta = node.getBoundingClientRect().top - snap.offsetY;
            if (a.debug)
                log(tag, "scroll correction", {
                    idx,
                    delta,
                    elapsedMs: Math.round(elapsed),
                });

            if (Math.abs(delta) <= tolerancePx) {
                settled++;
                if (settled >= settleFramesRequired) {
                    finish();
                    return;
                }
            } else {
                settled = 0;
                window.scrollBy(0, delta);
            }

            requestAnimationFrame(tick);
        };

        requestAnimationFrame(tick);
        return () => {
            cancelled = true;
        };
    }, [a.isReplyVisible, a.replyRefs, a.replies, id]);

    return { restoring };
}

/* 4 ────────────────────────────────────────────────────────────────────────── */
export const LeaveSnapshotContext = createContext<(from: CanvasDB) => void>(
    () => {}
);
export const useLeaveSnapshotFn = () => useContext(LeaveSnapshotContext);
