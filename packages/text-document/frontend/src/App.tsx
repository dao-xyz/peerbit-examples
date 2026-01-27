import { PeerProvider } from "@peerbit/react";
import { Document } from "./Document";

export const App = () => {
    return (
        <PeerProvider
            config={{
                runtime: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
                waitForConnected: true,
            }}
        >
            <Document />
        </PeerProvider>
    );
};
