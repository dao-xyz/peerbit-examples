import React from "react";
import { createRoot } from "react-dom/client";
import { PeerProvider } from "@peerbit/react";
import { documentAdapter } from "@peerbit/document-proxy/auto";
import { todoProgramAdapter } from "./todo/adapter";
import { App } from "./ui/App";
import "./ui/styles.css";

const workerUrl = new URL(
    "./worker/sharedworkerTodo.worker.ts",
    import.meta.url
);

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <PeerProvider
            config={{
                runtime: "canonical",
                transport: {
                    kind: "shared-worker",
                    worker: {
                        url: workerUrl,
                        name: "peerbit-sharedworker-todo",
                        type: "module",
                    },
                },
                open: {
                    adapters: [todoProgramAdapter, documentAdapter],
                    mode: "canonical",
                },
            }}
        >
            <App />
        </PeerProvider>
    </React.StrictMode>
);
