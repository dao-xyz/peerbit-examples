import { describe, expect, it } from "vitest";
import { detectMacFuseRuntime } from "../native-mount-runtime.js";

const installed =
    (...libraries: string[]) =>
    async (path: string) =>
        libraries.includes(path);

const MACFUSE = "/usr/local/lib/libfuse.2.dylib";
const OSXFUSE = "/usr/local/lib/libosxfuse.2.dylib";
const FUSE_T = "/usr/local/lib/libfuse-t.dylib";

describe("macOS FUSE runtime detection", () => {
    it("uses FUSE-T when it is the only runtime", async () => {
        const status = await detectMacFuseRuntime(installed(FUSE_T));
        expect(status.runtime).toBe("FUSE-T");
        expect(status.missing).toEqual([]);
    });

    it("uses macFUSE, including OSXFUSE-era installs", async () => {
        for (const library of [MACFUSE, OSXFUSE]) {
            const status = await detectMacFuseRuntime(installed(library));
            expect(status.runtime).toBe("macFUSE");
            expect(status.missing).toEqual([]);
        }
    });

    it("reports that macFUSE wins when both are installed", async () => {
        const status = await detectMacFuseRuntime(installed(MACFUSE, FUSE_T));
        expect(status.runtime).toBe("macFUSE");
        expect(status.notes.join("\n")).toContain(
            "FUSE-T is also installed but unused"
        );
    });

    it("asks for macFUSE when neither is installed", async () => {
        const status = await detectMacFuseRuntime(
            installed("/usr/local/lib/libfuse3.dylib")
        );
        expect(status.runtime).toBeUndefined();
        expect(status.missing).toEqual(["macFUSE"]);
    });
});
