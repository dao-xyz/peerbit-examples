import { field, variant } from "@dao-xyz/borsh";
import {
    ByteMatchQuery,
    CanPerformOperations,
    Documents,
    SearchRequest,
    Sort,
    SortDirection,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { v4 as uuid } from "uuid";
import { concat } from "uint8arrays";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { ReplicationOptions } from "@peerbit/shared-log";

@variant(0)
export class Post {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    title: string;

    @field({ type: "string" })
    content: string;

    @field({ type: "u8" })
    private replyTo: 0; // TODO feature not implemented yet

    constructor(properties: { id?: string; content: string; title: string }) {
        this.id = properties.id || uuid();
        this.title = properties.title;
        this.content = properties.content;
        this.replyTo = 0;
    }
}

class PostIndexable {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    title: string;

    @field({ type: "string" })
    content: string;

    @field({ type: "u64" })
    created: bigint;

    @field({ type: "u64" })
    modified: bigint;

    @field({ type: Uint8Array })
    author: Uint8Array;

    constructor(
        post: Post,
        created: bigint,
        modified: bigint,
        author: PublicSignKey
    ) {
        this.id = post.id;
        this.title = post.title;
        this.content = post.content;
        this.created = created;
        this.modified = modified;
        this.author = author.bytes;
    }
}

@variant(0)
export class Alias {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: "string" })
    name: string;

    constructor(property: { publicKey: PublicSignKey; name: string }) {
        this.name = property.name;

        // by forcing the id to be the publickey we can make sure that a public key can only have one alias
        this.id = serialize(property.publicKey);
    }

    get publicKey() {
        return deserialize(this.id, PublicSignKey);
    }
}

type Args = {
    replicate?: ReplicationOptions;
};

// define a fixed blog platform id with length 32
const GLOBAL_BLOG_PLATFORM_ID = new Uint8Array(new Array(32).fill(1));

@variant("blog-posts")
export class BlogPosts extends Program<Args> {
    @field({ type: Documents })
    posts: Documents<Post, PostIndexable>;

    @field({ type: Documents })
    alias: Documents<Alias>;

    // overriding this id will make address to change. Using afixed id will make all "client.open(new BlogPosts())" to open the same database
    constructor(id: Uint8Array = GLOBAL_BLOG_PLATFORM_ID) {
        super();
        this.posts = new Documents<Post, PostIndexable>({
            id: sha256Sync(concat([id, new Uint8Array([1])])),
        });
        this.alias = new Documents<Alias>({
            id: sha256Sync(concat([id, new Uint8Array([2])])),
        });
    }

    async open(args?: Args): Promise<void> {
        await this.alias.open({
            type: Alias,
            replicate: args?.replicate || {
                factor: 1, // TODO set replication factor better
            },
            canPerform: async (props) => {
                if (!(await allowCommitsFromSameSigners(this.alias)(props))) {
                    return false;
                }

                if (props.type === "put") {
                    // check that this id is the public key of the signer
                    const alias = props.value;
                    if (
                        !props.entry.signatures.find((x) =>
                            x.publicKey.equals(alias!.publicKey)
                        )
                    ) {
                        return false;
                    }

                    // check that the name is not too long or empty
                    if (alias!.name.length === 0 || alias!.name.length > 100) {
                        return false;
                    }
                }

                return true;
            },

            index: {
                canRead: async (identity) => {
                    return true; // Anyone can query
                },
            },
        });

        return this.posts.open({
            type: Post,
            replicate: args?.replicate || {
                factor: 1,
            },
            canPerform: allowCommitsFromSameSigners(this.posts),
            index: {
                canRead: async (identity) => {
                    return true; // Anyone can query
                },
                type: PostIndexable,
                transform: async (post, ctx) => {
                    return new PostIndexable(
                        post,
                        ctx.created,
                        ctx.modified,
                        (await this.posts.log.log.get(ctx.head))!.signatures[0]
                            .publicKey
                    );
                },
            },
        });
    }

    // utitlitym methods for search
    async getLatestPosts(size: number = 10): Promise<Post[]> {
        return this.posts.index.search(
            new SearchRequest({
                sort: [
                    new Sort({ key: "created", direction: SortDirection.DESC }),
                ],
                fetch: size,
            })
        );
    }

    async getLatestPostsIterator() {
        return this.posts.index.iterate(
            new SearchRequest({
                sort: [
                    new Sort({ key: "created", direction: SortDirection.DESC }),
                ],
            })
        );
    }

    async searchContent(content: string, size: number = 10): Promise<Post[]> {
        const query = new SearchRequest({
            query: [
                new StringMatch({
                    key: "content",
                    value: content,
                    method: StringMatchMethod.contains,
                    caseInsensitive: true,
                }),
            ],
            fetch: size,
        });
        return this.posts.index.search(query);
    }

    async getPostDate(id: string) {
        return new Date(
            Number(
                (await this.posts.index.getDetailed(id))![0].results[0].context
                    .created!
            ) / 1e6
        );
    }

    async getPostAuthor(id: string) {
        // TODO typechecking
        const head = (await this.posts.index.getDetailed(id))![0].results[0]
            .context.head;
        const key = (await this.posts.log.log.get(head))!.signatures[0]
            .publicKey;
        return key;
    }

    async getAlias(publicKey: PublicSignKey) {
        const alias = await this.alias.index.get(publicKey.bytes);
        return alias?.name;
    }

    async getMyPosts() {
        return this.posts.index.search(
            new SearchRequest({
                query: [
                    new ByteMatchQuery({
                        key: "author",
                        value: this.posts.node.identity.publicKey.bytes,
                    }),
                ],
            })
        );
    }
    async getAliases(alias: string): Promise<Alias[]> {
        return this.alias.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: alias,
                        method: StringMatchMethod.prefix,
                        caseInsensitive: true,
                    }),
                ],
            })
        );
    }

    async getPostsByAuthor(author: PublicSignKey) {
        return this.posts.index.search(
            new SearchRequest({
                query: [
                    new ByteMatchQuery({
                        key: "author",
                        value: author.bytes,
                    }),
                ],
            })
        );
    }
}

const allowCommitsFromSameSigners =
    (document: Documents<any>) => async (props: CanPerformOperations<any>) => {
        // allow all operations if the are signed by the same authors
        // i.e. for all the related commits ('next') the signatures should be the same
        const previousCommits = props.entry.meta.next;
        for (const commit of previousCommits) {
            const prevSignatures = (await document.log.log.get(commit))
                ?.signatures;
            if (!prevSignatures) {
                return false;
            }

            const currentSignatures = props.entry.signatures;

            // check that the new commit is signed by the same authors
            if (prevSignatures.length !== currentSignatures.length) {
                return false;
            }

            for (let i = 0; i < prevSignatures.length; i++) {
                if (
                    !currentSignatures.find((x) =>
                        x.publicKey.equals(prevSignatures[i].publicKey)
                    )
                ) {
                    return false;
                }
            }
        }

        return true;
    };
