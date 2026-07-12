import { describe, expect, it, vi } from "vitest";
import {
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import type { AbstractFile, Files } from "@peerbit/please-lib";
import {
    DEFAULT_REMOTE_ROOT_CONFIRMATION_TIMEOUT_MS,
    confirmRemoteRoot,
} from "../src/remote-root-confirmation";

const root = {
    id: "root",
    name: "root.bin",
    size: 1n,
} as AbstractFile;

const createProgram = (properties?: {
    hints?: string[] | undefined;
    search?: ReturnType<typeof vi.fn>;
    get?: ReturnType<typeof vi.fn>;
}) => {
    const search = properties?.search ?? vi.fn().mockResolvedValue([root]);
    const get = properties?.get ?? vi.fn();
    const hints =
        properties && "hints" in properties
            ? properties.hints
            : ["peer-a", "peer-b"];
    const getReadPeerHints = vi.fn().mockResolvedValue(hints);
    const program = {
        getReadPeerHints,
        files: { index: { get, search } },
    } as unknown as Files;
    return { get, getReadPeerHints, program, search };
};

describe("remote root confirmation", () => {
    it("uses a frozen peer snapshot for a bounded, non-replicating exact lookup", async () => {
        const hints = ["peer-a", "peer-b"];
        const { get, program, search } = createProgram({ hints });
        const controller = new AbortController();

        await expect(
            confirmRemoteRoot(program, "root", controller.signal)
        ).resolves.toEqual({ status: "present", root });

        expect(get).not.toHaveBeenCalled();
        expect(search).toHaveBeenCalledOnce();
        const [request, options] = search.mock.calls[0];
        expect(request).toBeInstanceOf(SearchRequest);
        expect(request.fetch).toBe(0xffffffff);
        expect(request.query).toHaveLength(1);
        expect(request.query[0]).toBeInstanceOf(StringMatch);
        expect(request.query[0]).toMatchObject({
            key: ["id"],
            value: "root",
            caseInsensitive: false,
            method: StringMatchMethod.exact,
        });
        expect(options).toEqual({
            local: false,
            signal: controller.signal,
            remote: {
                from: ["peer-a", "peer-b"],
                replicate: false,
                timeout: DEFAULT_REMOTE_ROOT_CONFIRMATION_TIMEOUT_MS,
                throwOnMissing: true,
                retryMissingResponses: false,
                strategy: "fallback",
            },
        });
        expect(options.remote.from).not.toBe(hints);
    });

    it("keeps a later peer result when an earlier response set is empty", async () => {
        const responseSets = [[], [root]] as AbstractFile[][];
        const get = vi.fn().mockResolvedValue(undefined);
        const search = vi
            .fn()
            .mockResolvedValue(responseSets.flatMap((results) => results));
        const { program } = createProgram({ get, search });

        await expect(
            confirmRemoteRoot(program, "root", new AbortController().signal)
        ).resolves.toEqual({ status: "present", root });
        expect(get).not.toHaveBeenCalled();
        expect(search).toHaveBeenCalledOnce();
    });

    it.each([undefined, []])(
        "returns unknown without querying when hints are %s",
        async (hints) => {
            const search = vi.fn();
            const { program } = createProgram({ hints, search });

            await expect(
                confirmRemoteRoot(program, "root", new AbortController().signal)
            ).resolves.toMatchObject({ status: "unknown" });
            expect(search).not.toHaveBeenCalled();
        }
    );

    it("classifies a successful empty response as missing", async () => {
        const { program } = createProgram({
            search: vi.fn().mockResolvedValue([]),
        });

        await expect(
            confirmRemoteRoot(program, "root", new AbortController().signal)
        ).resolves.toEqual({ status: "missing" });
    });

    it("classifies lookup failures as unknown and preserves their message", async () => {
        const { program } = createProgram({
            search: vi
                .fn()
                .mockRejectedValue(new Error("missing peer response")),
        });

        await expect(
            confirmRemoteRoot(program, "root", new AbortController().signal)
        ).resolves.toEqual({
            status: "unknown",
            diagnostic: "missing peer response",
        });
    });

    it("classifies cancellation as unknown without starting a lookup", async () => {
        const search = vi.fn();
        const { getReadPeerHints, program } = createProgram({ search });
        const controller = new AbortController();
        controller.abort();

        await expect(
            confirmRemoteRoot(program, "root", controller.signal)
        ).resolves.toMatchObject({ status: "unknown" });
        expect(getReadPeerHints).not.toHaveBeenCalled();
        expect(search).not.toHaveBeenCalled();
    });

    it("does not classify a returned child document as a present root", async () => {
        const child = {
            ...root,
            id: "child",
            parentId: "root",
        } as AbstractFile;
        const { program } = createProgram({
            search: vi.fn().mockResolvedValue([child]),
        });

        await expect(
            confirmRemoteRoot(program, "root", new AbortController().signal)
        ).resolves.toEqual({
            status: "unknown",
            diagnostic: "Exact root search returned no valid root document",
        });
    });

    it("does not classify a mismatched document id as the requested root", async () => {
        const mismatch = {
            ...root,
            id: "different-root",
        } as AbstractFile;
        const { program } = createProgram({
            search: vi.fn().mockResolvedValue([mismatch]),
        });

        await expect(
            confirmRemoteRoot(program, "root", new AbortController().signal)
        ).resolves.toEqual({
            status: "unknown",
            diagnostic: "Exact root search returned no valid root document",
        });
    });
});
