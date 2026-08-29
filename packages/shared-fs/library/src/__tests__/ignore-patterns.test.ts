import { describe, expect, it } from "vitest";
import {
    ARTIFACT_IGNORE_STARTER,
    IgnorePatternError,
    compileIgnoreRules,
} from "../ignore/patterns.js";

describe("artifact ignore patterns", () => {
    it("matches anchored, floating, glob and ** patterns", () => {
        const rules = compileIgnoreRules([
            "/dist",
            "node_modules/",
            "*.log",
            "/packages/**/coverage",
            "cache-?",
        ]);
        expect(rules.test("/dist").ignored).toBe(true);
        expect(rules.test("/src/dist").ignored).toBe(false); // anchored
        expect(rules.test("/node_modules").ignored).toBe(true);
        expect(rules.test("/a/b/node_modules").ignored).toBe(true); // floats
        expect(rules.test("/a/debug.log").ignored).toBe(true);
        expect(rules.test("/a/debug.log.txt").ignored).toBe(false);
        expect(rules.test("/packages/x/y/coverage").ignored).toBe(true);
        expect(rules.test("/coverage").ignored).toBe(false); // anchored **
        expect(rules.test("/x/cache-1").ignored).toBe(true);
        expect(rules.test("/x/cache-12").ignored).toBe(false);
        expect(rules.test("/src/index.ts").ignored).toBe(false);
    });

    it("pins prefix closure: ignored(p) implies ignored(p/child)", () => {
        const rules = compileIgnoreRules([
            "/dist",
            "node_modules/",
            "*.log",
            "/packages/**/out",
        ]);
        const seeds = [
            "/dist",
            "/a/node_modules",
            "/deep/x/y/node_modules",
            "/logs/app.log",
            "/packages/a/b/out",
        ];
        for (const seed of seeds) {
            expect(rules.test(seed).ignored).toBe(true);
            for (const child of [
                `${seed}/child`,
                `${seed}/a/b/c.txt`,
                `${seed}/.hidden/deep`,
            ]) {
                const verdict = rules.test(child);
                expect(verdict.ignored).toBe(true);
                // The boundary is the shallowest ignored prefix — stable
                // for the whole subtree.
                expect(verdict.boundary).toBe(rules.test(seed).boundary);
            }
        }
    });

    it("computes a canonical, order-independent version hash", () => {
        const a = compileIgnoreRules(["/dist", "node_modules/", "/dist"]);
        const b = compileIgnoreRules(["node_modules", "/dist"]);
        // Note: trailing "/" is part of the raw pattern text, so a/b only
        // agree when the canonical lists agree.
        expect(a.version).not.toBe("");
        expect(
            compileIgnoreRules(["x", "y"]).version ===
                compileIgnoreRules(["y", "x"]).version
        ).toBe(true);
        expect(a.version === b.version).toBe(false);
    });

    it("rejects catch-alls, negation, classes, escapes and oversized input", () => {
        for (const bad of ["*", "/**", "**", "?", "/*", "**/**"]) {
            expect(() => compileIgnoreRules([bad])).toThrow(IgnorePatternError);
        }
        expect(() => compileIgnoreRules(["!important"])).toThrow(
            IgnorePatternError
        );
        expect(() => compileIgnoreRules(["[abc]"])).toThrow(IgnorePatternError);
        expect(() => compileIgnoreRules(["a\\ b"])).toThrow(IgnorePatternError);
        expect(() => compileIgnoreRules(["/"])).toThrow(IgnorePatternError);
        expect(() => compileIgnoreRules([""])).toThrow(IgnorePatternError);
        expect(() => compileIgnoreRules(["x".repeat(600)])).toThrow(
            IgnorePatternError
        );
        expect(() =>
            compileIgnoreRules(Array.from({ length: 600 }, (_, i) => `/p${i}`))
        ).toThrow(IgnorePatternError);
        // Multi-segment patterns with a concrete segment stay valid.
        expect(() => compileIgnoreRules(["/a/*"])).not.toThrow();
        expect(() => compileIgnoreRules(["**/dist"])).not.toThrow();
    });

    it("ships a starter set that compiles and hits the usual artifact trees", () => {
        const rules = compileIgnoreRules([...ARTIFACT_IGNORE_STARTER]);
        for (const path of [
            "/node_modules/lodash/index.js",
            "/apps/web/node_modules/x",
            "/dist/bundle.js",
            "/packages/a/build/out.o",
            "/.cache/tmp",
            "/rust/target/debug/bin",
            "/coverage/lcov.info",
            "/apps/site/.next/static/x",
            "/.turbo/runs.json",
        ]) {
            expect(rules.test(path).ignored).toBe(true);
        }
        for (const path of [
            "/src/index.ts",
            "/docs/readme.md",
            "/builder/config.ts",
            "/distribution/list.txt",
        ]) {
            expect(rules.test(path).ignored).toBe(false);
        }
    });

    it("matches adversarial deep ** patterns in bounded time", () => {
        // Naive backtracking is exponential here; the memoized matcher
        // must finish instantly (and the ** count is capped anyway).
        const rules = compileIgnoreRules(["**/a/**/a/**/a/**/a"]);
        const deep = "/" + Array.from({ length: 60 }, () => "a").join("/");
        const start = performance.now();
        expect(rules.test(deep).ignored).toBe(true);
        expect(rules.test(deep + "/b").ignored).toBe(true);
        expect(
            rules.test("/" + Array.from({ length: 60 }, () => "x").join("/"))
                .ignored
        ).toBe(false);
        expect(performance.now() - start).toBeLessThan(500);
        expect(() => compileIgnoreRules(["**/a/**/a/**/a/**/a/**/a"])).toThrow(
            /"\*\*" segments/
        );
    });

    it("keeps git semantics for trailing **: contents only, never the boundary dir", () => {
        const rules = compileIgnoreRules(["/apps/**", "logs/**"]);
        expect(rules.test("/apps").ignored).toBe(false);
        expect(rules.test("/apps/web").ignored).toBe(true);
        expect(rules.test("/apps/web/deep/x").ignored).toBe(true);
        expect(rules.test("/x/logs").ignored).toBe(false);
        expect(rules.test("/x/logs/app.log").ignored).toBe(true);
    });

    it("optionally casefolds pattern matching", () => {
        const exact = compileIgnoreRules(["node_modules/"]);
        expect(exact.test("/NODE_MODULES").ignored).toBe(false);
        const folded = compileIgnoreRules(["node_modules/"], {
            casefold: "unicode-simple",
        });
        expect(folded.test("/NODE_MODULES").ignored).toBe(true);
    });
});
