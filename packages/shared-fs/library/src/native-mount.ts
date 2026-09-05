import type {
    SharedFsBackendErrorCode,
    SharedFsMountBackend,
    SharedFsMountBackendTarget,
} from "./mount-backend.js";
import {
    SharedFsBackendError,
    createSharedFsMountBackend,
} from "./mount-backend.js";
import { openFuseNativeCreate } from "./fuse-native-create.js";
import {
    beginSharedFsMountProfile,
    type SharedFsMountProfileSink,
} from "./mount-profile.js";

export type NativeMountOptions = {
    mountpoint: string;
    force?: boolean;
    mkdir?: boolean;
    /** Observe userspace callback duration; disabled by default. */
    profile?: SharedFsMountProfileSink;
};

export type NativeMountSession = {
    mountpoint: string;
    unmount(): Promise<void>;
};

export type NativeMountSupport = {
    platform: NodeJS.Platform;
    adapter: "fuse-native" | "winfsp" | "unsupported";
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

const errnoForPlatform = (
    platform: NodeJS.Platform
): Record<SharedFsBackendErrorCode, number> & { EPERM: number } => ({
    EPERM: -1,
    ENOENT: -2,
    EIO: -5,
    // Darwin follows BSD here; Linux and WinFsp use 11.
    EAGAIN: platform === "darwin" ? -35 : -11,
    EBADF: -9,
    EACCES: -13,
    EEXIST: -17,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    EROFS: -30,
    // ENOTEMPTY differs per platform (Linux 39, Darwin/BSD 66).
    ENOTEMPTY: platform === "darwin" ? -66 : -39,
});

/** Platform-correct errno mapping shared by adapters and portable tests. */
export const sharedFsBackendErrno = (
    code: SharedFsBackendErrorCode,
    platform: NodeJS.Platform = process.platform
) => errnoForPlatform(platform)[code];

const errno = errnoForPlatform(process.platform);

const importOptional = async (specifier: string) => {
    return import(specifier);
};

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

const packageAvailable = async (specifier: string) => {
    try {
        await importOptional(specifier);
        return true;
    } catch {
        return false;
    }
};

const externalNativeAdapterAvailable = async () => {
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER) {
        return true;
    }
    return commandExists("peerbit-shared-fs-native");
};

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const getNativeMountSupport = async (): Promise<NativeMountSupport> => {
    if (process.platform === "linux") {
        const hasFuseDevice = await pathExists("/dev/fuse");
        const hasFusermount =
            (await commandExists("fusermount3")) ||
            (await commandExists("fusermount"));
        const hasFuseNative = await packageAvailable("fuse-native");
        const hasExternalAdapter = await externalNativeAdapterAvailable();
        const missing = [
            !hasFuseDevice ? "/dev/fuse" : undefined,
            !hasFusermount ? "fusermount/fusermount3" : undefined,
            !hasFuseNative && !hasExternalAdapter
                ? "optional fuse-native package or peerbit-shared-fs-native adapter"
                : undefined,
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "fuse-native",
            available: missing.length === 0,
            missing,
            notes: ["Linux native mounts use FUSE/libfuse."],
        };
    }

    if (process.platform === "darwin") {
        const hasMacFuse =
            (await pathExists("/Library/Filesystems/macfuse.fs")) ||
            (await commandExists("mount_macfuse"));
        const hasFuseNative = await packageAvailable("fuse-native");
        const hasExternalAdapter = await externalNativeAdapterAvailable();
        const missing = [
            !hasMacFuse ? "macFUSE" : undefined,
            !hasFuseNative && !hasExternalAdapter
                ? "optional fuse-native package or peerbit-shared-fs-native adapter"
                : undefined,
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "fuse-native",
            available: missing.length === 0,
            missing,
            notes: [
                "macOS native mounts require macFUSE, which usually needs host-level installation and approval.",
            ],
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
        const hasExternalAdapter = await externalNativeAdapterAvailable();
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

const isBackend = (
    value: SharedFsMountBackend | SharedFsMountBackendTarget
): value is SharedFsMountBackend => {
    return typeof (value as SharedFsMountBackend).getattr === "function";
};

const toErrno = (error: unknown) => {
    if (error instanceof SharedFsBackendError) {
        return sharedFsBackendErrno(error.code);
    }
    return errno.EIO;
};

const withNativeCallback = <T>(
    profile: SharedFsMountProfileSink | undefined,
    operation: string,
    fn: () => Promise<T>,
    success: (value: T) => void,
    failure: (error: unknown) => void
) => {
    if (!profile) {
        fn().then(success, failure);
        return;
    }
    const finish = beginSharedFsMountProfile(profile, {
        source: "fuse-native",
        phase: "native.callback",
        operation,
    });
    fn().then(
        (value) => {
            try {
                success(value);
                finish(true);
            } catch (error) {
                finish(false);
                throw error;
            }
        },
        (error) => {
            try {
                failure(error);
            } finally {
                finish(false);
            }
        }
    );
};

const withCallback = (
    fn: () => Promise<void>,
    callback: (errno: number) => void,
    profile?: SharedFsMountProfileSink,
    operation = "unknown"
) => {
    withNativeCallback(
        profile,
        operation,
        fn,
        () => callback(0),
        (error) => callback(toErrno(error))
    );
};

const loadFuseNative = async () => {
    try {
        const loaded = (await importOptional("fuse-native")) as {
            default?: unknown;
        };
        return loaded.default ?? loaded;
    } catch (error) {
        const requirement =
            process.platform === "darwin"
                ? "macOS native mounts require macFUSE and the optional fuse-native package."
                : "Linux native mounts require libfuse/FUSE and the optional fuse-native package.";
        throw new NativeMountUnavailableError(
            `${requirement} Adapter import failed: ${errorMessage(error)}`
        );
    }
};

export const mountNativeSharedFs = async (
    target: SharedFsMountBackend | SharedFsMountBackendTarget,
    options: NativeMountOptions
): Promise<NativeMountSession> => {
    if (process.platform === "win32") {
        throw new NativeMountUnavailableError(
            "Windows native mounts require the WinFsp adapter. The shared IPC/backend contract is present, but this package does not bundle a WinFsp binary yet."
        );
    }
    if (process.platform !== "linux" && process.platform !== "darwin") {
        throw new NativeMountUnavailableError(
            `Native mounts are not supported on ${process.platform}.`
        );
    }

    const profile = options.profile;
    const backend = isBackend(target)
        ? target
        : createSharedFsMountBackend(target, { profile });
    const Fuse = (await loadFuseNative()) as any;
    const fuse = new Fuse(
        options.mountpoint,
        {
            getattr(
                path: string,
                callback: (errno: number, stat?: unknown) => void
            ) {
                withNativeCallback(
                    profile,
                    "getattr",
                    () => backend.getattr(path),
                    (stat) =>
                        callback(0, {
                            mtime: new Date(stat.mtimeMs),
                            atime: new Date(stat.mtimeMs),
                            ctime: new Date(stat.ctimeMs),
                            size: stat.size,
                            mode: stat.mode,
                            uid: process.getuid?.() ?? 0,
                            gid: process.getgid?.() ?? 0,
                        }),
                    (error) => callback(toErrno(error))
                );
            },
            readdir(
                path: string,
                callback: (errno: number, names?: string[]) => void
            ) {
                withNativeCallback(
                    profile,
                    "readdir",
                    () => backend.readdir(path),
                    (entries) =>
                        callback(
                            0,
                            entries.map((entry) => entry.name)
                        ),
                    (error) => callback(toErrno(error))
                );
            },
            open(
                path: string,
                flags: number,
                callback: (errno: number, fd?: number) => void
            ) {
                withNativeCallback(
                    profile,
                    "open",
                    () => backend.open(path, flags),
                    (handle) => callback(0, handle),
                    (error) => callback(toErrno(error))
                );
            },
            create(
                path: string,
                _mode: number,
                callback: (errno: number, fd?: number) => void
            ) {
                withNativeCallback(
                    profile,
                    "create",
                    () => openFuseNativeCreate(backend, path),
                    (handle) => callback(0, handle),
                    (error) => callback(toErrno(error))
                );
            },
            read(
                _path: string,
                fd: number,
                buffer: Buffer,
                length: number,
                position: number,
                callback: (bytesRead: number) => void
            ) {
                withNativeCallback(
                    profile,
                    "read",
                    () => backend.read(fd, length, position),
                    (bytes) => {
                        buffer.set(bytes);
                        callback(bytes.byteLength);
                    },
                    (error) => callback(toErrno(error))
                );
            },
            write(
                _path: string,
                fd: number,
                buffer: Buffer,
                length: number,
                position: number,
                callback: (bytesWritten: number) => void
            ) {
                withNativeCallback(
                    profile,
                    "write",
                    () =>
                        backend.write(
                            fd,
                            new Uint8Array(buffer.subarray(0, length)),
                            position
                        ),
                    (written) => callback(written),
                    (error) => callback(toErrno(error))
                );
            },
            truncate(
                path: string,
                size: number,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.truncate(path, size),
                    callback,
                    profile,
                    "truncate"
                );
            },
            ftruncate(
                _path: string,
                fd: number,
                size: number,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.truncate(fd, size),
                    callback,
                    profile,
                    "ftruncate"
                );
            },
            flush(
                _path: string,
                fd: number,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.flush(fd),
                    callback,
                    profile,
                    "flush"
                );
            },
            fsync(
                _path: string,
                fd: number,
                _datasync: boolean,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.fsync(fd),
                    callback,
                    profile,
                    "fsync"
                );
            },
            release(
                _path: string,
                fd: number,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.release(fd),
                    callback,
                    profile,
                    "release"
                );
            },
            mkdir(
                path: string,
                _mode: number,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.mkdir(path),
                    callback,
                    profile,
                    "mkdir"
                );
            },
            rmdir(path: string, callback: (errno: number) => void) {
                withCallback(
                    () => backend.rmdir(path),
                    callback,
                    profile,
                    "rmdir"
                );
            },
            rename(
                from: string,
                to: string,
                callback: (errno: number) => void
            ) {
                withCallback(
                    () => backend.rename(from, to),
                    callback,
                    profile,
                    "rename"
                );
            },
            unlink(path: string, callback: (errno: number) => void) {
                withCallback(
                    () => backend.unlink(path),
                    callback,
                    profile,
                    "unlink"
                );
            },
        },
        {
            force: options.force ?? true,
            mkdir: options.mkdir ?? true,
        }
    );

    await new Promise<void>((resolve, reject) => {
        fuse.mount((error: Error | undefined) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });

    return {
        mountpoint: options.mountpoint,
        async unmount() {
            await new Promise<void>((resolve, reject) => {
                fuse.unmount((error: Error | undefined) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        },
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
