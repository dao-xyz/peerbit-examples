import React, { createContext, useState, useContext, ReactNode } from "react";

interface OpenAIContextType {
    isAuthenticated: boolean;
    apiKey: string | null;
    login: (apiKey: string) => void;
    logout: () => void;
    queryAI: (prompt: string, contextText?: string) => Promise<string>;
}

const OpenAIContext = createContext<OpenAIContextType | undefined>(undefined);

export const OpenAIProvider = ({ children }: { children: ReactNode }) => {
    const [apiKey, setApiKey] = useState<string | null>(null);

    const login = (key: string) => {
        setApiKey(key);
        // Optionally: persist the API key (e.g., in localStorage)
    };

    const logout = () => {
        setApiKey(null);
    };

    // queryAI sends a request to OpenAI's completions endpoint.
    // It appends the optional context to the prompt if provided.
    const queryAI = async (
        prompt: string,
        contextText?: string
    ): Promise<string> => {
        if (!apiKey) {
            throw new Error("User is not authenticated with OpenAI.");
        }
        const fullPrompt = contextText ? `${contextText}\n${prompt}` : prompt;
        const response = await fetch("https://api.openai.com/v1/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "text-davinci-003", // or another model of your choice
                prompt: fullPrompt,
                max_tokens: 150,
                temperature: 0.7,
            }),
        });
        const data = await response.json();
        return data.choices[0]?.text?.trim() || "";
    };

    return (
        <OpenAIContext.Provider
            value={{
                isAuthenticated: !!apiKey,
                apiKey,
                login,
                logout,
                queryAI,
            }}
        >
            {children}
        </OpenAIContext.Provider>
    );
};

export const useOpenAI = () => {
    const context = useContext(OpenAIContext);
    if (!context) {
        throw new Error("useOpenAI must be used within an OpenAIProvider");
    }
    return context;
};
