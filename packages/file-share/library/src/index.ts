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
import { PublicSignKey, sha256Base64Sync, randomBytes } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { concat } from "uint8arrays";
import { sha256Sync } from "@peerbit/crypto";
import { TrustedNetwork } from "@peerbit/trusted-network";
import PQueue from "p-queue";
import { ReplicationOptions } from "@peerbit/shared-log";

export abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract size: number;
    abstract parentId?: string;
    abstract getFile<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array
    >(
        files: Files,
        properties?: {
            as: OutputType;
            timeout?: number;
            progress?: (progress: number) => any;
        }
    ): Promise<Output>;
    abstract delete(files: Files): Promise<void>;
}

export class IndexableFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u32" })
    size: number;

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
        return this.file.byteLength;
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

    async getFile<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array
    >(
        _files: Files,
        properties?: { as: OutputType; progress?: (progress: number) => any }
    ): Promise<Output> {
        if (sha256Base64Sync(this.file) !== this.id) {
            throw new Error("Hash does not match the file content");
        }
        properties?.progress?.(1);
        return Promise.resolve(
            properties?.as == "chunks" ? [this.file] : this.file
        ) as Output;
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

    @field({ type: "u32" })
    size: number;

    constructor(properties: {
        id: string;
        name: string;
        fileIds: string[];
        size: number;
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
        const segmetSize = TINY_FILE_SIZE_LIMIT / 10; // 10% of the small size limit
        const fileIds: string[] = [];
        const id = sha256Base64Sync(file);
        const fileSize = file.byteLength;
        progress?.(0);
        const end = Math.ceil(file.byteLength / segmetSize);
        for (let i = 0; i < end; i++) {
            progress?.((i + 1) / end);
            fileIds.push(
                await files.add(
                    name + "/" + i,
                    file.subarray(
                        i * segmetSize,
                        Math.min((i + 1) * segmetSize, file.byteLength)
                    ),
                    id
                )
            );
        }
        progress?.(1);
        return new LargeFile({ id, name, fileIds: fileIds, size: fileSize });
    }

    get parentId() {
        // Large file can never have a parent
        return undefined;
    }

    async fetchChunks(files: Files) {
        const expectedIds = new Set(this.fileIds);
        const allFiles = await files.files.index.search(
            new SearchRequest({
                query: [
                    new Or(
                        [...expectedIds].map(
                            (x) => new StringMatch({ key: "id", value: x })
                        )
                    ),
                ],
                fetch: 0xffffffff,
            })
        );
        return allFiles;
    }
    async delete(files: Files) {
        await Promise.all(
            (await this.fetchChunks(files)).map((x) => x.delete(files))
        );
    }

    async getFile<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array
    >(
        files: Files,
        properties?: {
            as: OutputType;
            timeout?: number;
            progress?: (progress: number) => any;
        }
    ): Promise<Output> {
        // Get all sub files (SmallFiles) and concatinate them in the right order (the order of this.fileIds)

        properties?.progress?.(0);

        const allChunks = await this.fetchChunks(files);

        const fetchQueue = new PQueue({ concurrency: 10 });
        let fetchError: Error | undefined = undefined;
        fetchQueue.on("error", (err) => {
            fetchError = err;
        });

        const chunks: Map<string, Uint8Array | undefined> = new Map();
        const expectedIds = new Set(this.fileIds);
        if (allChunks.length > 0) {
            let c = 0;
            for (const r of allChunks) {
                if (chunks.has(r.id)) {
                    // chunk already added;
                }
                if (!expectedIds.has(r.id)) {
                    // chunk is not part of this file
                }
                fetchQueue
                    .add(async () => {
                        let lastError: Error | undefined = undefined;
                        for (let i = 0; i < 3; i++) {
                            try {
                                const chunk = await r.getFile(files, {
                                    as: "joined",
                                    timeout: properties?.timeout,
                                });
                                if (!chunk) {
                                    throw new Error("Failed to fetch chunk");
                                }
                                chunks.set(r.id, chunk);
                                c++;
                                properties?.progress?.(c / allChunks.length);
                                return;
                            } catch (error: any) {
                                // try 3 times

                                lastError = error;
                            }
                        }
                        throw lastError;
                    })
                    .catch(() => {
                        fetchQueue.clear(); // Dont do anything more since we failed to fetch one block
                    });
            }
        }
        await fetchQueue.onIdle();

        if (fetchError || chunks.size !== expectedIds.size) {
            throw new Error(
                `Failed to resolve file. Recieved ${chunks.size}/${expectedIds.size} chunks`
            );
        }

        const chunkContentResolved: Uint8Array[] = await Promise.all(
            this.fileIds.map(async (x) => {
                const chunkValue = await chunks.get(x);
                if (!chunkValue) {
                    throw new Error("Failed to retrieve chunk with id: " + x);
                }
                return chunkValue;
            })
        );
        return (
            properties?.as == "chunks"
                ? chunkContentResolved
                : concat(chunkContentResolved)
        ) as Output;
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
        let toPut: AbstractFile;
        progress?.(0);
        if (file.byteLength <= TINY_FILE_SIZE_LIMIT) {
            toPut = new TinyFile({ name, file, parentId });
        } else {
            if (parentId) {
                throw new Error("Unexpected that a LargeFile to have a parent");
            }
            toPut = await LargeFile.create(name, file, this, progress);
        }
        await this.files.put(toPut);
        progress?.(1);
        return toPut.id;
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
                    throwOnMissing: true,
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

    /**
     * Get by name
     * @param id
     * @returns
     */
    async getById<
        OutputType extends "chunks" | "joined" = "joined",
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array
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
        Output = OutputType extends "chunks" ? Uint8Array[] : Uint8Array
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
