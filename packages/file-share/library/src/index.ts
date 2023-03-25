import { field, variant, vec } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    Documents,
    DocumentIndex,
    StringMatchMethod,
    DocumentQuery,
    ResultWithSource,
    StringMatch,
} from "@dao-xyz/peerbit-document";
import { sha256Base64Sync } from "@dao-xyz/peerbit-crypto";
import {
    createBlock,
    getBlockValue,
    DirectBlock,
} from "@dao-xyz/libp2p-direct-block";
import { concat } from "uint8arrays";

abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract getFile(files: Files): Promise<Uint8Array>;
}

const TINY_FILE_SIZE_LIMIT = 1e3;

@variant(0) // for versioning purposes, we can do @variant(1) when we create a new post type version
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
        return Promise.resolve(this.file);
    }
}

const SMALL_FILE_SIZE_LIMIT = 1e6 * 9;

@variant(1) // for versioning purposes, we can do @variant(1) when we create a new post type version
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

    static async create(name: string, file: Uint8Array, blocks: DirectBlock) {
        if (file.length > SMALL_FILE_SIZE_LIMIT) {
            throw new Error("To large file for SmallFile");
        }
        const cid = await blocks.put(await createBlock(file, "raw"));
        return new SmallFile({ name, cid });
    }

    async getFile(files: Files) {
        // Load the file from the block store
        const block = await files.libp2p.directblock.get(this.id);

        // Get the file value
        return (block ? await getBlockValue(block) : undefined) as Uint8Array;
    }
}

@variant(2) // for versioning purposes, we can do @variant(1) when we create a new post type version
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
        const chunks: Map<string, Promise<Uint8Array>> = new Map();
        const waitFor = 10 * 1000;

        await new Promise<void>((resolve, reject) => {
            const timout = setTimeout(() => {
                reject(new Error("Timed out"));
            }, waitFor);

            let stopSearch: () => void;
            files.files.index.query(
                new DocumentQuery({
                    queries: [
                        new StringMatch({
                            key: "name",
                            value: this.id + "/" + this.name,
                        }),
                    ],
                }),
                {
                    local: true,
                    remote: {
                        timeout: waitFor,
                        stopper: (stopperFn) => {
                            stopSearch = stopperFn;
                        },
                    },
                    onResponse: (result) => {
                        if (result.results.length > 0) {
                            for (const r of result.results) {
                                if (chunks.has(r.value.id)) {
                                    // chunk already added;
                                }
                                if (!expectedIds.has(r.value.id)) {
                                    // chunk is not part of this file
                                }

                                chunks.set(r.value.id, r.value.getFile(files));
                            }

                            if (chunks.size === expectedIds.size) {
                                clearTimeout(timout);
                                stopSearch && stopSearch();
                                resolve();
                            }
                        }
                    },
                }
            );
        });

        const chunkContentResolved: Uint8Array[] = await Promise.all(
            this.fileIds.map((x) => chunks.get(x)!)
        );
        return concat(chunkContentResolved);
    }
}

@variant("files")
export class Files extends Program {
    @field({ type: Documents })
    files: Documents<AbstractFile>;

    constructor() {
        super();
        this.files = new Documents({
            immutable: false,
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    async create(name: string, file: Uint8Array) {
        let toPut: AbstractFile;
        if (file.byteLength <= TINY_FILE_SIZE_LIMIT) {
            toPut = new TinyFile({ name, file });
        } else if (
            file.byteLength > TINY_FILE_SIZE_LIMIT &&
            file.byteLength <= SMALL_FILE_SIZE_LIMIT
        ) {
            toPut = await SmallFile.create(name, file, this.libp2p.directblock);
        } else {
            toPut = await LargeFile.create(name, file, this);
        }
        await this.files.put(toPut);
        return toPut.id;
    }

    /**
     * Get one file
     * @param name
     * @returns
     */
    async get(name: string): Promise<Uint8Array | undefined> {
        return new Promise((resolve, reject) => {
            const waitFor = 10 * 1000;
            const timout = setTimeout(() => {
                reject(new Error("Timed out"));
            }, waitFor);

            // query local first, then remote.
            let stopSearch: (() => void) | undefined = undefined;
            this.files.index
                .query(
                    new DocumentQuery({
                        queries: [
                            new StringMatch({ key: "name", value: name }),
                        ],
                    }),
                    {
                        local: true,
                        remote: {
                            stopper: (stopper) => {
                                stopSearch = stopper;
                            },
                        },
                    }
                )
                .then((results) => {
                    for (const result of results) {
                        if (result.results.length > 0) {
                            result.results[0].value
                                .getFile(this)
                                .then((file) => {
                                    clearTimeout(timout);
                                    stopSearch && stopSearch();
                                    resolve(file);
                                })
                                .catch((error) => {
                                    clearTimeout(timout);
                                    stopSearch && stopSearch();
                                    reject(error);
                                });
                        }
                    }
                });
        });
    }

    /**
     * Get all
     * @param name
     * @returns
     */
    async getOne(name: string): Promise<Uint8Array | undefined> {
        return new Promise((resolve, reject) => {
            this.files.index
                .query(
                    new DocumentQuery({
                        queries: [
                            new StringMatch({ key: "name", value: name }),
                        ],
                    }),
                    { local: true, remote: { amount: 1, timeout: 10 * 1000 } }
                )
                .then((results) => {
                    for (const result of results) {
                        if (result.results.length > 0) {
                            result.results[0].value
                                .getFile(this)
                                .then((file) => {
                                    resolve(file);
                                })
                                .catch((error) => {
                                    reject(error);
                                });
                        }
                    }
                })
                .catch(() => {
                    resolve(undefined);
                });
        });
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.files.setup({
            type: AbstractFile,
            canAppend: async (entry) => {
                await entry.verifySignatures();
                return true; // no verification as of now
            },
            canRead: async (identity) => {
                return true; // Anyone can query
            },
        });
    }
}
