import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LargeFile,
    ParentedLargeFileWithChunkHeads,
    TinyFile,
} from "@peerbit/please-lib";
import {
    File,
    formatIndexedChunkRatio,
    getFileChunkIdChange,
    hasFileChunkChange,
    LocalChunkCountTracker,
    shouldDisableFileDownload,
} from "../src/File";

const chunk = (parentId: string, index: number) =>
    new TinyFile({
        name: `${parentId}/${index}`,
        file: new Uint8Array([index]),
        parentId,
        index,
    });

describe("local chunk count UI", () => {
    it("uses one metadata snapshot and no growing COUNT queries for event bursts", async () => {
        vi.useFakeTimers();
        const events = new EventTarget();
        const listLocalChunkIds = vi.fn().mockResolvedValue([]);
        const countLocalChunks = vi.fn();
        const file = new LargeFile({
            id: "file-id",
            name: "large.bin",
            size: 100n,
            chunkCount: 100,
            ready: false,
        });

        render(
            createElement(File, {
                files: {
                    files: { events },
                    listLocalChunkIds,
                    countLocalChunks,
                } as any,
                isHost: false,
                replicated: true,
                file,
                delete: () => undefined,
                download: async () => undefined,
            })
        );
        await act(async () => {
            await Promise.resolve();
        });

        for (let index = 0; index < 50; index++) {
            events.dispatchEvent(
                new CustomEvent("change", {
                    detail: {
                        added: [chunk(file.id, index)],
                        removed: [],
                    },
                })
            );
        }
        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });

        expect(listLocalChunkIds).toHaveBeenCalledTimes(1);
        expect(countLocalChunks).not.toHaveBeenCalled();
        expect(screen.getByText("50% indexed")).toBeTruthy();
    });

    it("retries a failed initial snapshot without switching back to COUNT", async () => {
        vi.useFakeTimers();
        const listLocalChunkIds = vi
            .fn()
            .mockRejectedValueOnce(new Error("transient index failure"))
            .mockResolvedValue(["file-id:0"]);
        const countLocalChunks = vi.fn();
        const events = new EventTarget();
        const file = new LargeFile({
            id: "file-id",
            name: "large.bin",
            size: 2n,
            chunkCount: 2,
            ready: true,
        });

        render(
            createElement(File, {
                files: {
                    files: { events },
                    listLocalChunkIds,
                    countLocalChunks,
                } as any,
                isHost: false,
                replicated: true,
                file,
                delete: () => undefined,
                download: async () => undefined,
            })
        );
        await act(async () => {
            await Promise.resolve();
            events.dispatchEvent(
                new CustomEvent("change", {
                    detail: {
                        added: [chunk(file.id, 1)],
                        removed: [],
                    },
                })
            );
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(listLocalChunkIds).toHaveBeenCalledTimes(2);
        expect(countLocalChunks).not.toHaveBeenCalled();
        expect(screen.getByText("100% indexed")).toBeTruthy();
    });

    it("recovers once on a later exact chunk event after startup retries", async () => {
        vi.useFakeTimers();
        const warning = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        const listLocalChunkIds = vi
            .fn()
            .mockRejectedValueOnce(new Error("first failure"))
            .mockRejectedValueOnce(new Error("second failure"))
            .mockRejectedValueOnce(new Error("third failure"))
            .mockResolvedValue(["file-id:0"]);
        const countLocalChunks = vi.fn();
        const events = new EventTarget();
        const file = new LargeFile({
            id: "file-id",
            name: "large.bin",
            size: 2n,
            chunkCount: 2,
            ready: true,
        });

        render(
            createElement(File, {
                files: {
                    files: { events },
                    listLocalChunkIds,
                    countLocalChunks,
                } as any,
                isHost: false,
                replicated: true,
                file,
                delete: () => undefined,
                download: async () => undefined,
            })
        );
        await act(async () => {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(3);

        await act(async () => {
            for (let event = 0; event < 100; event++) {
                events.dispatchEvent(
                    new CustomEvent("change", {
                        detail: {
                            added: [chunk(file.id, 1)],
                            removed: [],
                        },
                    })
                );
            }
            await vi.advanceTimersByTimeAsync(4_999);
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(3);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(4);
        expect(countLocalChunks).not.toHaveBeenCalled();
        expect(screen.getByText("100% indexed")).toBeTruthy();
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it("remembers an exact event during startup retries for eventual recovery", async () => {
        vi.useFakeTimers();
        const warning = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        const listLocalChunkIds = vi
            .fn()
            .mockRejectedValueOnce(new Error("first failure"))
            .mockRejectedValueOnce(new Error("second failure"))
            .mockRejectedValueOnce(new Error("third failure"))
            .mockResolvedValue(["file-id:0"]);
        const countLocalChunks = vi.fn();
        const events = new EventTarget();
        const file = new LargeFile({
            id: "file-id",
            name: "large.bin",
            size: 2n,
            chunkCount: 2,
            ready: true,
        });

        render(
            createElement(File, {
                files: {
                    files: { events },
                    listLocalChunkIds,
                    countLocalChunks,
                } as any,
                isHost: false,
                replicated: true,
                file,
                delete: () => undefined,
                download: async () => undefined,
            })
        );
        await act(async () => {
            await Promise.resolve();
            events.dispatchEvent(
                new CustomEvent("change", {
                    detail: {
                        added: [chunk(file.id, 1)],
                        removed: [],
                    },
                })
            );
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(2_000);
            await vi.advanceTimersByTimeAsync(4_999);
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(3);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(listLocalChunkIds).toHaveBeenCalledTimes(4);
        expect(countLocalChunks).not.toHaveBeenCalled();
        expect(screen.getByText("100% indexed")).toBeTruthy();
        expect(warning).toHaveBeenCalledTimes(1);
    });
});

describe("file download controls", () => {
    it("disables while a download is in progress", () => {
        expect(
            shouldDisableFileDownload({
                progress: 0,
            })
        ).to.equal(true);
    });

    it("does not block pending large files before the read starts", () => {
        expect(
            shouldDisableFileDownload({
                progress: null,
            })
        ).to.equal(false);
    });

    it("refreshes local progress when a child chunk is removed", () => {
        const removed = chunk("file-id", 0);
        const parent = { id: "file-id", chunkCount: 1 };
        const detail = {
            added: [],
            removed: [removed],
        } as any;
        const change = getFileChunkIdChange(detail, parent);
        const tracker = new LocalChunkCountTracker();
        tracker.initialize([removed.id]);

        expect(change).toEqual({ added: [], removed: [removed.id] });
        expect(hasFileChunkChange(detail, parent)).toBe(true);
        expect(tracker.apply(change)).toBe(true);
        expect(tracker.count).toBe(0);
    });

    it("tracks exact deterministic slots identically for every payload type", () => {
        const parent = { id: "file-id", chunkCount: 4 };
        const matching = chunk("file-id", 0);
        const other = chunk("other-file", 0);
        const exactIdTinyWithoutIndex = new TinyFile({
            id: `${parent.id}:1`,
            name: "exact-id-without-index",
            file: new Uint8Array([1]),
            parentId: parent.id,
        });
        const exactIdWrongType = new ParentedLargeFileWithChunkHeads({
            id: `${parent.id}:2`,
            name: "exact-id-wrong-type",
            size: 1n,
            chunkCount: 0,
            ready: true,
            parentId: parent.id,
        });
        const wrongId = new TinyFile({
            id: "legacy-or-wrong-id",
            name: "wrong-id",
            file: new Uint8Array([1]),
            parentId: parent.id,
            index: 3,
        });
        const change = getFileChunkIdChange(
            {
                added: [
                    matching,
                    other,
                    exactIdTinyWithoutIndex,
                    exactIdWrongType,
                    wrongId,
                    chunk(parent.id, parent.chunkCount),
                ],
                removed: [other, exactIdTinyWithoutIndex, exactIdWrongType],
            } as any,
            parent
        );

        expect(change).toEqual({
            added: [
                matching.id,
                exactIdTinyWithoutIndex.id,
                exactIdWrongType.id,
            ],
            removed: [exactIdTinyWithoutIndex.id, exactIdWrongType.id],
        });
    });

    it("labels local chunk counts as indexed rather than fully replicated", () => {
        expect(formatIndexedChunkRatio(100)).toBe("100% indexed");
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("local chunk count tracking", () => {
    it("tracks inserts and deletes while treating replacements as idempotent", () => {
        const tracker = new LocalChunkCountTracker();
        expect(tracker.initialize(["file:0", "file:1"])).toBe(2);

        expect(tracker.apply({ added: ["file:2"], removed: [] })).toBe(true);
        expect(tracker.count).toBe(3);

        expect(tracker.apply({ added: ["file:1"], removed: [] })).toBe(false);
        expect(tracker.count).toBe(3);

        expect(tracker.apply({ added: [], removed: ["file:0"] })).toBe(true);
        expect(tracker.count).toBe(2);

        expect(
            tracker.apply({
                added: ["file:2"],
                removed: ["file:2"],
            })
        ).toBe(false);
        expect(tracker.count).toBe(2);
    });

    it("replays compacted changes received during the initial snapshot", () => {
        const tracker = new LocalChunkCountTracker();
        tracker.apply({ added: ["file:2"], removed: [] });
        tracker.apply({ added: ["file:0"], removed: [] });
        tracker.apply({ added: [], removed: ["file:1"] });

        expect(tracker.count).toBeUndefined();
        expect(tracker.initialize(["file:0", "file:1"])).toBe(2);
        expect(tracker.count).toBe(2);
    });

    it("restores the exact baseline when remounted", () => {
        const firstMount = new LocalChunkCountTracker();
        firstMount.initialize(["file:0"]);
        firstMount.apply({ added: ["file:1"], removed: [] });
        expect(firstMount.count).toBe(2);

        const remount = new LocalChunkCountTracker();
        expect(remount.initialize(["file:0", "file:1"])).toBe(2);
        expect(remount.count).toBe(2);
    });

    it("deduplicates event bursts by stable chunk id", () => {
        const tracker = new LocalChunkCountTracker();
        tracker.initialize([]);

        for (let index = 0; index < 2_048; index++) {
            const id = `file:${index}`;
            tracker.apply({ added: [id], removed: [] });
            tracker.apply({ added: [id], removed: [] });
        }
        expect(tracker.count).toBe(2_048);

        for (let index = 0; index < 1_024; index++) {
            tracker.apply({ added: [], removed: [`file:${index}`] });
        }
        expect(tracker.count).toBe(1_024);
    });
});
