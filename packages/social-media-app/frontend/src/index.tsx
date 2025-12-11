import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { setupPrettyConsole } from "./debug/debug";

// Patch console as early as possible when debug flag is set (localStorage/query/env)
setupPrettyConsole();

const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
);

root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
