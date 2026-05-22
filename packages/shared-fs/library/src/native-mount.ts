import type {
    SharedFsMountBackend,
    SharedFsMountBackendTarget,
} from "./mount-backend.js";
import {
    SharedFsBackendError,
    createSharedFsMountBackend,
} from "./mount-backend.js";

export type NativeMountOptions = {
    mountpoint: string;
    force?: boolean;
    mkdir?: boolean;
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

const errno = {
    EPERM: -1,
    ENOENT: -2,
    EIO: -5,
    EBADF: -9,
    EACCES: -13,
    EEXIST: -17,
    ENOTDIR: -20,
    EISDIR: -21,
    EROFS: -30,
};

const importOptional = async (specifier: string) => {
    const dynamicImport = new Function(
        "specifier",
        "return import(specifier)"
    ) as (specifier: string) => Promise<unknown>;
    return dynamicImport(specifier);
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

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const getNativeMountSupport = async (): Promise<NativeMountSupport> => {
    if (process.platform === "linux") {
        const hasFuseDevice = await pathExists("/dev/fuse");
        const hasFusermount =
            (await commandExists("fusermount3")) ||
            (await commandExists("fusermount"));
        const hasFuseNative = await packageAvailable("fuse-native");
        const missing = [
            !hasFuseDevice ? "/dev/fuse" : undefined,
            !hasFusermount ? "fusermount/fusermount3" : undefined,
            !hasFuseNative ? "optional fuse-native package" : undefined,
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
        const missing = [
            !hasMacFuse ? "macFUSE" : undefined,
            !hasFuseNative ? "optional fuse-native package" : undefined,
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
        const missing = [
            !hasWinFsp ? "WinFsp runtime" : undefined,
            "WinFsp adapter binary",
        ].filter((value): value is string => value != null);
        return {
            platform: process.platform,
            adapter: "winfsp",
            available: false,
            missing,
            notes: [
                "The shared IPC/backend contract is present, but this package does not bundle a WinFsp adapter binary yet.",
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
        return errno[error.code] ?? errno.EIO;
    }
    return errno.EIO;
};

const withCallback = (
    fn: () => Promise<void>,
    callback: (errno: number) => void
) => {
    fn().then(
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

    const backend = isBackend(target)
        ? target
        : createSharedFsMountBackend(target);
    const Fuse = (await loadFuseNative()) as any;
    const fuse = new Fuse(
        options.mountpoint,
        {
            getattr(
                path: string,
                callback: (errno: number, stat?: unknown) => void
            ) {
                backend.getattr(path).then(
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
                backend.readdir(path).then(
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
                backend.open(path, flags).then(
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
                backend.read(fd, length, position).then(
                    (bytes) => {
                        buffer.set(bytes);
                        callback(bytes.byteLength);
                    },
                    () => callback(0)
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
                backend
                    .write(
                        fd,
                        new Uint8Array(buffer.subarray(0, length)),
                        position
                    )
                    .then(
                        (written) => callback(written),
                        () => callback(0)
                    );
            },
            flush(
                _path: string,
                fd: number,
                callback: (errno: number) => void
            ) {
                withCallback(() => backend.flush(fd), callback);
            },
            fsync(
                _path: string,
                fd: number,
                _datasync: boolean,
                callback: (errno: number) => void
            ) {
                withCallback(() => backend.fsync(fd), callback);
            },
            release(
                _path: string,
                fd: number,
                callback: (errno: number) => void
            ) {
                withCallback(() => backend.release(fd), callback);
            },
            mkdir(
                path: string,
                _mode: number,
                callback: (errno: number) => void
            ) {
                withCallback(() => backend.mkdir(path), callback);
            },
            rmdir(path: string, callback: (errno: number) => void) {
                withCallback(() => backend.rmdir(path), callback);
            },
            rename(
                from: string,
                to: string,
                callback: (errno: number) => void
            ) {
                withCallback(() => backend.rename(from, to), callback);
            },
            unlink(path: string, callback: (errno: number) => void) {
                withCallback(() => backend.unlink(path), callback);
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
