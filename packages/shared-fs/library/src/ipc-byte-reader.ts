/**
 * A single-consumer byte reader for a socket-like async iterable.
 *
 * It retains coalesced bytes for the next frame, reads only on demand (so the
 * underlying Node stream can apply backpressure), and never repeatedly
 * concatenates a growing partial frame.
 */
export class BoundedIpcByteReader {
    readonly #iterator: AsyncIterator<Uint8Array>;
    readonly #maxReadBytes: number;
    #chunk: Buffer | undefined;
    #headOffset = 0;
    #done = false;
    #reading = false;

    constructor(source: AsyncIterable<Uint8Array>, maxReadBytes: number) {
        if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
            throw new TypeError("maxReadBytes must be a positive safe integer");
        }
        this.#iterator = source[Symbol.asyncIterator]();
        this.#maxReadBytes = maxReadBytes;
    }

    /** Bytes already obtained from the stream but not consumed by a read. */
    get bufferedByteLength() {
        return this.#chunk ? this.#chunk.byteLength - this.#headOffset : 0;
    }

    /**
     * Read one LF-delimited frame, excluding the LF.
     *
     * A clean EOF between frames returns undefined. EOF after any frame byte
     * is a protocol error. The configured bound excludes the LF.
     */
    readLine(): Promise<Buffer | undefined> {
        return this.#runExclusive(() => this.#readLine());
    }

    /**
     * Read exactly byteLength bytes while retaining any coalesced tail.
     * Intended for a future negotiated length-prefixed protocol.
     */
    readExactly(byteLength: number): Promise<Buffer> {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
            return Promise.reject(
                new TypeError("byteLength must be a non-negative safe integer")
            );
        }
        if (byteLength > this.#maxReadBytes) {
            return Promise.reject(
                new IpcFrameTooLargeError(byteLength, this.#maxReadBytes)
            );
        }
        return this.#runExclusive(() => this.#readExactly(byteLength));
    }

    async #runExclusive<T>(read: () => Promise<T>): Promise<T> {
        if (this.#reading) {
            throw new Error("Concurrent IPC byte reads are not supported");
        }
        this.#reading = true;
        try {
            return await read();
        } finally {
            this.#reading = false;
        }
    }

    async #readLine(): Promise<Buffer | undefined> {
        // Normal socket fragmentation is cheap with one final concat. The
        // fixed cap prevents adversarial one-byte chunks from growing this
        // bookkeeping without bound; beyond it, switch once to a geometric
        // accumulator.
        const fragments: Buffer[] = [];
        let accumulator: Buffer | undefined;
        let frameBytes = 0;

        for (;;) {
            if (!(await this.#ensureBuffered())) {
                if (frameBytes === 0) {
                    return undefined;
                }
                throw new IpcUnexpectedEofError(
                    `IPC stream ended after ${frameBytes} byte(s) of an unterminated line`
                );
            }

            const head = this.#head();
            const newline = head.chunk.indexOf(0x0a, head.offset);
            const end = newline === -1 ? head.chunk.byteLength : newline;
            const fragmentBytes = end - head.offset;
            if (fragmentBytes > this.#maxReadBytes - frameBytes) {
                throw new IpcFrameTooLargeError(
                    frameBytes + fragmentBytes,
                    this.#maxReadBytes
                );
            }
            if (newline !== -1) {
                // The overwhelmingly common case is one complete line in one
                // socket chunk. Preserve its zero-copy path.
                if (accumulator === undefined && fragments.length === 0) {
                    const line = this.#consume(fragmentBytes);
                    this.#consume(1);
                    return line;
                }
                const finalFragment = this.#consume(fragmentBytes);
                frameBytes += fragmentBytes;
                this.#consume(1);
                if (accumulator !== undefined) {
                    accumulator = this.#append(
                        accumulator,
                        frameBytes - fragmentBytes,
                        finalFragment
                    );
                    return accumulator.subarray(0, frameBytes);
                }
                if (fragmentBytes === 0 && fragments.length === 1) {
                    return fragments[0];
                }
                return Buffer.concat(
                    fragmentBytes > 0
                        ? [...fragments, finalFragment]
                        : fragments,
                    frameBytes
                );
            }
            if (fragmentBytes > 0) {
                const fragment = this.#consume(fragmentBytes);
                if (accumulator !== undefined) {
                    accumulator = this.#append(
                        accumulator,
                        frameBytes,
                        fragment
                    );
                } else if (fragments.length < MAX_RETAINED_LINE_FRAGMENTS) {
                    fragments.push(fragment);
                } else {
                    accumulator = this.#reserve(
                        undefined,
                        0,
                        frameBytes + fragmentBytes
                    );
                    let copied = 0;
                    for (const retained of fragments) {
                        retained.copy(accumulator, copied);
                        copied += retained.byteLength;
                    }
                    fragment.copy(accumulator, copied);
                    fragments.length = 0;
                }
                frameBytes += fragmentBytes;
            }
        }
    }

    async #readExactly(byteLength: number): Promise<Buffer> {
        if (byteLength === 0) {
            return Buffer.alloc(0);
        }

        if (!(await this.#ensureBuffered())) {
            throw new IpcUnexpectedEofError(
                `IPC stream ended after 0 of ${byteLength} required byte(s)`
            );
        }
        const first = this.#head();
        const firstAvailable = first.chunk.byteLength - first.offset;
        if (firstAvailable >= byteLength) {
            // Preserve the common coalesced header/body path without another
            // body-sized allocation. The retained tail, if any, stays owned by
            // the reader for the next frame.
            return this.#consume(byteLength);
        }

        // The caller validated this size against the configured bound before
        // any source bytes were consumed. A fragmented value gets exactly one
        // body-sized destination allocation.
        const value = Buffer.allocUnsafe(byteLength);
        this.#consume(firstAvailable).copy(value, 0);
        let readBytes = firstAvailable;
        while (readBytes < byteLength) {
            if (!(await this.#ensureBuffered())) {
                throw new IpcUnexpectedEofError(
                    `IPC stream ended after ${readBytes} of ${byteLength} required byte(s)`
                );
            }
            const head = this.#head();
            const available = head.chunk.byteLength - head.offset;
            const take = Math.min(available, byteLength - readBytes);
            this.#consume(take).copy(value, readBytes);
            readBytes += take;
        }
        return value;
    }

    async #ensureBuffered() {
        while (this.#chunk === undefined && !this.#done) {
            let next: IteratorResult<Uint8Array>;
            try {
                next = await this.#iterator.next();
            } catch (error) {
                this.#done = true;
                throw error;
            }
            if (next.done) {
                this.#done = true;
                break;
            }
            if (!(next.value instanceof Uint8Array)) {
                this.#done = true;
                throw new TypeError("IPC byte source yielded a non-byte chunk");
            }
            if (next.value.byteLength === 0) {
                continue;
            }
            const chunk = Buffer.isBuffer(next.value)
                ? next.value
                : Buffer.from(
                      next.value.buffer,
                      next.value.byteOffset,
                      next.value.byteLength
                  );
            this.#chunk = chunk;
            this.#headOffset = 0;
        }
        return this.#chunk !== undefined;
    }

    #head() {
        const chunk = this.#chunk;
        if (!chunk) {
            throw new Error("IPC byte reader lost its buffered chunk");
        }
        return { chunk, offset: this.#headOffset };
    }

    #consume(byteLength: number) {
        const { chunk, offset } = this.#head();
        const end = offset + byteLength;
        if (byteLength < 0 || end > chunk.byteLength) {
            throw new Error("IPC byte reader consumed beyond its buffer");
        }
        const value = chunk.subarray(offset, end);
        if (end === chunk.byteLength) {
            // Drop consumed socket chunks immediately so a persistent
            // connection cannot retain prior large frames.
            this.#chunk = undefined;
            this.#headOffset = 0;
        } else {
            this.#headOffset = end;
        }
        return value;
    }

    #append(accumulator: Buffer | undefined, used: number, fragment: Buffer) {
        const required = used + fragment.byteLength;
        const target = this.#reserve(accumulator, used, required);
        fragment.copy(target, used);
        return target;
    }

    #reserve(accumulator: Buffer | undefined, used: number, required: number) {
        if (accumulator === undefined || accumulator.byteLength < required) {
            const currentCapacity = accumulator?.byteLength ?? 0;
            const doubled =
                currentCapacity === 0
                    ? Math.min(this.#maxReadBytes, 4096)
                    : currentCapacity <= this.#maxReadBytes / 2
                      ? currentCapacity * 2
                      : this.#maxReadBytes;
            const capacity = Math.max(required, doubled);
            const grown = Buffer.allocUnsafe(capacity);
            if (accumulator !== undefined && used > 0) {
                accumulator.copy(grown, 0, 0, used);
            }
            return grown;
        }
        return accumulator;
    }
}

const MAX_RETAINED_LINE_FRAGMENTS = 32;

export class IpcFrameTooLargeError extends Error {
    constructor(
        readonly actualBytes: number,
        readonly maxBytes: number
    ) {
        super(`IPC frame exceeds ${maxBytes} byte limit`);
        this.name = "IpcFrameTooLargeError";
    }
}

export class IpcUnexpectedEofError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IpcUnexpectedEofError";
    }
}
