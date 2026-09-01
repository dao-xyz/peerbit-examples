import type { SharedFsMountBackend } from "./mount-backend.js";

/**
 * fuse-native's create callback omits the caller's open flags. Use the most
 * conservative capability set that can create a new, readable/writable file
 * without ever truncating an existing path after a peer race.
 */
export const openFuseNativeCreate = (
    backend: Pick<SharedFsMountBackend, "open">,
    path: string
) =>
    backend.open(path, {
        read: true,
        write: true,
        create: true,
        exclusive: true,
    });
