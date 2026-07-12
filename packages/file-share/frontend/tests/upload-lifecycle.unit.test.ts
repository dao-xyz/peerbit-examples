import { describe, expect, it, vi } from "vitest";
import { settleUploadBatch, takeInputFiles } from "../src/upload-lifecycle";

describe("upload lifecycle", () => {
    it("snapshots selected files and clears the input", () => {
        const first = { name: "first.bin" } as File;
        const second = { name: "second.bin" } as File;
        const input = {
            files: [first, second] as unknown as FileList,
            value: "/fake/path/first.bin",
        };

        const selected = takeInputFiles(input);

        expect(selected).toEqual([first, second]);
        expect(input.value).toBe("");
    });

    it("clears an empty input", () => {
        const input = { files: null, value: "/fake/path/stale.bin" };

        expect(takeInputFiles(input)).toEqual([]);
        expect(input.value).toBe("");
    });

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
