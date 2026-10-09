import { sha256Sync, toHexString } from "@peerbit/crypto";
import { concat, fromString } from "uint8arrays";
import { CELL_BYTES, LANES, M, READINESS_FORMAT_TAG } from "./constants.js";
import { IdHeadMap } from "./id-map.js";
import { isScopeId, type ScopeDescriptor, type ScopeId } from "./scopes.js";

/**
 * Local persistence of readiness state.
 *
 * Structures file, one per scope:
 * `<directory>/shared-fs-readiness/<store>.<scope>.bin`, where `<store>` is
 * the hex log id of the store the scope describes: SharedLog keys a store's
 * storage and index by that id, not by the program address, so two
 * addresses can share one store (the same `id` with another `rootKey` or
 * `sealedIgnoredNames`). Every open of that store takes the file, whichever
 * address wrote it; the file still names its address (the cell key), and a
 * file of another address is rejected. Written only at a clean close, after `super.close()` returned true (so no change event can
 * land after the snapshot), through a temp file and a rename. Read,
 * verified and unlinked at open before the store ingests, and that removal
 * is made durable, so a crash never leaves a stale file behind. A file the
 * open cannot remove (Windows sharing locks, an immutable flag) gets a
 * durable `<file>.void` marker beside it instead, and no open trusts a file
 * while its marker exists. A missing or rejected file means a rebuild by
 * scan; it is never trusted partially.
 */

export const STRUCTURES_DIRECTORY = "shared-fs-readiness";
const MAGIC = Uint8Array.of(0x53, 0x46, 0x53, 0x52); // "SFSR"
export const STRUCTURES_FORMAT = 1;
const CELLS_SECTION_BYTES = M * CELL_BYTES;
const LANES_SECTION_BYTES = LANES * 4;
const CHECKSUM_BYTES = 32;

export interface PersistedScope {
    scope: ScopeId;
    count: number;
    hlc: bigint;
    epoch: number;
    map: IdHeadMap;
    /** M x 44 B in the wire cell layout. */
    cells: Uint8Array;
    /** The anchor: 1,024 little-endian u32 lanes at `epoch`. */
    lanes: Uint8Array;
}

export type DecodeResult =
    | { ok: true; state: PersistedScope }
    | { ok: false; reason: string };

const addressCheck = (address: string) =>
    sha256Sync(fromString("shared-fs/readiness/structures/" + address));

/**
 * magic (4) | format u16 | tag length u8 | tag | scope u8 | address check
 * (32) | count u32 | hlc u64 | epoch u64 | cells length u32 | cells | lanes
 * length u32 | lanes | map length u32 | map | sha256 of all of the above.
 */
export const encodeStructures = (
    address: string,
    state: PersistedScope
): Uint8Array => {
    const tag = fromString(READINESS_FORMAT_TAG);
    const { cells, lanes } = state;
    if (
        cells.length !== CELLS_SECTION_BYTES ||
        lanes.length !== LANES_SECTION_BYTES
    ) {
        throw new Error("structures: cells and lanes must be complete");
    }
    const map = state.map.serialize();
    const head = new Uint8Array(4 + 2 + 1 + tag.length + 1 + 32 + 4 + 8 + 8);
    const view = new DataView(head.buffer);
    let o = 0;
    head.set(MAGIC, o);
    o += 4;
    view.setUint16(o, STRUCTURES_FORMAT, true);
    o += 2;
    head[o++] = tag.length;
    head.set(tag, o);
    o += tag.length;
    head[o++] = state.scope;
    head.set(addressCheck(address), o);
    o += 32;
    view.setUint32(o, state.count, true);
    o += 4;
    view.setBigUint64(o, state.hlc, true);
    o += 8;
    view.setBigUint64(o, BigInt(state.epoch), true);
    const length = (n: number) => {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, n, true);
        return out;
    };
    const body = concat([
        head,
        length(cells.length),
        cells,
        length(lanes.length),
        lanes,
        length(map.length),
        map,
    ]);
    return concat([body, sha256Sync(body)]);
};

/**
 * The reader's allowlist: the magic, this format, this build's format tag,
 * the expected scope and address, section sizes this build writes, a
 * consistent map and the checksum. Anything else is rejected whole.
 */
export const decodeStructures = (
    bytes: Uint8Array,
    address: string,
    expectedScope: ScopeId
): DecodeResult => {
    const fail = (reason: string): DecodeResult => ({ ok: false, reason });
    if (bytes.length < 4 + 2 + 1 + CHECKSUM_BYTES) {
        return fail("truncated");
    }
    const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
    const checksum = bytes.subarray(bytes.length - CHECKSUM_BYTES);
    const expected = sha256Sync(body);
    for (let i = 0; i < CHECKSUM_BYTES; i++) {
        if (checksum[i] !== expected[i]) return fail("checksum");
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const need = (n: number) => o + n <= body.length;
    for (let i = 0; i < 4; i++) {
        if (body[i] !== MAGIC[i]) return fail("magic");
    }
    o = 4;
    if (view.getUint16(o, true) !== STRUCTURES_FORMAT) return fail("format");
    o += 2;
    const tagLength = body[o++];
    if (!need(tagLength)) return fail("truncated");
    const tag = new TextDecoder().decode(body.subarray(o, o + tagLength));
    o += tagLength;
    if (tag !== READINESS_FORMAT_TAG) return fail("format tag");
    if (!need(1 + 32 + 4 + 8 + 8)) return fail("truncated");
    const scope = body[o++];
    if (!isScopeId(scope) || scope !== expectedScope) return fail("scope");
    const check = addressCheck(address);
    for (let i = 0; i < 32; i++) {
        if (body[o + i] !== check[i]) return fail("address");
    }
    o += 32;
    const count = view.getUint32(o, true);
    o += 4;
    const hlc = view.getBigUint64(o, true);
    o += 8;
    const epoch = view.getBigUint64(o, true);
    o += 8;
    if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) return fail("epoch");
    // Cells and lanes are always complete: a restore adopts them as they
    // are, at the file's epoch, so a partial file is never usable.
    const section = (size: number) => {
        if (!need(4)) return undefined;
        const n = view.getUint32(o, true);
        o += 4;
        if (n !== size || !need(n)) return undefined;
        const out = body.slice(o, o + n);
        o += n;
        return out;
    };
    const cells = section(CELLS_SECTION_BYTES);
    if (!cells) return fail("cells");
    const lanes = section(LANES_SECTION_BYTES);
    if (!lanes) return fail("lanes");
    if (!need(4)) return fail("truncated");
    const mapLength = view.getUint32(o, true);
    o += 4;
    if (o + mapLength !== body.length) return fail("map length");
    let map: IdHeadMap;
    try {
        map = IdHeadMap.restore(body.subarray(o, o + mapLength));
    } catch (error) {
        return fail(error instanceof Error ? error.message : "map");
    }
    if (map.size !== count) return fail("count");
    return {
        ok: true,
        state: {
            scope,
            count,
            hlc,
            epoch: Number(epoch),
            map,
            cells,
            lanes,
        },
    };
};

const syncDirectory = async (path: string) => {
    const fs = await import("node:fs/promises");
    try {
        const handle = await fs.open(path, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error: any) {
        // Windows does not consistently permit opening or fsyncing
        // directories (the sidecar code tolerates the same codes). On POSIX
        // every failure means the barrier was not established.
        const unsupported =
            process.platform === "win32" &&
            [
                "EINVAL",
                "ENOTSUP",
                "ENOSYS",
                "EPERM",
                "EACCES",
                "EISDIR",
                "EBADF",
            ].includes(error?.code);
        if (!unsupported) {
            throw error;
        }
    }
};

/** `store` is the 32-byte log id of the scope's store (`logIdOf`). */
export const structuresPath = async (
    directory: string,
    store: Uint8Array,
    scope: ScopeDescriptor
) => {
    const { join } = await import("node:path");
    return join(
        directory,
        STRUCTURES_DIRECTORY,
        `${toHexString(store)}.${scope.name}.bin`
    );
};

/** Beside a structures file an open could not remove: never trust it. */
const voidPath = (path: string) => `${path}.void`;

const exists = async (path: string) => {
    const fs = await import("node:fs/promises");
    try {
        await fs.stat(path);
        return true;
    } catch (error: any) {
        // Only a missing marker is absent; anything else counts as there.
        return error?.code !== "ENOENT";
    }
};

/**
 * Removes a structures file durably, or, when it cannot be removed, writes
 * its durable void marker. Rejects with the removal's error either way, so
 * the caller does not use the file now. A marker that cannot be written
 * either (an unwritable directory) leaves the file unmarked; this
 * generation cannot write a replacement there, and a later open with the
 * directory writable again would trust it.
 */
const discardStructures = async (path: string) => {
    const fs = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    try {
        await fs.rm(path, { force: true });
        await syncDirectory(dirname(path));
    } catch (error) {
        try {
            await fs.writeFile(voidPath(path), new Uint8Array(0));
            await syncDirectory(dirname(path));
        } catch {
            // See above.
        }
        throw error;
    }
    // The file is gone durably: its marker, if any, has nothing to void.
    await fs.rm(voidPath(path), { force: true }).catch(() => {});
};

/**
 * Reads, verifies and removes one scope's structures file. The file is
 * unlinked (and the removal made durable) whatever it held, so a later
 * crash can never restore it; when it cannot be unlinked, its void marker
 * keeps every later open from restoring it (`void`) until an open removes
 * it. A file another address wrote over the same store is taken and
 * rejected (`address`). Undefined when there was no file.
 */
export const takeStructures = async (
    directory: string,
    store: Uint8Array,
    address: string,
    scope: ScopeDescriptor
): Promise<DecodeResult | undefined> => {
    const fs = await import("node:fs/promises");
    const path = await structuresPath(directory, store, scope);
    let bytes: Uint8Array;
    try {
        bytes = await fs.readFile(path);
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            await fs.rm(voidPath(path), { force: true }).catch(() => {});
            return undefined;
        }
        await discardStructures(path).catch(() => {});
        return { ok: false, reason: `read: ${error?.code ?? error}` };
    }
    // Read before the removal below drops it.
    const voided = await exists(voidPath(path));
    try {
        await discardStructures(path);
    } catch (error: any) {
        // A removal that may not be durable could come back after a crash
        // and be restored over a changed store: do not use it now either.
        return { ok: false, reason: `unlink: ${error?.code ?? error}` };
    }
    if (voided) {
        // An earlier open could not remove this file: it may predate
        // anything that generation changed.
        return { ok: false, reason: "void" };
    }
    return decodeStructures(bytes, address, scope.id);
};

/**
 * Writes one scope's structures file: a temp file renamed over the path.
 * Not fsynced: the file is a cache, and after a power loss during or after
 * the close it is either absent or fails its checksum (a rebuild), since
 * the previous one was durably removed at open (or is voided). That holds
 * where the filesystem never exposes a new file's blocks before its data
 * (ext4 data=ordered, XFS, btrfs, APFS, NTFS). Where it can (ext4
 * data=writeback with nodelalloc, FAT32/exFAT outside Windows), a power
 * loss could show the freed blocks of the previous generation's file under
 * the new name, and that file is valid; it is restored only if it lands on
 * exactly those blocks, whole, and the count still matches. Accepted: the
 * two fsyncs cost about 10 ms per close, and 70-230 ms under disk load
 * (review measurement). When the rename replaced a voided file, the marker
 * goes only after the rename is durable.
 */
export const writeStructures = async (
    directory: string,
    store: Uint8Array,
    scope: ScopeDescriptor,
    bytes: Uint8Array
): Promise<void> => {
    const fs = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = await structuresPath(directory, store, scope);
    await fs.mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    try {
        await fs.writeFile(temp, bytes, { mode: 0o600 });
        await fs.rename(temp, path);
    } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
    if (await exists(voidPath(path))) {
        try {
            await syncDirectory(dirname(path));
            await fs.rm(voidPath(path), { force: true });
        } catch {
            // The marker stays: the next open rebuilds instead of restoring.
        }
    }
};
