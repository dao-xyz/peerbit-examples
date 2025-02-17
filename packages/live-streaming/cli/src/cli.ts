import { MediaStreamDBs } from "@peerbit/video-lib";
import { Peerbit } from "peerbit";
import select from "@inquirer/select";
import { toBase64 } from "@peerbit/crypto";
import path from "path";
import os from "os";
import fs from "fs";
import events from "events";
events.setMaxListeners(100);

const dotsIfLongerThan = (string: string, length: number) => {
    if (string.length > length) {
        return string.slice(0, length) + "...";
    }
    return string;
};

export const start = async (directory?: string | null) => {
    // if directoy is not provided open in a default directory
    if (directory === undefined) {
        // if directory is null we dont want to use persistance
        const homeDir = os.homedir();

        // check if the blog-platform directory exists
        directory = path.join(homeDir, "peerbit-video-replicator");
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    }

    console.log(
        "Starting video replicator" +
            (directory ? ` in directory ${directory}` : "")
    );

    const client = await Peerbit.create({ directory: directory ?? undefined });

    // if local env arg then bootstrap to local node, else global

    if (process.argv.includes("--local")) {
        await client.dial(
            "/ip4/127.0.0.1/tcp/8002/ws/p2p/" +
                (await (await fetch("http://localhost:8082/peer/id")).text())
        );
    } else {
        await client.bootstrap();
    }

    const streams = await client.open<MediaStreamDBs>(new MediaStreamDBs(), {
        args: {
            replicate: true,
        },
    });

    const startCLI = () => {
        select(
            {
                message: "What would you like to do?",
                choices: [
                    {
                        name: "List seeded streams",
                        description: "Information about seeding activities",
                        value: "List seeded streams",
                    },
                ],
            },
            { clearPromptOnDone: true }
        ).then(async (answers) => {
            if (answers === "List seeded streams") {
                const allMediaStreamDBs = await streams.mediaStreams.index
                    .iterate({}, { local: true, remote: false })
                    .all();

                if (allMediaStreamDBs.length === 0) {
                    console.log("No seeded streams found");
                } else {
                    for (const stream of allMediaStreamDBs) {
                        console.log("");
                        console.log(
                            "\x1b[1m\x1b[36m%s\x1b[0m",
                            "Media container id: " + toBase64(stream.id)
                        );

                        let tracks = await stream.tracks.index
                            .iterate({}, { local: true, remote: false })
                            .all();

                        for (const track of tracks) {
                            const chunkCount =
                                await track.source.chunks.index.getSize();
                            console.log(
                                "\x1b[3m%s\x1b[0m",
                                `${track.toString()} (${chunkCount} chunks)`
                            );
                        }
                    }
                }
                // go back
                startCLI();
            }
        });
    };
    return startCLI();
};
