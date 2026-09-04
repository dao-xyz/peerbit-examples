import type { Socket } from "node:net";
import { BoundedIpcByteReader } from "./ipc-byte-reader.js";

export const SHARED_FS_IPC_PROTOCOL = "peerbit-shared-fs-ipc";
export const SHARED_FS_IPC_NEGOTIATE_OP = "$peerbit.shared-fs.ipc.negotiate";
export const SHARED_FS_IPC_V2_HEADER_BYTES = 16;
export const SHARED_FS_IPC_V2_MAX_METADATA_BYTES = 1024 * 1024;
export const SHARED_FS_IPC_NEGOTIATION_MAX_BYTES = 64 * 1024;

const MAGIC = Buffer.from("PBFS", "ascii");
const VERSION = 2;

export const enum IpcV2FrameKind {
    Request = 1,
    Response = 2,
}

export class IpcV2ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IpcV2ProtocolError";
    }
}

export class IpcV2FrameTooLargeError extends IpcV2ProtocolError {
    constructor(message: string) {
        super(message);
        this.name = "IpcV2FrameTooLargeError";
    }
}

export type IpcV2Frame = {
    metadata: Buffer;
    body: Buffer;
};

const validateLimit = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
        throw new TypeError(
            `${name} must be an integer from 1 through 4294967295`
        );
    }
};

/**
 * Read one bounded v2 frame. The caller owns dispatch ordering; this function
 * consumes and validates one complete frame before returning any metadata.
 */
export const readIpcV2Frame = async (
    reader: BoundedIpcByteReader,
    expectedKind: IpcV2FrameKind,
    maxFrameBytes: number,
    maxMetadataBytes: number
): Promise<IpcV2Frame> => {
    validateLimit("maxFrameBytes", maxFrameBytes);
    validateLimit("maxMetadataBytes", maxMetadataBytes);
    if (maxMetadataBytes > maxFrameBytes) {
        throw new TypeError("maxMetadataBytes must not exceed maxFrameBytes");
    }

    const header = await reader.readExactly(SHARED_FS_IPC_V2_HEADER_BYTES);
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
        throw new IpcV2ProtocolError("IPC v2 frame has invalid magic");
    }
    if (header[4] !== VERSION) {
        throw new IpcV2ProtocolError("IPC v2 frame has invalid version");
    }
    if (header[5] !== expectedKind) {
        throw new IpcV2ProtocolError("IPC v2 frame has invalid kind");
    }
    if (header.readUInt16BE(6) !== 0) {
        throw new IpcV2ProtocolError("IPC v2 frame has unsupported flags");
    }

    const metadataBytes = header.readUInt32BE(8);
    const bodyBytes = header.readUInt32BE(12);
    if (metadataBytes > maxMetadataBytes) {
        throw new IpcV2FrameTooLargeError(
            `IPC v2 metadata exceeds ${maxMetadataBytes} byte limit`
        );
    }
    // Subtraction avoids overflow in implementations whose native integer is
    // narrower than the two unsigned 32-bit header fields combined.
    if (
        metadataBytes > maxFrameBytes ||
        bodyBytes > maxFrameBytes - metadataBytes
    ) {
        throw new IpcV2FrameTooLargeError(
            `IPC v2 frame exceeds ${maxFrameBytes} byte limit`
        );
    }

    const metadata = await reader.readExactly(metadataBytes);
    const body = await reader.readExactly(bodyBytes);
    return { metadata, body };
};

export const encodeIpcV2Frame = (
    kind: IpcV2FrameKind,
    metadataValue: unknown,
    body: Uint8Array,
    maxFrameBytes: number,
    maxMetadataBytes: number
) => {
    validateLimit("maxFrameBytes", maxFrameBytes);
    validateLimit("maxMetadataBytes", maxMetadataBytes);
    if (maxMetadataBytes > maxFrameBytes) {
        throw new TypeError("maxMetadataBytes must not exceed maxFrameBytes");
    }
    if (kind !== IpcV2FrameKind.Request && kind !== IpcV2FrameKind.Response) {
        throw new IpcV2ProtocolError("IPC v2 frame has invalid kind");
    }
    const json = JSON.stringify(metadataValue);
    if (json === undefined) {
        throw new IpcV2ProtocolError(
            "IPC v2 metadata is not JSON serializable"
        );
    }
    const metadata = Buffer.from(json, "utf8");
    const bodyBuffer = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (metadata.byteLength > maxMetadataBytes) {
        throw new IpcV2FrameTooLargeError(
            `IPC v2 metadata exceeds ${maxMetadataBytes} byte limit`
        );
    }
    if (
        metadata.byteLength > maxFrameBytes ||
        bodyBuffer.byteLength > maxFrameBytes - metadata.byteLength
    ) {
        throw new IpcV2FrameTooLargeError(
            `IPC v2 frame exceeds ${maxFrameBytes} byte limit`
        );
    }
    if (
        metadata.byteLength > 0xffff_ffff ||
        bodyBuffer.byteLength > 0xffff_ffff
    ) {
        throw new IpcV2FrameTooLargeError("IPC v2 frame length exceeds uint32");
    }

    const header = Buffer.allocUnsafe(SHARED_FS_IPC_V2_HEADER_BYTES);
    MAGIC.copy(header, 0);
    header[4] = VERSION;
    header[5] = kind;
    header.writeUInt16BE(0, 6);
    header.writeUInt32BE(metadata.byteLength, 8);
    header.writeUInt32BE(bodyBuffer.byteLength, 12);
    return { header, metadata, body: bodyBuffer };
};

/** Write one frame without copying its body and without interleaving parts. */
export const writeIpcV2Frame = async (
    socket: Socket,
    frame: { header: Buffer; metadata: Buffer; body: Buffer }
) => {
    if (socket.destroyed || !socket.writable) {
        throw new Error("IPC socket is not writable");
    }

    let cleanup = () => {};
    let settle = (_error?: Error | null) => {};
    const completed = new Promise<void>((resolve, reject) => {
        let settled = false;
        settle = (error?: Error | null) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const onError = (error: Error) => {
            settle(error);
        };
        const onClose = () => {
            settle(new Error("IPC socket closed before frame write completed"));
        };
        cleanup = () => {
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        socket.once("error", onError);
        socket.once("close", onClose);
    });

    const chunks = [frame.header, frame.metadata];
    if (frame.body.byteLength > 0) {
        chunks.push(frame.body);
    }
    socket.cork();
    try {
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (index === chunks.length - 1) {
                socket.write(chunk, (error) => settle(error));
            } else {
                socket.write(chunk);
            }
        }
    } catch (error) {
        cleanup();
        throw error;
    } finally {
        socket.uncork();
    }
    await completed;
};
