import { describe, expect, it } from "vitest";
import { compileIgnoreRules, type IgnoreVerdict } from "../ignore/patterns.js";

type FoldMode = "none" | "unicode-simple";

/**
 * Small reference oracle for accepted v1 patterns, not a second validator.
 * Authored patterns are nonempty, have no empty segments, contain a concrete
 * segment, and do not use negation, classes, escapes or more than four **s.
 * Caps/rejection behavior remains covered by ignore-patterns.test.ts.
 *
 * Paths are passed through exactly as received: ordinary cases are normalized
 * absolute paths, while explicit compatibility cases contain empty segments or
 * omit the leading slash. This oracle must not normalize those accepted inputs.
 * unicode-simple currently means String.toLowerCase(), not NFC or Unicode full
 * case folding. Boundaries use folded path text; rules retain authored text.
 *
 * This deliberately enumerates every prefix, floating start and ** consumption
 * count. There is no fixed-width shortcut, memoized production search, or cache.
 * Segment literals are emitted one UTF-16 code unit at a time as \uXXXX, rather
 * than copying production's regexp-escaping expression. Native ^...$ assertions
 * and [^/] retain the engine's exact newline and non-u wildcard semantics.
 * The corpus is short enough that exhaustive search is bounded and cheap.
 */
const referenceSegment = (segment: string) => {
    let expression = "";
    for (let index = 0; index < segment.length; index++) {
        const unit = segment[index];
        expression +=
            unit === "*"
                ? "[^/]*"
                : unit === "?"
                  ? "[^/]"
                  : `\\u${segment.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return new RegExp(`^(?:${expression})$`);
};

const referenceTest = (
    authored: readonly string[],
    path: string,
    mode: FoldMode = "none"
): IgnoreVerdict => {
    const fold = (value: string) =>
        mode === "unicode-simple" ? value.toLowerCase() : value;
    const rules = [...new Set(authored)].sort().map((raw, order) => {
        const anchored = raw.startsWith("/");
        const body = raw.substring(
            anchored ? 1 : 0,
            raw.endsWith("/") ? raw.length - 1 : raw.length
        );
        return {
            raw,
            order,
            anchored,
            parts: body
                .split("/")
                .map((part) =>
                    part === "**" ? null : referenceSegment(fold(part))
                ),
        };
    });
    const folded = fold(path);
    const segments =
        folded === "/"
            ? []
            : (folded.startsWith("/") ? folded.substring(1) : folded).split(
                  "/"
              );
    const matches: Array<{ depth: number; order: number; raw: string }> = [];

    for (const rule of rules) {
        for (let depth = 1; depth <= segments.length; depth++) {
            const prefix = segments.slice(0, depth);
            const exact = (
                remaining: (RegExp | null)[],
                words: string[]
            ): boolean => {
                if (remaining.length === 0) return words.length === 0;
                const [part, ...tail] = remaining;
                if (part !== null) {
                    return (
                        words.length > 0 &&
                        part.test(words[0]) &&
                        exact(tail, words.slice(1))
                    );
                }
                // A trailing ** requires at least one SEGMENT (even an empty
                // segment in a currently accepted non-normalized input).
                const minimum = tail.length === 0 ? 1 : 0;
                for (let count = minimum; count <= words.length; count++) {
                    if (exact(tail, words.slice(count))) return true;
                }
                return false;
            };
            const lastStart = rule.anchored ? 0 : prefix.length;
            for (let start = 0; start <= lastStart; start++) {
                if (exact(rule.parts, prefix.slice(start))) {
                    matches.push({ depth, order: rule.order, raw: rule.raw });
                    break;
                }
            }
        }
    }
    matches.sort(
        (left, right) => left.depth - right.depth || left.order - right.order
    );
    const first = matches[0];
    return first
        ? {
              ignored: true,
              boundary: `/${segments.slice(0, first.depth).join("/")}`,
              rule: first.raw,
          }
        : { ignored: false };
};

type PinnedCase = {
    name: string;
    patterns: string[];
    path: string;
    mode?: FoldMode;
    expected: IgnoreVerdict;
};
const hit = (boundary: string, rule: string): IgnoreVerdict => ({
    ignored: true,
    boundary,
    rule,
});
const miss: IgnoreVerdict = { ignored: false };

const pinned: PinnedCase[] = [
    {
        name: "root never forms a candidate prefix",
        patterns: ["a"],
        path: "/",
        expected: miss,
    },
    { name: "empty rules", patterns: [], path: "/a/b", expected: miss },
    {
        name: "anchored rule cannot float",
        patterns: ["/a/b"],
        path: "/x/a/b",
        expected: miss,
    },
    {
        name: "floating fixed multi-segment suffix",
        patterns: ["a/b"],
        path: "/x/a/b/child",
        expected: hit("/x/a/b", "a/b"),
    },
    {
        name: "fixed pattern longer than prefix",
        patterns: ["a/b/c"],
        path: "/a/b",
        expected: miss,
    },
    {
        name: "multi-segment wildcards",
        patterns: ["/a*/b?"],
        path: "/alpha/b1/deep",
        expected: hit("/alpha/b1", "/a*/b?"),
    },
    {
        name: "fixed wildcard cannot cross a separator",
        patterns: ["/a*b"],
        path: "/a/x/b",
        expected: miss,
    },
    {
        name: "embedded double star stays within one segment",
        patterns: ["foo**/b"],
        path: "/x/foobar/b/child",
        expected: hit("/x/foobar/b", "foo**/b"),
    },
    {
        name: "embedded double star is not a directory globstar",
        patterns: ["foo**/b"],
        path: "/foo/x/b",
        expected: miss,
    },
    {
        name: "shortest prefix beats earlier canonical rule",
        patterns: ["/a/b", "a"],
        path: "/a/b/c",
        expected: hit("/a", "a"),
    },
    {
        name: "canonical raw rule wins tied boundary",
        patterns: ["b", "a/b"],
        path: "/a/b/c",
        expected: hit("/a/b", "a/b"),
    },
    {
        name: "trailing slash remains authored tie identity",
        patterns: ["a/", "a", "a/"],
        path: "/a/child",
        expected: hit("/a", "a"),
    },
    {
        name: "canonical ** wins fixed-width tie",
        patterns: ["a/b", "**/b"],
        path: "/a/b/c",
        expected: hit("/a/b", "**/b"),
    },
    {
        name: "middle ** consumes zero segments",
        patterns: ["/a/**/b"],
        path: "/a/b/c",
        expected: hit("/a/b", "/a/**/b"),
    },
    {
        name: "middle ** consumes multiple segments",
        patterns: ["/a/**/b"],
        path: "/a/x/y/b/c",
        expected: hit("/a/x/y/b", "/a/**/b"),
    },
    {
        name: "adjacent middle **s may both be empty",
        patterns: ["/a/**/**/b"],
        path: "/a/b",
        expected: hit("/a/b", "/a/**/**/b"),
    },
    {
        name: "trailing ** excludes its parent",
        patterns: ["/a/**"],
        path: "/a",
        expected: miss,
    },
    {
        name: "trailing ** includes first child",
        patterns: ["/a/**"],
        path: "/a/b/c",
        expected: hit("/a/b", "/a/**"),
    },
    {
        name: "floating trailing ** excludes deepest parent",
        patterns: ["a/**"],
        path: "/x/a",
        expected: miss,
    },
    {
        name: "mixed rules still pick shortest fixed boundary",
        patterns: ["**/cache/out", "cache", "/x/**/out"],
        path: "/x/cache/out/file",
        expected: hit("/x/cache", "cache"),
    },
    {
        name: "partial literal does not match",
        patterns: ["cache"],
        path: "/cacheable/file",
        expected: miss,
    },
    {
        name: "raw uppercase wins casefold tie",
        patterns: ["cache", "CACHE"],
        path: "/X/CACHE/Child",
        mode: "unicode-simple",
        expected: hit("/x/cache", "CACHE"),
    },
    {
        name: "case-sensitive miss",
        patterns: ["cache"],
        path: "/CACHE",
        expected: miss,
    },
    {
        name: "dotted I expansion preserves raw rule",
        patterns: ["İ/cache"],
        path: "/X/İ/CACHE/Child",
        mode: "unicode-simple",
        expected: hit("/x/i\u0307/cache", "İ/cache"),
    },
    {
        name: "dotted I is not ASCII i",
        patterns: ["i/cache"],
        path: "/İ/CACHE",
        mode: "unicode-simple",
        expected: miss,
    },
    {
        name: "question mark is one UTF-16 unit",
        patterns: ["x?"],
        path: "/x😀",
        expected: miss,
    },
    {
        name: "two question marks match an astral character",
        patterns: ["x??"],
        path: "/x😀/child",
        expected: hit("/x😀", "x??"),
    },
    {
        name: "astral literal casefold",
        patterns: ["𐐀/cache"],
        path: "/𐐨/CACHE/file",
        mode: "unicode-simple",
        expected: hit("/𐐨/cache", "𐐀/cache"),
    },
    {
        name: "casefold does not normalize combining marks",
        patterns: ["é"],
        path: "/E\u0301",
        mode: "unicode-simple",
        expected: miss,
    },
    {
        name: "regex punctuation is literal",
        patterns: ["a.+^${}()|"],
        path: "/a.+^${}()|/child",
        expected: hit("/a.+^${}()|", "a.+^${}()|"),
    },
    {
        name: "newline consumed by one wildcard",
        patterns: ["log-?"],
        path: "/log-\n/child",
        expected: hit("/log-\n", "log-?"),
    },
    {
        name: "line terminators consumed by star",
        patterns: ["log-*"],
        path: "/log-\r\n\u2028\u2029/child",
        expected: hit("/log-\r\n\u2028\u2029", "log-*"),
    },
    {
        name: "literal newline stays in the boundary",
        patterns: ["a\nb"],
        path: "/x/a\nb/child",
        expected: hit("/x/a\nb", "a\nb"),
    },
    {
        name: "repeated separator is not collapsed",
        patterns: ["/a/b"],
        path: "/a//b",
        expected: miss,
    },
    {
        name: "single star can consume empty segment",
        patterns: ["/a/*"],
        path: "/a//b",
        expected: hit("/a/", "/a/*"),
    },
    {
        name: "trailing empty segment counts for **",
        patterns: ["/a/**"],
        path: "/a/",
        expected: hit("/a/", "/a/**"),
    },
    {
        name: "floating rule retains repeated leading separator",
        patterns: ["a"],
        path: "//a/b",
        expected: hit("//a", "a"),
    },
    {
        name: "relative input preserves existing implicit root output",
        patterns: ["/a/b"],
        path: "a/b/c",
        expected: hit("/a/b", "/a/b"),
    },
    {
        name: "empty input remains unmatched",
        patterns: ["a"],
        path: "",
        expected: miss,
    },
];

describe("ignore prefix matching reference corpus", () => {
    it.each(pinned)("$name", ({ patterns, path, mode = "none", expected }) => {
        expect(referenceTest(patterns, path, mode)).toEqual(expected);
        const rules = compileIgnoreRules(patterns, { casefold: mode });
        expect(rules.test(path)).toEqual(expected);
        // Also lock the cache-hit verdict, not only the first evaluation.
        expect(rules.test(path)).toEqual(expected);
    });

    it("retains native non-multiline regex end assertions for line terminators", () => {
        // Do not import another regexp engine's $ convention into the oracle.
        // This explicit native predicate locks whichever inputs ^cache$ admits.
        for (const ending of ["", "\n", "\r", "\r\n", "\u2028", "\u2029"]) {
            const segment = `cache${ending}`;
            const path = `/x/${segment}/child`;
            const expected = /^cache$/.test(segment)
                ? hit(`/x/${segment}`, "cache")
                : miss;
            expect(referenceTest(["cache"], path)).toEqual(expected);
            expect(compileIgnoreRules(["cache"]).test(path)).toEqual(expected);
        }
    });

    it("keeps canonical tie order and verdicts across authored permutations", () => {
        const patterns = ["cache", "CACHE", "**/cache", "/cache", "cache/"];
        for (const mode of ["none", "unicode-simple"] as const) {
            const canonical = compileIgnoreRules(patterns, { casefold: mode });
            for (let shift = 0; shift < patterns.length; shift++) {
                const rotated = [
                    ...patterns.slice(shift),
                    ...patterns.slice(0, shift),
                ];
                const rules = compileIgnoreRules(
                    [...rotated.reverse(), ...rotated],
                    { casefold: mode }
                );
                expect(rules.patterns).toEqual([...new Set(patterns)].sort());
                expect(rules.version).toBe(canonical.version);
                for (const path of [
                    "/cache",
                    "/CACHE",
                    "/x/CACHE/out",
                    "/cacheable",
                    "/",
                ]) {
                    expect(rules.test(path)).toEqual(
                        referenceTest(patterns, path, mode)
                    );
                }
            }
        }
    });

    it("agrees with exhaustive short paths for fixed and mixed ** rule sets", () => {
        const alphabet = ["a", "b", "ab", "x"];
        const paths = ["/"];
        const addPaths = (prefix: string, remaining: number) => {
            if (remaining === 0) return;
            for (const name of alphabet) {
                const path = `${prefix}/${name}`;
                paths.push(path);
                addPaths(path, remaining - 1);
            }
        };
        addPaths("", 3); // 85 paths, including root.
        const sets = [
            ["a/b"],
            ["/a/b"],
            ["a?/b*"],
            ["a/*/b"],
            ["/a/**/b"],
            ["a/**"],
            ["a/**/**/b"],
            ["**/b", "a/b", "/ab/*"],
            ["/a/b/x", "a", "**/ab"],
            [],
        ];
        for (const patterns of sets) {
            const rules = compileIgnoreRules(patterns);
            for (const path of paths) {
                expect(
                    rules.test(path),
                    JSON.stringify({ patterns, path })
                ).toEqual(referenceTest(patterns, path));
            }
        }
    });

    it("agrees with a fixed-seed short Unicode and wildcard corpus", () => {
        let seed = 0x71a9d;
        const next = () =>
            (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
        const pick = <T>(values: readonly T[]): T =>
            values[next() % values.length];
        const concrete = ["a", "Cache", "İ", "x?", "𐐀", "log-*", "a.b"];
        const tail = ["b", "*", "?", "**", "a*", "x??", "İ"];
        const names = [
            "a",
            "b",
            "ab",
            "Cache",
            "CACHE",
            "İ",
            "i\u0307",
            "x😀",
            "𐐨",
            "log-\n",
            "a.b",
        ];
        for (let row = 0; row < 160; row++) {
            const patterns = Array.from({ length: 1 + (next() % 3) }, () => {
                const parts = [pick(concrete)];
                const extras = next() % 3;
                for (let index = 0; index < extras; index++)
                    parts.push(pick(tail));
                return `${next() % 2 ? "/" : ""}${parts.join("/")}${next() % 3 === 0 ? "/" : ""}`;
            });
            const path = `/${Array.from({ length: 1 + (next() % 4) }, () => pick(names)).join("/")}`;
            for (const mode of ["none", "unicode-simple"] as const) {
                const rules = compileIgnoreRules(patterns, { casefold: mode });
                const expected = referenceTest(patterns, path, mode);
                expect(
                    rules.test(path),
                    JSON.stringify({ row, patterns, path, mode })
                ).toEqual(expected);
                if (expected.ignored) {
                    expect(rules.test(`${path}/child`)).toEqual(expected);
                }
            }
        }
    });
});
