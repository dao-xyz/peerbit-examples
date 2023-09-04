import { PeerProvider, usePeer } from "@peerbit/react";
import { Document } from "./Document";

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
            <Document />
        </PeerProvider>
    );
};
