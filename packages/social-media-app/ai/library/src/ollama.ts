import ollama from "ollama"; // For Node; use "ollama/browser" if needed
import { DEEP_SEEK_R1_7b } from "./model.js";

/**
 * queryOllama sends a prompt to the locally running Ollama API.
 * @param {string} prompt - The prompt to send.
 * @param {string} [model="deepseek-r1:1.5b"] - The model to use.
 * @returns {Promise<string>} The assistant's response.
 */
export const queryOllama = async (prompt, model = DEEP_SEEK_R1_7b) => {
    try {
        const response = await ollama.chat({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
        });

        // after the </think> tag the actual response starts
        const thinkSplit = response.message.content.split("</think>");

        return thinkSplit[thinkSplit.length - 1].trim();
    } catch (error) {
        console.error("Error querying Ollama:", error);
        throw error;
    }
};
