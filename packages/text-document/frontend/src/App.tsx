import { PeerProvider, usePeer } from "@peerbit/react";
import { Routes, Route } from "react-router";
import { Document } from './Document.js';
import { NewDocument } from './NewDocument';
import { HashRouter } from "react-router-dom";


export const App = () => {
    return (
        <PeerProvider
            iframe={{ type: "proxy", targetOrigin: "*" }}
            top={{
                type: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
                host: true,
            }}
            waitForConnnected={true}
        >
            <HashRouter basename="/">

                <Routes>
                    {/* <Route path={USER_BY_KEY_NAME} element={<Canvas />} /> */}
                    <Route path="/d/:address" element={<Document />} />
                    <Route path="/*" element={<NewDocument />} />
                </Routes>
            </HashRouter>
        </PeerProvider>
    );
};
