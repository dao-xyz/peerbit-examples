import { describe, expect, it } from "vitest";
import { LargeFile, TinyFile } from "@peerbit/please-lib";
import {
    applyRootFileChangeToList,
    getRootFileChange,
    shouldRefreshRootListForFileChange,
} from "../src/root-list";

const largeFile = (properties: {
    id: string;
    name: string;
    ready?: boolean;
    finalHash?: string;
}) =>
    new LargeFile({
        id: properties.id,
        name: properties.name,
        size: 1024n,
        chunkCount: 2,
        ready: properties.ready ?? false,
        finalHash: properties.finalHash,
    });

describe("root list change handling", () => {
    it("extracts root file changes while ignoring chunk-only changes", () => {
        const root = largeFile({ id: "root", name: "root.bin" });
        const chunk = new TinyFile({
            id: "chunk",
            name: "root.bin/0",
            parentId: "root",
            file: new Uint8Array([1]),
            index: 0,
        });
        const event = new CustomEvent("change", {
            detail: { added: [chunk, root], removed: [] },
        });

        expect(shouldRefreshRootListForFileChange(event)).to.equal(true);
        expect(getRootFileChange(event).added.map((file) => file.id)).to.deep.eq(
            ["root"]
        );
    });

    it("does not refresh for child-only change batches", () => {
        const chunk = new TinyFile({
            id: "chunk",
            name: "root.bin/0",
            parentId: "root",
            file: new Uint8Array([1]),
            index: 0,
        });
        const event = new CustomEvent("change", {
            detail: { added: [chunk], removed: [] },
        });

        expect(shouldRefreshRootListForFileChange(event)).to.equal(false);
        expect(getRootFileChange(event).added).to.deep.eq([]);
    });

    it("adds roots from change payloads before full list queries catch up", () => {
        const root = largeFile({ id: "root", name: "root.bin" });

        expect(
            applyRootFileChangeToList([], { added: [root], removed: [] }).map(
                (file) => file.name
            )
        ).to.deep.eq(["root.bin"]);
    });

    it("keeps ready root metadata over older pending metadata", () => {
        const pending = largeFile({ id: "root", name: "root.bin" });
        const ready = largeFile({
            id: "root",
            name: "root.bin",
            ready: true,
            finalHash: "final",
        });

        const withReady = applyRootFileChangeToList([pending], {
            added: [ready],
            removed: [],
        });
        expect((withReady[0] as LargeFile).ready).to.equal(true);

        const stillReady = applyRootFileChangeToList(withReady, {
            added: [pending],
            removed: [],
        });
        expect((stillReady[0] as LargeFile).ready).to.equal(true);
    });

    it("removes roots from explicit root removal events", () => {
        const root = largeFile({ id: "root", name: "root.bin" });
        const next = applyRootFileChangeToList([root], {
            added: [],
            removed: [{ id: "root", parentId: undefined }],
        });

        expect(next).to.deep.eq([]);
    });
});
