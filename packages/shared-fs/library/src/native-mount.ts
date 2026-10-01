import { detectMacFuseRuntime } from "./native-mount-runtime.js";

export type NativeMountSupport = {
    platform: NodeJS.Platform;
    adapter: "fuse" | "winfsp" | "unsupported";
    available: boolean;
    missing: string[];
    notes: string[];
};

export class NativeMountUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeMountUnavailableError";
    }
}

const pathExists = async (path: string) => {
    const { access } = await import("node:fs/promises");
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const commandExists = async (command: string) => {
    const { execFile } = await import("node:child_process");
    const executable = process.platform === "win32" ? "where" : "which";
    return new Promise<boolean>((resolve) => {
        execFile(executable, [command], (error) => {
            resolve(!error);
        });
    });
};

const externalNativeAdapterAvailable = async (resolved?: boolean) => {
    if (resolved !== undefined) {
        return resolved;
    }
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER) {
        return true;
    }
    return commandExists("peerbit-shared-fs-native");
};

export const getNativeMountSupport = async (
    options: {
        /**
         * Whether the caller already resolved an external
         * peerbit-shared-fs-native adapter. When omitted, the adapter is
         * looked up from PEERBIT_SHARED_FS_NATIVE_ADAPTER and PATH.
         */
        externalAdapter?: boolean;
    } = {}
): Promise<NativeMountSupport> => {
    if (process.platform === "linux") {
        const hasFuseDevice = await pathExists("/dev/fuse");
        const hasFusermount =
            (await commandExists("fusermount3")) ||
            (await commandExists("fusermount"));
        const hasExternalAdapter = await externalNativeAdapterAvailable(
            options.externalAdapter
        );
        const missing = [
            !hasFuseDevice ? "/dev/fuse" : undefined,
            !hasFusermount ? "fusermount/fusermount3" : undefined,
            !hasExternalAdapter
                ? "peerbit-shared-fs-native adapter binary"
                : undefined,
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "fuse",
            available: missing.length === 0,
            missing,
            notes: ["Linux native mounts use FUSE/libfuse."],
        };
    }

    if (process.platform === "darwin") {
        const fuse = await detectMacFuseRuntime(pathExists);
        const hasExternalAdapter = await externalNativeAdapterAvailable(
            options.externalAdapter
        );
        const missing = [
            ...fuse.missing,
            !hasExternalAdapter
                ? "peerbit-shared-fs-native adapter binary"
                : undefined,
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "fuse",
            available: missing.length === 0,
            missing,
            notes: fuse.notes,
        };
    }

    if (process.platform === "win32") {
        const hasWinFsp =
            (await pathExists(
                "C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll"
            )) ||
            (await pathExists(
                "C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll"
            ));
        const hasExternalAdapter = await externalNativeAdapterAvailable(
            options.externalAdapter
        );
        const missing = [
            !hasWinFsp ? "WinFsp runtime" : undefined,
            !hasExternalAdapter
                ? "peerbit-shared-fs-native adapter binary"
                : undefined,
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "winfsp",
            available: missing.length === 0,
            missing,
            notes: [
                "Windows native mounts use WinFsp through the external peerbit-shared-fs-native adapter.",
            ],
        };
    }

    return {
        platform: process.platform,
        adapter: "unsupported",
        available: false,
        missing: [`native mount adapter for ${process.platform}`],
        notes: [],
    };
};

export const unmountNativeMountpoint = async (mountpoint: string) => {
    if (process.platform === "win32") {
        throw new NativeMountUnavailableError(
            "Windows unmount requires the WinFsp adapter service."
        );
    }
    const { execFile } = await import("node:child_process");
    const command = process.platform === "darwin" ? "umount" : "fusermount";
    const args =
        process.platform === "darwin" ? [mountpoint] : ["-u", mountpoint];
    await new Promise<void>((resolve, reject) => {
        execFile(command, args, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
};
