import { field, variant, vec, option } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    IsNull,
} from "@peerbit/document";
import {
    PublicSignKey,
    sha256Base64Sync,
    randomBytes,
    toBase64,
    toBase64URL,
} from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { sha256Sync } from "@peerbit/crypto";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { ReplicationOptions } from "@peerbit/shared-log";
import { SHA256 } from "@stablelib/sha256";

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableChunkLookupError = (error: unknown) =>
    error instanceof Error &&
    (error.name === "AbortError" ||
        error.message.includes("fanout channel closed"));

type FileReadOptions = {
    timeout?: number;
    progress?: (progress: number) => any;
};

export interface ReReadableChunkSource {
    size: bigint;
    readChunks(chunkSize: number): AsyncIterable<Uint8Array>;
}

interface ChunkWritable {
    write(chunk: Uint8Array): Promise<void> | void;
    close?(): Promise<void> | void;
    abort?(reason?: unknown): Promise<void> | void;
}

export abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract size: bigint;
    abstract parentId?: string;
    abstract streamFile(
        files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array>;

    async getFile<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        files: Files,
        properties?: {
            as: OutputType;
        } & FileReadOptions
    ): Promise<Output> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.streamFile(files, properties)) {
            chunks.push(chunk);
        }
        return (
            properties?.as === "chunks" ? chunks : concat(chunks)
        ) as Output;
    }

    async writeFile(
        files: Files,
        writable: ChunkWritable,
        properties?: FileReadOptions
    ) {
        try {
            for await (const chunk of this.streamFile(files, properties)) {
                await writable.write(chunk);
            }
            await writable.close?.();
        } catch (error) {
            if (writable.abort) {
                try {
                    await writable.abort(error);
                } catch {
                    // Ignore writable cleanup failures.
                }
            }
            throw error;
        }
    }

    abstract delete(files: Files): Promise<void>;
}

@variant("files_indexable_file")
export class IndexableFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: option("string") })
    parentId?: string;

    constructor(file: AbstractFile) {
        this.id = file.id;
        this.name = file.name;
        this.size = file.size;
        this.parentId = file.parentId;
    }
}

const TINY_FILE_SIZE_LIMIT = 5 * 1e6; // 6mb
const LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT / 10;
const LARGE_FILE_TARGET_CHUNK_COUNT = 1024;
const CHUNK_SIZE_GRANULARITY = 64 * 1024;
const MAX_LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT - 256 * 1024;
const LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;
const LARGE_FILE_PERSISTED_READ_AHEAD = 16;
const TINY_FILE_SIZE_LIMIT_BIGINT = BigInt(TINY_FILE_SIZE_LIMIT);

const roundUpTo = (value: number, multiple: number) =>
    Math.ceil(value / multiple) * multiple;
const getLargeFileSegmentSize = (size: number | bigint) =>
    Math.min(
        MAX_LARGE_FILE_SEGMENT_SIZE,
        roundUpTo(
            Math.max(
                LARGE_FILE_SEGMENT_SIZE,
                Math.ceil(Number(size) / LARGE_FILE_TARGET_CHUNK_COUNT)
            ),
            CHUNK_SIZE_GRANULARITY
        )
    );
const getChunkStart = (index: number, chunkSize = LARGE_FILE_SEGMENT_SIZE) =>
    index * chunkSize;
const getChunkEnd = (
    index: number,
    size: number | bigint,
    chunkSize = LARGE_FILE_SEGMENT_SIZE
) => Math.min((index + 1) * chunkSize, Number(size));
const getChunkCount = (
    size: number | bigint,
    chunkSize = LARGE_FILE_SEGMENT_SIZE
) => Math.ceil(Number(size) / chunkSize);
const getChunkId = (parentId: string, index: number) => `${parentId}:${index}`;
const createUploadId = () => toBase64URL(randomBytes(16));
const isBlobLike = (value: Uint8Array | Blob): value is Blob =>
    typeof Blob !== "undefined" && value instanceof Blob;
const readBlobChunk = async (blob: Blob, index: number, chunkSize: number) =>
    new Uint8Array(
        await blob
            .slice(
                getChunkStart(index, chunkSize),
                getChunkEnd(index, blob.size, chunkSize)
            )
            .arrayBuffer()
    );
const ensureSourceSize = (actual: bigint, expected: bigint) => {
    if (actual !== expected) {
        throw new Error(
            `Source size changed during upload. Expected ${expected} bytes, got ${actual}`
        );
    }
};

@variant(0) // for versioning purposes
export class TinyFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: Uint8Array })
    file: Uint8Array; // 10 mb imit

    @field({ type: "string" })
    hash: string;

    @field({ type: option("string") })
    parentId?: string;

    @field({ type: option("u32") })
    index?: number;

    get size() {
        return BigInt(this.file.byteLength);
    }

    constructor(properties: {
        id?: string;
        name: string;
        file: Uint8Array;
        hash?: string;
        parentId?: string;
        index?: number;
    }) {
        super();
        this.parentId = properties.parentId;
        this.index = properties.index;
        this.id =
            properties.id ||
            (properties.parentId != null && properties.index != null
                ? `${properties.parentId}:${properties.index}`
                : sha256Base64Sync(properties.file));
        this.name = properties.name;
        this.file = properties.file;
        this.hash = properties.hash || sha256Base64Sync(properties.file);
    }

    async *streamFile(
        _files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        if (sha256Base64Sync(this.file) !== this.hash) {
            throw new Error("Hash does not match the file content");
        }
        properties?.progress?.(1);
        yield this.file;
    }

    async delete(): Promise<void> {
        // Do nothing, since no releated files where created
    }
}

@variant(1) // for versioning purposes
export class LargeFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u32" })
    chunkCount: number;

    @field({ type: "bool" })
    ready: boolean;

    @field({ type: option("string") })
    finalHash?: string;

    constructor(properties: {
        id?: string;
        name: string;
        size: bigint;
        chunkCount: number;
        ready?: boolean;
        finalHash?: string;
    }) {
        super();
        this.id = properties.id || createUploadId();
        this.name = properties.name;
        this.size = properties.size;
        this.chunkCount = properties.chunkCount;
        this.ready = properties.ready ?? false;
        this.finalHash = properties.finalHash;
    }

    get parentId() {
        // Large file can never have a parent
        return undefined;
    }

    async fetchChunks(
        files: Files,
        properties?: {
            timeout?: number;
        }
    ) {
        const chunks = new Map<number, TinyFile>();
        const totalTimeout = properties?.timeout ?? 30_000;
        const deadline = Date.now() + totalTimeout;
        const queryTimeout = Math.min(totalTimeout, 5_000);
        const searchOptions = {
            local: true,
            remote: {
                timeout: queryTimeout,
                throwOnMissing: false,
                // Chunk queries return the full TinyFile document including its
                // bytes. Observer reads can stream that result directly, while
                // actual replicators should still persist downloaded chunks.
                replicate: files.persistChunkReads,
            },
        };
        const recordChunks = (results: AbstractFile[]) => {
            for (const chunk of results) {
                if (
                    chunk instanceof TinyFile &&
                    chunk.parentId === this.id &&
                    chunk.index != null &&
                    !chunks.has(chunk.index)
                ) {
                    chunks.set(chunk.index, chunk);
                }
            }
        };

        while (chunks.size < this.chunkCount && Date.now() < deadline) {
            const before = chunks.size;
            recordChunks(
                await files.files.index.search(
                    new SearchRequest({
                        query: new StringMatch({ key: "parentId", value: this.id }),
                        fetch: 0xffffffff,
                    }),
                    searchOptions
                )
            );

            if (chunks.size === before && chunks.size < this.chunkCount) {
                await sleep(250);
            }
        }

        return [...chunks.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
    }
    async delete(files: Files) {
        await Promise.all((await this.fetchChunks(files)).map((x) => files.files.del(x.id)));
    }

    private async resolveChunk(
        files: Files,
        index: number,
        knownChunks: Map<number, TinyFile>,
        properties?: {
            timeout?: number;
        }
    ): Promise<TinyFile> {
        const totalTimeout =
            properties?.timeout ?? LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS;
        const deadline = Date.now() + totalTimeout;
        const attemptTimeout = Math.min(totalTimeout, 5_000);
        const chunkId = getChunkId(this.id, index);

        while (Date.now() < deadline) {
            const cached = knownChunks.get(index);
            if (cached) {
                return cached;
            }

            try {
                const chunk = await files.files.index.get(chunkId, {
                    local: true,
                    waitFor: attemptTimeout,
                    remote: {
                        timeout: attemptTimeout,
                        wait: {
                            timeout: attemptTimeout,
                            behavior: "keep-open",
                        },
                        throwOnMissing: false,
                        retryMissingResponses: true,
                        replicate: files.persistChunkReads,
                    },
                });

                if (
                    chunk instanceof TinyFile &&
                    chunk.parentId === this.id &&
                    chunk.index === index
                ) {
                    knownChunks.set(index, chunk);
                    return chunk;
                }
            } catch (error) {
                if (!isRetryableChunkLookupError(error)) {
                    throw error;
                }
            }

            await sleep(250);
        }

        throw new Error(
            `Failed to resolve chunk ${index + 1}/${this.chunkCount} for file ${this.id}`
        );
    }

    async *streamFile(
        files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        if (!this.ready) {
            throw new Error("File is still uploading");
        }

        properties?.progress?.(0);

        let processed = 0;
        const hasher = this.finalHash ? new SHA256() : undefined;
        const knownChunks = files.persistChunkReads
            ? new Map<number, TinyFile>()
            : new Map(
                  (
                      await this.fetchChunks(files, {
                          timeout:
                              properties?.timeout ??
                              LARGE_FILE_CHUNK_LOOKUP_TIMEOUT_MS,
                      })
                  ).map((chunk) => [chunk.index || 0, chunk])
              );
        const inFlightChunks = new Map<number, Promise<TinyFile>>();
        const resolveChunkWithReadAhead = (index: number) => {
            const cached = inFlightChunks.get(index);
            if (cached) {
                return cached;
            }
            const pending = this.resolveChunk(files, index, knownChunks, {
                timeout: properties?.timeout,
            });
            inFlightChunks.set(index, pending);
            return pending;
        };

        if (files.persistChunkReads) {
            for (
                let index = 0;
                index <
                Math.min(this.chunkCount, LARGE_FILE_PERSISTED_READ_AHEAD);
                index++
            ) {
                void resolveChunkWithReadAhead(index);
            }
        }

        for (let index = 0; index < this.chunkCount; index++) {
            const nextIndex = index + LARGE_FILE_PERSISTED_READ_AHEAD;
            if (files.persistChunkReads && nextIndex < this.chunkCount) {
                void resolveChunkWithReadAhead(nextIndex);
            }
            const chunkFile = files.persistChunkReads
                ? await resolveChunkWithReadAhead(index)
                : knownChunks.get(index);
            inFlightChunks.delete(index);
            if (!chunkFile) {
                throw new Error(
                    `Failed to resolve chunk ${index + 1}/${this.chunkCount} for file ${this.id}`
                );
            }
            const chunk = await chunkFile.getFile(files, {
                as: "joined",
                timeout: properties?.timeout,
            });
            hasher?.update(chunk);
            processed += chunk.byteLength;
            properties?.progress?.(
                processed / Math.max(Number(this.size), 1)
            );
            yield chunk;
        }

        if (hasher && toBase64(hasher.digest()) !== this.finalHash) {
            throw new Error("File hash does not match the expected content");
        }
    }
}

type Args = { replicate: ReplicationOptions };

@variant("files")
export class Files extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    @field({ type: option(TrustedNetwork) })
    trustGraph?: TrustedNetwork;

    @field({ type: Documents })
    files: Documents<AbstractFile, IndexableFile>;

    persistChunkReads: boolean;

    constructor(
        properties: {
            id?: Uint8Array;
            name?: string;
            rootKey?: PublicSignKey;
        } = {}
    ) {
        super();
        this.id = properties.id || randomBytes(32);
        this.name = properties.name || "";
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({ id: this.id, rootTrust: properties.rootKey })
            : undefined;
        this.files = new Documents({
            id: sha256Sync(
                concat([
                    this.id,
                    new TextEncoder().encode(this.name),
                    properties.rootKey?.bytes || new Uint8Array(0),
                ])
            ),
        });
        this.persistChunkReads = true;
    }

    async add(
        name: string,
        file: Uint8Array | Blob,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        if (isBlobLike(file)) {
            return this.addBlob(name, file, parentId, progress);
        }

        progress?.(0);
        if (BigInt(file.byteLength) <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const tinyFile = new TinyFile({ name, file, parentId });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        const chunkSize = getLargeFileSegmentSize(file.byteLength);
        return this.addChunkedFile(
            name,
            BigInt(file.byteLength),
            (index) =>
                Promise.resolve(
                    file.subarray(
                        getChunkStart(index, chunkSize),
                        getChunkEnd(index, file.byteLength, chunkSize)
                    )
                ),
            chunkSize,
            parentId,
            progress
        );
    }

    async addBlob(
        name: string,
        file: Blob,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        progress?.(0);
        if (BigInt(file.size) <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const tinyFile = new TinyFile({
                name,
                file: new Uint8Array(await file.arrayBuffer()),
                parentId,
            });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        const chunkSize = getLargeFileSegmentSize(file.size);
        return this.addChunkedFile(
            name,
            BigInt(file.size),
            (index) => readBlobChunk(file, index, chunkSize),
            chunkSize,
            parentId,
            progress
        );
    }

    async addSource(
        name: string,
        source: ReReadableChunkSource,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        progress?.(0);
        if (source.size <= TINY_FILE_SIZE_LIMIT_BIGINT) {
            const chunks: Uint8Array[] = [];
            let processed = 0n;
            for await (const chunk of source.readChunks(TINY_FILE_SIZE_LIMIT)) {
                chunks.push(chunk);
                processed += BigInt(chunk.byteLength);
            }
            ensureSourceSize(processed, source.size);
            const tinyFile = new TinyFile({
                name,
                file: chunks.length === 0 ? new Uint8Array(0) : concat(chunks),
                parentId,
            });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        if (parentId) {
            throw new Error("Unexpected that a LargeFile to have a parent");
        }

        const size = source.size;
        const chunkSize = getLargeFileSegmentSize(size);
        const uploadId = createUploadId();
        const manifest = new LargeFile({
            id: uploadId,
            name,
            size,
            chunkCount: getChunkCount(size, chunkSize),
            ready: false,
        });

        await this.files.put(manifest);
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0n;
            let chunkCount = 0;
            for await (const chunkBytes of source.readChunks(chunkSize)) {
                hasher.update(chunkBytes);
                await this.files.put(
                    new TinyFile({
                        name: name + "/" + chunkCount,
                        file: chunkBytes,
                        parentId: uploadId,
                        index: chunkCount,
                    })
                );
                uploadedBytes += BigInt(chunkBytes.byteLength);
                chunkCount++;
                progress?.(Number(uploadedBytes) / Math.max(Number(size), 1));
            }
            ensureSourceSize(uploadedBytes, source.size);
            await this.files.put(
                new LargeFile({
                    id: uploadId,
                    name,
                    size,
                    chunkCount,
                    ready: true,
                    finalHash: toBase64(hasher.digest()),
                })
            );
        } catch (error) {
            await this.cleanupChunkedUpload(uploadId).catch(() => {});
            await this.files.del(uploadId).catch(() => {});
            throw error;
        }

        progress?.(1);
        return uploadId;
    }

    private async cleanupChunkedUpload(uploadId: string) {
        const chunks = await this.files.index.search(
            new SearchRequest({
                query: new StringMatch({
                    key: "parentId",
                    value: uploadId,
                }),
                fetch: 0xffffffff,
            }),
            { local: true }
        );
        await Promise.all(chunks.map((chunk) => this.files.del(chunk.id)));
    }

    private async addChunkedFile(
        name: string,
        size: bigint,
        getChunk: (index: number) => Promise<Uint8Array>,
        chunkSize: number,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        if (parentId) {
            throw new Error("Unexpected that a LargeFile to have a parent");
        }

        const uploadId = createUploadId();
        const chunkCount = getChunkCount(size, chunkSize);
        const manifest = new LargeFile({
            id: uploadId,
            name,
            size,
            chunkCount,
            ready: false,
        });

        await this.files.put(manifest);
        const hasher = new SHA256();
        try {
            let uploadedBytes = 0;
            for (let i = 0; i < chunkCount; i++) {
                const chunkBytes = await getChunk(i);
                hasher.update(chunkBytes);
                await this.files.put(
                    new TinyFile({
                        name: name + "/" + i,
                        file: chunkBytes,
                        parentId: uploadId,
                        index: i,
                    })
                );
                uploadedBytes += chunkBytes.byteLength;
                progress?.(uploadedBytes / Math.max(Number(size), 1));
            }
            await this.files.put(
                new LargeFile({
                    id: uploadId,
                    name,
                    size,
                    chunkCount,
                    ready: true,
                    finalHash: toBase64(hasher.digest()),
                })
            );
        } catch (error) {
            await this.cleanupChunkedUpload(uploadId).catch(() => {});
            await this.files.del(uploadId).catch(() => {});
            throw error;
        }

        progress?.(1);
        return uploadId;
    }

    async removeById(id: string) {
        const file = await this.files.index.get(id);
        if (file) {
            await file.delete(this);
            await this.files.del(file.id);
        }
    }

    async removeByName(name: string) {
        const files = await this.files.index.search(
            new SearchRequest({
                query: new StringMatch({
                    key: ["name"],
                    value: name,
                    caseInsensitive: false,
                    method: StringMatchMethod.exact,
                }),
                fetch: 0xffffffff,
            })
        );
        for (const file of files) {
            await file.delete(this);
            await this.files.del(file.id);
        }
    }

    async list() {
        // only root files (don't fetch fetch chunks here)
        const files = await this.files.index.search(
            new SearchRequest({
                query: new IsNull({ key: "parentId" }),
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    // Allow partial results while the network is still forming. If we
                    // throw on missing shards here, the UI can appear "empty" until
                    // all shard roots respond, which feels broken during joins/churn.
                    throwOnMissing: false,
                    replicate: true, // sync here because this, because we might want to access it offline, even though we are not replicators
                },
            }
        );
        return files;
    }

    async countLocalChunks(parent: LargeFile): Promise<number> {
        const count = await this.files.index.index.count(
            new SearchRequest({
                query: new StringMatch({ key: "parentId", value: parent.id }),
                fetch: 0xffffffff,
            })
        );
        return count;
    }

    async resolveById(
        id: string,
        properties?: {
            timeout?: number;
            replicate?: boolean;
        }
    ): Promise<AbstractFile | undefined> {
        return this.files.index.get(id, {
            local: true,
            waitFor: properties?.timeout,
            remote: {
                timeout: properties?.timeout ?? 10 * 1000,
                wait: properties?.timeout
                    ? {
                          timeout: properties.timeout,
                          behavior: "keep-open",
                      }
                    : undefined,
                throwOnMissing: false,
                retryMissingResponses: true,
                replicate: properties?.replicate,
            },
        });
    }

    async resolveByName(
        name: string,
        properties?: {
            timeout?: number;
            replicate?: boolean;
        }
    ): Promise<AbstractFile | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: name,
                        caseInsensitive: false,
                        method: StringMatchMethod.exact,
                    }),
                ],
                fetch: 1,
            }),
            {
                local: true,
                remote: {
                    timeout: properties?.timeout ?? 10 * 1000,
                    throwOnMissing: false,
                    replicate: properties?.replicate,
                },
            }
        );
        return results[0];
    }

    /**
     * Get by name
     * @param id
     * @returns
     */
    async getById<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        id: string,
        properties?: { as: OutputType }
    ): Promise<{ id: string; name: string; bytes: Output } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "id", value: id })],
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this, properties);
            if (file) {
                return {
                    id: result.id,
                    name: result.name,
                    bytes: file as Output,
                };
            }
        }
    }

    /**
     * Get by name
     * @param name
     * @returns
     */
    async getByName<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array,
    >(
        name: string,
        properties?: { as: OutputType }
    ): Promise<{ id: string; name: string; bytes: Output } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "name", value: name })],
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this, properties);
            if (file) {
                return {
                    id: result.id,
                    name: result.name,
                    bytes: file as Output,
                };
            }
        }
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        this.persistChunkReads = args?.replicate !== false;
        await this.trustGraph?.open({
            replicate: args?.replicate,
        });

        await this.files.open({
            type: AbstractFile,
            // TODO add ACL
            replicate: args?.replicate,
            replicas: { min: 3 },
            canPerform: async (operation) => {
                if (!this.trustGraph) {
                    return true;
                }
                for (const key of await operation.entry.getPublicKeys()) {
                    if (await this.trustGraph.isTrusted(key)) {
                        return true;
                    }
                }
                return false;
            },
            index: {
                type: IndexableFile,
            },
        });
    }
}
