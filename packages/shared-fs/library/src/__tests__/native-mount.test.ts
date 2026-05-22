import { describe, expect, it } from "vitest";
import { getNativeMountSupport } from "../index.js";

describe("native mount support detection", () => {
    it("reports adapter availability without throwing", async () => {
        const support = await getNativeMountSupport();
        expect(support.platform).toBe(process.platform);
        expect(support.adapter).toMatch(/^(fuse-native|winfsp|unsupported)$/);
        expect(support.available).toBeTypeOf("boolean");
        expect(Array.isArray(support.missing)).toBe(true);
        expect(Array.isArray(support.notes)).toBe(true);
    });
});
