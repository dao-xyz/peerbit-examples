import inquirer from "inquirer";
import { Peerbit } from "peerbit";
import { CanvasAIReply } from "@giga-app/llm";
import path from "path";
import os from "os";
import fs from "fs";
import { Canvas } from "@giga-app/interface";

export const start = async (directory?: string | null) => {
    // Use a default directory if one is not provided.
    if (directory === undefined) {
        const homeDir = os.homedir();
        directory = path.join(homeDir, "peerbit-ai-response-program");
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    }

    console.log(
        "Starting AI Response CLI" +
            (directory ? ` in directory ${directory}` : "")
    );

    // Create the Peerbit client with optional persistence.
    const client = await Peerbit.create({ directory: directory ?? undefined });

    // If "--local" is provided, dial a local node; otherwise bootstrap.
    if (process.argv.includes("--local")) {
        const localPeerId = await (
            await fetch("http://localhost:8082/peer/id")
        ).text();
        await client.dial("/ip4/127.0.0.1/tcp/8002/ws/p2p/" + localPeerId);
        console.log("Dialed local node", localPeerId);
    } else {
        await client.bootstrap();
    }

    // Determine LLM configuration based on command-line flags.
    // Use "--chatgpt" to choose ChatGPT; otherwise defaults to Ollama.
    const llm = process.argv.includes("--chatgpt") ? "chatgpt" : "ollama";

    // Check if an API key is passed as a CLI argument using the flag "--api-key".
    let chatgptApiKey: string | undefined;
    const apiKeyIndex = process.argv.indexOf("--api-key");
    if (apiKeyIndex > -1 && process.argv.length > apiKeyIndex + 1) {
        chatgptApiKey = process.argv[apiKeyIndex + 1];
    }

    const serviceArgs = {
        server: true,
        llm: llm as "chatgpt" | "ollama",
        ...(llm === "chatgpt" && {
            apiKey: chatgptApiKey || process.env.OPENAI_API_KEY,
        }),
    };

    // Open the CanvasAIReply service (server mode) with the proper LLM configuration.
    const service = await client.open<CanvasAIReply>(new CanvasAIReply(), {
        args: {
            ...serviceArgs,
            server: true,
        },
        existing: "reuse",
    });

    // Main interactive menu using inquirer.
    const { mode } = await inquirer.prompt([
        {
            type: "list",
            name: "mode",
            message: "Select a mode:",
            choices: [
                {
                    name: "Monitor Mode (periodically display the request rate)",
                    value: "monitor",
                },
                {
                    name: "Generate Reply (enter a Canvas address to generate a reply)",
                    value: "reply",
                },
            ],
        },
    ]);

    if (mode === "monitor") {
        console.log("Entering Monitor Mode. Press Ctrl+C to exit.");
        // Simulate monitoring: replace this with actual request rate retrieval logic if available.
        setInterval(() => {
            const simulatedRequestRate = Math.floor(Math.random() * 100);
            console.log("Current Request Rate:", simulatedRequestRate);
        }, 5000);
    } else if (mode === "reply") {
        // Prompt the user for a Canvas address.
        const { canvasAddress } = await inquirer.prompt([
            {
                type: "input",
                name: "canvasAddress",
                message: "Enter the Canvas address:",
            },
        ]);

        console.log("Opening Canvas at address:", canvasAddress);
        const canvas = await client.open<Canvas>(canvasAddress, {
            existing: "reuse",
        });
        await canvas.load();

        console.log("Querying AI, please wait...");
        try {
            const response = await service.query(canvas, { timeout: 10000 });
            console.log("\nAI Response:");
            console.log(response ? "Done!" : "No response received");
        } catch (error) {
            console.error("Error querying AI:", error);
        }
        process.exit(0);
    }
};
