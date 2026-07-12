import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const libraryPackageJson = JSON.parse(
    fs.readFileSync(
        path.join(repoRoot, "packages/file-share/library/package.json"),
        "utf8"
    )
) as {
    dependencies?: Record<string, string>;
};

const syncedDependencies = [
    "peerbit",
    "@peerbit/document",
    "@peerbit/program",
    "@peerbit/shared-log",
    "@peerbit/trusted-network",
] as const;

const isMajorCompatibleCaretRange = (range: string) =>
    /^\^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(range);

describe("package manifest", () => {
    it("keeps published peerbit dependency ranges major-compatible", () => {
        for (const dependency of syncedDependencies) {
            const version = libraryPackageJson.dependencies?.[dependency];
            expect(version).toBeDefined();
            expect(isMajorCompatibleCaretRange(version!)).toBe(true);
        }
    });

    it("rejects dependency ranges that can cross the next major", () => {
        for (const range of [
            "*",
            "latest",
            ">=5",
            ">=5 <7",
            "^5 || ^6",
            "~5.3.0",
            "5.3.0",
        ]) {
            expect(isMajorCompatibleCaretRange(range)).toBe(false);
        }
        for (const range of ["^5", "^5.3", "^5.3.0", "^13.1.0"]) {
            expect(isMajorCompatibleCaretRange(range)).toBe(true);
        }
    });
});
