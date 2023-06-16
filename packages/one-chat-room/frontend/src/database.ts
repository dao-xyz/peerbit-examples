import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    Documents,
    DocumentIndex,
    PutOperation,
    DeleteOperation,
    IntegerCompare,
    SortDirection,
    SearchRequest,
    Sort,
    Compare,
    Query,
} from "@dao-xyz/peerbit-document";
import { v4 as uuid } from "uuid";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";

const FROM = "from";
const MESSAGE = "message";
const TIMESTAMP = "timestamp";

@variant(0) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class Post {
    @field({ type: "string" })
    id: string;

    @field({ type: PublicSignKey })
    [FROM]: PublicSignKey;

    @field({ type: "string" })
    [MESSAGE]: string;

    constructor(properties: { message: string; from: PublicSignKey }) {
        this.id = uuid();
        this.from = properties.from;
        this.message = properties.message;
    }
}

@variant("room")
export class Room extends Program {
    @field({ type: PublicSignKey })
    creator: PublicSignKey;

    @field({ type: Documents })
    messages: Documents<Post>;

    constructor(properties: {
        creator: PublicSignKey;
        messages?: Documents<Post>;
    }) {
        super();
        this.creator = properties.creator;
        this.messages = properties.messages || new Documents<Post>();
    }

    get id() {
        return this.creator.hashcode();
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.messages.setup({
            type: Post,
            canAppend: async (entry) => {
                await entry.verifySignatures();
                try {
                    const payload = await entry.getPayloadValue();
                    if (payload instanceof PutOperation) {
                        const post = payload.getValue(
                            this.messages.index.valueEncoding
                        );
                        if (
                            !entry.signatures.find((x) =>
                                x.publicKey.equals(post.from)
                            )
                        ) {
                            return false;
                        }
                    } else if (payload instanceof DeleteOperation) {
                        const get = await this.messages.index.get(payload.key);
                        if (
                            !get ||
                            !entry.signatures.find((x) =>
                                x.publicKey.equals(get.from)
                            )
                        ) {
                            return false;
                        }
                    }
                } catch (error) {
                    console.error(error);
                    throw error;
                }
                return true; // no verification as of now
            },
            canRead: async (identity) => {
                return true; // Anyone can query
            },
            index: {
                fields: (obj, entry) => {
                    return {
                        [FROM]: obj[FROM].bytes,
                        [MESSAGE]: obj[MESSAGE],
                        [TIMESTAMP]: entry.created,
                    };
                },
            },
        });
    }

    async loadEarlier() {
        // get the earlist doc locally, query all docs earlier than this
        const firstIterator = await this.messages.index.iterate(
            new SearchRequest({
                query: [],
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: TIMESTAMP,
                    }),
                ],
            }),
            {
                local: true,
                remote: false,
            }
        );
        const earliestPost = (await firstIterator.next(1))[0];
        firstIterator.close();

        const query: Query[] = [];
        if (earliestPost) {
            const created = (
                await this.messages.index.getDetailed(earliestPost.id, {
                    local: true,
                })
            )?.[0].results[0]?.context.created;
            if (created != null) {
                query.push(
                    new IntegerCompare({
                        key: "timestmap",
                        compare: Compare.Less,
                        value: created,
                    })
                );
            }
        }
        const iterator = await this.messages.index.iterate(
            new SearchRequest({
                query,
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: TIMESTAMP,
                    }),
                ],
            })
        );
        const next = await iterator.next(10);
        iterator.close();
        return next;
    }
    async loadLater() {
        // get the earlist doc locally, query all docs earlier than this
        const lastIterator = await this.messages.index.iterate(
            new SearchRequest({
                query: [],
                sort: [
                    new Sort({
                        direction: SortDirection.DESC,
                        key: TIMESTAMP,
                    }),
                ],
            }),
            {
                local: true,
                remote: false,
            }
        );

        const latestPost = (await lastIterator.next(1))[0];
        lastIterator.close();

        const query: Query[] = [];

        if (latestPost) {
            const created = (
                await this.messages.index.getDetailed(latestPost.id, {
                    local: true,
                })
            )?.[0].results[0]?.context.created;
            if (created != null) {
                query.push(
                    new IntegerCompare({
                        key: TIMESTAMP,
                        compare: Compare.Greater,
                        value: created,
                    })
                );
            }
        }

        const iterator = await this.messages.index.iterate(
            new SearchRequest({
                query,
                sort: [
                    new Sort({
                        direction: SortDirection.ASC,
                        key: TIMESTAMP,
                    }),
                ],
            }),
            {
                remote: {
                    sync: true,
                },
            }
        );
        const next = await iterator.next(10);
        iterator.close();
        return next;
    }
}
