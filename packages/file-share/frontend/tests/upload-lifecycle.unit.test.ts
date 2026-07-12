import { describe, expect, it, vi } from "vitest";
import { settleUploadBatch } from "../src/upload-lifecycle";

describe("upload lifecycle", () => {
    it("reports a rejection and waits for the remaining uploads", async () => {
        let finishRemaining: () => void = () => {};
        const remaining = new Promise<void>((resolve) => {
            finishRemaining = resolve;
        });
        const onError = vi.fn();
        let settled = false;
        const batch = settleUploadBatch(
            [Promise.reject(new Error("upload failed")), remaining],
            onError
        ).then(() => {
            settled = true;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledOnce();
        expect(settled).toBe(false);

        finishRemaining();
        await batch;
        expect(settled).toBe(true);
    });

    it("resolves cleanly when every upload succeeds", async () => {
        const onError = vi.fn();
        await settleUploadBatch(
            [Promise.resolve(), Promise.resolve()],
            onError
        );
        expect(onError).not.toHaveBeenCalled();
    });
});
