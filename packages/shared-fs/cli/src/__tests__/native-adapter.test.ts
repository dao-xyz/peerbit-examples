import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    defaultNativeAdapterPath,
    getNativeAdapterTarget,
    nativeAdapterAssetName,
    nativeAdapterBinaryName,
    nativeAdapterDownloadUrl,
    nativeAdapterReleaseTag,
    resolveExternalNativeAdapter,
} from "../native-adapter.js";

describe("native adapter installer helpers", () => {
    it("maps supported platforms to release assets", () => {
        const mac = getNativeAdapterTarget("darwin", "arm64");
        expect(mac.id).toBe("darwin-arm64");
        expect(mac.binaryName).toBe("peerbit-shared-fs-native");
        expect(nativeAdapterAssetName(mac)).toBe(
            "peerbit-shared-fs-native-darwin-arm64.tar.gz"
        );

        const windows = getNativeAdapterTarget("win32", "x64");
        expect(windows.id).toBe("win32-x64");
        expect(windows.binaryName).toBe("peerbit-shared-fs-native.exe");
        expect(nativeAdapterAssetName(windows)).toBe(
            "peerbit-shared-fs-native-win32-x64.zip"
        );
    });

    it("builds release URLs from versions and base URL overrides", () => {
        expect(nativeAdapterReleaseTag("0.0.1")).toBe(
            "shared-fs-native-v0.0.1"
        );
        expect(nativeAdapterReleaseTag("shared-fs-native-v0.0.2")).toBe(
            "shared-fs-native-v0.0.2"
        );
        expect(
            nativeAdapterDownloadUrl({
                assetName: "peerbit-shared-fs-native-linux-x64.tar.gz",
                baseUrl: "https://example.com/releases/",
                tag: "shared-fs-native-v0.0.1",
            })
        ).toBe(
            "https://example.com/releases/peerbit-shared-fs-native-linux-x64.tar.gz"
        );
    });

    it("resolves explicit, environment, managed, and PATH adapters in order", async () => {
        const installDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-native-test-")
        );
        const managedPath = defaultNativeAdapterPath({
            installDir,
            platform: "darwin",
        });

        try {
            expect(
                await resolveExternalNativeAdapter("custom-adapter", {
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe("custom-adapter");

            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {
                        PEERBIT_SHARED_FS_NATIVE_ADAPTER: "env-adapter",
                    },
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe("env-adapter");

            await fs.writeFile(managedPath, "");
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {},
                    installDir,
                    platform: "darwin",
                    commandExists: async () => true,
                })
            ).toBe(managedPath);

            await fs.rm(managedPath);
            expect(
                await resolveExternalNativeAdapter(undefined, {
                    env: {},
                    installDir,
                    platform: "darwin",
                    commandExists: async (command) =>
                        command === nativeAdapterBinaryName("darwin"),
                })
            ).toBe("peerbit-shared-fs-native");
        } finally {
            await fs.rm(installDir, { recursive: true, force: true });
        }
    });
});
