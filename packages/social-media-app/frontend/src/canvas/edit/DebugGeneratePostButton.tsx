import { usePeer } from "@peerbit/react";
import { VscDebug } from "react-icons/vsc";
import { useCanvases } from "../useCanvas";
import {
    Canvas,
    Element,
    ElementContent,
    IFrameContent,
    Layout,
    LOWEST_QUALITY,
    StaticContent,
    StaticImage,
    StaticMarkdownText,
} from "@giga-app/interface";
import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { MOCK_TEXTS } from "./MockTexts";
/**
 * Returns one of the pre‑written markdown snippets
 */
const getSampleMarkdown = (): string => {
    let text = MOCK_TEXTS[Math.floor(Math.random() * MOCK_TEXTS.length)];
    return text.trim();
};

export const DebugGeneratePostButton = () => {
    const { leaf, path } = useCanvases();
    const { peer } = usePeer();

    const fetchImageFromUrl = async (
        url: string | undefined,
        options?: { width: number; height: number }
    ) => {
        const definedUrl =
            url ||
            `https://picsum.photos/${options?.width ?? 200}/${
                options?.height ?? 300
            }`;
        const response = await fetch(definedUrl);
        // Convert the response to an ArrayBuffer then to a Uint8Array.
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);
        return new StaticImage({
            data,
            height: options?.height ?? 300,
            width: options?.width ?? 200,
            mimeType: "image/jpeg",
            alt: "Debug image",
            caption: "",
        });
    };

    const insertPostsForDebugging = async () => {
        type PostContent = "image" | "text" | "twitch";
        const postsToCreate: (PostContent[] | PostContent)[] = [
            "image",
            ["text"], // ["twitch", "text"],
            ["image", "text"],
            ["image", "image"],
            "text",
        ];

        for (const [px, type] of postsToCreate.entries()) {
            let publicKeyTuse =
                px % 2 === 0
                    ? peer.identity.publicKey
                    : (await Ed25519Keypair.create()).publicKey;

            const typeArray = Array.isArray(type) ? type : [type];
            // Create a post (canvas) that references its parent.
            const canvas = new Canvas({
                publicKey: publicKeyTuse,
            });

            // Open the canvas so we can insert elements.
            const openCanvas = await leaf.nearestScope.openWithSameSettings(
                canvas
            );

            for (const [ix, type] of typeArray.entries()) {
                let mockContent: ElementContent;
                if (type === "image") {
                    mockContent = new StaticContent({
                        content: await fetchImageFromUrl(undefined, {
                            width: 200,
                            height: 300,
                        }),
                        contentId: randomBytes(32),
                        quality: LOWEST_QUALITY,
                    });
                } else if (type === "text") {
                    mockContent = new StaticContent({
                        content: new StaticMarkdownText({
                            text: getSampleMarkdown(),
                        }),
                        contentId: randomBytes(32),
                        quality: LOWEST_QUALITY,
                    });
                } else if (type === "twitch") {
                    mockContent = new IFrameContent({
                        resizer: false,
                        src: "https://player.twitch.tv/?channel=freecodecamp&parent=localhost",
                    });
                }

                await openCanvas.elements.put(
                    new Element({
                        content: mockContent,
                        location: new Layout({
                            x: 0,
                            y: ix,
                            z: 0,
                            w: 0,
                            h: 0,
                            breakpoint: "md",
                        }),
                        publicKey: peer.identity.publicKey,
                        canvasId: openCanvas.id,
                    })
                );
            }

            // Last step – add this post as a reply to the parent.
            await leaf.upsertReply(openCanvas);
        }
    };

    return (
        <button
            onClick={insertPostsForDebugging}
            className="btn btn-icon-md p-2"
        >
            <VscDebug size={25} />
        </button>
    );
};
