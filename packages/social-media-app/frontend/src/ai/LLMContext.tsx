import React, { createContext, useContext, ReactNode, useEffect } from "react";
import { AIResponseProgram, DEEP_SEEK_R1 } from "@giga-app/llm";
import { useProgram } from "@peerbit/react";

export type LLMContextType = {
    /**
     * Sends a prompt to the AI and returns the assistant's response.
     */
    query: (prompt: string, timeout?: number) => Promise<string>;

    /**
     * Indicates whether the LLM program is ready to accept queries.
     */
    isReady: boolean;
};

// Create a context with undefined default.
const LLMContext = createContext<LLMContextType | undefined>(undefined);

type LLMProviderProps = {
    children: ReactNode;
};

export const LLMProvider = ({ children }: LLMProviderProps) => {
    // Use the Peerbit hook to open the program.
    const { program } = useProgram(new AIResponseProgram(), {
        existing: "reuse",
    });

    const [isReady, setIsReady] = React.useState(false);

    useEffect(() => {
        if (!program || program.closed) {
            return;
        }
        program
            .waitForModel(DEEP_SEEK_R1)
            .then(() => {
                setIsReady(true);
            })
            .catch((error) => {
                console.log("Model not available", error);
                setIsReady(false);
            });
    }, [!program || program?.closed ? undefined : program.address]);

    // Define the query function that calls the program's query method.
    const query = async (prompt: string, timeout = 10000): Promise<string> => {
        if (!program) {
            throw new Error("LLM program is not available");
        }
        const response = await program.query(prompt, { timeout });
        return response?.response || "";
    };

    // You might want to handle loading/error state here in your provider.
    // For simplicity, we assume program is ready.
    return (
        <LLMContext.Provider value={{ query, isReady }}>
            {children}
        </LLMContext.Provider>
    );
};

// Custom hook to access the LLM context.
export const useLLM = (): LLMContextType => {
    const context = useContext(LLMContext);
    if (!context) {
        throw new Error("useLLM must be used within a LLMProvider");
    }
    return context;
};
