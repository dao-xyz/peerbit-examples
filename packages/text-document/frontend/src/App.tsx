import { PeerProvider, usePeer } from "@peerbit/react";
import { Document } from "./Document";

export const App = () => {
    return (
        <PeerProvider
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
            host={true}
        >
            <Document />
        </PeerProvider>
    );
};
