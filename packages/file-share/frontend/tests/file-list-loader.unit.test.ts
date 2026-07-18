import { describe, expect, it, vi } from "vitest";
import type { Files } from "@peerbit/please-lib";
import {
    coalesceRootListRefreshSource,
    getRootListRefreshSource,
    listRemoteRootFilesForReconciliation,
    listRootFilesForRole,
    shouldReconcileRemoteRootFiles,
} from "../src/file-list-loader";

describe("file-share root list loading", () => {
    it("preserves join events and maps argument-less periodic ticks to refresh", () => {
        expect(getRootListRefreshSource({ type: "join" })).toBe("join");
        expect(getRootListRefreshSource()).toBe("refresh");
        expect(getRootListRefreshSource("role-change")).toBe("role-change");
    });

    it("does not let periodic or stale work overwrite a queued lifecycle reconciliation", () => {
        expect(coalesceRootListRefreshSource("join", "refresh")).toBe("join");
        expect(
            coalesceRootListRefreshSource("role-change", "stale-root-revision")
        ).toBe("role-change");
        expect(coalesceRootListRefreshSource("refresh", "join")).toBe("join");
        expect(coalesceRootListRefreshSource("event", "refresh")).toBe(
            "refresh"
        );
    });

    it("uses a local-only root query for replicators", async () => {
        const roots = [{ id: "root" }];
        const search = vi.fn().mockResolvedValue(roots);
        const list = vi.fn();
        const program = {
            list,
            files: { index: { search } },
        } as unknown as Files;

        await expect(
            listRootFilesForRole(program, { limits: {} })
        ).resolves.toBe(roots);
        expect(list).not.toHaveBeenCalled();
        expect(search).toHaveBeenCalledOnce();
        expect(search.mock.calls[0][1]).toEqual({
            local: true,
            remote: false,
        });
    });

    it("keeps remote listing non-replicating for persisted-read observers", async () => {
        const roots = [{ id: "remote-root" }];
        const search = vi.fn();
        const list = vi.fn().mockResolvedValue(roots);
        const program = {
            persistChunkReads: true,
            list,
            files: { index: { search } },
        } as unknown as Files;

        await expect(listRootFilesForRole(program, false)).resolves.toBe(roots);
        expect(list).toHaveBeenCalledExactlyOnceWith({ replicate: false });
        expect(search).not.toHaveBeenCalled();
    });

    it("uses a non-replicating root-only remote query for reconciliation", async () => {
        const roots = [{ id: "remote-root" }];
        const search = vi.fn().mockResolvedValue(roots);
        const from = ["peer-hint"];
        const getReadPeerHints = vi.fn().mockResolvedValue(from);
        const program = {
            getReadPeerHints,
            files: { index: { search } },
        } as unknown as Files;

        await expect(
            listRemoteRootFilesForReconciliation(program)
        ).resolves.toBe(roots);
        expect(getReadPeerHints).toHaveBeenCalledOnce();
        expect(search).toHaveBeenCalledOnce();
        expect(search.mock.calls[0][1]).toEqual({
            local: false,
            remote: {
                throwOnMissing: false,
                replicate: false,
                from,
            },
        });
    });

    it("reconciles replicators on lifecycle triggers and a slow cadence", () => {
        const role = { limits: {} };
        const policy = (
            source: string,
            now: number,
            lastStartedAt: number | null
        ) =>
            shouldReconcileRemoteRootFiles({
                role,
                source,
                now,
                lastStartedAt,
            });

        expect(policy("initial-open", 1_000, null)).toBe(true);
        expect(policy("join", 2_000, 1_000)).toBe(true);
        expect(policy("role-change", 3_000, 2_000)).toBe(true);
        expect(policy("refresh", 29_999, 0)).toBe(false);
        expect(policy("refresh", 30_000, 0)).toBe(true);
        expect(policy("event", 30_000, 0)).toBe(false);
        expect(policy("stale-root-revision", 30_000, 0)).toBe(false);
    });

    it("never adds a second remote reconciliation for observers", () => {
        for (const source of [
            "initial-open",
            "join",
            "role-change",
            "refresh",
        ]) {
            expect(
                shouldReconcileRemoteRootFiles({
                    role: false,
                    source,
                    now: 60_000,
                    lastStartedAt: null,
                })
            ).toBe(false);
        }
    });
});
