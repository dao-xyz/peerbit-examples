import { describe, expect, it, vi } from "vitest";
import { openFuseNativeCreate } from "../fuse-native-create.js";

describe("fuse-native create shim", () => {
    it("uses a non-truncating exclusive read/write create", async () => {
        const open = vi.fn(async () => 41);

        await expect(
            openFuseNativeCreate({ open }, "/new-node.txt")
        ).resolves.toBe(41);
        expect(open).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledWith("/new-node.txt", {
            read: true,
            write: true,
            create: true,
            exclusive: true,
        });
        expect(open.mock.calls[0]?.[1]).not.toHaveProperty("truncate");
    });
});
