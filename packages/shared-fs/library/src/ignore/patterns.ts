import { sha256Base64Sync } from "@peerbit/crypto";

const utf8 = new TextEncoder();
const byteLength = (value: string) => utf8.encode(value).byteLength;

/**
 * Deterministic artifact-ignore pattern language, frozen for v1: a
 * gitignore subset over normalized absolute paths.
 *
 * - A leading "/" anchors a pattern to the root; unanchored patterns
 *   float (an implicit "**\/" prefix, like git).
 * - "*" and "?" match within one path segment; a full "**" segment
 *   crosses directories. A trailing "/" is accepted and stripped: under
 *   prefix-closure semantics every match already acts as a subtree
 *   boundary.
 * - NO negation ("!"), character classes, or escapes. This is
 *   load-bearing, not provisional: negation would break the
 *   prefix-closure property that the write-path proofs and the
 *   divert-whole-subtree model rely on. `formatVersion` gates any future
 *   extension.
 *
 * PREFIX-CLOSURE SEMANTICS: a path is ignored iff ANY prefix of it
 * (including itself) matches any rule — every rule is a boundary for its
 * whole subtree. Pinned property: ignored(p) implies ignored(p +
 * "/child") for every rule set.
 */

export const IGNORE_FORMAT_VERSION = 1;

/** Compile-time caps: invalid input never partially applies. */
export const MAX_IGNORE_PATTERNS = 512;
export const MAX_IGNORE_PATTERN_BYTES = 512;
export const MAX_IGNORE_TOTAL_BYTES = 64 * 1024;

/**
 * Opt-in starter set for build-artifact trees. Never active by default.
 */
export const ARTIFACT_IGNORE_STARTER: readonly string[] = [
    "node_modules/",
    "dist/",
    "build/",
    ".cache/",
    "target/",
    "coverage/",
    ".next/",
    ".turbo/",
];

export type IgnoreVerdict = {
    ignored: boolean;
    /** Shallowest matching prefix — the subtree boundary. */
    boundary?: string;
    /** The (canonical) rule that matched the boundary. */
    rule?: string;
};

export type CompiledIgnoreRules = {
    /** sha256 (base64) of the canonical sorted, deduped pattern list. */
    version: string;
    /** Canonical pattern list (sorted, deduped). */
    patterns: readonly string[];
    test(path: string): IgnoreVerdict;
};

export class IgnorePatternError extends Error {
    constructor(
        readonly pattern: string | undefined,
        message: string
    ) {
        super(
            pattern === undefined
                ? message
                : `invalid ignore pattern ${JSON.stringify(pattern)}: ${message}`
        );
    }
}

type CompiledPattern = {
    raw: string;
    anchored: boolean;
    segments: string[];
    segmentRegexes: (RegExp | null)[]; // null for "**"
};

const SEGMENT_SPECIALS = /[.+^${}()|[\]\\]/g;

const compileSegment = (segment: string): RegExp | null => {
    if (segment === "**") {
        return null;
    }
    const escaped = segment
        .replace(SEGMENT_SPECIALS, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    return new RegExp(`^${escaped}$`);
};

/** No legitimate artifact rule needs more; bounds match cost hard. */
export const MAX_DOUBLESTAR_SEGMENTS = 4;

const validatePattern = (
    raw: string,
    fold: (value: string) => string
): CompiledPattern => {
    if (typeof raw !== "string" || raw.length === 0) {
        throw new IgnorePatternError(raw, "empty pattern");
    }
    if (byteLength(raw) > MAX_IGNORE_PATTERN_BYTES) {
        throw new IgnorePatternError(
            raw,
            `longer than ${MAX_IGNORE_PATTERN_BYTES} bytes`
        );
    }
    if (raw.includes("!")) {
        throw new IgnorePatternError(
            raw,
            "negation is not supported in format v1"
        );
    }
    if (raw.includes("[") || raw.includes("]")) {
        throw new IgnorePatternError(
            raw,
            "character classes are not supported in format v1"
        );
    }
    if (raw.includes("\\")) {
        throw new IgnorePatternError(
            raw,
            "escapes are not supported in format v1"
        );
    }
    let body = raw;
    const anchored = body.startsWith("/");
    if (anchored) {
        body = body.slice(1);
    }
    // Trailing "/" marks directory intent; prefix closure makes every
    // match a subtree boundary anyway, so it is accepted and stripped.
    if (body.endsWith("/")) {
        body = body.slice(0, -1);
    }
    if (body.length === 0) {
        throw new IgnorePatternError(raw, "matches the root");
    }
    const segments = body.split("/");
    if (segments.some((segment) => segment.length === 0)) {
        throw new IgnorePatternError(raw, "empty path segment");
    }
    if (
        segments.filter((segment) => segment === "**").length >
        MAX_DOUBLESTAR_SEGMENTS
    ) {
        throw new IgnorePatternError(
            raw,
            `more than ${MAX_DOUBLESTAR_SEGMENTS} "**" segments`
        );
    }
    // Catch-all rejection: a pattern that would match every depth-1 name
    // (and with prefix closure, therefore the entire tree) is a fleet
    // blackout, not a rule.
    const catchAllSegment = (segment: string) =>
        segment === "**" || /^[*?]+$/.test(segment);
    if (segments.every(catchAllSegment)) {
        throw new IgnorePatternError(raw, "matches every path");
    }
    if (!anchored && segments.length === 1 && catchAllSegment(segments[0])) {
        throw new IgnorePatternError(raw, "matches every path");
    }
    return {
        // The AUTHORED text: verdicts and errors must quote what the
        // user wrote, not a casefolded transform of it.
        raw,
        anchored,
        segments,
        segmentRegexes: segments.map((segment) =>
            compileSegment(fold(segment))
        ),
    };
};

/**
 * True when the pattern matches the given segment sequence exactly
 * (anchored at its start; the caller supplies every prefix of the path,
 * which realizes prefix-closure).
 */
const matchesSegments = (
    pattern: CompiledPattern,
    segments: string[]
): boolean => {
    // Failed (pi, si) states are memoized per call: naive "**"
    // backtracking is exponential, and a cap-compliant adversarial
    // pattern from the replicated rules file could otherwise pin every
    // policy-enabled peer's CPU. With the memo, work is O(k·n) states.
    const failed = new Set<number>();
    const width = segments.length + 2;
    const match = (pi: number, si: number): boolean => {
        const key = pi * width + si;
        if (failed.has(key)) {
            return false;
        }
        let p = pi;
        let s2 = si;
        while (p < pattern.segments.length) {
            const regex = pattern.segmentRegexes[p];
            if (regex === null) {
                // "**": consume 1..n remaining segments (git semantics —
                // a trailing "x/**" means x's CONTENTS, never x itself),
                // and 0..n when more pattern follows ("a/**/b" matches
                // "a/b").
                if (p === pattern.segments.length - 1) {
                    if (s2 < segments.length) {
                        return true;
                    }
                    failed.add(key);
                    return false;
                }
                for (let skip = s2; skip <= segments.length; skip++) {
                    if (match(p + 1, skip)) {
                        return true;
                    }
                }
                failed.add(key);
                return false;
            }
            if (s2 >= segments.length || !regex.test(segments[s2])) {
                failed.add(key);
                return false;
            }
            p++;
            s2++;
        }
        if (s2 === segments.length) {
            return true;
        }
        failed.add(key);
        return false;
    };
    if (pattern.anchored) {
        return match(0, 0);
    }
    // Floating: implicit "**/" prefix — try every start offset.
    for (let start = 0; start <= segments.length; start++) {
        if (match(0, start)) {
            return true;
        }
    }
    return false;
};

export const canonicalizeIgnorePatterns = (
    patterns: readonly string[]
): string[] => [...new Set(patterns)].sort();

/**
 * Compile a pattern list into an immutable matcher. Throws
 * IgnorePatternError on any invalid pattern — invalid input never
 * partially applies.
 */
export const compileIgnoreRules = (
    patterns: readonly string[],
    options: { casefold?: "none" | "unicode-simple" } = {}
): CompiledIgnoreRules => {
    if (patterns.length > MAX_IGNORE_PATTERNS) {
        throw new IgnorePatternError(
            undefined,
            `more than ${MAX_IGNORE_PATTERNS} ignore patterns`
        );
    }
    const canonical = canonicalizeIgnorePatterns(patterns);
    const totalBytes = canonical.reduce(
        (sum, pattern) => sum + byteLength(pattern),
        0
    );
    if (totalBytes > MAX_IGNORE_TOTAL_BYTES) {
        throw new IgnorePatternError(
            undefined,
            `ignore patterns exceed ${MAX_IGNORE_TOTAL_BYTES} bytes in total`
        );
    }
    const fold =
        options.casefold === "unicode-simple"
            ? (value: string) => value.toLowerCase()
            : (value: string) => value;
    const compiled = canonical.map((raw) => validatePattern(raw, fold));
    // The casefold mode changes verdicts for identical pattern text, so
    // it is part of the version identity.
    const version = sha256Base64Sync(
        utf8.encode(
            JSON.stringify({
                v: IGNORE_FORMAT_VERSION,
                c: options.casefold ?? "none",
                p: canonical,
            })
        )
    );
    const verdictCache = new Map<string, IgnoreVerdict>();
    const test = (path: string): IgnoreVerdict => {
        const cached = verdictCache.get(path);
        if (cached) {
            return cached;
        }
        const folded = fold(path);
        const segments =
            folded === "/" ? [] : folded.replace(/^\//, "").split("/");
        let verdict: IgnoreVerdict = { ignored: false };
        // Prefix closure: test every prefix, shallowest boundary wins.
        outer: for (let depth = 1; depth <= segments.length; depth++) {
            const prefix = segments.slice(0, depth);
            for (const pattern of compiled) {
                if (matchesSegments(pattern, prefix)) {
                    verdict = {
                        ignored: true,
                        boundary: `/${prefix.join("/")}`,
                        rule: pattern.raw,
                    };
                    break outer;
                }
            }
        }
        if (verdictCache.size > 50_000) {
            verdictCache.clear();
        }
        verdictCache.set(path, verdict);
        return verdict;
    };
    return { version, patterns: canonical, test };
};

/** The empty rule set: matches nothing, stable version hash. */
export const EMPTY_IGNORE_RULES: CompiledIgnoreRules = compileIgnoreRules([]);
