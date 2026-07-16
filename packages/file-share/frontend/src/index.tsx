import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { cleanupOpfsDownloadsOnStartup } from "./download-sink";

void cleanupOpfsDownloadsOnStartup().catch((error) => {
    console.warn(
        "Unable to clean temporary file-share downloads on startup: " +
            (error instanceof Error ? error.message : String(error))
    );
});

const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
);

root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
