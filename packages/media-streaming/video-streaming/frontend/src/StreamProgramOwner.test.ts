import { describe, expect, it, vi } from "vitest";
import {
    selectStreamProgramTarget,
    type StreamProgramOwnership,
} from "./streamProgramOwnership";

type Program = { address: string };

const emptyOwnership = (): StreamProgramOwnership<Program> => ({
    created: undefined,
    peerId: undefined,
    wasCreateRoute: false,
});

const select = (
    ownership: StreamProgramOwnership<Program>,
    route:
        | { kind: "create" }
        | { kind: "stream"; address: string }
        | { kind: "outside" },
    create = vi.fn(() => ({ address: "created" }))
) =>
    selectStreamProgramTarget(
        ownership,
        route,
        "peer",
        create,
        (program) => program.address
    );

describe("selectStreamProgramTarget", () => {
    it("hands the created program to its exact address route", () => {
        const create = vi.fn(() => ({ address: "created" }));
        const root = select(emptyOwnership(), { kind: "create" }, create);
        const destination = select(root.ownership, {
            kind: "stream",
            address: "created",
        });

        expect(create).toHaveBeenCalledOnce();
        expect(destination.target).toBe(root.target);
        expect(destination.ownership.created).toBe(root.target);
    });

    it("opens direct and non-matching addresses without retaining a creation", () => {
        const root = select(emptyOwnership(), { kind: "create" });
        const destination = select(root.ownership, {
            kind: "stream",
            address: "external",
        });

        expect(destination.target).toBe("external");
        expect(destination.ownership.created).toBeUndefined();
    });

    it("drops the target outside the owned routes", () => {
        const root = select(emptyOwnership(), { kind: "create" });
        const outside = select(root.ownership, { kind: "outside" });

        expect(outside.target).toBeUndefined();
        expect(outside.ownership.created).toBeUndefined();
    });

    it("creates a fresh program after returning to the root route", () => {
        const first = select(emptyOwnership(), { kind: "create" });
        const destination = select(first.ownership, {
            kind: "stream",
            address: "created",
        });
        const create = vi.fn(() => ({ address: "replacement" }));
        const second = select(
            destination.ownership,
            { kind: "create" },
            create
        );

        expect(create).toHaveBeenCalledOnce();
        expect(second.target).toEqual({ address: "replacement" });
        expect(second.target).not.toBe(first.target);
    });
});
