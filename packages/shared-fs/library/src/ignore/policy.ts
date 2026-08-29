import { FileVersion, NamingEvent } from "../model.js";
import { ROOT_NODE_ID } from "../path.js";
import type { SharedFileSystem } from "../index.js";
import {
    EMPTY_IGNORE_RULES,
    compileIgnoreRules,
    type CompiledIgnoreRules,
} from "./patterns.js";

/** Well-known replicated rules file (ordinary data, causally versioned). */
export const IGNORE_DEFAULTS_FILE = "/.artifactignore";

const RULES_DEBOUNCE_MS = 500;

/**
 * One engine per program: reopening a handle with an ignore policy on the
 * same program detaches the previous engine (last one wins — including
 * ownership of advisoryIgnorePublish), instead of stacking listeners and
 * racing installs.
 */
const enginesByProgram = new WeakMap<object, IgnorePolicyEngine>();

export type IgnorePolicy = {
    /** Open-args rules, active from the first instruction. */
    patterns?: string[];
    /** Replicated defaults file path, or false to disable (default "/.artifactignore"). */
    defaultsFile?: string | false;
    /** "extend" (default): open-args ∪ file. "replace": open-args only. */
    defaultsMode?: "extend" | "replace";
    /** Write behavior for ignored paths. v1 ships "reject" (default). */
    onIgnoredWrite?: "reject" | "divert";
    /** list() behavior for leaked store entries under ignored paths. */
    showLeaked?: "hide" | "annotate";
    /** Allowlist of authorKeys whose rules-file head is honored. */
    rulesFileAuthors?: string[];
    /** Pattern matching casefold (sealed-tier matching stays byte-exact). */
    casefold?: "none" | "unicode-simple";
};

export type IgnoreRulesProvenance =
    | "none"
    | "open-args"
    | "manifest-advisory"
    | "rules-file";

export type IgnorePolicyStatus = {
    rulesVersion: string;
    patterns: readonly string[];
    provenance: IgnoreRulesProvenance;
    /** Set when the rules file is present but unusable (last-good kept). */
    degraded?: string;
    /** Set when the rules-file slot itself is in a naming conflict. */
    rulesFileConflict?: boolean;
};

/**
 * Resolves the effective artifact-ignore rule set for one open handle:
 * open-args patterns, union the replicated defaults file (read strictly
 * as DATA — the store never interprets it), with manifest-carried
 * advisory patterns filling the bootstrap window until the file is
 * readable. Invalid content NEVER partially applies: the last good
 * compiled rule set is kept and an `ignore:rules-file-degraded` event is
 * dispatched on the program. The watcher subscribes to the naming SLOT
 * (root, basename) — a delete+recreate mints a fresh node and node-keyed
 * watching would go stale.
 */
export class IgnorePolicyEngine {
    private compiled: CompiledIgnoreRules;
    private provenance: IgnoreRulesProvenance;
    private degraded: string | undefined;
    private rulesFileConflict = false;
    private fileRead = false;
    private listener: ((event: any) => void) | undefined;
    /** nodeId of the current rules-file head; content updates key on it. */
    private rulesFileNodeId: string | undefined;
    private bootstrapListener: (() => void) | undefined;
    private convergedListener: (() => void) | undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshing: Promise<void> = Promise.resolve();

    constructor(
        readonly program: SharedFileSystem,
        readonly policy: IgnorePolicy
    ) {
        this.compiled = this.compileBase([]);
        this.provenance =
            (this.policy.patterns?.length ?? 0) > 0 ? "open-args" : "none";
    }

    /** The immutable current rule set — callers snapshot one per op. */
    current(): CompiledIgnoreRules {
        return this.compiled;
    }

    status(): IgnorePolicyStatus {
        return {
            rulesVersion: this.compiled.version,
            patterns: this.compiled.patterns,
            provenance: this.provenance,
            degraded: this.degraded,
            rulesFileConflict: this.rulesFileConflict || undefined,
        };
    }

    private compileBase(extra: readonly string[]): CompiledIgnoreRules {
        const base = this.policy.patterns ?? [];
        const merged =
            this.policy.defaultsMode === "replace" ? base : [...base, ...extra];
        // Open-args patterns are the caller's own input: compile errors
        // there should throw at open. Extra (file/manifest) content is
        // validated by the callers of this method.
        return compileIgnoreRules(merged, {
            casefold: this.policy.casefold,
        });
    }

    private install(
        rules: CompiledIgnoreRules,
        provenance: IgnoreRulesProvenance
    ) {
        const changed = rules.version !== this.compiled.version;
        this.compiled = rules;
        this.provenance = provenance;
        // Keep automatic snapshot manifests advertising the effective set.
        this.program.advisoryIgnorePublish = [...rules.patterns];
        if (changed) {
            (this.program.events as any).dispatchEvent(
                new CustomEvent("ignore:rules-changed", {
                    detail: this.status(),
                })
            );
        }
    }

    async start() {
        const previous = enginesByProgram.get(this.program);
        if (previous && previous !== this) {
            previous.stop();
        }
        enginesByProgram.set(this.program, this);
        // Open-args apply immediately (throws on invalid caller input).
        this.install(
            this.compileBase([]),
            (this.policy.patterns?.length ?? 0) > 0 ? "open-args" : "none"
        );
        if (this.policy.defaultsFile === false) {
            return;
        }
        // Bootstrap window: manifest-carried advisory patterns fill in
        // until the real file content is readable.
        const advisory = this.program.bootstrapAdvisoryIgnorePatterns;
        if (advisory && this.policy.defaultsMode !== "replace") {
            try {
                this.install(this.compileBase(advisory), "manifest-advisory");
            } catch {
                /* dropped; open-args stay active */
            }
        }
        this.bootstrapListener = () => {
            // Advisory rules install IMMEDIATELY at manifest accept (no
            // debounce): the whole point is covering writes that race the
            // bootstrap window.
            const late = this.program.bootstrapAdvisoryIgnorePatterns;
            if (
                !this.fileRead &&
                late &&
                this.policy.defaultsMode !== "replace"
            ) {
                try {
                    this.install(this.compileBase(late), "manifest-advisory");
                } catch {
                    /* dropped; current rules stay */
                }
            }
            // Segments install right after manifest accept, making the
            // rules file readable through the bootstrap overlay — re-read
            // it now instead of waiting for its log entries.
            this.scheduleRefresh();
        };
        (this.program.events as any).addEventListener(
            "ignore:advisory-available",
            this.bootstrapListener
        );
        // The settled-state conclusion (absent vs present, author gating)
        // re-runs once the bootstrap converges.
        this.convergedListener = () => {
            this.scheduleRefresh();
        };
        (this.program.events as any).addEventListener(
            "bootstrap:converged",
            this.convergedListener
        );
        // Slot watcher: any naming change directly under the root re-runs
        // slot resolution for the defaults file.
        const fileName = this.defaultsFileName();
        this.listener = (event: any) => {
            const touched = [
                ...(event?.detail?.added ?? []),
                ...(event?.detail?.removed ?? []),
            ];
            for (const value of touched) {
                // Three triggers: (a) a naming event in OUR slot (name +
                // parent — a subdirectory file with the same name is a
                // different slot); (b) any naming event on the tracked
                // node (covers rename-away, whose event carries the NEW
                // name); (c) a content overwrite (FileVersion) on the
                // tracked node — overwrites mint no naming event.
                const slotMatch =
                    value instanceof NamingEvent &&
                    value.name === fileName &&
                    (!this.rootLevelDefaults ||
                        value.parentId === ROOT_NODE_ID);
                const nodeMatch =
                    this.rulesFileNodeId !== undefined &&
                    (value instanceof NamingEvent ||
                        value instanceof FileVersion) &&
                    value.nodeId === this.rulesFileNodeId;
                if (slotMatch || nodeMatch) {
                    this.scheduleRefresh();
                    return;
                }
            }
        };
        this.program.entries.events.addEventListener("change", this.listener);
        await this.refresh();
    }

    stop() {
        if (this.listener) {
            this.program.entries.events.removeEventListener(
                "change",
                this.listener
            );
            this.listener = undefined;
        }
        if (this.bootstrapListener) {
            (this.program.events as any).removeEventListener(
                "ignore:advisory-available",
                this.bootstrapListener
            );
            this.bootstrapListener = undefined;
        }
        if (this.convergedListener) {
            (this.program.events as any).removeEventListener(
                "bootstrap:converged",
                this.convergedListener
            );
            this.convergedListener = undefined;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }

    private get rootLevelDefaults(): boolean {
        const path = this.defaultsFilePath();
        return path.lastIndexOf("/") === 0;
    }

    private defaultsFilePath(): string {
        return this.policy.defaultsFile === undefined
            ? IGNORE_DEFAULTS_FILE
            : (this.policy.defaultsFile as string);
    }

    private defaultsFileName(): string {
        const path = this.defaultsFilePath();
        return path.slice(path.lastIndexOf("/") + 1);
    }

    private scheduleRefresh() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            void this.refresh();
        }, RULES_DEBOUNCE_MS);
        (this.debounceTimer as any)?.unref?.();
    }

    /** Chained validate-compile-swap; last-good on any failure. */
    refresh(): Promise<void> {
        const run = this.refreshing.then(() =>
            this.refreshInner().catch(() => {})
        );
        this.refreshing = run;
        return run;
    }

    private async refreshInner() {
        if (this.policy.defaultsMode === "replace") {
            return;
        }
        const path = this.defaultsFilePath();
        let info;
        try {
            info = await this.program.stat(path);
        } catch {
            info = undefined;
        }
        this.rulesFileConflict = false;
        if (!info) {
            // stat() returning nothing conflates three states: truly
            // absent, not yet synced (cold join in flight), and
            // naming-present-but-content-pending. Only a settled store
            // may conclude ABSENT; everything else keeps the door open
            // for the manifest advisory and later arrivals.
            const phase = this.program.bootstrapStatus().phase;
            const settled = phase === "off" || phase === "converged";
            const pendingNode = settled
                ? await (this.program as any)
                      .resolvePath(path)
                      .catch(() => undefined)
                : undefined;
            if (pendingNode?.nodeId) {
                // Naming arrived, content still replicating: track the
                // node so the FileVersion arrival re-triggers us.
                this.rulesFileNodeId = pendingNode.nodeId;
                this.degrade("rules file content pending replication");
                return;
            }
            this.rulesFileNodeId = undefined;
            if (!settled) {
                return; // decide nothing while the store is partial
            }
            this.fileRead = true;
            if (this.provenance === "manifest-advisory") {
                // Sticky last-good: advisory rules hold until a REAL
                // rules file replaces them (a fleet may run on advisory
                // alone) — never silently collapse to open-args.
                return;
            }
            try {
                this.install(
                    this.compileBase([]),
                    (this.policy.patterns?.length ?? 0) > 0
                        ? "open-args"
                        : "none"
                );
            } catch {
                /* keep last good */
            }
            return;
        }
        this.rulesFileNodeId = info.nodeId;
        if (info.namingConflict) {
            this.rulesFileConflict = true;
            (this.program.events as any).dispatchEvent(
                new CustomEvent("ignore:rules-file-conflict", {
                    detail: { path },
                })
            );
        }
        if (this.policy.rulesFileAuthors) {
            // Gate BOTH planes: the naming winner (who placed the file)
            // and every current content head (who wrote the rules) —
            // content overwrites mint no naming event, so checking the
            // naming author alone gates the wrong plane.
            const authors = new Set<string>([info.authorKey]);
            try {
                for (const version of await this.program.versions(path)) {
                    if (version.head) {
                        authors.add(version.authorKey);
                    }
                }
            } catch {
                /* fall through with the naming author only */
            }
            const unlisted = [...authors].filter(
                (author) => !this.policy.rulesFileAuthors!.includes(author)
            );
            if (unlisted.length > 0) {
                this.degrade(
                    `rules file head authored by ${unlisted.join(", ")}, not in rulesFileAuthors`
                );
                return;
            }
        }
        let content: Uint8Array | undefined;
        try {
            content = await this.program.readFile(path);
        } catch (error: any) {
            this.degrade(`rules file unreadable: ${error?.message ?? error}`);
            return;
        }
        try {
            const lines = new TextDecoder()
                .decode(content)
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith("#"));
            this.fileRead = true;
            this.degraded = undefined;
            this.install(this.compileBase(lines), "rules-file");
        } catch (error: any) {
            this.degrade(`rules file invalid: ${error?.message ?? error}`);
        }
    }

    private degrade(reason: string) {
        // Last-good stays active — never a silent swap to permissive.
        this.degraded = reason;
        (this.program.events as any).dispatchEvent(
            new CustomEvent("ignore:rules-file-degraded", {
                detail: { reason },
            })
        );
    }
}

export { EMPTY_IGNORE_RULES };
