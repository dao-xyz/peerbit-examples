import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import { Documents, DocumentIndex, FieldStringMatchQuery, DocumentQueryRequest, ResultWithSource } from "@dao-xyz/peerbit-document";
import { sha256Base64Sync } from "@dao-xyz/peerbit-crypto";
import {
    createBlock,
    getBlockValue,
    DirectBlock,
} from "@dao-xyz/libp2p-direct-block";
import { concat } from 'uint8arrays';

abstract class AbstractFile {
    abstract id: string;
    abstract name: string;
    abstract getFile(files: Files): Promise<Uint8Array>;
}

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

@variant(1) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class SmallFile extends AbstractFile {

    @field({ type: "string" })
    id: string; // cid

    @field({ type: "string" })
    name: string;

    @field({ type: 'string' })
    cid: string

    constructor(properties: { name: string; cid: string }) {
        super();
        this.id = properties.cid;
        this.name = properties.name
        this.cid = properties.cid;
    }

    static async create(name: string, file: Uint8Array, blocks: DirectBlock) {
        if (file.length > 1e6 * 9) {
            throw new Error("To large file for SmallFile")
        }
        const cid = await blocks.put(await createBlock(file, "raw"));
        return new SmallFile({ name, cid });
    }

    async getFile(files: Files) {
        const block = await files.libp2p.directblock.get(this.id);
        return (block ? await getBlockValue(block) : undefined) as Uint8Array;
    }
}

@variant(2) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class LargeFile extends AbstractFile {

    @field({ type: "string" })
    id: string; // hash

    @field({ type: "string" })
    name: string;

    @field({ type: 'string' })
    chunkIds: string[]

    constructor(properties: { id: string, name: string, chunkIds: string[] }) {
        super();
        this.id = properties.id;
        this.name = properties.name;
        this.chunkIds = properties.chunkIds;
    }

    static async create(name: string, file: Uint8Array, files: Files) {
        const segmetSize = 1e6; // 1 mb
        let chunkIds: string[] = [];
        const id = sha256Base64Sync(file)
        for (let i = 0; i < Math.ceil(file.byteLength / segmetSize); i++) {
            chunkIds.push((await files.create(id + "/" + name, file.subarray(i * segmetSize, Math.min((i + 1) * segmetSize, file.length)))));
        }

        return new LargeFile({ id, name, chunkIds });
    }

    async getFile(files: Files) {

        /*  let ids = new Set<string>();
        let chunks: ResultWithSource<AbstractFile>[] = []
        let stopSearch: () => void;
       await new Promise<void>((resolve, _reject) => {
            files.files.index.query(new DocumentQueryRequest({ queries: [new FieldStringMatchQuery({ key: 'name', value: this.id + "/" + this.name })] }), (result) => {
                if (result.results.length > 0) {
                    for (const r of result.results) {
                        if (ids.has(r.context.head)) {
                            // chunk already added;
                        }
                        ids.add(r.context.head); // The head is unique for every document/chunk it is the hash of the commit
                        chunks.push(r)
                    }

                    if (chunks.length === this.chunks) {
                        stopSearch && stopSearch();
                        resolve()
                    }
                }
            }, { local: true, remote: { timeout: 10 * 1000, stopper: (stopperFn) => { stopSearch = stopperFn } } })
        })
 

        chunks.sort((a, b) => Number(a.context.created - b.context.created))*/
        let chunkDatas: Uint8Array[] = await Promise.all(chunks.map(x => x.value.getFile(files)));
        return concat(chunkDatas);
    }
}



@variant("files")
export class Files extends Program {
    @field({ type: Documents })
    files: Documents<AbstractFile>; // Or Document<TinyFile | SmallFile | LargeFile> 

    constructor() {
        super();
        this.files = new Documents({
            immutable: false,
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    async create(name: string, file: Uint8Array) {
        let toPut: AbstractFile;
        if (file.byteLength <= 1e3) {
            toPut = new TinyFile({ name, file });
        } else if (file.byteLength > 1e3 && file.byteLength <= 9 * 1e6) {
            toPut = await SmallFile.create(name, file, this.libp2p.directblock)

        }
        else {
            toPut = await LargeFile.create(name, file, this)
        }
        await this.files.put(toPut);
        return toPut.id
    }

    /**
     * Get one file
     * @param name 
     * @returns 
     */
    async get(name: string): Promise<Uint8Array | undefined> {
        return new Promise((resolve, reject) => {
            let waitFor = 10 * 1000;
            let timout = setTimeout(() => {
                reject()
            }, waitFor)

            // query local first, then remote.
            let queryOptions = [{ local: true }, { remote: { amount: 1 } }]
            for (const options of queryOptions) {
                this.files.index.query(new DocumentQueryRequest({ queries: [new FieldStringMatchQuery({ key: 'name', value: name })] }), (result) => {
                    if (result.results.length > 0) {
                        result.results[0].value.getFile(this).then((file) => {
                            clearTimeout(timout)
                            resolve(file)
                        }).catch((error) => {
                            clearTimeout(timout)
                            reject(error)
                        })
                    }
                }, options)
            }

        })
    }

    /**
     * Get all
     * @param name 
     * @returns 
     */
    async getOne(name: string): Promise<Uint8Array | undefined> {
        return new Promise((resolve, reject) => {
            this.files.index.query(new DocumentQueryRequest({ queries: [new FieldStringMatchQuery({ key: 'name', value: name })] }), (result) => {
                if (result.results.length > 0) {
                    result.results[0].value.getFile(this).then((file) => {
                        resolve(file)
                    }).catch((error) => {
                        reject(error)
                    })
                }
            }, { local: true, remote: { amount: 1, timeout: 10 * 1000 } }).finally(() => {
                resolve(undefined)
            });
        })
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
