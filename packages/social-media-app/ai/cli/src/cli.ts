import { Peerbit } from "peerbit";
import { AIResponseProgram } from "@giga-app/llm";
import inquirer from "inquirer";
import path from "path";
import os from "os";
import fs from "fs";

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

    // Global request counter.
    let requestCount = 0;

    // Open the AIResponseProgram as a service (server mode) and pass the onRequest callback.
    const service = await client.open<AIResponseProgram>(
        new AIResponseProgram(),
        {
            args: {
                server: true,
                onRequest: (query, context) => {
                    requestCount++;
                },
            },
            existing: "reuse",
        }
    );

    // Monitor mode: show the rate of incoming requests in real time.
    const monitorMode = async () => {
        console.log(
            "Entering monitor mode. Type 'back' to return to interactive mode."
        );
        let lastCount = requestCount;
        const interval = setInterval(() => {
            const currentCount = requestCount;
            const rate = currentCount - lastCount;
            lastCount = currentCount;
            console.log(`Requests in the last second: ${rate}`);
        }, 1000);

        // Stay in monitor mode until user types "back".
        while (true) {
            const answer = await inquirer.prompt([
                {
                    type: "input",
                    name: "command",
                    message: "Monitor mode (type 'back' to exit):",
                },
            ]);
            if (answer.command.trim().toLowerCase() === "back") {
                break;
            }
        }
        clearInterval(interval);
        console.log("Exiting monitor mode.");
    };

    // Main CLI loop: prompt the user for input and query the AI.
    const promptLoop = async () => {
        const answers = await inquirer.prompt([
            {
                type: "input",
                name: "prompt",
                message:
                    "Enter your prompt (or type 'exit' to quit or 'monitor' to view request rate):",
            },
        ]);
        const userPrompt = answers.prompt.trim();
        if (userPrompt.toLowerCase() === "exit") {
            console.log("Exiting...");
            process.exit(0);
        } else if (userPrompt.toLowerCase() === "monitor") {
            await monitorMode();
        } else {
            // Open a client connection to the running service.
            const clientInstance = await client.open<AIResponseProgram>(
                service.address,
                { existing: "reuse" }
            );
            await clientInstance.waitFor(service.node.identity.publicKey);

            console.log("Querying AI, please wait...");
            try {
                // Increase the timeout if needed.
                const response = await clientInstance.query(userPrompt, {
                    timeout: 10000,
                });
                console.log("\nAI Response:");
                console.log(response?.response || "No response received");
            } catch (error) {
                console.error("Error querying AI:", error);
            }
            console.log("");
        }
        // Continue the prompt loop.
        await promptLoop();
    };

    await promptLoop();
};
