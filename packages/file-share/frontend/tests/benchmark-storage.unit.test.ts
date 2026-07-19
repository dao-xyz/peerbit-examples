import { describe, expect, it } from "vitest";
import {
    FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK,
    getFileShareBenchmarkStorageBackendEvidence,
    getFileShareBenchmarkStorageMode,
} from "../src/benchmark-storage";

describe("file-share benchmark storage selection", () => {
    it("preserves the normal app path when the page-init hook is absent", () => {
        expect(getFileShareBenchmarkStorageMode({} as Window)).toBeNull();
    });

    it.each(["memory", "opfs"] as const)(
        "accepts the %s page-init cohort",
        (mode) => {
            expect(
                getFileShareBenchmarkStorageMode({
                    [FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK]: mode,
                } as unknown as Window)
            ).toBe(mode);
        }
    );

    it("fails closed on unsupported or unreadable page-init values", () => {
        expect(() =>
            getFileShareBenchmarkStorageMode({
                [FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK]: "indexeddb",
            } as unknown as Window)
        ).toThrow('expected "memory" or "opfs"');

        const unreadable = {};
        Object.defineProperty(
            unreadable,
            FILE_SHARE_BENCHMARK_STORAGE_MODE_HOOK,
            {
                get: () => {
                    throw new Error("hook getter failed");
                },
            }
        );
        expect(() =>
            getFileShareBenchmarkStorageMode(unreadable as Window)
        ).toThrow("hook getter failed");
    });
});

describe("file-share benchmark storage backend evidence", () => {
    it("reports the selected backend without exposing its directory path", async () => {
        const evidence = await getFileShareBenchmarkStorageBackendEvidence({
            requestedMode: "opfs",
            navigatorStorage: {
                persisted: async () => true,
            },
            peer: {
                directory: "./repo/private-peer-id/",
                storage: { persisted: () => true },
                services: { blocks: { persisted: async () => true } },
                indexer: { persisted: () => true },
            },
        });

        expect(evidence).toEqual({
            requestedMode: "opfs",
            directoryConfigured: true,
            directoryConfigurationError: null,
            persistence: {
                navigatorStorage: {
                    api: "navigator.storage.persisted",
                    available: true,
                    persisted: true,
                    error: null,
                },
                peerStorage: {
                    api: "peer.storage.persisted",
                    available: true,
                    persisted: true,
                    error: null,
                },
                peerBlocks: {
                    api: "peer.services.blocks.persisted",
                    available: true,
                    persisted: true,
                    error: null,
                },
                peerIndexer: {
                    api: "peer.indexer.persisted",
                    available: true,
                    persisted: true,
                    error: null,
                },
            },
        });
        expect(JSON.stringify(evidence)).not.toContain("private-peer-id");
    });

    it("records missing and failing persistence APIs without throwing", async () => {
        const peer = {
            directory: undefined,
            storage: {
                persisted: async () => {
                    throw new Error("x".repeat(700));
                },
            },
            services: { blocks: {} },
            indexer: { persisted: () => "yes" },
        };
        const evidence = await getFileShareBenchmarkStorageBackendEvidence({
            requestedMode: "memory",
            navigatorStorage: undefined,
            peer,
        });

        expect(evidence.directoryConfigured).toBe(false);
        expect(evidence.persistence.navigatorStorage).toMatchObject({
            available: false,
            persisted: null,
            error: null,
        });
        expect(evidence.persistence.peerStorage).toMatchObject({
            available: true,
            persisted: null,
        });
        expect(evidence.persistence.peerStorage.error).toHaveLength(512);
        expect(evidence.persistence.peerBlocks).toMatchObject({
            available: false,
            persisted: null,
            error: null,
        });
        expect(evidence.persistence.peerIndexer).toMatchObject({
            available: true,
            persisted: null,
            error: "peer.indexer.persisted returned a non-boolean value",
        });
    });
});
