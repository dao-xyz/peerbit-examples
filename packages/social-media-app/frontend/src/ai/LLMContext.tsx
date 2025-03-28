import React, { createContext, useContext, ReactNode } from "react";
import { AIResponseProgram } from "@giga-app/llm";
import { useProgram } from "@peerbit/react";

export type LLMContextType = {
    /**
     * Sends a prompt to the AI and returns the assistant's response.
     */
    query: (prompt: string, timeout?: number) => Promise<string>;
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
        <LLMContext.Provider value={{ query }}>{children}</LLMContext.Provider>
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
