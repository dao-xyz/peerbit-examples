import { usePeer } from "@peerbit/react";
import { VscDebug } from "react-icons/vsc";
import { useCanvases } from "../useCanvas";
import {
    Canvas,
    CanvasAddressReference,
    Element,
    Layout,
    StaticContent,
    StaticImage,
    StaticMarkdownText,
} from "@dao-xyz/social";
import { Ed25519Keypair } from "@peerbit/crypto";

const generateATextInMarkdown = (length: number = 100) => {
    let text = "";
    // Decide randomly if we will use markdown formatting.
    const useMarkdown = Math.random() < 0.5;

    // List of realistic titles that people might actually write.
    const titles = [
        "Debugging Session",
        "Bug Report",
        "Test Output",
        "Development Log",
        "Error Analysis",
        "Application Crash Report",
        "Code Debugging Summary",
        "Issue Investigation",
    ];

    // Optionally add a realistic markdown heading.
    if (useMarkdown) {
        const title = titles[Math.floor(Math.random() * titles.length)];
        text += `# ${title}\n\n`;
    }

    // Array of sample words for pseudo text.
    const words = [
        "lorem",
        "ipsum",
        "dolor",
        "sit",
        "amet",
        "consectetur",
        "adipiscing",
        "elit",
        "debug",
        "message",
        "code",
        "example",
        "function",
        "variable",
    ];

    // Build text until it reaches the desired length.
    while (text.length < length) {
        // Pick a random word.
        let word = words[Math.floor(Math.random() * words.length)];

        // If markdown is enabled, randomly apply formatting.
        if (useMarkdown) {
            const formatChance = Math.random();
            if (formatChance < 0.3) {
                word = `**${word}**`; // Bold formatting.
            } else if (formatChance < 0.6) {
                word = `*${word}*`; // Italic formatting.
            }
        }

        text += word + " ";
    }
    return text.trim();
};

export const DebugGeneratePostButton = () => {
    const { leaf, path } = useCanvases();
    const { peer } = usePeer();

    const fetchImageFromUrl = async (
        url: string | undefined,
        options?: { width: number; height: number }
    ) => {
        let definedUrl = url
            ? url
            : `https://picsum.photos/${options.width ?? 200}/${
                  options.height ?? 300
              }`;
        const image = await fetch(definedUrl).then((response) =>
            response.blob()
        );
        const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve(reader.result as string);
            };
            reader.readAsDataURL(image);
        });
        return new StaticImage({
            base64: base64.split(",")[1],
            height: options.height ?? 300,
            width: options.width ?? 200,
            mimeType: "image/jpeg",
        });
    };

    const insertPostsForDebugging = async () => {
        type PostContent = "image" | "text";
        const postsToCreate: (PostContent[] | PostContent)[] = [
            "image",
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
            // create a post (canvas) that references its parent
            const canvas = new Canvas({
                parent: new CanvasAddressReference({
                    canvas: path[path.length - 1],
                }),
                publicKey: publicKeyTuse,
            });

            // open it (so we can insert elements)
            const openCanvas = await peer.open(canvas, { existing: "reuse" });

            for (const [ix, type] of typeArray.entries()) {
                let mockContent: StaticContent;
                if (type === "image") {
                    mockContent = new StaticContent({
                        content: await fetchImageFromUrl(undefined, {
                            width: 200,
                            height: 300,
                        }),
                    });
                } else {
                    mockContent = new StaticContent({
                        content: new StaticMarkdownText({
                            text: generateATextInMarkdown(
                                Math.round(Math.max(Math.random() * 200, 10))
                            ),
                        }),
                    });
                }

                openCanvas.elements.put(
                    new Element({
                        content: mockContent,
                        location: [
                            new Layout({
                                x: 0,
                                y: ix,
                                z: 0,
                                w: 0,
                                h: 0,
                                breakpoint: "md",
                            }),
                        ],
                        publicKey: publicKeyTuse,
                    })
                );
            }

            // last step - add this post as a reply to the parent

            console.log(leaf.closed);
            leaf.replies.put(openCanvas);
        }
    };

    return (
        <button
            onClick={insertPostsForDebugging}
            className="btn btn-elevated btn-icon-md"
        >
            <VscDebug size={25} />
        </button>
    );
};
