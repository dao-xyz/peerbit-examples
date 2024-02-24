import { Alias, BlogPosts, Post } from "@peerbit/blog-sdk";
import { Peerbit } from "peerbit";
import editor from "@inquirer/editor";
import select from "@inquirer/select";
import input from "@inquirer/input";

import { Ed25519PublicKey } from "@peerbit/crypto";

export const start = async () => {
    const client = await Peerbit.create();
    const blogPosts = await client.open(new BlogPosts());

    let myAlias = await blogPosts.getAlias(client.identity.publicKey);
    if (myAlias) {
        console.log(`Welcome back ${myAlias}`);
    } else {
        console.log("Welcome to the blog platform");
    }

    const startCLI = () => {
        select(
            {
                message: "What would you like to do?",
                choices: [
                    {
                        name: "Post feed",
                        description: "View others posts",
                        value: "Post feed",
                    },
                    {
                        name: "Posts by author",
                        description: "Get posts by a specific author",
                        value: "Posts by author",
                    },
                    {
                        name: "Search for posts",
                        description: "Search for posts by their content",
                        value: "Search for posts",
                    },
                    {
                        name: "Create a new post",
                        description: "Create a new post",
                        value: "Create a new post",
                    },
                    {
                        name: "Manage posts",
                        description: "Edit or delete your posts",
                        value: "Manage posts",
                    },

                    {
                        name: "Set name",
                        description: "Set an alias for your public key",
                        value: "Set name",
                    },
                    {
                        name: "Exit",
                        description: "Exit",
                        value: "Exit",
                    },
                ],
            },
            { clearPromptOnDone: true }
        ).then(async (answers) => {
            if (answers === "Create a new post") {
                // prompt the user for the title and content of the post
                // when writing the content allow the user to use the enter key normally for new lines
                const title = await input({
                    message: "Enter the title of the post",
                });

                const content = await editor({
                    message: "Write the content of the post",
                });

                // create a new post
                const postObject = new Post({
                    title,
                    content,
                });

                // put post to the network
                await blogPosts.posts.put(postObject);

                console.log("Post created successfully: ", postObject.id);

                // go back
                startCLI();
            } else if (answers === "Posts by author") {
                const author = await input({
                    message: "Enter the author's alias",
                });

                const aliases = await blogPosts.getAliases(author);

                // select a public key from the list to read posts from
                const authorChoices: { name: string; value: "back" | Alias }[] =
                    await Promise.all(
                        aliases.map(async (alias) => {
                            return {
                                name:
                                    alias.name +
                                    " " +
                                    (
                                        await (
                                            alias.publicKey as Ed25519PublicKey
                                        ).toPeerId()
                                    ).toString(),
                                value: alias,
                            };
                        })
                    );

                authorChoices.push({ name: "Back", value: "back" });

                const result = await select({
                    message:
                        aliases.length > 0
                            ? "Select an author to read posts from"
                            : "No authors found",
                    choices: authorChoices,
                });

                if (result === "back") {
                    startCLI();
                    return;
                }

                const authorAlias: Alias = result;

                const posts = await blogPosts.getPostsByAuthor(
                    authorAlias.publicKey
                );
                await readPosts(posts, startCLI);
            } else if (answers === "Search for posts") {
                // prompt the user for a search query
                const search = await input({
                    message: "Enter the search query",
                });
                // search for posts with the search query
                const results = await blogPosts.searchContent(search);

                // if we got results show them
                readPosts(results, startCLI);
            } else if (answers === "Manage posts") {
                // show all my posts

                const myPosts = await blogPosts.getMyPosts();
                manageMyPosts(myPosts);
            } else if (answers === "Post feed") {
                const iterator = await blogPosts.getLatestPostsIterator();

                // use inquirer to show the posts in a list
                // the last two options allow the user either load more or go back to previous menu

                const showPage = async (posts?: Post[]) => {
                    const currentPosts = posts ?? (await iterator.next(10));

                    const postChoices: {
                        name: string;
                        value: "back" | "load" | Post;
                    }[] = currentPosts.map((post) => {
                        return {
                            name: post.title,
                            value: post,
                        };
                    });

                    if (postChoices.length > 0 && iterator.done() == false) {
                        postChoices.push({ name: "Load more", value: "load" });
                    }

                    postChoices.push({ name: "Back", value: "back" });
                    const result = await select({
                        message:
                            currentPosts.length === 0
                                ? "No more posts"
                                : "Select a post to read",
                        choices: postChoices,
                    });

                    if (result === "back") {
                        startCLI();
                    } else if (result === "load") {
                        showPage();
                    } else {
                        const post: Post = result;
                        readPost(post, () => showPage(currentPosts));
                    }
                };

                showPage();
            } else if (answers === "Set name") {
                // show current alias in italic if exist, else show None in normal font
                if (myAlias != null) {
                    console.log("\x1b[3m%s\x1b[0m", `Current name: ${myAlias}`);
                } else {
                    console.log("You don't have a name set yet");
                }

                const name = await input({
                    message: "Enter your name",
                });

                await blogPosts.alias.put(
                    new Alias({
                        name: name as string,
                        publicKey: client.identity.publicKey,
                    })
                );
                myAlias = await blogPosts.getAlias(client.identity.publicKey);
                console.log(("Name set successfully to: " + myAlias) as string);
                startCLI();
            } else if (answers === "Exit") {
                process.exit();
            }
        });
    };

    const readPosts = async (posts: Post[], back = startCLI) => {
        const postChoicesFn = async () => {
            const postChoices: { name: string; value: "back" | Post }[] =
                posts.map((post) => {
                    return {
                        name: post.title,
                        value: post,
                    };
                });
            postChoices.push({ name: "Back", value: "back" });
            const result = await select({
                message:
                    posts.length > 0
                        ? "Select a post to read"
                        : "No posts found",
                choices: postChoices,
            });
            if (result === "back") {
                return back();
            } else {
                const post: Post = result;
                return readPost(post, postChoicesFn);
            }
        };
        return postChoicesFn();
    };

    const readPost = async (post: Post, back = startCLI) => {
        // show post title in a bold and colored font
        console.log("");
        console.log("\x1b[1m\x1b[36m%s\x1b[0m", post.title);

        // show author and date in italic font
        const author = await blogPosts.getPostAuthor(post.id);
        console.log(
            "\x1b[3m%s\x1b[0m",
            `By ${(
                (await blogPosts.getAlias(author)) ||
                (await (author as Ed25519PublicKey).toPeerId())
            ).toString()} on ${await blogPosts.getPostDate(post.id)}`
        );

        console.log("");

        // show post content after newline
        console.log(post.content);

        console.log("");
        // when the user presses enter, go back to the menu
        await input({
            message: "Press any key to go back",
        });
        return back();
    };

    const manageMyPosts = async (results: Post[], back = startCLI) => {
        if (results.length === 0) {
            console.log("No posts found");
            startCLI();
            return;
        }

        const postChoices: { name: string; value: "back" | Post }[] =
            results.map((post) => {
                return {
                    name: post.title,
                    value: post,
                };
            });
        postChoices.push({ name: "Back", value: "back" });

        const result = await select({
            message: "Select a post to read or edit",
            choices: postChoices,
        });

        if (result === "back") {
            return back();
        } else {
            const post: Post = result;

            // show ui to edit or delete post
            const action = await select({
                message: "What would you like to do?",
                choices: ["Edit", "Delete", "Back"].map((x) => {
                    return { name: x, value: x };
                }),
            });

            if (action === "Edit") {
                // prompt the user for the title and content of the post
                // when writing the content allow the user to use the enter key normally for new lines
                const title = await input({
                    message: "Enter the title of the post",
                    default: post.title,
                });

                const content = await editor({
                    message: "Write the content of the post",
                    default: post.content,
                });

                // create a new post
                const postObject = new Post({
                    id: post.id,
                    title,
                    content,
                });

                // put post to the network
                await blogPosts.posts.put(postObject);

                console.log("Post updated successfully: ", postObject.id);

                // go back
                return back();
            } else if (action === "Delete") {
                await blogPosts.posts.del(post.id);
                console.log("Post deleted successfully");
                return back();
            } else if (action === "Back") {
                return manageMyPosts(results);
            }
        }
    };
    return startCLI();
};
