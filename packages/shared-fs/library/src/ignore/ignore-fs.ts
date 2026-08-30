import {
    SharedFsError,
    SharedFsHandle,
    type ResolveNamingAction,
    type SharedFileSystem,
    type WriteBatchEntry,
    type WriteBatchOptions,
    type WriteFileOptions,
} from "../index.js";
import { normalizeFsPath } from "../path.js";
import type { FsWatcher, FsWatchOptions } from "../watch.js";
import type { CompiledIgnoreRules, IgnoreVerdict } from "./patterns.js";
import type { IgnorePolicy, IgnorePolicyEngine } from "./policy.js";
import { IgnoreFilteredWatcher } from "./watch-filter.js";

/**
 * Artifact-ignore enforcement, between the caller and the program. The
 * contract every test pins: the mutable policy may influence what this
 * peer WRITES and SHOWS — never what the store ACCEPTS, RETIRES (GC),
 * RESURRECTS (Guard D), or SNAPSHOTS. Every guard runs on the normalized
 * path strictly before any shared mutation; verdicts govern NEW writes
 * and DEFAULT visibility, never access to existing shared data (exclude
 * hides, it never blocks open).
 *
 * Every top-level operation snapshots ONE compiled rule set at entry, so
 * a rule rollout never flips verdicts under an in-flight operation.
 *
 * v1 ships reject mode; the machine-local overlay ("divert") is a
 * follow-up and openSharedFs refuses the option until it lands.
 */
export class IgnoreAwareFs extends SharedFsHandle {
    constructor(
        program: SharedFileSystem,
        readonly ignorePolicy: IgnorePolicyEngine,
        private readonly policyOptions: IgnorePolicy
    ) {
        super(program);
    }

    /**
     * The current EFFECTIVE verdict for a path (tooling/status/mount):
     * the rules-file control surface is never ignored — a rule set that
     * covers it must not lock its own edits out anywhere.
     */
    ignoreCheck(path: string): IgnoreVerdict {
        return this.effectiveVerdict(
            this.ignorePolicy.current(),
            normalizeFsPath(path)
        );
    }

    private effectiveVerdict(
        rules: CompiledIgnoreRules,
        normalized: string
    ): IgnoreVerdict {
        if (normalized === this.defaultsFilePath()) {
            return { ignored: false };
        }
        return rules.test(normalized);
    }

    ignoreStatus() {
        return this.ignorePolicy.status();
    }

    private defaultsFilePath(): string {
        const configured = this.policyOptions.defaultsFile;
        if (configured === false) {
            return ""; // no control surface to exempt
        }
        return normalizeFsPath(configured ?? "/.artifactignore");
    }

    /**
     * Close this handle's watchers, then detach the policy engine's
     * listeners and timers. Call when done with a handle whose program
     * outlives it; closing the peer or the program tears the listeners
     * down anyway.
     */
    close() {
        super.close();
        this.ignorePolicy.stop();
    }

    /**
     * Watch through THIS handle's ignore policy: events on ignored paths
     * are suppressed, boundary crossings translate to created/deleted, and
     * a rules change reconciles the stream with cause:"policy" events.
     * `includeIgnored` bypasses the filter entirely.
     */
    watch(path = "/", options?: FsWatchOptions): FsWatcher {
        const inner = super.watch(path, options);
        if (options?.includeIgnored) {
            return inner;
        }
        return new IgnoreFilteredWatcher(
            inner,
            {
                currentRules: () => this.ignorePolicy.current(),
                isIgnored: (rules, path) =>
                    this.effectiveVerdict(rules, normalizeFsPath(path)).ignored,
                viewSnapshot: () => (inner as any).viewSnapshot?.() ?? [],
                onRulesChanged: (cb) => {
                    const handler = () => cb();
                    (this.program.events as any).addEventListener(
                        "ignore:rules-changed",
                        handler
                    );
                    return () =>
                        (this.program.events as any).removeEventListener(
                            "ignore:rules-changed",
                            handler
                        );
                },
            },
            (code, message) => new SharedFsError(code as any, message),
            // An initial snapshot flows through the filter and seeds the
            // baseline itself; seeding first would double-count it.
            { seedBaseline: options?.initial !== "snapshot" }
        );
    }

    private guardWrite(
        rules: CompiledIgnoreRules,
        path: string,
        operation: string
    ): string {
        const normalized = normalizeFsPath(path);
        const verdict = this.effectiveVerdict(rules, normalized);
        if (verdict.ignored) {
            throw new SharedFsError(
                "EIGNORED",
                `${operation} rejected: ${normalized} is artifact-ignored (rule ${JSON.stringify(verdict.rule)}, boundary ${verdict.boundary}, rules ${rules.version.slice(0, 8)})`
            );
        }
        return normalized;
    }

    async writeFile(
        path: string,
        source: Uint8Array | string | AsyncIterable<Uint8Array>,
        options?: WriteFileOptions
    ) {
        const rules = this.ignorePolicy.current();
        this.guardWrite(rules, path, "writeFile");
        return super.writeFile(path, source, options);
    }

    async mkdir(path: string) {
        const rules = this.ignorePolicy.current();
        this.guardWrite(rules, path, "mkdir");
        return super.mkdir(path);
    }

    async rm(path: string) {
        const rules = this.ignorePolicy.current();
        const normalized = normalizeFsPath(path);
        const verdict = this.effectiveVerdict(rules, normalized);
        if (verdict.ignored) {
            // Never a silent unlink of SHARED state through a policy
            // accident: a leaked store entry is a hygiene concern.
            const leaked = await super.stat(normalized);
            throw new SharedFsError(
                leaked ? "EIGNORED" : "ENOENT",
                leaked
                    ? `rm rejected: ${normalized} is artifact-ignored but exists in the shared store (leaked by a peer without the rule) — use the hygiene flow to remediate`
                    : `Path does not exist: ${normalized}`
            );
        }
        return super.rm(path);
    }

    async rename(from: string, to: string) {
        const rules = this.ignorePolicy.current();
        const fromPath = normalizeFsPath(from);
        const toPath = normalizeFsPath(to);
        for (const [endpoint, label] of [
            [fromPath, "source"],
            [toPath, "destination"],
        ] as const) {
            const verdict = this.effectiveVerdict(rules, endpoint);
            if (verdict.ignored) {
                throw new SharedFsError(
                    "EXDEV",
                    `rename crosses an artifact-ignore boundary (${label} ${endpoint} under ${verdict.boundary}); copy and delete explicitly`
                );
            }
        }
        // Ancestor reclassification: moving a DIRECTORY can carry an
        // ANCHORED rule's boundary with it (e.g. "/app/dist" under a
        // moved /app; "/app/*" likewise scopes /app's children). The
        // rule-side test uses the leading literal prefix — the segments
        // strictly before the first glob-bearing segment (or the whole
        // pattern when literal): EXDEV when that prefix path equals or
        // lies under either endpoint. Unanchored segment rules are
        // invariant under ancestor renames (endpoints covered above);
        // file moves cannot carry subtree boundaries.
        const source = await super.stat(fromPath);
        if (source?.kind === "directory") {
            for (const pattern of rules.patterns) {
                if (!pattern.startsWith("/")) {
                    continue;
                }
                const segments = pattern.slice(1).replace(/\/$/, "").split("/");
                const literalLead: string[] = [];
                for (const segment of segments) {
                    if (segment.includes("*") || segment.includes("?")) {
                        break;
                    }
                    literalLead.push(segment);
                }
                if (literalLead.length === 0) {
                    continue;
                }
                const hadGlobTail = literalLead.length < segments.length;
                const boundary = `/${literalLead.join("/")}`;
                const covers = (endpoint: string) =>
                    boundary.startsWith(`${endpoint}/`) ||
                    (hadGlobTail && boundary === endpoint);
                if (covers(fromPath) || covers(toPath)) {
                    throw new SharedFsError(
                        "EXDEV",
                        `rename would carry the artifact-ignore boundary of ${JSON.stringify(pattern)} across the move (${fromPath} -> ${toPath}); adjust rules or copy explicitly`
                    );
                }
            }
        }
        return super.rename(from, to);
    }

    async writeBatch(entries: WriteBatchEntry[], options?: WriteBatchOptions) {
        const rules = this.ignorePolicy.current();
        const onIgnored = options?.onIgnored ?? "reject";
        const skipped: { index: number; path: string; rule?: string }[] = [];
        const kept: WriteBatchEntry[] = [];
        const keptOriginalIndex: number[] = [];
        entries.forEach((entry, index) => {
            const normalized = normalizeFsPath(entry.path);
            const verdict = this.effectiveVerdict(rules, normalized);
            if (!verdict.ignored) {
                kept.push(entry);
                keptOriginalIndex.push(index);
                return;
            }
            if (onIgnored === "reject") {
                throw new SharedFsError(
                    "EIGNORED",
                    `writeBatch rejected: entry ${index} (${normalized}) is artifact-ignored (rule ${JSON.stringify(verdict.rule)})`
                );
            }
            skipped.push({ index, path: normalized, rule: verdict.rule });
        });
        const result = await super.writeBatch(kept, options);
        if (skipped.length > 0) {
            // Preserve the documented contract: results[i] corresponds to
            // the caller's entries[i]. Skipped slots stay undefined, with
            // `skipped` as the explicit disambiguator.
            const aligned = new Array(entries.length).fill(undefined);
            result.results.forEach((value, keptIndex) => {
                aligned[keptOriginalIndex[keptIndex]] = value;
            });
            result.results = aligned;
            result.skipped = skipped;
        }
        return result;
    }

    async list(path?: string, options?: { includeIgnored?: boolean }) {
        const entries = await super.list(path);
        if (options?.includeIgnored) {
            return entries;
        }
        const rules = this.ignorePolicy.current();
        const showLeaked = this.policyOptions.showLeaked ?? "hide";
        const out: typeof entries = [];
        for (const entry of entries) {
            const verdict = this.effectiveVerdict(rules, entry.path);
            if (!verdict.ignored) {
                out.push(entry);
            } else if (showLeaked === "annotate") {
                out.push({ ...entry, ignoredLeak: true });
            }
        }
        return out;
    }

    async stat(path: string) {
        const info = await super.stat(path);
        if (!info) {
            return info;
        }
        const verdict = this.effectiveVerdict(
            this.ignorePolicy.current(),
            info.path
        );
        return verdict.ignored ? { ...info, ignoredLeak: true } : info;
    }

    async conflicts(
        path?: string,
        options?: { allowPartial?: boolean; includeIgnored?: boolean }
    ) {
        const conflicts = await super.conflicts(path, options);
        if (options?.includeIgnored || path) {
            return conflicts;
        }
        const rules = this.ignorePolicy.current();
        return conflicts.filter((conflict) => {
            const verdict = this.effectiveVerdict(rules, conflict.path);
            // Boundary-path conflicts are always surfaced: they decide
            // what the boundary IS.
            return !verdict.ignored || verdict.boundary === conflict.path;
        });
    }

    async namingConflicts(
        path?: string,
        options?: { allowPartial?: boolean; includeIgnored?: boolean }
    ) {
        const conflicts = await super.namingConflicts(path, options);
        // An explicit path scope implies intent to see that subtree —
        // matching conflicts(path)'s semantics.
        if (options?.includeIgnored || path) {
            return conflicts;
        }
        const rules = this.ignorePolicy.current();
        return conflicts.filter((conflict) => {
            const verdict = this.effectiveVerdict(rules, conflict.path);
            return !verdict.ignored || verdict.boundary === conflict.path;
        });
    }

    resolveNamingConflict(nodeId: string, action: ResolveNamingAction) {
        // Pass-through: conflicts on ignored paths are resolvable via
        // namingConflicts(..., { includeIgnored: true }).
        return super.resolveNamingConflict(nodeId, action);
    }

    async snapshotWrite() {
        // Publish this peer's effective rules as manifest advisory, so
        // joiners are covered during the bootstrap window.
        const patterns = this.ignorePolicy.current().patterns;
        return this.program.snapshotWrite({
            // Empty stays undefined so the publisher's rules-file
            // fallback can still advertise fleet rules.
            advisoryIgnorePatterns:
                patterns.length > 0 ? [...patterns] : undefined,
        });
    }
}
