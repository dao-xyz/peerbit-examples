import { field, variant, vec, option } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    Or,
    IsNull,
} from "@peerbit/document";
import {
    createSHA256,
    PublicSignKey,
    sha256Base64Sync,
    randomBytes,
    sha256Sync,
    toBase64,
} from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { ReplicationOptions } from "@peerbit/shared-log";

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

const TINY_FILE_SIZE_LIMIT = 5 * 1e6; // 5 MB
const LARGE_FILE_SEGMENT_SIZE = TINY_FILE_SIZE_LIMIT / 10;
const LARGE_FILE_DOWNLOAD_BATCH_SIZE = 32;
const TINY_FILE_SIZE_LIMIT_BIGINT = BigInt(TINY_FILE_SIZE_LIMIT);
const PROGRESS_SCALE = 10_000n;

const toProgress = (processed: bigint, total: bigint): number => {
    if (total <= 0n) {
        return 1;
    }
    return Number((processed * PROGRESS_SCALE) / total) / Number(PROGRESS_SCALE);
};

const ensureSourceSize = (actual: bigint, expected: bigint) => {
    if (actual !== expected) {
        throw new Error(
            `Source size changed during upload. Expected ${expected} bytes, got ${actual}`
        );
    }
};

export interface ReReadableChunkSource {
    size: bigint;
    readChunks(chunkSize: number): AsyncIterable<Uint8Array>;
}

export type FileReadOptions = {
    timeout?: number;
    progress?: (progress: number) => any;
};

export interface ChunkWritable {
    write(chunk: Uint8Array): Promise<void> | void;
    close?(): Promise<void> | void;
    abort?(reason?: unknown): Promise<void> | void;
}

export const chunkSourceFromBytes = (
    bytes: Uint8Array
): ReReadableChunkSource => ({
    size: BigInt(bytes.byteLength),
    async *readChunks(chunkSize: number) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            yield bytes.subarray(
                offset,
                Math.min(offset + chunkSize, bytes.byteLength)
            );
        }
    },
});

export const chunkSourceFromBlob = (blob: Blob): ReReadableChunkSource => ({
    size: BigInt(blob.size),
    async *readChunks(chunkSize: number) {
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
            const chunk = blob.slice(
                offset,
                Math.min(offset + chunkSize, blob.size)
            );
            yield new Uint8Array(await chunk.arrayBuffer());
        }
    },
});

const readAllFromSource = async (
    source: ReReadableChunkSource,
    chunkSize: number
): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let processed = 0n;

    for await (const chunk of source.readChunks(chunkSize)) {
        chunks.push(chunk);
        processed += BigInt(chunk.byteLength);
    }

    ensureSourceSize(processed, source.size);
    return chunks.length === 0 ? new Uint8Array(0) : concat(chunks);
};

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
            timeout?: number;
            progress?: (progress: number) => any;
        }
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
                    // ignore abort cleanup failures
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

@variant(0) // for versioning purposes
export class TinyFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: Uint8Array })
    file: Uint8Array; // 10 mb imit

    @field({ type: option("string") })
    parentId?: string;

    get size() {
        return BigInt(this.file.byteLength);
    }

    constructor(properties: {
        id?: string;
        name: string;
        file: Uint8Array;
        parentId?: string;
    }) {
        super();
        this.id = properties.id || sha256Base64Sync(properties.file);
        this.name = properties.name;
        this.file = properties.file;
        this.parentId = properties.parentId;
    }

    async *streamFile(
        _files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        if (sha256Base64Sync(this.file) !== this.id) {
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
    id: string; // hash

    @field({ type: "string" })
    name: string;

    @field({ type: vec("string") })
    fileIds: string[];

    @field({ type: "u64" })
    size: bigint;

    constructor(properties: {
        id: string;
        name: string;
        fileIds: string[];
        size: bigint;
    }) {
        super();
        this.id = properties.id;
        this.name = properties.name;
        this.fileIds = properties.fileIds;
        this.size = properties.size;
    }

    static async create(
        name: string,
        file: Uint8Array,
        files: Files,
        progress?: (progress: number) => void
    ) {
        const source = chunkSourceFromBytes(file);
        const { file: largeFile, chunkIds } = await LargeFile.prepareSource(
            name,
            source,
            progress,
        );
        let index = 0;
        for await (const chunk of source.readChunks(LARGE_FILE_SEGMENT_SIZE)) {
            await files.files.put(
                new TinyFile({
                    id: chunkIds[index],
                    name: name + "/" + index,
                    file: chunk,
                    parentId: largeFile.id,
                }),
            );
            index++;
        }
        return largeFile;
    }

    static prepare(name: string, file: Uint8Array) {
        const id = sha256Base64Sync(file);
        const fileSize = BigInt(file.byteLength);
        const end = Math.ceil(file.byteLength / LARGE_FILE_SEGMENT_SIZE);
        const chunks: TinyFile[] = [];

        for (let i = 0; i < end; i++) {
            chunks.push(
                new TinyFile({
                    name: name + "/" + i,
                    file: file.subarray(
                        i * LARGE_FILE_SEGMENT_SIZE,
                        Math.min(
                            (i + 1) * LARGE_FILE_SEGMENT_SIZE,
                            file.byteLength
                        )
                    ),
                    parentId: id,
                })
            );
        }

        return {
            file: new LargeFile({
                id,
                name,
                fileIds: chunks.map((chunk) => chunk.id),
                size: fileSize,
            }),
            chunks,
        };
    }

    static async prepareSource(
        name: string,
        source: ReReadableChunkSource,
        progress?: (progress: number) => void
    ) {
        const fileHasher = createSHA256();
        const fileIds: string[] = [];
        let processed = 0n;

        for await (const chunk of source.readChunks(LARGE_FILE_SEGMENT_SIZE)) {
            fileHasher.update(chunk);
            fileIds.push(sha256Base64Sync(chunk));
            processed += BigInt(chunk.byteLength);
            progress?.(toProgress(processed, source.size));
        }

        ensureSourceSize(processed, source.size);
        progress?.(1);

        return {
            file: new LargeFile({
                id: toBase64(fileHasher.digest()),
                name,
                fileIds,
                size: processed,
            }),
            chunkIds: fileIds,
        };
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
        const expectedIds = [...new Set(this.fileIds)];
        const expectedSet = new Set(expectedIds);
        const chunks = new Map<string, AbstractFile>();
        const totalTimeout = properties?.timeout ?? 30_000;
        const deadline = Date.now() + totalTimeout;
        const queryTimeout = Math.min(totalTimeout, 5_000);
        const searchOptions = {
            local: true,
            remote: {
                timeout: queryTimeout,
                throwOnMissing: false,
                // Observer downloads still need chunk metadata/documents, even
                // when the peer is not a replicator.
                replicate: true,
            },
        };
        const recordChunks = (results: AbstractFile[]) => {
            for (const chunk of results) {
                if (
                    chunk instanceof TinyFile &&
                    expectedSet.has(chunk.id) &&
                    !chunks.has(chunk.id)
                ) {
                    chunks.set(chunk.id, chunk);
                }
            }
        };

        recordChunks(
            await files.files.index.search(
                new SearchRequest({
                    query: new StringMatch({ key: "parentId", value: this.id }),
                    fetch: 0xffffffff,
                }),
                searchOptions
            )
        );

        while (chunks.size < expectedSet.size && Date.now() < deadline) {
            const missingIds = expectedIds.filter((id) => !chunks.has(id));
            if (missingIds.length === 0) {
                break;
            }

            const before = chunks.size;
            for (let i = 0; i < missingIds.length; i += 32) {
                const batch = missingIds.slice(i, i + 32);
                recordChunks(
                    await files.files.index.search(
                        new SearchRequest({
                            query: [
                                new Or(
                                    batch.map(
                                        (id) =>
                                            new StringMatch({
                                                key: "id",
                                                value: id,
                                            })
                                    )
                                ),
                            ],
                            fetch: batch.length,
                        }),
                        searchOptions
                    )
                );
            }

            if (chunks.size === before && chunks.size < expectedSet.size) {
                await sleep(250);
            }
        }

        return [...chunks.values()];
    }
    async delete(files: Files) {
        await Promise.all(
            (await this.fetchChunks(files)).map((x) => x.delete(files))
        );
    }

    async *streamFile(
        files: Files,
        properties?: FileReadOptions
    ): AsyncIterable<Uint8Array> {
        properties?.progress?.(0);
        const totalTimeout = properties?.timeout ?? 30_000;
        const deadline = Date.now() + totalTimeout;
        const remainingOccurrences = new Map<string, number>();
        const cachedChunks = new Map<string, Uint8Array>();
        const prefetchedChunks = new Map<string, Uint8Array>();
        let processed = 0n;

        for (const fileId of this.fileIds) {
            remainingOccurrences.set(
                fileId,
                (remainingOccurrences.get(fileId) ?? 0) + 1
            );
        }

        const prefetchChunks = async (startIndex: number) => {
            const batchIds: string[] = [];
            const seen = new Set<string>();
            for (
                let cursor = startIndex;
                cursor < this.fileIds.length &&
                batchIds.length < LARGE_FILE_DOWNLOAD_BATCH_SIZE;
                cursor++
            ) {
                const fileId = this.fileIds[cursor];
                if (
                    prefetchedChunks.has(fileId) ||
                    cachedChunks.has(fileId) ||
                    seen.has(fileId)
                ) {
                    continue;
                }
                seen.add(fileId);
                batchIds.push(fileId);
            }

            const missingIds = new Set(batchIds);
            while (missingIds.size > 0) {
                const remainingTime = deadline - Date.now();
                if (remainingTime <= 0) {
                    break;
                }

                const results = await files.files.index.search(
                    new SearchRequest({
                        query: [
                            new Or(
                                [...missingIds].map(
                                    (id) =>
                                        new StringMatch({
                                            key: "id",
                                            value: id,
                                        })
                                )
                            ),
                        ],
                        fetch: missingIds.size,
                    }),
                    {
                        local: true,
                        remote: {
                            timeout: Math.min(remainingTime, 5_000),
                            throwOnMissing: false,
                            replicate: true,
                        },
                    }
                );

                let progress = false;
                for (const entry of results) {
                    if (
                        entry instanceof TinyFile &&
                        missingIds.has(entry.id) &&
                        !prefetchedChunks.has(entry.id)
                    ) {
                        prefetchedChunks.set(entry.id, entry.file);
                        missingIds.delete(entry.id);
                        progress = true;
                    }
                }

                if (!progress && missingIds.size > 0) {
                    await sleep(250);
                }
            }

            if (missingIds.size > 0) {
                throw new Error(
                    `Failed to retrieve chunk with id: ${[...missingIds][0]}`
                );
            }
        };

        for (let index = 0; index < this.fileIds.length; index++) {
            const fileId = this.fileIds[index];
            let chunk = cachedChunks.get(fileId) ?? prefetchedChunks.get(fileId);
            if (!chunk) {
                await prefetchChunks(index);
                chunk = cachedChunks.get(fileId) ?? prefetchedChunks.get(fileId);
            }

            if (!chunk) {
                throw new Error(`Failed to retrieve chunk with id: ${fileId}`);
            }

            prefetchedChunks.delete(fileId);

            if ((remainingOccurrences.get(fileId) ?? 0) > 1) {
                cachedChunks.set(fileId, chunk);
            }

            processed += BigInt(chunk.byteLength);
            properties?.progress?.(toProgress(processed, this.size));
            yield chunk;

            const remaining = (remainingOccurrences.get(fileId) ?? 0) - 1;
            if (remaining <= 0) {
                remainingOccurrences.delete(fileId);
                cachedChunks.delete(fileId);
            } else {
                remainingOccurrences.set(fileId, remaining);
            }
        }

        ensureSourceSize(processed, this.size);
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
    }

    async add(
        name: string,
        file: Uint8Array,
        parentId?: string,
        progress?: (progress: number) => void
    ) {
        return this.addSource(
            name,
            chunkSourceFromBytes(file),
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
        return this.addSource(
            name,
            chunkSourceFromBlob(file),
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
            const bytes = await readAllFromSource(source, TINY_FILE_SIZE_LIMIT);
            const tinyFile = new TinyFile({ name, file: bytes, parentId });
            await this.files.put(tinyFile);
            progress?.(1);
            return tinyFile.id;
        }

        if (parentId) {
            throw new Error("Unexpected that a LargeFile to have a parent");
        }

        const { file: largeFile, chunkIds } = await LargeFile.prepareSource(
            name,
            source,
            (scanProgress) => {
                progress?.(scanProgress * 0.5);
            }
        );

        // Put the root metadata first so readers can list the file while chunks
        // are still arriving.
        await this.files.put(largeFile);
        try {
            let processed = 0n;
            let index = 0;
            for await (const chunk of source.readChunks(LARGE_FILE_SEGMENT_SIZE)) {
                await this.files.put(
                    new TinyFile({
                        id: chunkIds[index],
                        name: name + "/" + index,
                        file: chunk,
                        parentId: largeFile.id,
                    })
                );
                processed += BigInt(chunk.byteLength);
                index++;
                progress?.(0.5 + toProgress(processed, source.size) * 0.5);
            }
            ensureSourceSize(processed, source.size);
            if (index !== chunkIds.length) {
                throw new Error(
                    `Chunk count changed during upload. Expected ${chunkIds.length} chunks, got ${index}`
                );
            }
        } catch (error) {
            await this.files.del(largeFile.id).catch(() => {});
            throw error;
        }

        progress?.(1);
        return largeFile.id;
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
        const results = await this.files.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "id",
                        value: id,
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
        const result = await this.resolveById(id);
        if (!result) {
            return undefined;
        }
        const file = await result.getFile(this, properties);
        if (!file) {
            return undefined;
        }
        return {
            id: result.id,
            name: result.name,
            bytes: file as Output,
        };
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
        const result = await this.resolveByName(name);
        if (!result) {
            return undefined;
        }
        const file = await result.getFile(this, properties);
        if (!file) {
            return undefined;
        }
        return {
            id: result.id,
            name: result.name,
            bytes: file as Output,
        };
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
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
