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

describe("package manifest", () => {
    it("keeps published peerbit dependency ranges major-compatible", () => {
        for (const dependency of syncedDependencies) {
            const version = libraryPackageJson.dependencies?.[dependency];
            expect(version).toBeDefined();
            expect(version).toMatch(/^\^\d+$/);
        }
    });
});
