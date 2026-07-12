import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
    MemoryRouter,
    Route,
    Routes,
    useNavigate,
    type NavigateFunction,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressKeyedDrop } from "../src/routes";
import {
    applyReplicationRoleGuarded,
    applyReplicationRoleUntilStable,
    createFileShareReplicationRole,
    DEFAULT_REPLICATION_ROLE,
    FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
    formatFileShareStorageMegabytes,
    getInitialReplicationRole,
    normalizeFileShareReplicationRole,
    parseFileShareStorageMegabytes,
} from "../src/role-state";
import type { Files } from "@peerbit/please-lib";
import type { ReplicationOptions } from "@peerbit/shared-log";

const dropLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../src/Drop", async () => {
    const { useEffect } = await import("react");
    return {
        Drop: () => {
            useEffect(() => {
                dropLifecycle.mounts += 1;
                return () => {
                    dropLifecycle.unmounts += 1;
                };
            }, []);
            return null;
        },
    };
});

describe("file-share route state", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("remounts route state when only the address parameter changes", async () => {
        dropLifecycle.mounts = 0;
        dropLifecycle.unmounts = 0;
        let navigate: NavigateFunction | undefined;
        const RouteHarness = () => {
            navigate = useNavigate();
            return createElement(
                Routes,
                null,
                createElement(Route, {
                    path: "/s/:address",
                    element: createElement(AddressKeyedDrop),
                })
            );
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;

        await act(async () => {
            root.render(
                createElement(
                    MemoryRouter,
                    { initialEntries: ["/s/first"] },
                    createElement(RouteHarness)
                )
            );
        });
        expect(dropLifecycle.mounts).toBe(1);

        await act(async () => {
            navigate?.("/s/second");
        });
        expect(dropLifecycle.mounts).toBe(2);
        expect(dropLifecycle.unmounts).toBe(1);

        await act(async () => root.unmount());
    });

    it("uses the default replication role when a share has no stored role", () => {
        expect(getInitialReplicationRole(null)).toBe(DEFAULT_REPLICATION_ROLE);
        expect(getInitialReplicationRole("false")).toBe(false);
    });

    it("quiets only unconstrained file-share replication roles", () => {
        expect(createFileShareReplicationRole({ cpuMax: 1 })).toEqual({
            limits: {
                cpu: { max: 1 },
                storage: undefined,
                interval: FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
            },
        });
        expect(createFileShareReplicationRole({})).toEqual({
            limits: {
                cpu: undefined,
                storage: undefined,
                interval: FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
            },
        });
        expect(createFileShareReplicationRole({ cpuMax: 0.5 })).toEqual({
            limits: {
                cpu: { max: 0.5 },
                storage: undefined,
            },
        });
        expect(
            createFileShareReplicationRole({ cpuMax: 1, storage: 1_000_000 })
        ).toEqual({
            limits: {
                cpu: { max: 1 },
                storage: 1_000_000,
            },
        });
    });

    it("round-trips persisted storage bytes through the megabyte input", () => {
        const persistedStorageBytes = 100_000_000;
        const inputValue = formatFileShareStorageMegabytes(
            persistedStorageBytes
        );

        expect(inputValue).toBe("100");
        expect(parseFileShareStorageMegabytes(inputValue)).toBe(
            persistedStorageBytes
        );
    });

    it("normalizes legacy default roles without overriding explicit intervals", () => {
        expect(
            normalizeFileShareReplicationRole({
                limits: { cpu: { max: 1 } },
            })
        ).toEqual({
            limits: {
                cpu: { max: 1 },
                interval: FILE_SHARE_QUIET_REBALANCE_INTERVAL_MS,
            },
        });
        const explicit = {
            limits: { cpu: { max: 1 }, interval: 12_345 },
        } satisfies ReplicationOptions;
        expect(normalizeFileShareReplicationRole(explicit)).toBe(explicit);
    });

    it("enables the requested replication role while its context stays current", async () => {
        const calls: ReplicationOptions[] = [];
        const program = {
            closed: false,
            persistChunkReads: false,
            files: {
                log: {
                    replicate: vi.fn(async (role: ReplicationOptions) => {
                        calls.push(role);
                    }),
                },
            },
        } as unknown as Files;
        const requestedRole: ReplicationOptions = { limits: {} };

        await applyReplicationRoleGuarded(program, requestedRole, {
            expectedRevision: 1,
            getCurrentRevision: () => 1,
            getCurrentRole: () => requestedRole,
            isContextActive: () => true,
        });

        expect(calls).toEqual([false, requestedRole]);
        expect(program.persistChunkReads).toBe(true);
    });

    it("does not re-enable a role that changed while replication was disabling", async () => {
        let releaseDisable: () => void = () => {};
        const disabled = new Promise<void>((resolve) => {
            releaseDisable = resolve;
        });
        const calls: ReplicationOptions[] = [];
        const program = {
            closed: false,
            persistChunkReads: false,
            files: {
                log: {
                    replicate: vi.fn(async (role: ReplicationOptions) => {
                        calls.push(role);
                        if (role === false) {
                            await disabled;
                        }
                    }),
                },
            },
        } as unknown as Files;
        const requestedRole: ReplicationOptions = { limits: {} };
        let currentRole: ReplicationOptions = requestedRole;
        let revision = 1;

        const applying = applyReplicationRoleGuarded(program, requestedRole, {
            expectedRevision: revision,
            getCurrentRevision: () => revision,
            getCurrentRole: () => currentRole,
            isContextActive: () => true,
        });
        currentRole = false;
        revision += 1;
        releaseDisable();
        await applying;

        expect(calls).toEqual([false]);
    });

    it("does not re-enable replication after its share context becomes stale", async () => {
        let releaseDisable: () => void = () => {};
        const disabled = new Promise<void>((resolve) => {
            releaseDisable = resolve;
        });
        const calls: ReplicationOptions[] = [];
        const program = {
            closed: false,
            persistChunkReads: false,
            files: {
                log: {
                    replicate: vi.fn(async (role: ReplicationOptions) => {
                        calls.push(role);
                        if (role === false) {
                            await disabled;
                        }
                    }),
                },
            },
        } as unknown as Files;
        const requestedRole: ReplicationOptions = { limits: {} };
        let active = true;

        const applying = applyReplicationRoleGuarded(program, requestedRole, {
            expectedRevision: 1,
            getCurrentRevision: () => 1,
            getCurrentRole: () => requestedRole,
            isContextActive: () => active,
        });
        active = false;
        releaseDisable();
        await applying;

        expect(calls).toEqual([false]);
    });

    it("reapplies the newest role until multiple racing revisions settle", async () => {
        const role1: ReplicationOptions = { limits: { memory: 1 } };
        const role2: ReplicationOptions = { limits: { memory: 2 } };
        const role3: ReplicationOptions = { limits: { memory: 3 } };
        let currentRole = role1;
        let revision = 1;
        let disableCount = 0;
        const calls: ReplicationOptions[] = [];
        const program = {
            closed: false,
            persistChunkReads: false,
            files: {
                log: {
                    replicate: vi.fn(async (role: ReplicationOptions) => {
                        calls.push(role);
                        if (role !== false) {
                            return;
                        }
                        disableCount += 1;
                        if (disableCount === 1) {
                            currentRole = role2;
                            revision = 2;
                        } else if (disableCount === 2) {
                            currentRole = role3;
                            revision = 3;
                        }
                    }),
                },
            },
        } as unknown as Files;

        const appliedRevision = await applyReplicationRoleUntilStable(
            program,
            1,
            {
                getCurrentRevision: () => revision,
                getCurrentRole: () => currentRole,
                isContextActive: () => true,
            }
        );

        expect(appliedRevision).toBe(3);
        expect(calls).toEqual([false, false, false, role3]);
        expect(program.persistChunkReads).toBe(true);
    });
});
