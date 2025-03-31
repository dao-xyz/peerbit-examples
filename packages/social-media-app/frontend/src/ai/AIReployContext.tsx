import React, { createContext, useContext, ReactNode, useEffect } from "react";
import { CanvasAIReply } from "@giga-app/llm";
import { useProgram } from "@peerbit/react";
import { Canvas } from "@giga-app/interface";

export type AIReplyContext = {
    /**
     * Sends a prompt to the AI and returns the assistant's response.
     */
    request: (canvas: Canvas, timeout?: number) => Promise<void>;

    /**
     * Indicates whether the LLM program is ready to accept queries.
     */
    isReady: boolean;
};

// Create a context with undefined default.
const AIReplyContext = createContext<AIReplyContext | undefined>(undefined);

type AIReplyMProviderProps = {
    children: ReactNode;
};

export const AIReplyProvider = ({ children }: AIReplyMProviderProps) => {
    // Use the Peerbit hook to open the program.
    const { program } = useProgram(new CanvasAIReply(), {
        existing: "reuse",
    });

    const [isReady, setIsReady] = React.useState(false);

    useEffect(() => {
        if (!program || program.closed) {
            return;
        }
        program
            .waitForModel()
            .then(() => {
                setIsReady(true);
            })
            .catch((error) => {
                console.log("Model not available", error);
                setIsReady(false);
            });
    }, [!program || program?.closed ? undefined : program.address]);

    // Define the query function that calls the program's query method.
    const query = async (canvas: Canvas, timeout = 10000): Promise<void> => {
        if (!program) {
            throw new Error("LLM program is not available");
        }
        await program.query(canvas, { timeout });
    };

    // You might want to handle loading/error state here in your provider.
    // For simplicity, we assume program is ready.
    return (
        <AIReplyContext.Provider value={{ request: query, isReady }}>
            {children}
        </AIReplyContext.Provider>
    );
};

// Custom hook to access the LLM context.
export const useAIReply = (): AIReplyContext => {
    const context = useContext(AIReplyContext);
    if (!context) {
        throw new Error("useLLM must be used within a LLMProvider");
    }
    return context;
};
