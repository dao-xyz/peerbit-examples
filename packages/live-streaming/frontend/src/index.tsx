import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";
import * as s from "./iframeResizer.contentWindow.min.js";
!!s;
const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
);
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
