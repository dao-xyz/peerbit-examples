import { useEffect } from "react";
import { PeerProvider } from "./Peer";
import { BaseRoutes } from "./routes";
import { HashRouter } from "react-router-dom";
export const App = () => {
    useEffect(() => {
        console.log();
    }, []);
    return (
        <PeerProvider>
            <HashRouter basename="/">
                <BaseRoutes />
            </HashRouter>
        </PeerProvider>
    );
};
