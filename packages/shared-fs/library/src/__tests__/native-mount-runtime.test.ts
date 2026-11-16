import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getNativeMountRefusal } from "../native-mount.js";
import {
    FUSE_T_UNSUPPORTED,
    detectMacFuseRuntime,
} from "../native-mount-runtime.js";

const installed =
    (...libraries: string[]) =>
    async (path: string) =>
        libraries.includes(path);

const MACFUSE = "/usr/local/lib/libfuse.2.dylib";
const OSXFUSE = "/usr/local/lib/libosxfuse.2.dylib";
const FUSE_T = "/usr/local/lib/libfuse-t.dylib";

describe("macOS FUSE runtime detection", () => {
    it("refuses FUSE-T when it is the only runtime, naming the fix and the libraries checked", async () => {
        const status = await detectMacFuseRuntime(installed(FUSE_T));
        expect(status.runtime).toBeUndefined();
        expect(status.missing).toEqual(["macFUSE"]);
        expect(status.refusal).toMatch(
            /^FUSE-T is not supported: install macFUSE \(brew install --cask macfuse\)/
        );
        for (const library of [MACFUSE, OSXFUSE, FUSE_T]) {
            expect(status.refusal).toContain(library);
        }
        expect(status.notes[0]).toBe(status.refusal);
    });

    it("uses macFUSE, including OSXFUSE-era installs", async () => {
        for (const library of [MACFUSE, OSXFUSE]) {
            const status = await detectMacFuseRuntime(installed(library));
            expect(status.runtime).toBe("macFUSE");
            expect(status.refusal).toBeUndefined();
            expect(status.missing).toEqual([]);
        }
    });

    it("reports that macFUSE wins when both are installed", async () => {
        for (const library of [MACFUSE, OSXFUSE]) {
            const status = await detectMacFuseRuntime(
                installed(library, FUSE_T)
            );
            expect(status.runtime).toBe("macFUSE");
            expect(status.refusal).toBeUndefined();
            expect(status.missing).toEqual([]);
            expect(status.notes.join("\n")).toContain(
                "FUSE-T is also installed but unused"
            );
        }
    });

    it("asks for macFUSE when neither is installed", async () => {
        const status = await detectMacFuseRuntime(
            installed("/usr/local/lib/libfuse3.dylib")
        );
        expect(status.runtime).toBeUndefined();
        expect(status.refusal).toBeUndefined();
        expect(status.missing).toEqual(["macFUSE"]);
    });

    it("words the refusal exactly as the adapter does", async () => {
        const adapter = await readFile(
            new URL("../../../native/mount_options.go", import.meta.url),
            "utf8"
        );
        expect(adapter).toContain(
            `errors.New(${JSON.stringify(FUSE_T_UNSUPPORTED)})`
        );
    });
});

describe("native mount refusal", () => {
    it("refuses only a Mac where the adapter would load FUSE-T", async () => {
        const refusal = (platform: NodeJS.Platform, ...libraries: string[]) =>
            getNativeMountRefusal({
                platform,
                pathExists: installed(...libraries),
            });
        expect(await refusal("darwin", FUSE_T)).toBe(FUSE_T_UNSUPPORTED);
        for (const libraries of [
            [MACFUSE],
            [OSXFUSE],
            [MACFUSE, FUSE_T],
            [OSXFUSE, FUSE_T],
            [],
        ]) {
            expect(await refusal("darwin", ...libraries)).toBeUndefined();
        }
        // Only the macOS adapter loads these libraries.
        for (const platform of ["linux", "win32"] as const) {
            expect(await refusal(platform, FUSE_T)).toBeUndefined();
        }
    });
});
