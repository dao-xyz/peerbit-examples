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
    view: string; // view key
    rootId: string; // idString of the canvas you were inside
    anchorId: string; // first reply visible when you left
    offsetY: number; // pixels between viewport‑top and anchor‑top
    loadedUntil: number; // how many replies had been fetched
}
const cache = new Map<string, FeedSnapshot>();
export const saveSnapshot = (key: string, snap: FeedSnapshot) =>
    cache.set(key, snap);
export const getSnapshot = (key: string) => cache.get(key);
export const consumeSnapshot = (key: string) => cache.delete(key);

/* 2 ────────────────────────────────────────────────────────────────────────── */
interface LeaveArgs {
    replies: { reply: WithContext<CanvasDB> }[]; // processedReplies
    replyRefs: (HTMLDivElement | null)[]; // ↕ same length
    view: string;
    viewRoot?: CanvasDB;
}
export function useLeaveSnapshot(args: LeaveArgs) {
    const location = useLocation();
    const { replies, replyRefs, view, viewRoot } = args;
    return (from: CanvasDB) => {
        if (!viewRoot) return;

        const idx = replies.findIndex(
            (r) => r.reply.idString === from.idString
        );

        const nodeTop = replyRefs[idx]!.getBoundingClientRect().top; // << screen-relative

        saveSnapshot(location.key, {
            view,
            rootId: viewRoot.idString,
            anchorId: from.idString,
            offsetY: nodeTop, // screen relative
            loadedUntil: replies.length,
        });
    };
}

/* 3 ────────────────────────────────────────────────────────────────────────── */
interface RestoreArgs {
    replies: { reply: { idString: string } }[];
    loadMore: () => Promise<boolean>;
    hasMore: () => boolean;
    replyRefs: (HTMLDivElement | null)[];
    setView: (v: string) => void;
    setViewRootById: (id: string) => void;
    onSnapshot: (snap: FeedSnapshot) => void;
    onRestore: (snap: FeedSnapshot) => void;
    isReplyVisible: (id: string) => boolean;
    debug?: boolean;
}

const nextFrame = () =>
    new Promise<void>((r) => requestAnimationFrame(() => r()));

const tag = "[restore]"; // ⇠ easy filter

export function useRestoreFeed(a: RestoreArgs) {
    const { key } = useLocation();
    const snapRef = useRef<FeedSnapshot | undefined>(undefined);
    const doneRef = useRef(false);
    const [restoring, setRestoring] = useState(false);
    let log = a.debug ? console.log : (args: any) => {};

    /* ────────────────────────────────────────────────────────────────── */
    /* 1. restore view & root (once)                                     */
    /* ────────────────────────────────────────────────────────────────── */
    useLayoutEffect(() => {
        const next = getSnapshot(key);
        const current = snapRef.current;
        if (current !== next && next) {
            a.setView(next.view);
            a.onSnapshot(next);
        }
        setRestoring(!!next);
        snapRef.current = next;
        doneRef.current = false;

        if (snapRef.current && !doneRef.current) {
            log(tag, "restore view/root", snapRef.current);
            a.setView(snapRef.current.view);
            a.setViewRootById(snapRef.current.rootId);
        }
    }, [key]);

    /* ────────────────────────────────────────────────────────────────── */
    /* 2. fetch missing pages                                            */
    /* ────────────────────────────────────────────────────────────────── */
    const fetching = useRef(false);
    const lenRef = useRef(a.replies.length);
    useEffect(() => {
        lenRef.current = a.replies.length;
    }, [a.replies.length]);

    const repliesRef = useRef(a.replies);
    useEffect(() => {
        repliesRef.current = a.replies;
    }, [a.replies]);

    const loadMoreAndWait = async (): Promise<boolean> => {
        const before = lenRef.current;
        const maxWaitTime = 5e3; // ms
        let ticks = 0;

        log(tag, "loadMore()");
        await a.loadMore();
        let t0 = Date.now();
        while (lenRef.current === before) {
            await nextFrame();
            ticks++;
            if (Date.now() - t0 > maxWaitTime) {
                log(tag, "loadMore() timeout");
                break;
            }
        }

        log(
            tag,
            `loadMore finished – list ${
                lenRef.current > before ? "grew" : "timeout"
            }`,
            { before, after: lenRef.current }
        );

        return true;
    };

    const needMore = () => {
        if (!snapRef.current) {
            return false;
        }
        log(tag, "done?", {
            len: lenRef.current,
            len2: repliesRef.current.length,
            found: repliesRef.current.some(
                (r) => r.reply.idString === snapRef.current.anchorId
            ),
            lookingFor: snapRef.current.anchorId,
            set: new Set(repliesRef.current.map((r) => r.reply.idString)),
        });

        return (
            lenRef.current < snapRef.current.loadedUntil ||
            !repliesRef.current.some(
                (r) => r.reply.idString === snapRef.current.anchorId
            )
        );
    };

    useEffect(() => {
        const snap = snapRef.current;

        if (!snap || doneRef.current || fetching.current) return;

        if (!needMore()) return;

        log(tag, "start fetching loop", { snap });
        fetching.current = true;

        (async () => {
            let guard = 30;
            while (guard-- && needMore()) {
                log(tag, `loop guard=${guard + 1}`);
                await loadMoreAndWait();
                if (!a.hasMore) {
                    log(tag, "No more elements to load");
                    break;
                }
            }
            fetching.current = false;
            log(tag, "fetching loop done");
        })();
    }, [key]);

    /* ────────────────────────────────────────────────────────────────── */
    /* 3. scroll correction                                              */
    /* ────────────────────────────────────────────────────────────────── */
    useEffect(() => {
        const snap = snapRef.current;
        if (doneRef.current) {
            log(tag, "Already done");
            return;
        }
        if (!snap) {
            log(tag, "Missing snapshot");
            return;
        }

        const idx = repliesRef.current.findIndex(
            (r) => r.reply.idString === snap.anchorId
        );
        if (idx === -1) {
            log(tag, "anchor reply not found yet");
            return;
        }

        const node = a.replyRefs[idx];
        if (!node) {
            log(tag, "anchor DOM node not attached yet");
            return;
        }

        if (!a.isReplyVisible(a.replies[idx].reply.idString)) {
            log(tag, "anchor reply not visible yet");
            return;
        }

        setTimeout(() => {
            const delta = node.getBoundingClientRect().top - snap.offsetY;
            log(tag, "scroll correction", { idx, delta });
            if (delta !== 0) {
                window.scrollBy(0, delta);
            }
        }, 0);

        doneRef.current = true;
        consumeSnapshot(key);
        setRestoring(false);
        a.onRestore(snap);
    }, [
        a.isReplyVisible,
        a.replyRefs,
        a.replies,
        fetching.current,
        key,
        snapRef,
    ]);

    return { restoring };
}

/* 4 ────────────────────────────────────────────────────────────────────────── */
export const LeaveSnapshotContext = createContext<(from: CanvasDB) => void>(
    () => {}
);
export const useLeaveSnapshotFn = () => useContext(LeaveSnapshotContext);
