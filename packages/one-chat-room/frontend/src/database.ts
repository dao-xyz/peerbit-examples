import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    Documents,
    PutOperation,
    DeleteOperation,
    IntegerCompare,
    SortDirection,
    SearchRequest,
    Sort,
    Compare,
    Query,
} from "@peerbit/document";
import { v4 as uuid } from "uuid";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { Role, SyncFilter } from "@peerbit/shared-log";
import { concat } from "uint8arrays";

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

type Args = {
    role?: Role;
    sync?: SyncFilter;
};

@variant("room")
export class Room extends Program<Args> {
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
        this.messages =
            properties.messages ||
            new Documents<Post>({
                id: sha256Sync(
                    concat([
                        new TextEncoder().encode("room"),
                        this.creator.bytes,
                    ])
                ),
            });
    }

    get id() {
        return this.creator.hashcode();
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.messages.open({
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
                fields: (obj, context) => {
                    return {
                        [FROM]: obj[FROM].bytes,
                        [MESSAGE]: obj[MESSAGE],
                        [TIMESTAMP]: context.created,
                    };
                },
            },
            role: args?.role,
            sync: args?.sync,
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

    async getTimestamp(id: string) {
        const docs = await this.messages.index.getDetailed(id, {
            local: true,
        });
        return docs?.[0]?.results[0]?.context.created;
    }

    async loadLater(than?: bigint) {
        // get the earlist doc locally, query all docs earlier than this

        const query: Query[] = [];

        if (than == null) {
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
                    local: true, // we only query locally too see what we don't have
                    remote: false,
                }
            );

            const latestPost = (await lastIterator.next(1))[0];
            lastIterator.close();

            if (latestPost) {
                const created = await this.getTimestamp(latestPost.id);
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
        } else {
            query.push(
                new IntegerCompare({
                    key: TIMESTAMP,
                    compare: Compare.Greater,
                    value: than,
                })
            );
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
