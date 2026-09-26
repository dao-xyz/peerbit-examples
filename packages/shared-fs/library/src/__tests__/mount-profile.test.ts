import { describe, expect, it, vi } from "vitest";
import {
    emitSharedFsMountProfile,
    profileSharedFsMountOperation,
    type SharedFsMountProfileEvent,
} from "../mount-profile.js";

describe("shared fs mount profiling", () => {
    it("uses monotonic nanoseconds and preserves the operation result", async () => {
        const clock = vi
            .spyOn(process.hrtime, "bigint")
            .mockReturnValueOnce(10n)
            .mockReturnValueOnce(27n);
        const events: SharedFsMountProfileEvent[] = [];
        try {
            await expect(
                profileSharedFsMountOperation(
                    (event) => events.push(event),
                    {
                        source: "node-daemon",
                        phase: "ipc.service",
                        operation: "getattr",
                    },
                    async () => "result"
                )
            ).resolves.toBe("result");
        } finally {
            clock.mockRestore();
        }
        expect(events).toEqual([
            {
                schema: "peerbit.shared-fs.mount-profile.v1",
                source: "node-daemon",
                phase: "ipc.service",
                operation: "getattr",
                durationNs: 17,
                ok: true,
            },
        ]);
    });

    it("reports failure without replacing the operation error", async () => {
        const expected = new Error("backend failed");
        const events: SharedFsMountProfileEvent[] = [];
        await expect(
            profileSharedFsMountOperation(
                (event) => events.push(event),
                {
                    source: "node-daemon",
                    phase: "mount.target.writeFile",
                    operation: "writeFile",
                },
                async () => {
                    throw expected;
                }
            )
        ).rejects.toBe(expected);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            phase: "mount.target.writeFile",
            ok: false,
        });
    });

    it("isolates a report sink failure", () => {
        expect(() =>
            emitSharedFsMountProfile(
                () => {
                    throw new Error("report failed");
                },
                {
                    schema: "peerbit.shared-fs.mount-profile.v1",
                    source: "node-daemon",
                    phase: "ipc.service",
                    operation: "read",
                    durationNs: 1,
                    ok: true,
                }
            )
        ).not.toThrow();
    });

    it("isolates a rejected async report sink", async () => {
        const rejection = Promise.reject(new Error("async report failed"));
        const catchRejection = vi.spyOn(rejection, "catch");

        emitSharedFsMountProfile(() => rejection, {
            schema: "peerbit.shared-fs.mount-profile.v1",
            source: "node-daemon",
            phase: "ipc.service",
            operation: "read",
            durationNs: 1,
            ok: true,
        });

        expect(catchRejection).toHaveBeenCalledOnce();
        await expect(rejection).rejects.toThrow("async report failed");
    });
});
