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
        throw new NativeMountUnavailableError(
            process.platform === "darwin"
                ? "macOS native mounts require macFUSE and the optional fuse-native package."
                : "Linux native mounts require libfuse/FUSE and the optional fuse-native package."
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
