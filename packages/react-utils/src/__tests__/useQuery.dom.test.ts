import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { Peerbit } from "peerbit";
import { field, variant } from "@dao-xyz/borsh";
import { Documents } from "@peerbit/document";
import { Program } from "@peerbit/program";
import React, { useEffect } from "react";
import { render, act, waitFor } from "@testing-library/react";
import { useQuery, UseQuerySharedOptions } from "../useQuery.js";
import sodium from "libsodium-wrappers";

// Minimal Post model and Program with Documents for integration-like tests
@variant(0)
class Post {
    @field({ type: "string" })
    id!: string;
    @field({ type: "string" })
    message!: string;
    constructor(props?: { id?: string; message?: string }) {
        if (!props) return; // borsh
        this.id = props.id ?? `${Date.now()}-${Math.random()}`;
        this.message = props.message ?? "";
    }
}

@variant("posts-db")
class PostsDB extends Program<{ replicate?: boolean }> {
    @field({ type: Documents })
    posts: Documents<Post>;
    constructor() {
        super();
        this.posts = new Documents<Post>();
    }
    async open(args?: { replicate?: boolean }): Promise<void> {
        await this.posts.open({
            type: Post,
            index: { type: Post },
            replicate: args?.replicate ? { factor: 1 } : false,
        });
    }
}

describe("useQuery (integration with Documents)", () => {
    let peerWriter: Peerbit;
    let peerReader: Peerbit;
    let dbWriter: PostsDB;
    let dbReader: PostsDB;
    let autoUnmount: undefined | (() => void);

    beforeEach(async () => {
        await sodium.ready;
        peerWriter = await Peerbit.create();
        peerReader = await Peerbit.create();
    });
    const setupConnected = async () => {
        await peerWriter.dial(peerReader);
        dbWriter = await peerWriter.open(new PostsDB(), {
            existing: "reuse",
            args: { replicate: true },
        });
        dbReader = await peerReader.open<PostsDB>(dbWriter.address, {
            args: { replicate: false },
        });
        // ensure reader knows about writer as replicator for the log
        await dbReader.posts.log.waitForReplicator(
            peerWriter.identity.publicKey
        );
    };

    const setupDisconnected = async () => {
        dbWriter = await peerWriter.open(new PostsDB(), {
            existing: "reuse",
            args: { replicate: true },
        });
        dbReader = await peerReader.open<PostsDB>(dbWriter.clone(), {
            args: { replicate: false },
        });
    };

    afterEach(async () => {
        // Unmount React trees before tearing down peers
        autoUnmount?.();
        autoUnmount = undefined;
        await peerWriter?.stop();
        await peerReader?.stop();
    });

    function renderUseQuery<R extends boolean | undefined>(
        db: PostsDB,
        options: UseQuerySharedOptions<Post, Post, R, Post>
    ) {
        const result: {
            current: {
                items: Post[];
                loadMore: (n?: number) => Promise<boolean>;
                isLoading: boolean;
                empty: () => boolean;
                id: string | undefined;
            };
        } = {} as any;

        function HookCmp({
            opts,
        }: {
            opts: UseQuerySharedOptions<Post, Post, R, Post>;
        }) {
            const hook = useQuery<Post, Post, R, Post>(db.posts, opts);
            useEffect(() => {
                result.current = hook;
            }, [hook]);
            return null;
        }

        const api = render(React.createElement(HookCmp, { opts: options }));
        const rerender = (opts: UseQuerySharedOptions<Post, Post, R, Post>) =>
            api.rerender(React.createElement(HookCmp, { opts }));
        let hasUnmounted = false;
        const doUnmount = () => {
            if (hasUnmounted) return;
            hasUnmounted = true;
            api.unmount();
            if (autoUnmount === doUnmount) {
                // clear outer reference if we still own it
                autoUnmount = undefined;
            }
        };
        // Expose to outer afterEach so tests don't need to remember calling unmount
        autoUnmount = doUnmount;
        return { result, rerender, unmount: doUnmount };
    }

    it("local query", async () => {
        await setupConnected();
        await dbWriter.posts.put(new Post({ message: "hello" }));
        const { result } = renderUseQuery(dbWriter, {
            query: {},
            resolve: true,
            local: true,
            prefetch: true,
        });
        await waitFor(() => expect(result.current?.items?.length ?? 0).toBe(1));

        await act(async () => {
            expect(result.current.items.length).toBe(1);
            expect(result.current.items[0].message).toBe("hello");
        });
    });

    it("respects remote warmup before iterating", async () => {
        await setupConnected();
        await dbWriter.posts.put(new Post({ message: "hello" }));

        const { result, rerender } = renderUseQuery(dbReader, {
            query: {},
            resolve: true,
            local: false,
            remote: { eager: true, warmup: 10_000 },
            prefetch: false,
            batchSize: 10,
        });

        await waitFor(() => {
            if (!result.current) throw new Error("no result yet");
            return true;
        });

        expect(result.current.items.length).toBe(0);

        await act(async () => {
            await result.current.loadMore();
        });

        expect(result.current.items.length).toBe(1);
        expect(result.current.items[0].message).toBe("hello");

        await act(async () => {
            rerender({
                query: {},
                resolve: true,
                local: true,
                remote: false,
                prefetch: false,
            });
            await result.current.loadMore();
        });
        await waitFor(() => expect(result.current.items.length).toBe(1));
    });

    it("honors remote.joining.waitFor by resolving after connection", async () => {
        // create isolated peers not connected yet
        await setupDisconnected();

        const { result } = renderUseQuery(dbReader, {
            query: {},
            resolve: true,
            local: false,
            remote: { eager: true, joining: { waitFor: 5_000 } },
            prefetch: true,
        });

        await waitFor(() => expect(result.current).toBeDefined());

        // Now connect and write

        await act(async () => {
            await dbReader.node.dial(dbWriter.node.getMultiaddrs());
            await dbWriter.posts.put(new Post({ message: "late" }));
            await dbReader.posts.log.waitForReplicator(
                dbWriter.node.identity.publicKey
            );
        });

        await waitFor(() => expect(result.current.items.length).toBe(1));
        expect(result.current.items[0].message).toBe("late");
    });
});
