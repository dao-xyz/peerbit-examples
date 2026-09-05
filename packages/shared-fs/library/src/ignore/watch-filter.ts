/**
 * Per-handle ignore filtering for watch subscriptions.
 *
 * The wrapper pins ONE compiled rule set per policy generation and filters
 * delivered batches through it, so a rules rollout can never flip verdicts
 * under an in-flight batch. Policy changes run as a serialized pass that
 * reconciles the emitted stream against the handle's own filtered reads —
 * the same source of truth as its list()/stat().
 */
import { composeBatches } from "../watch.js";
import type { FsWatchEvent, FsWatcher, FsWatchCause } from "../watch.js";
import type { CompiledIgnoreRules } from "./patterns.js";

export type IgnoreWatchHost = {
    /** The current effective verdict machinery (defaults-file exempt). */
    currentRules(): CompiledIgnoreRules;
    isIgnored(rules: CompiledIgnoreRules, path: string): boolean;
    /** Snapshot of the inner subscription's committed served view — the
     *  wrapper seeds and reconciles from this, never from live re-walks. */
    viewSnapshot(): {
        path: string;
        nodeId: string;
        kind: "file" | "directory";
    }[];
    onRulesChanged(cb: () => void): () => void;
};

export class IgnoreFilteredWatcher implements FsWatcher {
    readonly path: string;
    readonly ready: Promise<void>;

    private pinnedRules: CompiledIgnoreRules;
    /** What the FILTERED stream has shown: nodeId -> shown state. */
    private emittedVisible = new Map<
        string,
        { path: string; kind: "file" | "directory" }
    >();
    private changeCbs = new Set<(batch: FsWatchEvent[]) => void>();
    private errorCbs = new Set<(error: Error) => void>();
    private closeCbs = new Set<() => void>();
    private chain: Promise<void> = Promise.resolve();
    private pending: FsWatchEvent[] | null = null;
    private iteratorActive = false;
    private iteratorWake: (() => void) | null = null;
    private unsubscribeRules: () => void;
    private unsubscribeInner: (() => void)[] = [];
    private didClose = false;

    constructor(
        private inner: FsWatcher,
        private host: IgnoreWatchHost,
        private makeError: (code: string, message: string) => Error,
        options?: { seedBaseline?: boolean }
    ) {
        this.path = inner.path;
        this.ready = inner.ready;
        this.pinnedRules = host.currentRules();
        if (options?.seedBaseline !== false) {
            // The subscriber's logical baseline is the served filtered view
            // at ready (its mirror starts from list()); the policy pass
            // reconciles against THAT, not just what this stream emitted.
            // Serialized first so data batches filter after the seed.
            this.chain = this.chain.then(async () => {
                try {
                    await inner.ready;
                    if (this.closed) return;
                    // Synchronous snapshot of the inner committed view —
                    // batches queued behind this in the chain diff against
                    // a consistent baseline (no read-race window).
                    for (const entry of host.viewSnapshot()) {
                        if (host.isIgnored(this.pinnedRules, entry.path)) {
                            continue;
                        }
                        this.emittedVisible.set(entry.nodeId, {
                            path: entry.path,
                            kind: entry.kind,
                        });
                    }
                } catch {
                    // Data batches reconcile organically.
                }
            });
        }
        this.unsubscribeInner.push(
            inner.on("change", (batch) => this.enqueueDataBatch(batch)),
            inner.on("error", (error) => {
                for (const cb of [...this.errorCbs]) cb(error);
            }),
            inner.on("close", () => this.close())
        );
        this.unsubscribeRules = host.onRulesChanged(() =>
            this.enqueuePolicyPass()
        );
    }

    get closed(): boolean {
        return this.didClose || this.inner.closed;
    }

    close(): void {
        if (this.didClose) return;
        // Set the guard first: inner.close() synchronously calls the inner
        // close listener below, which otherwise re-enters this method.
        this.didClose = true;
        if (!this.inner.closed) this.inner.close();
        this.unsubscribeRules();
        for (const un of this.unsubscribeInner.splice(0)) un();
        this.emittedVisible.clear();
        this.pending = null;
        const iteratorWake = this.iteratorWake;
        this.iteratorWake = null;
        iteratorWake?.();
        for (const cb of [...this.closeCbs]) {
            try {
                cb();
            } catch {
                /* subscriber errors are theirs */
            }
        }
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
            throw this.makeError(
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

    /* ---------------- filtering ---------------- */

    private enqueueDataBatch(batch: FsWatchEvent[]): void {
        this.chain = this.chain.then(async () => {
            if (this.closed) return;
            const out = await this.filterBatch(batch);
            if (out.length > 0) this.deliver(out);
        });
    }

    private async filterBatch(batch: FsWatchEvent[]): Promise<FsWatchEvent[]> {
        const rules = this.pinnedRules;
        const out: FsWatchEvent[] = [];
        for (const event of batch) {
            const visible = !this.host.isIgnored(rules, event.path);
            const wasEmitted = this.emittedVisible.has(event.nodeId);
            switch (event.type) {
                case "created":
                case "modified":
                    if (visible) {
                        out.push(
                            wasEmitted && event.type === "created"
                                ? { ...event, type: "modified" }
                                : event
                        );
                        this.emittedVisible.set(event.nodeId, {
                            path: event.path,
                            kind: event.kind,
                        });
                    }
                    break;
                case "deleted":
                    if (wasEmitted) {
                        const shown = this.emittedVisible.get(event.nodeId)!;
                        if (event.kind === "directory") {
                            out.push(
                                ...this.descendantDeletes(shown.path, event)
                            );
                        }
                        out.push({ ...event, path: shown.path });
                        this.forgetSubtree(event.nodeId, shown.path);
                    }
                    break;
                case "renamed": {
                    const oldVisible = wasEmitted;
                    if (oldVisible && visible) {
                        out.push({
                            ...event,
                            oldPath: this.emittedVisible.get(event.nodeId)
                                ?.path,
                        });
                        this.renameSubtree(event);
                        this.emittedVisible.set(event.nodeId, {
                            path: event.path,
                            kind: event.kind,
                        });
                    } else if (oldVisible && !visible) {
                        // Crossed INTO the ignored boundary: the filtered
                        // stream sees a deletion (directories expand,
                        // children-first, from what was shown).
                        const shown = this.emittedVisible.get(event.nodeId)!;
                        if (event.kind === "directory") {
                            out.push(
                                ...this.descendantDeletes(shown.path, event)
                            );
                        }
                        out.push({
                            ...event,
                            type: "deleted",
                            path: shown.path,
                            oldPath: undefined,
                        });
                        this.forgetSubtree(event.nodeId, shown.path);
                    } else if (!oldVisible && visible) {
                        // Crossed OUT of the ignored boundary: appears.
                        out.push({
                            ...event,
                            type: "created",
                            oldPath: undefined,
                        });
                        this.emittedVisible.set(event.nodeId, {
                            path: event.path,
                            kind: event.kind,
                        });
                        if (event.kind === "directory") {
                            // Descendants appear too; reconcile from the
                            // handle's own filtered reads.
                            out.push(
                                ...this.appearedDescendants(
                                    event.path,
                                    rules,
                                    event.cause
                                )
                            );
                        }
                    }
                    break;
                }
            }
        }
        return out;
    }

    private descendantDeletes(
        dirPath: string,
        template: FsWatchEvent
    ): FsWatchEvent[] {
        const prefix = `${dirPath}/`;
        const events: FsWatchEvent[] = [];
        for (const [nodeId, shown] of this.emittedVisible) {
            if (shown.path.startsWith(prefix)) {
                events.push({
                    type: "deleted",
                    path: shown.path,
                    nodeId,
                    parentId: template.nodeId,
                    kind: shown.kind,
                    origin: template.origin,
                    cause: template.cause,
                });
            }
        }
        // Children first, deepest paths first.
        return events.sort((a, b) => b.path.length - a.path.length);
    }

    private forgetSubtree(nodeId: string, dirPath: string): void {
        this.emittedVisible.delete(nodeId);
        const prefix = `${dirPath}/`;
        for (const [id, shown] of [...this.emittedVisible]) {
            if (shown.path.startsWith(prefix)) this.emittedVisible.delete(id);
        }
    }

    private renameSubtree(event: FsWatchEvent): void {
        if (event.kind !== "directory") return;
        const oldShown = this.emittedVisible.get(event.nodeId);
        if (!oldShown) return;
        const prefix = `${oldShown.path}/`;
        for (const [id, shown] of [...this.emittedVisible]) {
            if (shown.path.startsWith(prefix)) {
                this.emittedVisible.set(id, {
                    path: event.path + shown.path.slice(oldShown.path.length),
                    kind: shown.kind,
                });
            }
        }
    }

    private appearedDescendants(
        root: string,
        rules: CompiledIgnoreRules,
        cause: FsWatchCause
    ): FsWatchEvent[] {
        const events: FsWatchEvent[] = [];
        const prefix = root === "/" ? "/" : `${root}/`;
        for (const entry of this.host.viewSnapshot()) {
            if (entry.path !== root && !entry.path.startsWith(prefix)) {
                continue;
            }
            if (this.host.isIgnored(rules, entry.path)) continue;
            if (this.emittedVisible.has(entry.nodeId)) continue;
            this.emittedVisible.set(entry.nodeId, {
                path: entry.path,
                kind: entry.kind,
            });
            events.push({
                type: "created",
                path: entry.path,
                nodeId: entry.nodeId,
                parentId: "",
                kind: entry.kind,
                origin: "remote",
                cause,
            });
        }
        return events.sort((a, b) => a.path.length - b.path.length);
    }

    /** Rules changed: reconcile the emitted stream under the NEW rules. */
    private enqueuePolicyPass(): void {
        this.chain = this.chain.then(async () => {
            if (this.closed) return;
            const next = this.host.currentRules();
            const previous = this.pinnedRules;
            if (next.version === previous.version) return;
            const out: FsWatchEvent[] = [];
            // Newly ignored: everything we have shown that the new rules hide.
            for (const [nodeId, shown] of [...this.emittedVisible]) {
                if (this.host.isIgnored(next, shown.path)) {
                    this.emittedVisible.delete(nodeId);
                    out.push({
                        type: "deleted",
                        path: shown.path,
                        nodeId,
                        parentId: "",
                        kind: shown.kind,
                        origin: "local",
                        cause: "policy",
                    });
                }
            }
            out.sort((a, b) => b.path.length - a.path.length);
            // Newly visible: served entries the old rules hid.
            try {
                const served = this.host.viewSnapshot();
                const creations: FsWatchEvent[] = [];
                for (const entry of served) {
                    if (this.host.isIgnored(next, entry.path)) continue;
                    if (this.emittedVisible.has(entry.nodeId)) continue;
                    if (!this.host.isIgnored(previous, entry.path)) {
                        // Was already visible under the old rules — the data
                        // stream owns it; do not synthesize policy events.
                        continue;
                    }
                    this.emittedVisible.set(entry.nodeId, {
                        path: entry.path,
                        kind: entry.kind,
                    });
                    creations.push({
                        type: "created",
                        path: entry.path,
                        nodeId: entry.nodeId,
                        parentId: "",
                        kind: entry.kind,
                        origin: "local",
                        cause: "policy",
                    });
                }
                creations.sort((a, b) => a.path.length - b.path.length);
                out.push(...creations);
            } catch {
                // Served reads failing here is not fatal; the swap below
                // still happens and data batches reconcile organically.
            }
            this.pinnedRules = next;
            if (out.length > 0) this.deliver(out);
        });
    }

    private deliver(batch: FsWatchEvent[]): void {
        if (this.closed || batch.length === 0) return;
        for (const cb of [...this.changeCbs]) {
            try {
                cb(batch);
            } catch {
                /* subscriber errors are theirs */
            }
        }
        if (this.iteratorActive) {
            // Bounded: composition nets per-node deltas; without an active
            // iterator nothing accumulates (callbacks got the batch).
            this.pending = this.pending
                ? composeBatches(this.pending, batch)
                : batch;
        }
        this.iteratorWake?.();
    }
}
