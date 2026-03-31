import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
) as {
    pnpm?: {
        overrides?: Record<string, string>;
    };
};
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
] as const;

const normalizeVersion = (version?: string) =>
    version?.trim().replace(/^[~^]/, "");

describe("package manifest", () => {
    it("keeps published peerbit dependency pins aligned with repo overrides", () => {
        for (const dependency of syncedDependencies) {
            expect(
                normalizeVersion(libraryPackageJson.dependencies?.[dependency])
            ).toBe(
                normalizeVersion(rootPackageJson.pnpm?.overrides?.[dependency])
            );
        }
    });
});
