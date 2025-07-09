import { deserialize } from "@dao-xyz/borsh";
import {
    BasicVisualization,
    Canvas,
    Element,
    Layout,
    LOWEST_QUALITY,
    Navigation,
    Purpose,
    StaticContent,
} from "./content.js";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { toId } from "@peerbit/document";
import { StaticMarkdownText } from "./static/text.js";

const ROOT_ID_SEED = new TextEncoder().encode("giga | place");

const ROOT_IDENTITY_DEVELOPMENT = deserialize(
    new Uint8Array([
        0, 0, 100, 171, 121, 177, 143, 132, 216, 160, 114, 206, 201, 210, 133,
        17, 161, 86, 242, 139, 211, 26, 91, 240, 38, 132, 155, 204, 167, 51, 69,
        114, 170, 211, 0, 4, 142, 151, 39, 126, 167, 96, 33, 175, 100, 38, 167,
        37, 133, 179, 14, 196, 158, 96, 228, 244, 241, 4, 115, 64, 172, 99, 30,
        2, 207, 129, 237,
    ]),
    Ed25519Keypair
);

const GIGA_ROOT_POST = `
### Welcome to Giga

A *public* and *private* media platform owned by you
`;

const rootDevelopment = new Canvas({
    seed: ROOT_ID_SEED,
    publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
});

const rootFeedDevelopment = (parent: Canvas) =>
    new Canvas({
        seed: sha256Sync(ROOT_ID_SEED),
        publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
        parent,
    });

const addText = async (peer: ProgramClient, canvas: Canvas, text: string) => {
    let rootElementId = new Uint8Array(canvas.id);
    if (
        await canvas.elements.index.get(toId(rootElementId), {
            local: true,
            remote: {
                eager: true,
            },
        })
    ) {
        return;
    }
    return canvas.createElement(
        new Element({
            location: Layout.zero(),
            id: rootElementId,
            publicKey: peer.identity.publicKey,
            content: new StaticContent({
                content: new StaticMarkdownText({
                    text,
                }),
                quality: LOWEST_QUALITY,
                contentId: sha256Sync(new TextEncoder().encode(text)),
            }),
            canvasId: canvas.id,
        })
    );
};

export const createRoot = (
    peer: ProgramClient,
    persisted?: boolean
): Promise<Canvas> => {
    return peer
        .open(rootDevelopment.clone(), {
            existing: "reuse",
            args: {
                replicate: persisted,
            },
        })
        .then(async (result) => {
            await addText(peer, result, GIGA_ROOT_POST);
            const rootFeedCanvas = rootFeedDevelopment(result);
            const rootFeedExisting = await result.replies.index.get(
                toId(rootFeedCanvas.id),
                {
                    local: true,
                    remote: {
                        eager: true,
                    },
                }
            );

            const rootFeed = rootFeedExisting || rootFeedCanvas;
            await peer.open(rootFeed, {
                existing: "reuse",
                args: {
                    replicate: persisted,
                },
            });

            if (!rootFeedExisting) {
                await result.replies.put(rootFeed);
                await rootFeed.load();
                await rootFeed.setType(
                    new Purpose({
                        canvasId: rootFeed.id,
                        type: new Navigation({}),
                    })
                );

                await addText(peer, rootFeed, "Feed");
            }
            return result;
        });
};
