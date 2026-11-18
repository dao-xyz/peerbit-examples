import type {
    SharedFsMountBackendTarget,
    SharedFsMountLocalOverlay,
} from "@peerbit/shared-fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The library functions this module needs, from the caller's lazily loaded
 * runtime: importing the library here would load it for every command.
 */
export type LocalOverlayRuntime = Pick<
    typeof import("@peerbit/shared-fs"),
    "localOverlayDirectory" | "openMountLocalOverlay"
>;

/** A mount's local overlay and how to put it away when the mount stops. */
export type MountLocalOverlay = {
    overlay: SharedFsMountLocalOverlay;
    /** The host directory holding the mount's local entries. */
    directory: string;
    /** Whether `remove()` deletes it: an in-memory peer's temporary one. */
    temporary: boolean;
    /** Delete a temporary overlay; a durable one is kept. */
    remove(): Promise<void>;
};

const removeDirectory = (directory: string) =>
    // Windows may still hold a just-closed file for a moment.
    fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
    });

/**
 * Open the local overlay of a mount of `address`: under `stateDirectory`
 * (`<state>/shared-fs-local-overlay/<id>`), kept across remounts, or, for
 * an in-memory peer (no state directory), in a new temporary directory.
 */
export const openMountLocalOverlayForCli = async (
    runtime: LocalOverlayRuntime,
    options: {
        stateDirectory: string | undefined;
        address: string;
        sealedNames: readonly string[];
    }
): Promise<MountLocalOverlay> => {
    const temporary =
        options.stateDirectory === undefined
            ? await fs.mkdtemp(
                  path.join(os.tmpdir(), "peerbit-shared-fs-local-overlay-")
              )
            : undefined;
    try {
        const overlay = await runtime.openMountLocalOverlay({
            directory:
                temporary ??
                runtime.localOverlayDirectory(
                    options.stateDirectory!,
                    options.address
                ),
            address: options.address,
            sealedNames: options.sealedNames,
        });
        return {
            overlay,
            directory: overlay.directory,
            temporary: temporary !== undefined,
            remove: async () => {
                if (temporary !== undefined) await removeDirectory(temporary);
            },
        };
    } catch (error) {
        if (temporary !== undefined) await removeDirectory(temporary);
        throw error;
    }
};

/**
 * What a mount prints about its local overlay: where it is and, when
 * another writer deleted shared directories holding local entries, how many.
 */
export const localOverlayLines = async (
    local: Pick<MountLocalOverlay, "overlay" | "directory">,
    target: Pick<SharedFsMountBackendTarget, "nodeForMount">
) => {
    const lines = [`Local overlay: ${local.directory}`];
    const detached = await local.overlay.detached(target);
    if (detached > 0) {
        lines.push(
            detached === 1
                ? `Local overlay: 1 directory with local entries was removed from the filesystem; its entries stay under ${local.directory} until you delete them`
                : `Local overlay: ${detached} directories with local entries were removed from the filesystem; their entries stay under ${local.directory} until you delete them`
        );
    }
    return lines;
};
