import React, { createContext, useContext, useState } from "react";
import {
    Canvas,
    Element,
    getOwnedElementsQuery,
    getSubownedElementsQuery,
    getTextElementsQuery,
    StaticContent,
    StaticMarkdownText,
} from "@dao-xyz/social";
import { WithContext } from "@peerbit/document";
import { useLLM } from "./LLMContext"; // adjust path as needed
import { useReplyProgress } from "../canvas/useReplyProgress";
import { Ed25519Keypair } from "@peerbit/crypto";

// We assume each Canvas has a unique string identifier (e.g. canvas.id)
interface AiReplyContextType {
    generateReply: (canvas: Canvas) => Promise<string>;
    // A map of canvas ids to a loading flag
    loadingMap: Record<string, boolean>;
}

const BOT_IDENTITY = await Ed25519Keypair.create();

const AiReplyContext = createContext<AiReplyContextType | undefined>(undefined);

export const AiReplyProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const { query } = useLLM();
    const { announceReply } = useReplyProgress();

    // Use an object mapping canvas IDs to loading booleans.
    const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});

    // Helper to format an element's text and owner.
    const createContextFromElement = (
        element: WithContext<Element<StaticContent<StaticMarkdownText>>>
    ) => {
        const text = element.content.content.text.replace(/"/g, '\\"');
        return `{ owner: ${element.publicKey.hashcode()}, content: "${text}" }`;
    };

    // The generateReply method takes a canvas instance, builds aggregated context,
    // and then queries the AI using the global LLM query function.
    const generateReply = async (canvas: Canvas): Promise<string> => {
        // Assume canvas.id exists and is a unique string.
        const canvasId = canvas.address;
        try {
            // Mark this canvas as loading.
            setLoadingMap((prev) => ({ ...prev, [canvasId]: true }));

            // Retrieve sibling posts (subowned elements).
            const siblingElements = await canvas.elements.index
                .iterate({
                    query: [
                        ...getSubownedElementsQuery(canvas),
                        getTextElementsQuery(),
                    ],
                })
                .all();

            const siblingTexts = siblingElements.map((x) =>
                createContextFromElement(
                    x as WithContext<Element<StaticContent<StaticMarkdownText>>>
                )
            );

            // Retrieve parent posts (owned elements).
            const parentElements = await canvas.elements.index
                .iterate({
                    query: [
                        ...getOwnedElementsQuery(canvas),
                        getTextElementsQuery(),
                    ],
                })
                .all();

            const parentTexts = parentElements.map((x) =>
                createContextFromElement(
                    x as WithContext<Element<StaticContent<StaticMarkdownText>>>
                )
            );

            // Build the aggregated context string.
            let aggregatedContext = "";
            if (parentTexts.length > 0) {
                aggregatedContext +=
                    "Parent Posts:\n" + parentTexts.join("\n") + "\n";
            }
            if (siblingTexts.length > 0) {
                aggregatedContext +=
                    "\nSibling Posts:\n" + siblingTexts.join("\n") + "\n";
            }

            // Compose the prompt with context instructions.
            const promptText = `
You are a social media assistant. Based on the conversation thread below, generate a thoughtful and engaging reply that continues the discussion appropriately. Try to keep it concise and relevant. For example if the users ask what 1+1 is, you can say "2". If the users are discussing a topic, you can add your own opinion or ask a question to keep the conversation going. Assume the reader have really short attention span and so if you are not precise, they will not read your answer.

${aggregatedContext}

Reply:
      `.trim();

            const aiResponse = await query(promptText);
            // after the </think> tag the actual response starts
            return aiResponse.split("</think>")[1].trim();
        } catch (error) {
            console.error("Error generating AI reply:", error);
            return "";
        } finally {
            // Clear the loading flag for this canvas.
            setLoadingMap((prev) => ({ ...prev, [canvasId]: false }));
        }
    };

    return (
        <AiReplyContext.Provider value={{ generateReply, loadingMap }}>
            {children}
        </AiReplyContext.Provider>
    );
};

export const useAiReply = (): AiReplyContextType => {
    const context = useContext(AiReplyContext);
    if (!context) {
        throw new Error("useAiReply must be used within an AiReplyProvider");
    }
    return context;
};
