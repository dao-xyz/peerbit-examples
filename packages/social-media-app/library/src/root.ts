import { deserialize } from "@dao-xyz/borsh";
import { Canvas, Scope, ChildVisualization } from "./content.js";
import { Ed25519Keypair, sha256Sync } from "@peerbit/crypto";
import { ProgramClient } from "@peerbit/program";
import { concat } from "uint8arrays";
import { ViewKind } from "./link.js";
import { orderKeyBetween } from "./order-key.js";

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

// ————————— helpers —————————

export const createRootScope = () =>
    new Scope({
        publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
        seed: ROOT_ID_SEED,
    });

export const createRootCanvas = () =>
    new Canvas({
        seed: ROOT_ID_SEED,
        publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
        // no selfScope: it will inherit from getOrCreateReply(this)
    });

const createSection = (seed: string) =>
    new Canvas({
        seed: new TextEncoder().encode(seed),
        publicKey: ROOT_IDENTITY_DEVELOPMENT.publicKey,
        // no selfScope here either
    });

// ————————— main —————————

export const createRoot = async (
    peer: ProgramClient,
    options?: {
        scope?: Scope;
        persisted?: boolean;
        sections?: string[];
    }
): Promise<{ scope: Scope; canvas: Canvas }> => {
    const rootScope = await peer.open(options?.scope || createRootScope(), {
        existing: "reuse",
        args: { replicate: options?.persisted ? { factor: 1 } : false },
    });

    // Create (or reuse) the root canvas inside rootScope.
    // getOrCreateReply will:
    //  • inherit home => selfScope = rootScope (since draft had none)
    //  • insert into rootScope.replies
    const [_, rootCanvas] = await rootScope.getOrCreateReply(
        null,
        createRootCanvas()
    );

    // Idempotent intro text
    await rootCanvas.addTextElement(GIGA_ROOT_POST, {
        id: sha256Sync(
            concat([rootCanvas.id, new TextEncoder().encode(GIGA_ROOT_POST)])
        ),
    });

    // Optional sections
    if (options?.sections?.length) {
        // compute sequential orderKeys using orderKeyBetween
        let prevKey: string | undefined = undefined;

        for (const section of options.sections) {
            const sectionDraft = createSection(section);

            // link-only in same scope (rootScope); visibility defaults to "both"
            // Also set the children visualization for the section node.
            const orderKey = orderKeyBetween(prevKey, undefined);

            const [created, sectionNode] = await rootCanvas.upsertReply(
                sectionDraft,
                {
                    // same-scope => link-only is implied; no mode needed
                    kind: new ViewKind({ orderKey }),
                    view: ChildVisualization.OUTLINE,
                    type: "sync",
                }
            );

            if (created) {
                await sectionNode.addTextElement(section, {
                    id: sha256Sync(
                        concat([
                            sectionNode.id,
                            new TextEncoder().encode(section),
                        ])
                    ),
                });
            }

            prevKey = orderKey;
        }
    }

    return { canvas: rootCanvas, scope: rootScope };
};
