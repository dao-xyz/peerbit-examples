import { deserialize } from "@dao-xyz/borsh";
import { Canvas, ChildVisualization } from "./content.js";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { toId } from "@peerbit/document";
import { concat } from "uint8arrays";

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

const createSection = (parent: Canvas, seed: string) =>
    new Canvas({
        seed: new TextEncoder().encode(seed),
        publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
        parent,
    });

export const createRoot = (
    peer: ProgramClient,
    options?: {
        persisted?: boolean;
        sections?: string[];
    }
): Promise<Canvas> => {
    return peer
        .open(rootDevelopment.clone(), {
            existing: "reuse",
            args: {
                replicate: options?.persisted,
            },
        })
        .then(async (result) => {
            await result.addTextElement({
                id: sha256Sync(
                    concat([
                        result.id,
                        new TextEncoder().encode(GIGA_ROOT_POST),
                    ])
                ),

                text: GIGA_ROOT_POST,
            });

            // await result.setMode('narrative'); not needed, for the root

            if (options?.sections) {
                for (const section of options.sections) {
                    const sectionCanvasNew = createSection(result, section);
                    const sectionCanvasExisting =
                        await result.replies.index.get(
                            toId(sectionCanvasNew.id),
                            {
                                local: true,
                                remote: {
                                    eager: true,
                                },
                            }
                        );

                    const sectionCanvas =
                        sectionCanvasExisting || sectionCanvasNew;

                    await peer.open(sectionCanvas, {
                        existing: "reuse",
                        args: {
                            replicate: options?.persisted,
                        },
                    });

                    if (!sectionCanvasExisting) {
                        await result.replies.put(sectionCanvas);
                        await sectionCanvas.load();
                        await result.setChildPosition(sectionCanvas.id, 1);
                        await sectionCanvas.setExperience(
                            ChildVisualization.TREE
                        );

                        await sectionCanvas.addTextElement({
                            id: sha256Sync(
                                concat([
                                    sectionCanvas.id,
                                    new TextEncoder().encode(section),
                                ])
                            ),
                            text: section,
                        });
                    }
                }
            }

            return result;
        });
};
