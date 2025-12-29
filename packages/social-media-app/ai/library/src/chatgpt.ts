/**
 * queryChatGPT sends a prompt to the OpenAI ChatGPT API.
 * @param {string} prompt - The prompt to send.
 * @param {string} apiKey - Your OpenAI API key.
 * @param {{ model?: string, system?: string }} [options] - Optional model/system overrides.
 * @returns {Promise<string>} The assistant's response.
 */
export const queryChatGPT = async (
    prompt: string,
    apiKey: string,
    options?: { model?: string; system?: string }
) => {
    if (!apiKey) {
        throw new Error("API key is required for ChatGPT queries");
    }
    try {
        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: options?.model ?? "gpt-4o",
                    messages: [
                        ...(options?.system
                            ? [{ role: "system", content: options.system }]
                            : []),
                        { role: "user", content: prompt },
                    ],
                    stream: false,
                }),
            }
        );
        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.error("Error querying ChatGPT:", error);
        throw error;
    }
};
