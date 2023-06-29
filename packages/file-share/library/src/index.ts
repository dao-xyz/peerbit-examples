import { field, variant, vec } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { Documents, SearchRequest, StringMatch, Role } from "@peerbit/document";
import { sha256Base64Sync, randomBytes } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { concat } from "uint8arrays";

abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract getFile(files: Files): Promise<Uint8Array | undefined>;
}

const TINY_FILE_SIZE_LIMIT = 1e3;

@variant(0) // for versioning purposes
export class TinyFile extends AbstractFile {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    name: string;

    @field({ type: Uint8Array })
    file: Uint8Array; // 10 mb imit

    constructor(properties: { name: string; file: Uint8Array }) {
        super();
        this.id = sha256Base64Sync(properties.file);
        this.name = properties.name;
        this.file = properties.file;
    }

    async getFile(_files: Files) {
        if (sha256Base64Sync(this.file) !== this.id) {
            throw new Error("Hash does not match the file content");
        }
        return Promise.resolve(this.file);
    }
}

const SMALL_FILE_SIZE_LIMIT = 1e6 * 9;

@variant(1) // for versioning purposes
export class SmallFile extends AbstractFile {
    @field({ type: "string" })
    id: string; // cid

    @field({ type: "string" })
    name: string;

    @field({ type: "string" })
    cid: string; // store file separately in a block store, like IPFS

    constructor(properties: { name: string; cid: string }) {
        super();
        this.id = properties.cid;
        this.name = properties.name;
        this.cid = properties.cid;
    }

    static async create(node: ProgramClient, name: string, file: Uint8Array) {
        if (file.length > SMALL_FILE_SIZE_LIMIT) {
            throw new Error("To large file for SmallFile");
        }
        const cid = await node.services.blocks.put(file);
        return new SmallFile({ name, cid });
    }

    async getFile(files: Files) {
        // Load the file from the block store
        return await files.node.services.blocks.get(this.id);
    }
}

@variant(2) // for versioning purposes
export class LargeFile extends AbstractFile {
    @field({ type: "string" })
    id: string; // hash

    @field({ type: "string" })
    name: string;

    @field({ type: vec("string") })
    fileIds: string[];

    constructor(properties: { id: string; name: string; fileIds: string[] }) {
        super();
        this.id = properties.id;
        this.name = properties.name;
        this.fileIds = properties.fileIds;
    }

    static async create(name: string, file: Uint8Array, files: Files) {
        const segmetSize = SMALL_FILE_SIZE_LIMIT / 10; // 10% of the small size limit
        const fileIds: string[] = [];
        const id = sha256Base64Sync(file);
        for (let i = 0; i < Math.ceil(file.byteLength / segmetSize); i++) {
            fileIds.push(
                await files.create(
                    id + "/" + name,
                    file.subarray(
                        i * segmetSize,
                        Math.min((i + 1) * segmetSize, file.length)
                    )
                )
            );
        }

        return new LargeFile({ id, name, fileIds });
    }

    async getFile(files: Files) {
        // Get all sub files (SmallFiles) and concatinate them in the right order (the order of this.fileIds)
        const expectedIds = new Set(this.fileIds);
        const chunks: Map<string, Promise<Uint8Array | undefined>> = new Map();

        const results = await files.files.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: this.id + "/" + this.name,
                    }),
                ],
            }),
            {
                local: true,
                remote: true,
            }
        );

        if (results.length > 0) {
            for (const r of results) {
                if (chunks.has(r.id)) {
                    // chunk already added;
                }
                if (!expectedIds.has(r.id)) {
                    // chunk is not part of this file
                }

                chunks.set(r.id, r.getFile(files));
            }
        }

        if (chunks.size !== expectedIds.size) {
            throw new Error("Failed to resolve file");
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
        return concat(chunkContentResolved);
    }
}

type Args = { role: Role };

@variant("files")
export class Files extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    files: Documents<AbstractFile>;

    constructor(id: Uint8Array = randomBytes(32)) {
        super();
        this.id = id;
        this.files = new Documents({ id: this.id });
    }

    async create(name: string, file: Uint8Array) {
        let toPut: AbstractFile;
        if (file.byteLength <= TINY_FILE_SIZE_LIMIT) {
            toPut = new TinyFile({ name, file });
        } else if (
            file.byteLength > TINY_FILE_SIZE_LIMIT &&
            file.byteLength <= SMALL_FILE_SIZE_LIMIT
        ) {
            toPut = await SmallFile.create(this.node, name, file);
        } else {
            toPut = await LargeFile.create(name, file, this);
        }
        await this.files.put(toPut);
        return toPut.id;
    }

    /**
     * Get by name
     * @param id
     * @returns
     */
    async getById(
        id: string
    ): Promise<{ id: string; name: string; bytes: Uint8Array } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "id", value: id })],
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this);
            if (file) {
                return { id: result.id, name: result.name, bytes: file };
            }
        }
    }

    /**
     * Get by name
     * @param name
     * @returns
     */
    async getByName(
        name: string
    ): Promise<{ id: string; name: string; bytes: Uint8Array } | undefined> {
        const results = await this.files.index.search(
            new SearchRequest({
                query: [new StringMatch({ key: "name", value: name })],
            }),
            {
                local: true,
                remote: {
                    timeout: 10 * 1000,
                },
            }
        );

        for (const result of results) {
            const file = await result.getFile(this);
            if (file) {
                return { id: result.id, name: result.name, bytes: file };
            }
        }
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.files.open({
            type: AbstractFile,
            canAppend: async (entry) => {
                await entry.verifySignatures();
                return true; // no verification as of now
            },
            canRead: async (identity) => {
                return true; // Anyone can query
            },
            role: args?.role,
        });
    }
}
