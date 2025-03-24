import { HashRouter, Routes, Route } from "react-router-dom";
import HomePage from "./HomePage";
import ChessLobby from "./ChessLobby";
import { PeerProvider } from "@peerbit/react";
import { AppProvider } from "@giga-app/sdk";
import "./index.css";
import ChessGamePage from "./ChessGamePage";

const setTheme = () => {
    // On page load or when changing themes, best to add inline in `head` to avoid FOUC
    if (
        localStorage.theme === "dark" ||
        (!("theme" in localStorage) &&
            window.matchMedia("(prefers-color-scheme: dark)").matches)
    ) {
        localStorage.setItem("theme", "dark");
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
};

export const App = () => {
    setTheme();
    return (
        <PeerProvider
            inMemory={false}
            waitForConnnected={true}
            top={{
                type: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
            }}
            iframe={{ type: "proxy", targetOrigin: "*" }}
        >
            <AppProvider navigation="emit-all">
                <HashRouter basename="/">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route
                            path="/lobby/:address"
                            element={<ChessLobby />}
                        />
                        <Route
                            path="/game/:address"
                            element={<ChessGamePage />}
                        />
                    </Routes>
                </HashRouter>
            </AppProvider>
        </PeerProvider>
    );
};

export default App;
