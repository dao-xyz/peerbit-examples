/**
 * Multi-party change notification for shared filesystems.
 *
 * A watcher maintains a per-subscription materialized view of the served
 * subtree and emits filesystem-shaped events by diffing that view against
 * fresh reads whenever the underlying document feed marks it dirty. All
 * winner election runs through the host (the program's own read pipeline) —
 * this module contains zero winner logic and can never drift from list().
 *
 * Design: scratch "final-design.md" (view-diff winner + grafts). The public
 * contract lives in the README's watch section; guarantees G1-G7.
 */
import { FileChunk, FileVersion, NamingEvent } from "./model.js";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type FsWatchEventType = "created" | "modified" | "deleted" | "renamed";

export type FsWatchCause = "data" | "policy" | "overlay-timeout" | "snapshot";

export interface FsWatchEvent {
    type: FsWatchEventType;
    /** Path in the watcher's view AFTER the transition (deleted: last visible path). */
    path: string;
    /** renamed only: previous visible path of the same nodeId. */
    oldPath?: string;
    nodeId: string;
    /** Parent nodeId in the served view after the transition (deleted: last visible parent). */
    parentId: string;
    kind: "file" | "directory";
    /** Files: id of the visible content head after the transition. Absent on deleted. */
    versionId?: string;
    contentHash?: string;
    changesetId?: string;
    author?: string;
    /** Author identity vs this program's key — NOT "this handle wrote it". */
    origin: "local" | "remote";
    cause: FsWatchCause;
}

export interface FsWatchOptions {
    /** Whole subtree (default) or direct children only. */
    recursive?: boolean;
    /** Deliver the current tree as a first batch of created events (cause:"snapshot"). */
    initial?: "none" | "snapshot";
    /** Quiet-time before a flush; each new dirty mark restarts it. 0 = microtask pass. */
    settleMs?: number;
    /** Liveness cap: flush at latest this long after the first unflushed mark. */
    maxSettleMs?: number;
    /** MINIMUM hold on removal-caused visibility losses; extended while the guard is busy. */
    guardHoldMs?: number;
    /** Upper bound on materialized-view size; exceeding it errors the watcher. */
    maxNodes?: number;
    /** Ignore-aware handles only: bypass the handle's ignore filtering. */
    includeIgnored?: boolean;
    signal?: AbortSignal;
}

export interface FsWatcher extends AsyncIterable<FsWatchEvent[]> {
    readonly path: string;
    readonly ready: Promise<void>;
    readonly closed: boolean;
    on(type: "change", cb: (batch: FsWatchEvent[]) => void): () => void;
    on(type: "error", cb: (error: Error) => void): () => void;
    on(type: "close", cb: () => void): () => void;
    close(): void;
}

/* ------------------------------------------------------------------ */
/* Host surface (structural; implemented by the program)               */
/* ------------------------------------------------------------------ */

export type WatchHostNaming = {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    deleted: boolean;
    authorKey?: string;
    changesetId?: string;
};

export type WatchHostNamingState = {
    nodeId: string;
    winner: WatchHostNaming;
    conflicted: boolean;
};

export type WatchHostVersion = {
    id: string;
    nodeId: string;
    contentHash?: string;
    authorKey?: string;
    changesetId?: string;
};

export type WatchHostChild = {
    name: string;
    nodeId: string;
    kind: "directory" | "file";
    state: WatchHostNamingState;
    contested: boolean;
    heads?: WatchHostVersion[];
};

export type WatchHostResolved = {
    resolved: {
        kind: "root" | "directory" | "file";
        nodeId: string;
        path: string;
    };
    spine: { parentId: string; name: string; nodeId: string }[];
};

export interface WatchHost {
    resolvePathDetailed(path: string): Promise<WatchHostResolved | undefined>;
    listByParentId(parentId: string): Promise<WatchHostChild[]>;
    headsForNodes(nodeIds: string[]): Promise<Map<string, WatchHostVersion[]>>;
    namingStatesForNodes(
        nodeIds: string[]
    ): Promise<Map<string, WatchHostNamingState>>;
    localAuthorKey(): string | undefined;
    clock(): number;
    guardPendingFor(nodeId: string): boolean;
    makeError(code: string, message: string): Error;
    nodeKindOf(nodeId: string): "directory" | "file";
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

type ViewEntry = {
    nodeId: string;
    parentId: string;
    name: string;
    path: string;
    kind: "directory" | "file";
    /** false for depth-1 directories of a non-recursive watch. */
    expanded: boolean;
    versionId?: string;
    contentHash?: string;
    changesetId?: string;
    author?: string;
};

type Mark =
    | {
          doc: "naming";
          nodeId: string;
          parentId: string;
          name: string;
          removed: boolean;
      }
    | { doc: "version"; nodeId: string; removed: boolean };

type QuarantineEntry = {
    nodeId: string;
    /** Pre-image retained in the view until confirmed or restored. */
    preImage: ViewEntry;
    since: number;
    timer?: ReturnType<typeof setTimeout>;
};

const DEFAULTS = {
    recursive: true,
    initial: "none" as const,
    settleMs: 20,
    maxSettleMs: 200,
    guardHoldMs: 350,
    maxNodes: 100_000,
    includeIgnored: false,
};

const DIRTY_FORCE_FLUSH = 50_000;
const ATTACH_BUFFER_CAP = 50_000;
const FLUSH_RETRY_BASE_MS = 50;
const FLUSH_RETRY_MAX = 5;

const joinPath = (parent: string, name: string) =>
    parent === "/" ? `/${name}` : `${parent}/${name}`;

const depthOf = (path: string) =>
    path === "/" ? 0 : path.split("/").length - 1;

/* ------------------------------------------------------------------ */
/* Hub                                                                 */
/* ------------------------------------------------------------------ */

export class WatchHub {
    private subscriptions = new Set<WatchSubscription>();
    private firedLatches = new Set<string>();

    constructor(private host: WatchHost) {}

    /** Synchronous feed tap; runs inside the program's change listener. */
    ingest(added: any[], removed: any[]): void {
        if (this.subscriptions.size === 0) return;
        for (const sub of this.subscriptions) {
            for (const doc of added) sub.mark(doc, false);
            for (const doc of removed) sub.mark(doc, true);
            sub.scheduleFlush();
        }
    }

    /** The guard finished re-put work for these nodes; poke quarantines. */
    guardSettled(nodeIds: Iterable<string>): void {
        for (const sub of this.subscriptions) sub.guardSettled(nodeIds);
    }

    /**
     * Mark every subscription root-dirty (full re-diff) — used only at
     * bootstrap phase transitions. A latchKey makes the call once-only
     * (the unverified-retirement path can dispatch twice).
     */
    resyncAll(cause: FsWatchCause, latchKey?: string): void {
        if (latchKey) {
            if (this.firedLatches.has(latchKey)) return;
            this.firedLatches.add(latchKey);
        }
        for (const sub of this.subscriptions) {
            sub.markRoot(cause);
            sub.scheduleFlush();
        }
    }

    watch(path: string, options: FsWatchOptions | undefined): FsWatcher {
        const sub = new WatchSubscription(this.host, this, path, options);
        this.subscriptions.add(sub);
        sub.start();
        return sub;
    }

    detach(sub: WatchSubscription): void {
        this.subscriptions.delete(sub);
    }

    closeAll(): void {
        for (const sub of [...this.subscriptions]) sub.close();
    }
}

/* ------------------------------------------------------------------ */
/* Subscription                                                        */
/* ------------------------------------------------------------------ */

class WatchSubscription implements FsWatcher {
    readonly path: string;
    readonly ready: Promise<void>;
    closed = false;

    private opts: Required<Omit<FsWatchOptions, "signal">>;
    private signal?: AbortSignal;
    private readyResolve!: () => void;
    private readyReject!: (err: Error) => void;

    /** nodeId -> served entry. The watch root itself is NOT an entry. */
    private view = new Map<string, ViewEntry>();
    private byPath = new Map<string, string>();
    /** Naming-visible files with no content head yet: nodeId -> placement. */
    private latent = new Map<string, { parentId: string; name: string }>();
    private spineParents = new Set<string>();
    private spineNodes = new Set<string>();
    /** Segment names of the watch path — the birth trigger while the path
     *  does not resolve (there is no spine to hit yet). */
    private pathSegmentNames: Set<string>;
    private rootNodeId: string | null = null;
    private fileMode = false;

    private dirtyDirs = new Set<string>();
    private dirtyFiles = new Set<string>();
    private dirtyRoot = false;
    private rootCause: FsWatchCause = "data";
    private removalTouched = new Set<string>();
    private windowHadAdds = false;

    private attachBuffer: Mark[] | null = [];
    private quarantine = new Map<string, QuarantineEntry>();

    private settleTimer?: ReturnType<typeof setTimeout>;
    private maxSettleTimer?: ReturnType<typeof setTimeout>;
    private flushChain: Promise<void> = Promise.resolve();
    private flushRetries = 0;

    private changeCbs = new Set<(batch: FsWatchEvent[]) => void>();
    private errorCbs = new Set<(error: Error) => void>();
    private closeCbs = new Set<() => void>();

    /** Iterator state: at most ONE composed pending batch. */
    private pending: FsWatchEvent[] | null = null;
    private iteratorActive = false;
    private iteratorWake: (() => void) | null = null;

    constructor(
        private host: WatchHost,
        private hub: WatchHub,
        path: string,
        options?: FsWatchOptions
    ) {
        this.path = normalizeWatchPath(path);
        this.pathSegmentNames = new Set(this.path.split("/").filter(Boolean));
        this.opts = { ...DEFAULTS, ...stripUndefined(options) };
        this.signal = options?.signal;
        if (
            this.opts.settleMs < 0 ||
            this.opts.maxSettleMs < this.opts.settleMs ||
            this.opts.maxNodes < 1
        ) {
            throw host.makeError("EINVAL", "invalid watch options");
        }
        this.ready = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        // An unconsumed ready rejection must not crash the process.
        this.ready.catch(() => {});
    }

    /* ---------------- lifecycle ---------------- */

    start(): void {
        if (this.signal?.aborted) {
            this.close();
            this.readyReject(this.host.makeError("EINVAL", "watch aborted"));
            return;
        }
        this.signal?.addEventListener("abort", () => this.close(), {
            once: true,
        });
        void this.build();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.hub.detach(this);
        if (this.settleTimer) clearTimeout(this.settleTimer);
        if (this.maxSettleTimer) clearTimeout(this.maxSettleTimer);
        for (const q of this.quarantine.values()) {
            if (q.timer) clearTimeout(q.timer);
        }
        this.quarantine.clear();
        this.view.clear();
        this.byPath.clear();
        this.latent.clear();
        this.pending = null;
        this.iteratorWake?.();
        for (const cb of this.closeCbs) cb();
        this.changeCbs.clear();
        this.errorCbs.clear();
        this.closeCbs.clear();
    }

    on(type: any, cb: any): () => void {
        const set =
            type === "change"
                ? this.changeCbs
                : type === "error"
                  ? this.errorCbs
                  : this.closeCbs;
        set.add(cb);
        return () => set.delete(cb);
    }

    [Symbol.asyncIterator](): AsyncIterator<FsWatchEvent[]> {
        if (this.iteratorActive) {
            throw this.host.makeError(
                "EINVAL",
                "watcher already has an active iterator"
            );
        }
        this.iteratorActive = true;
        const next = async (): Promise<IteratorResult<FsWatchEvent[]>> => {
            for (;;) {
                if (this.pending && this.pending.length > 0) {
                    const batch = this.pending;
                    this.pending = null;
                    return { value: batch, done: false };
                }
                if (this.closed) {
                    this.iteratorActive = false;
                    return { value: undefined, done: true };
                }
                await new Promise<void>((resolve) => {
                    this.iteratorWake = resolve;
                });
                this.iteratorWake = null;
            }
        };
        return {
            next,
            return: async () => {
                this.iteratorActive = false;
                return { value: undefined, done: true };
            },
        };
    }

    /* ---------------- marking ---------------- */

    /** Synchronous, called from the feed tap for every changed document. */
    mark(doc: any, removed: boolean): void {
        if (this.closed) return;
        if (doc instanceof FileChunk) return;
        if (doc instanceof FileVersion) {
            this.applyMark({ doc: "version", nodeId: doc.nodeId, removed });
            return;
        }
        if (doc instanceof NamingEvent) {
            this.applyMark({
                doc: "naming",
                nodeId: doc.nodeId,
                parentId: doc.parentId,
                name: doc.name,
                removed,
            });
        }
        // BootstrapManifest and anything else: infrastructure, never fs changes.
    }

    private applyMark(mark: Mark): void {
        if (this.attachBuffer) {
            if (this.attachBuffer.length >= ATTACH_BUFFER_CAP) {
                this.attachBuffer = [];
                this.dirtyRoot = true;
            } else {
                this.attachBuffer.push(mark);
            }
            return;
        }
        if (!mark.removed) this.windowHadAdds = true;
        if (mark.doc === "version") {
            const entry = this.view.get(mark.nodeId);
            if (
                (entry && entry.kind === "file") ||
                this.latent.has(mark.nodeId)
            ) {
                this.dirtyFiles.add(mark.nodeId);
            }
            if (mark.removed) this.removalTouched.add(mark.nodeId);
            if (this.fileMode && this.rootNodeId === mark.nodeId) {
                this.dirtyRoot = true;
            }
            return;
        }
        // Naming event.
        const known = this.view.get(mark.nodeId);
        if (known) this.dirtyDirs.add(known.parentId);
        const latent = this.latent.get(mark.nodeId);
        if (latent) this.dirtyDirs.add(latent.parentId);
        const parentEntry = this.view.get(mark.parentId);
        if (
            mark.parentId === this.rootNodeId ||
            (parentEntry &&
                parentEntry.kind === "directory" &&
                parentEntry.expanded)
        ) {
            this.dirtyDirs.add(mark.parentId);
        }
        if (
            this.spineParents.has(mark.parentId) ||
            this.spineNodes.has(mark.nodeId)
        ) {
            this.dirtyRoot = true;
        }
        if (
            this.rootNodeId === null &&
            !mark.removed &&
            this.pathSegmentNames.has(mark.name)
        ) {
            // Path-anchored watch on a not-yet-existing path: a naming
            // event using one of the path's segment names may be its birth.
            this.dirtyRoot = true;
        }
        if (mark.removed) {
            this.removalTouched.add(mark.nodeId);
            if (known) this.removalTouched.add(`slot:${known.parentId}`);
            this.removalTouched.add(`slot:${mark.parentId}`);
        }
    }

    markRoot(cause: FsWatchCause): void {
        if (this.closed) return;
        this.dirtyRoot = true;
        this.rootCause = cause;
        this.windowHadAdds = true; // resyncs never wait the guard hold
    }

    guardSettled(nodeIds: Iterable<string>): void {
        for (const nodeId of nodeIds) {
            const q = this.quarantine.get(nodeId);
            if (q) void this.recheckQuarantine(q);
        }
    }

    /* ---------------- settle scheduling ---------------- */

    scheduleFlush(): void {
        if (this.closed || this.attachBuffer) return;
        if (
            !this.dirtyRoot &&
            this.dirtyDirs.size === 0 &&
            this.dirtyFiles.size === 0
        ) {
            return;
        }
        const total = this.dirtyDirs.size + this.dirtyFiles.size;
        if (total >= DIRTY_FORCE_FLUSH) {
            this.fireFlush();
            return;
        }
        // Removal-only windows are GC/guard churn by construction (user
        // deletes are ADDED tombstone events) — wait out the guard hold.
        const settle = this.windowHadAdds
            ? this.opts.settleMs
            : Math.max(this.opts.settleMs, this.opts.guardHoldMs);
        if (settle === 0) {
            if (!this.settleTimer) {
                this.settleTimer = setTimeout(() => this.fireFlush(), 0);
            }
            return;
        }
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.fireFlush(), settle);
        if (!this.maxSettleTimer) {
            this.maxSettleTimer = setTimeout(
                () => this.fireFlush(),
                Math.max(this.opts.maxSettleMs, settle)
            );
        }
    }

    private fireFlush(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        if (this.maxSettleTimer) clearTimeout(this.maxSettleTimer);
        this.settleTimer = undefined;
        this.maxSettleTimer = undefined;
        this.flushChain = this.flushChain.then(() => this.runFlush());
    }

    /* ---------------- initial build ---------------- */

    private async build(): Promise<void> {
        try {
            const resolved = await this.host.resolvePathDetailed(this.path);
            if (this.closed) return;
            if (resolved) {
                this.adoptSpine(resolved);
                if (resolved.resolved.kind === "file") {
                    this.fileMode = true;
                    await this.buildFileRoot(resolved);
                } else {
                    await this.bfs(resolved.resolved.nodeId);
                }
            }
            // else: path-anchored watch on a not-yet-existing path.
            if (this.closed) return;
            const buffered = this.attachBuffer;
            this.attachBuffer = null;
            for (const mark of buffered ?? []) this.applyMark(mark);
            this.readyResolve();
            if (this.opts.initial === "snapshot") {
                const snapshot = [...this.view.values()]
                    .map((entry) => this.eventFor("created", entry, "snapshot"))
                    .sort(
                        (a, b) =>
                            depthOf(a.path) - depthOf(b.path) ||
                            a.path.localeCompare(b.path)
                    );
                if (snapshot.length > 0) this.deliver(snapshot);
            }
            this.scheduleFlush();
        } catch (error: any) {
            if (this.closed) return;
            this.readyReject(error);
            this.emitError(error);
            this.close();
        }
    }

    private adoptSpine(resolved: WatchHostResolved): void {
        this.spineParents = new Set(resolved.spine.map((s) => s.parentId));
        this.spineNodes = new Set(resolved.spine.map((s) => s.nodeId));
        this.rootNodeId = resolved.resolved.nodeId;
    }

    private async buildFileRoot(resolved: WatchHostResolved): Promise<void> {
        const seg = resolved.spine[resolved.spine.length - 1];
        const children = await this.host.listByParentId(seg.parentId);
        const child = children.find(
            (c) => c.nodeId === resolved.resolved.nodeId
        );
        if (child)
            this.adoptChild(child, seg.parentId, this.parentPathOf(this.path));
    }

    /** BFS the served tree under a directory node into the view. */
    private async bfs(dirNodeId: string, dirPath = this.path): Promise<void> {
        const queue: { nodeId: string; path: string; depth: number }[] = [
            { nodeId: dirNodeId, path: dirPath, depth: 0 },
        ];
        while (queue.length > 0) {
            const { nodeId, path, depth } = queue.shift()!;
            const children = await this.host.listByParentId(nodeId);
            if (this.closed) return;
            for (const child of children) {
                const entry = this.adoptChild(child, nodeId, path);
                if (!entry) continue;
                if (entry.kind === "directory" && entry.expanded) {
                    queue.push({
                        nodeId: entry.nodeId,
                        path: entry.path,
                        depth: depth + 1,
                    });
                }
                this.checkMaxNodes();
            }
        }
    }

    /** Materialize one served child into the view (or latent). */
    private adoptChild(
        child: WatchHostChild,
        parentId: string,
        parentPath: string
    ): ViewEntry | undefined {
        if (
            child.kind === "file" &&
            (!child.heads || child.heads.length === 0)
        ) {
            this.latent.set(child.nodeId, { parentId, name: child.name });
            return undefined;
        }
        const head = child.heads?.[0];
        const winner = child.state.winner;
        const entry: ViewEntry = {
            nodeId: child.nodeId,
            parentId,
            name: child.name,
            path: joinPath(parentPath, child.name),
            kind: child.kind,
            expanded:
                this.opts.recursive || parentId === this.rootNodeId
                    ? this.opts.recursive
                    : false,
            versionId: head?.id,
            contentHash: head?.contentHash,
            changesetId:
                child.kind === "file" ? head?.changesetId : winner.changesetId,
            author: child.kind === "file" ? head?.authorKey : winner.authorKey,
        };
        this.latent.delete(child.nodeId);
        this.view.set(entry.nodeId, entry);
        this.byPath.set(entry.path, entry.nodeId);
        return entry;
    }

    private checkMaxNodes(): void {
        if (this.view.size > this.opts.maxNodes) {
            const error = this.host.makeError(
                "EWATCHLIMIT",
                `watch view exceeded maxNodes (${this.opts.maxNodes})`
            );
            this.emitError(error);
            this.close();
            throw error;
        }
    }

    /* ---------------- flush ---------------- */

    private async runFlush(): Promise<void> {
        if (this.closed) return;
        // Swap the window out atomically.
        const dirtyDirs = this.dirtyDirs;
        const dirtyFiles = this.dirtyFiles;
        const wasRootDirty = this.dirtyRoot;
        const rootCause = this.rootCause;
        const removalTouched = this.removalTouched;
        this.dirtyDirs = new Set();
        this.dirtyFiles = new Set();
        this.dirtyRoot = false;
        this.rootCause = "data";
        this.removalTouched = new Set();
        this.windowHadAdds = false;
        try {
            const batch = wasRootDirty
                ? await this.fullDiff(rootCause, removalTouched)
                : await this.partialDiff(dirtyDirs, dirtyFiles, removalTouched);
            this.flushRetries = 0;
            if (this.closed) return;
            if (batch.length > 0) this.deliver(batch);
        } catch (error: any) {
            if (this.closed) return;
            // Retain the marks and retry with backoff.
            for (const d of dirtyDirs) this.dirtyDirs.add(d);
            for (const f of dirtyFiles) this.dirtyFiles.add(f);
            for (const r of removalTouched) this.removalTouched.add(r);
            if (wasRootDirty) {
                this.dirtyRoot = true;
                this.rootCause = rootCause;
            }
            this.windowHadAdds = true;
            if (this.flushRetries < FLUSH_RETRY_MAX) {
                const delay = FLUSH_RETRY_BASE_MS * 2 ** this.flushRetries;
                this.flushRetries += 1;
                setTimeout(() => this.fireFlush(), delay);
            } else {
                this.flushRetries = 0;
                this.emitError(error);
            }
        }
    }

    /** Full-subtree diff: fresh BFS into a scratch subscription state. */
    private async fullDiff(
        cause: FsWatchCause,
        removalTouched: Set<string>
    ): Promise<FsWatchEvent[]> {
        const resolved = await this.host.resolvePathDetailed(this.path);
        const fresh = new WatchSubscription(
            this.host,
            detachedHub(this.host),
            this.path,
            { ...this.opts, initial: "none", signal: undefined }
        );
        fresh.rootNodeId = null;
        if (resolved) {
            fresh.adoptSpine(resolved);
            if (resolved.resolved.kind === "file") {
                fresh.fileMode = true;
                await fresh.buildFileRoot(resolved);
            } else {
                await fresh.bfs(resolved.resolved.nodeId);
            }
        }
        if (resolved) this.adoptSpine(resolved);
        else {
            this.rootNodeId = null;
        }
        const events = this.diffViews(fresh.view, cause, removalTouched);
        fresh.closed = true;
        return events;
    }

    /** Partial diff: re-list dirty dirs + re-head dirty files. */
    private async partialDiff(
        dirtyDirs: Set<string>,
        dirtyFiles: Set<string>,
        removalTouched: Set<string>
    ): Promise<FsWatchEvent[]> {
        if (this.rootNodeId === null) return [];
        if (this.fileMode) {
            // A file watch re-resolves its single slot on any mark.
            return this.fullDiff("data", removalTouched);
        }
        const listable = [...dirtyDirs].filter(
            (dir) =>
                dir === this.rootNodeId ||
                (this.view.get(dir)?.kind === "directory" &&
                    this.view.get(dir)!.expanded)
        );
        // Fresh child listings, with one consistency re-read on contest.
        let freshLists = new Map<string, WatchHostChild[]>();
        for (let attempt = 0; ; attempt++) {
            freshLists = new Map();
            for (const dir of listable) {
                freshLists.set(dir, await this.host.listByParentId(dir));
            }
            if (!this.contested(freshLists) || attempt >= 2) break;
        }
        // Build the after-state: start from the current view and apply the
        // fresh listings for the diffed directories.
        const target = new Map(this.view);
        const targetLatent = new Map(this.latent);
        for (const [dir, children] of freshLists) {
            const dirPath =
                dir === this.rootNodeId ? this.path : this.view.get(dir)!.path;
            const freshIds = new Set<string>();
            for (const child of children) {
                if (
                    child.kind === "file" &&
                    (!child.heads || child.heads.length === 0)
                ) {
                    targetLatent.set(child.nodeId, {
                        parentId: dir,
                        name: child.name,
                    });
                    target.delete(child.nodeId);
                    continue;
                }
                freshIds.add(child.nodeId);
                targetLatent.delete(child.nodeId);
                const head = child.heads?.[0];
                const winner = child.state.winner;
                const existing = target.get(child.nodeId);
                target.set(child.nodeId, {
                    nodeId: child.nodeId,
                    parentId: dir,
                    name: child.name,
                    path: joinPath(dirPath, child.name),
                    kind: child.kind,
                    expanded:
                        existing?.expanded ??
                        (this.opts.recursive ? true : false),
                    versionId: head?.id,
                    contentHash: head?.contentHash,
                    changesetId:
                        child.kind === "file"
                            ? head?.changesetId
                            : winner.changesetId,
                    author:
                        child.kind === "file"
                            ? head?.authorKey
                            : winner.authorKey,
                });
            }
            // Children the view had under this dir that the fresh list lacks.
            for (const entry of this.view.values()) {
                if (entry.parentId !== dir) continue;
                if (!freshIds.has(entry.nodeId)) {
                    const still = target.get(entry.nodeId);
                    if (still && still.parentId === dir) {
                        target.delete(entry.nodeId);
                    }
                }
            }
        }
        // Dirty files not covered by a re-listed dir: refresh heads only.
        const headOnly = [...dirtyFiles].filter((nodeId) => {
            const entry = this.view.get(nodeId);
            if (entry && !freshLists.has(entry.parentId)) return true;
            const latent = this.latent.get(nodeId);
            if (latent && !freshLists.has(latent.parentId)) return true;
            return false;
        });
        if (headOnly.length > 0) {
            const heads = await this.host.headsForNodes(headOnly);
            for (const nodeId of headOnly) {
                const nodeHeads = heads.get(nodeId);
                const head = nodeHeads?.[0];
                const entry = target.get(nodeId);
                if (entry) {
                    if (!head) {
                        // Head vanished: file leaves the view, becomes latent.
                        targetLatent.set(nodeId, {
                            parentId: entry.parentId,
                            name: entry.name,
                        });
                        target.delete(nodeId);
                    } else {
                        target.set(nodeId, {
                            ...entry,
                            versionId: head.id,
                            contentHash: head.contentHash,
                            changesetId: head.changesetId,
                            author: head.authorKey,
                        });
                    }
                } else {
                    const latent = this.latent.get(nodeId);
                    if (latent && head) {
                        // Latent file gained a head: appears at its slot.
                        const parentPath =
                            latent.parentId === this.rootNodeId
                                ? this.path
                                : this.view.get(latent.parentId)?.path;
                        if (parentPath !== undefined) {
                            targetLatent.delete(nodeId);
                            target.set(nodeId, {
                                nodeId,
                                parentId: latent.parentId,
                                name: latent.name,
                                path: joinPath(parentPath, latent.name),
                                kind: "file",
                                expanded: false,
                                versionId: head.id,
                                contentHash: head.contentHash,
                                changesetId: head.changesetId,
                                author: head.authorKey,
                            });
                        }
                    }
                }
            }
        }
        // Newly appeared directories expand recursively.
        if (this.opts.recursive) {
            for (const entry of [...target.values()]) {
                if (
                    entry.kind === "directory" &&
                    !this.view.has(entry.nodeId) &&
                    entry.expanded
                ) {
                    await this.expandInto(target, targetLatent, entry);
                }
            }
        }
        const events = this.diffViews(
            target,
            "data",
            removalTouched,
            targetLatent
        );
        return events;
    }

    /** Recursively list an appeared directory into the target after-state. */
    private async expandInto(
        target: Map<string, ViewEntry>,
        targetLatent: Map<string, { parentId: string; name: string }>,
        dir: ViewEntry
    ): Promise<void> {
        const children = await this.host.listByParentId(dir.nodeId);
        for (const child of children) {
            if (
                child.kind === "file" &&
                (!child.heads || child.heads.length === 0)
            ) {
                targetLatent.set(child.nodeId, {
                    parentId: dir.nodeId,
                    name: child.name,
                });
                continue;
            }
            const head = child.heads?.[0];
            const winner = child.state.winner;
            const entry: ViewEntry = {
                nodeId: child.nodeId,
                parentId: dir.nodeId,
                name: child.name,
                path: joinPath(dir.path, child.name),
                kind: child.kind,
                expanded: this.opts.recursive,
                versionId: head?.id,
                contentHash: head?.contentHash,
                changesetId:
                    child.kind === "file"
                        ? head?.changesetId
                        : winner.changesetId,
                author:
                    child.kind === "file" ? head?.authorKey : winner.authorKey,
            };
            target.set(entry.nodeId, entry);
            if (target.size > this.opts.maxNodes) this.checkMaxNodes();
            if (entry.kind === "directory") {
                await this.expandInto(target, targetLatent, entry);
            }
        }
    }

    /** A nodeId appearing under two parents in one read set = torn read. */
    private contested(freshLists: Map<string, WatchHostChild[]>): boolean {
        const seen = new Map<string, string>();
        for (const [dir, children] of freshLists) {
            for (const child of children) {
                const prior = seen.get(child.nodeId);
                if (prior !== undefined && prior !== dir) return true;
                seen.set(child.nodeId, dir);
            }
        }
        return false;
    }

    /**
     * Diff the committed view against a target after-state, gate losses
     * through the quarantine, derive paths two-phase, emit scheduled events,
     * and commit.
     */
    private diffViews(
        target: Map<string, ViewEntry>,
        cause: FsWatchCause,
        removalTouched: Set<string>,
        targetLatent?: Map<string, { parentId: string; name: string }>
    ): FsWatchEvent[] {
        const events: FsWatchEvent[] = [];
        const losses: ViewEntry[] = [];
        // Phase 1: recompute paths in the target from parent chains, so an
        // ancestor rename rewrites its whole subtree (two-phase derivation).
        const pathOf = (entry: ViewEntry, guard = 0): string => {
            if (guard > 512) return entry.path;
            if (entry.parentId === this.rootNodeId) {
                return joinPath(this.path, entry.name);
            }
            const parent = target.get(entry.parentId);
            if (!parent) return entry.path;
            return joinPath(pathOf(parent, guard + 1), entry.name);
        };
        for (const entry of target.values()) {
            entry.path = pathOf(entry);
        }
        // Transitions.
        for (const [nodeId, after] of target) {
            const before = this.view.get(nodeId);
            if (!before) {
                events.push(this.eventFor("created", after, cause));
                continue;
            }
            if (
                before.parentId !== after.parentId ||
                before.name !== after.name ||
                before.path !== after.path
            ) {
                events.push({
                    ...this.eventFor("renamed", after, cause),
                    oldPath: before.path,
                });
                if (
                    after.kind === "file" &&
                    before.versionId !== after.versionId
                ) {
                    events.push(this.eventFor("modified", after, cause));
                }
                continue;
            }
            if (after.kind === "file" && before.versionId !== after.versionId) {
                events.push(this.eventFor("modified", after, cause));
            }
        }
        for (const [nodeId, before] of this.view) {
            if (target.has(nodeId)) continue;
            // Descendants of a disappeared directory are pruned silently —
            // the single directory event carries the subtree by contract.
            const parentGone =
                before.parentId !== this.rootNodeId &&
                this.view.has(before.parentId) &&
                !target.has(before.parentId);
            if (parentGone) continue;
            losses.push(before);
        }
        // Quarantine gate on removal-provenance losses.
        const emittedLosses: ViewEntry[] = [];
        for (const loss of losses) {
            const removalCaused =
                removalTouched.has(loss.nodeId) ||
                removalTouched.has(`slot:${loss.parentId}`);
            if (removalCaused && cause === "data") {
                this.enqueueQuarantine(loss, target);
                continue;
            }
            emittedLosses.push(loss);
        }
        for (const loss of emittedLosses) {
            events.push({
                type: "deleted",
                path: loss.path,
                nodeId: loss.nodeId,
                parentId: loss.parentId,
                kind: loss.kind,
                changesetId: loss.changesetId,
                author: loss.author,
                origin: this.originOf(loss.author),
                cause,
            });
        }
        // Commit: target plus quarantined pre-images (carve-out).
        for (const q of this.quarantine.values()) {
            if (!target.has(q.nodeId)) target.set(q.nodeId, q.preImage);
        }
        this.view = target;
        this.byPath = new Map(
            [...target.values()].map((entry) => [entry.path, entry.nodeId])
        );
        if (targetLatent) this.latent = targetLatent;
        this.checkMaxNodes();
        return scheduleEvents(events);
    }

    /* ---------------- quarantine ---------------- */

    private enqueueQuarantine(
        loss: ViewEntry,
        target: Map<string, ViewEntry>
    ): void {
        if (this.quarantine.has(loss.nodeId)) return; // join existing
        const entry: QuarantineEntry = {
            nodeId: loss.nodeId,
            preImage: loss,
            since: this.host.clock(),
        };
        this.quarantine.set(loss.nodeId, entry);
        target.set(loss.nodeId, loss);
        entry.timer = setTimeout(
            () => void this.recheckQuarantine(entry),
            this.opts.guardHoldMs
        );
    }

    private async recheckQuarantine(entry: QuarantineEntry): Promise<void> {
        if (this.closed) return;
        if (!this.quarantine.has(entry.nodeId)) return;
        if (this.host.guardPendingFor(entry.nodeId)) {
            // The guard still holds this node; wait for guardSettled or
            // re-arm a short backstop check.
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(
                () => void this.recheckQuarantine(entry),
                this.opts.guardHoldMs
            );
            return;
        }
        try {
            const states = await this.host.namingStatesForNodes([entry.nodeId]);
            const state = states.get(entry.nodeId);
            const restored = state !== undefined && !state.winner.deleted;
            this.quarantine.delete(entry.nodeId);
            if (entry.timer) clearTimeout(entry.timer);
            if (restored) {
                // The guard re-put it (or it never truly left) — mark its
                // parent so the next flush trues the entry up silently.
                this.dirtyDirs.add(entry.preImage.parentId);
                this.scheduleFlush();
                return;
            }
            // Confirmed loss: drop the carved-out entry and emit honestly.
            if (this.view.get(entry.nodeId) === entry.preImage) {
                this.view.delete(entry.nodeId);
                this.byPath.delete(entry.preImage.path);
            }
            this.deliver([
                {
                    type: "deleted",
                    path: entry.preImage.path,
                    nodeId: entry.nodeId,
                    parentId: entry.preImage.parentId,
                    kind: entry.preImage.kind,
                    changesetId: entry.preImage.changesetId,
                    author: entry.preImage.author,
                    origin: this.originOf(entry.preImage.author),
                    cause: "data",
                },
            ]);
        } catch {
            // Read failure: retry after another hold.
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(
                () => void this.recheckQuarantine(entry),
                this.opts.guardHoldMs
            );
        }
    }

    /* ---------------- delivery ---------------- */

    private eventFor(
        type: FsWatchEventType,
        entry: ViewEntry,
        cause: FsWatchCause
    ): FsWatchEvent {
        return {
            type,
            path: entry.path,
            nodeId: entry.nodeId,
            parentId: entry.parentId,
            kind: entry.kind,
            versionId: entry.kind === "file" ? entry.versionId : undefined,
            contentHash: entry.kind === "file" ? entry.contentHash : undefined,
            changesetId: entry.changesetId,
            author: entry.author,
            origin: this.originOf(entry.author),
            cause,
        };
    }

    private originOf(author: string | undefined): "local" | "remote" {
        const local = this.host.localAuthorKey();
        return author !== undefined && author === local ? "local" : "remote";
    }

    private deliver(batch: FsWatchEvent[]): void {
        if (this.closed || batch.length === 0) return;
        for (const cb of [...this.changeCbs]) {
            try {
                cb(batch);
            } catch {
                // A subscriber throwing must not break delivery to others.
            }
        }
        if (this.iteratorActive || this.pending) {
            this.pending = this.pending
                ? composeBatches(this.pending, batch)
                : batch;
            this.iteratorWake?.();
        } else {
            this.pending = this.pending
                ? composeBatches(this.pending, batch)
                : batch;
        }
        this.iteratorWake?.();
    }

    private emitError(error: Error): void {
        for (const cb of [...this.errorCbs]) {
            try {
                cb(error);
            } catch {
                /* subscriber errors are theirs */
            }
        }
    }

    private parentPathOf(path: string): string {
        const idx = path.lastIndexOf("/");
        return idx <= 0 ? "/" : path.slice(0, idx);
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const normalizeWatchPath = (path: string): string => {
    let p = path.trim();
    if (!p.startsWith("/")) p = `/${p}`;
    while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
};

const stripUndefined = <T extends object>(obj?: T): Partial<T> => {
    if (!obj) return {};
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
};

/** A hub that never receives feed traffic — used for scratch rebuild state. */
const detachedHub = (host: WatchHost): WatchHub => new WatchHub(host);

/**
 * Order a batch so a path-keyed mirror can apply it sequentially:
 * deletes deepest-first, then renames/creates shallowest-first with
 * dependency ordering (a rename whose destination is freed by another
 * pending rename waits for it; cycles degrade one rename), then modifieds.
 */
const scheduleEvents = (events: FsWatchEvent[]): FsWatchEvent[] => {
    if (events.length <= 1) return events;
    const deletes = events
        .filter((e) => e.type === "deleted")
        .sort(
            (a, b) =>
                depthOf(b.path) - depthOf(a.path) ||
                a.path.localeCompare(b.path)
        );
    const modifieds = events
        .filter((e) => e.type === "modified")
        .sort((a, b) => a.path.localeCompare(b.path));
    let movers = events
        .filter((e) => e.type === "created" || e.type === "renamed")
        .sort(
            (a, b) =>
                depthOf(a.path) - depthOf(b.path) ||
                a.path.localeCompare(b.path)
        );
    const ordered: FsWatchEvent[] = [...deletes];
    const freed = new Set(deletes.map((e) => e.path));
    const occupiedOld = new Map<string, FsWatchEvent>();
    for (const e of movers) {
        if (e.type === "renamed" && e.oldPath) occupiedOld.set(e.oldPath, e);
    }
    // Greedy dependency pass over creates/renames.
    let guard = movers.length * 2 + 4;
    while (movers.length > 0 && guard-- > 0) {
        const emittable = movers.filter((e) => {
            const blocker = occupiedOld.get(e.path);
            return !blocker || blocker === e || freed.has(e.path);
        });
        if (emittable.length === 0) {
            // Cycle (A<->B swap): degrade the first rename into delete+create.
            const victim = movers.find((e) => e.type === "renamed");
            if (!victim) break;
            movers = movers.filter((e) => e !== victim);
            occupiedOld.delete(victim.oldPath!);
            ordered.push({
                type: "deleted",
                path: victim.oldPath!,
                nodeId: victim.nodeId,
                parentId: victim.parentId,
                kind: victim.kind,
                origin: victim.origin,
                cause: victim.cause,
            });
            freed.add(victim.oldPath!);
            ordered.push({ ...victim, type: "created", oldPath: undefined });
            freed.add(victim.path);
            continue;
        }
        for (const e of emittable) {
            ordered.push(e);
            if (e.type === "renamed" && e.oldPath) {
                freed.add(e.oldPath);
                occupiedOld.delete(e.oldPath);
            }
        }
        const emitted = new Set(emittable);
        movers = movers.filter((e) => !emitted.has(e));
    }
    ordered.push(...movers); // guard exhaustion: emit rest as-is
    ordered.push(...modifieds);
    return ordered;
};

/**
 * Compose an undelivered batch with a newer one: per-node net view deltas.
 * Intermediate transitions drop; the net state never does.
 */
const composeBatches = (
    older: FsWatchEvent[],
    newer: FsWatchEvent[]
): FsWatchEvent[] => {
    const byNode = new Map<string, FsWatchEvent[]>();
    for (const e of older) {
        byNode.set(e.nodeId, [...(byNode.get(e.nodeId) ?? []), e]);
    }
    for (const e of newer) {
        const prior = byNode.get(e.nodeId) ?? [];
        const first = prior[0];
        if (!first) {
            byNode.set(e.nodeId, [e]);
            continue;
        }
        switch (e.type) {
            case "modified":
                if (first.type === "created" || first.type === "renamed") {
                    byNode.set(e.nodeId, [
                        {
                            ...first,
                            versionId: e.versionId,
                            contentHash: e.contentHash,
                            changesetId: e.changesetId,
                            author: e.author,
                            origin: e.origin,
                        },
                    ]);
                } else {
                    byNode.set(e.nodeId, [e]);
                }
                break;
            case "deleted":
                if (first.type === "created") {
                    byNode.delete(e.nodeId); // create+delete nets to nothing
                } else if (first.type === "renamed") {
                    byNode.set(e.nodeId, [
                        { ...e, path: first.oldPath ?? e.path },
                    ]);
                } else {
                    byNode.set(e.nodeId, [e]);
                }
                break;
            case "renamed":
                if (first.type === "renamed") {
                    byNode.set(e.nodeId, [{ ...e, oldPath: first.oldPath }]);
                } else if (first.type === "created") {
                    byNode.set(e.nodeId, [
                        { ...e, type: "created", oldPath: undefined },
                    ]);
                } else if (first.type === "deleted") {
                    byNode.set(e.nodeId, [e]);
                } else {
                    byNode.set(e.nodeId, [e]);
                }
                break;
            case "created":
                if (first.type === "deleted") {
                    if (first.path === e.path) {
                        // delete + recreate at the same path: net modified.
                        byNode.set(e.nodeId, [
                            e.versionId === undefined &&
                            first.versionId === undefined
                                ? e
                                : { ...e, type: "modified" },
                        ]);
                    } else {
                        byNode.set(e.nodeId, [
                            { ...e, type: "renamed", oldPath: first.path },
                        ]);
                    }
                } else {
                    byNode.set(e.nodeId, [e]);
                }
                break;
        }
    }
    return scheduleEvents([...byNode.values()].flat());
};
