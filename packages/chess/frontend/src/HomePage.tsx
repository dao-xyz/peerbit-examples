// src/HomePage.tsx
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Lobby } from "./chessGame";
import { usePeer } from "@peerbit/react";

const HomePage = () => {
    const navigate = useNavigate();
    const { peer } = usePeer();

    useEffect(() => {
        const createLobby = async () => {
            if (!peer) return;
            // Create a new Lobby instance wrapping a pending ChessGame
            // with the current peer as the creator.
            const lobbyInstance = new Lobby({
                creator: peer.identity.publicKey,
            });
            // Open the lobby (reuse if it already exists) and navigate immediately.
            await peer
                .open(lobbyInstance, { existing: "reuse" })
                .then((lobby) => {
                    navigate(`/lobby/${lobby.address}`);
                });
        };
        createLobby();
    }, [peer, navigate]);

    return <div className="p-4">Loading lobby...</div>;
};

export default HomePage;
