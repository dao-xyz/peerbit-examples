import inquirer from "inquirer";
import { Peerbit } from "peerbit";
import { CanvasAIReply, ServerConfig } from "@giga-app/llm";
import path from "path";
import os from "os";
import fs from "fs";
import { Canvas, CanvasAddressReference, Scope } from "@giga-app/interface";
import { fromBase64 } from "@peerbit/crypto"

export const start = async (directory?: string | null) => {
    process.on("uncaughtException", (err) => {
        console.error("Uncaught exception", err);
    });

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
    const apiKeyIndex =
        process.argv.indexOf("--api-key") != -1
            ? process.argv.indexOf("--api-key")
            : process.argv.indexOf("--apiKey");
    if (apiKeyIndex > -1 && process.argv.length > apiKeyIndex + 1) {
        chatgptApiKey = process.argv[apiKeyIndex + 1];
    }

    // Check if an model key is passed as a CLI argument using the flag "--model".
    let model: string | undefined;
    const modelIndex = process.argv.indexOf("--model");
    if (modelIndex > -1 && process.argv.length > modelIndex + 1) {
        model = process.argv[modelIndex + 1];
    }

    const serviceArgs = {
        server: true,
        llm: llm as "chatgpt" | "ollama",
        ...(llm === "chatgpt" && {
            apiKey: chatgptApiKey || process.env.OPENAI_API_KEY,
        }),
        ...(llm === "ollama" && {
            model,
        }),
    } as ServerConfig;


    // Open the CanvasAIReply service (server mode) with the proper LLM configuration.
    const service = await client.open<CanvasAIReply>(new CanvasAIReply(), {
        args: {
            ...serviceArgs,
            server: true,
        },
        existing: "reuse",
    });

    // Main interactive loop using inquirer.
    while (true) {
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
                        name: "Generate Reply (enter a Canvas id to generate a reply)",
                        value: "reply",
                    },
                    {
                        name: "Exit",
                        value: "exit",
                    },
                ],
            },
        ]);

        if (mode === "exit") {
            console.log("Exiting...");
            process.exit(0);
        } else if (mode === "monitor") {
            console.log(
                "Entering Monitor Mode. Press Enter to return to the main menu."
            );
            const monitorInterval = setInterval(() => {
                const stats = service.getRequestStats();
                console.log("Request Stats:");
                console.log("  Requests:        " + stats.requestCount);
                console.log(
                    "  Average Latency: " +
                    stats.averageLatency.toFixed(2) +
                    " ms"
                );
                console.log("  Errors:          " + stats.errorCount);
            }, 5000);

            // Wait for user input to stop monitoring.
            await inquirer.prompt([
                {
                    type: "input",
                    name: "stop",
                    message:
                        "Press Enter to stop monitoring and return to the main menu.",
                },
            ]);
            clearInterval(monitorInterval);
        } else if (mode === "reply") {
            // Prompt the user for a Canvas address.
            const { canvasId: canvasIdStr } = await inquirer.prompt([
                {
                    type: "input",
                    name: "canvasId",
                    message: "Enter the Canvas address:",
                }
            ]);
            if (canvasIdStr.trim().length === 0) {
                console.error("Invalid Canvas address");
                continue;
            }

            const canvasID = fromBase64(canvasIdStr.trim());


            const { scopeAddress } = await inquirer.prompt([
                {
                    type: "input",
                    name: "scopeAddress",
                    message: "Enter the scope address (optional):",
                }
            ]);

            // either use the provided scope address or default to the canvas address
            let scope: Scope = service.origin!.root;
            if (scopeAddress) {
                scope = await client.open<Scope>(scopeAddress, {
                    existing: "reuse",
                    args: service.origin?.root.openingArgs!
                });
            }



            console.log("Querying AI, please wait...");
            try {
                const response = await service.query(new CanvasAddressReference({ id: canvasID, scope }), {
                    timeout: 10000,
                });
                console.log("\nAI Response:");
                console.log(response ? "Done!" : "No response received");
            } catch (error) {
                console.error("Error querying AI:", error);
            }

            // Wait for user to press Enter to return to the main menu.
            await inquirer.prompt([
                {
                    type: "input",
                    name: "continue",
                    message: "Press Enter to return to the main menu.",
                },
            ]);
        }
    }
};
