import express, { Request, Response } from "express";
import { Peerbit } from "peerbit";
import { BlogPosts, Post } from "@peerbit/blog-sdk";
import bodyParser from "body-parser";
import { PostJSON } from "./types.js";

export const start = async (port = 7654) => {
    const client = await Peerbit.create();
    await client.bootstrap();
    const posts = await client.open(new BlogPosts());
    const app = express();
    app.use(bodyParser.json());

    // endpoint to post a post
    app.post("/posts", (req: Request<Post>, res: Response) => {
        const post = new Post({
            ...req.body,
            author: req.body.author || client.identity.publicKey,
        });
        posts.posts
            .put(post)
            .then(() => {
                res.status(200).send({ id: post.id });
            })
            .catch((err) => {
                res.status(500).send(err);
            });
    });

    // endpoint for getting a post with an id
    app.get("/posts/:id", async (req: Request, res: Response) => {
        try {
            const post = await posts.posts.index.get(req.params.id);
            if (!post) {
                res.status(404).send();
                return;
            }
            const postJSON = await PostJSON.from(posts, post);
            res.status(200).send(postJSON);
        } catch (error) {
            res.status(500).send(error);
        }
    });

    // endpoint for searching posts using string match with a search query paramter q
    app.get("/search", async (req: Request, res: Response) => {
        // if no query is provided, return 10 latest posts
        const size = Number(req.query.size) || 10;
        try {
            let results: Post[];
            if (!req.query.q) {
                results = await posts.getLatestPosts(size);
            } else {
                results = await posts.searchContent(
                    req.query.q as string,
                    size
                );
            }
            res.send(
                await Promise.all(
                    results.map((result) => PostJSON.from(posts, result))
                )
            );
        } catch (error) {
            res.status(500).send(error);
        }
    });

    // endpoint for deleting a post with an id
    app.delete("/posts/:id", (req: Request, res: Response) => {
        posts.posts
            .del(req.params.id)
            .then(() => {
                res.status(200).send();
            })
            .catch((err) => {
                res.status(500).send(err);
            });
    });

    const server = app.listen(port, () => {
        console.log(`Blogplatform server node listening on port: ${port}`);
    });

    return {
        close: async () => {
            // TODO better error handling
            let err: any;
            try {
                server.close();
            } catch (error) {
                err = error;
            }
            try {
                await client.stop();
            } catch (error) {
                err = error;
            }
            if (err) {
                throw err;
            }
        },
    };
};
