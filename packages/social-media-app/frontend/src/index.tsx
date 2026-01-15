import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { setupPrettyConsole } from "./debug/debug";
import { initStartupPerf, markStorageSnapshot } from "./debug/perf";

// Patch console as early as possible when debug flag is set (localStorage/query/env)
setupPrettyConsole();
initStartupPerf();
markStorageSnapshot("initial");

const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
);

root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
