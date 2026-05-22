import { describe, expect, it } from "vitest";
import { runCli } from "../index.js";

describe("peerbit-fs cli", () => {
    it("exports the CLI entry point", () => {
        expect(runCli).toBeTypeOf("function");
    });
});
