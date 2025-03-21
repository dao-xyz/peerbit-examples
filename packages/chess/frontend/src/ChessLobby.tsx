import { useNavigate, useParams } from "react-router-dom";
import { useLocal, useOnline, usePeer, useProgram } from "@peerbit/react";
import {
    ChessGame,
    GamesStartMessage,
    IsReadyMessage,
    Lobby,
} from "./chessGame";
import { PublicSignKey } from "@peerbit/crypto";
import { useEffect, useState } from "react";
import {
    FaUser,
    FaCheckCircle,
    FaTimesCircle,
    FaHandPointer,
} from "react-icons/fa";

const shortenId = (id: string) => `${id.slice(0, 6)}...${id.slice(-4)}`;

export const ChessLobby = () => {
    const navigate = useNavigate();
    const { peer } = usePeer();
    const { address } = useParams<{ address: string }>();

    const {
        program: lobby,
        loading,
        peers,
    } = useProgram<Lobby>(address, {
        existing: "reuse",
        keepOpenOnUnmount: true,
    });
    const messages = useLocal(lobby?.messages);
    const { peers: peersOnline } = useOnline(lobby);
    const [gameStarted, setGameStarted] = useState(false);
    const isHost = lobby?.creator.equals(peer?.identity.publicKey);

    useEffect(() => {
        if (!messages || !lobby) return;
        const gameStartMessage = messages.find(
            (msg) => msg instanceof GamesStartMessage
        );
        if (gameStartMessage) {
            setGameStarted(true);
            lobby.messages
                .put(new IsReadyMessage({ message: "I am ready!" }))
                .then(() => {
                    if (!isHost) {
                        navigate(`/game/${gameStartMessage.game}`);
                    }
                });
        }
    }, [messages, lobby, isHost, navigate]);

    if (loading) return <div className="p-2 text-sm">Loading lobby...</div>;
    if (!lobby) return <div className="p-2 text-sm">Error loading lobby.</div>;

    const handleSelectOpponent = async (opponentPublicKey: PublicSignKey) => {
        if (!isHost) return;
        // Host sets the opponent on the pending board.
        const game = new ChessGame({
            creator: peer.identity.publicKey,
            opponent: opponentPublicKey,
        });
        try {
            await peer.open(game, { existing: "reuse" });
            lobby.messages.events.addEventListener("change", async (e: any) => {
                for (const message of e.detail.added) {
                    const logEntry = await lobby.messages.log.log.get(
                        message.__context.head
                    );
                    const signer = logEntry.signatures[0].publicKey;
                    if (signer.equals(opponentPublicKey)) {
                        navigate(`/game/${game.address}`);
                    }
                }
            });
            await lobby.messages.put(
                new GamesStartMessage({ game: game.address })
            );
        } catch (error) {
            console.error("Error selecting opponent:", error);
        }
    };

    const isOnline = (pk: PublicSignKey) =>
        peersOnline.some((onlinePeer) => onlinePeer.equals(pk));

    const messageToRender = () => {
        if (gameStarted) return "Game is starting...";
        if (isHost) {
            if (peers.length <= 1) return "Waiting for participants to join...";
            return "Choose an opponent to start the game.";
        }
        return "Waiting for the host to choose an opponent...";
    };

    return (
        <div className="p-2 text-sm">
            <h1 className="text-xl font-bold mb-2">Chess Lobby</h1>
            <div className="mb-2">
                <span className="font-semibold">Lobby:</span>{" "}
                {shortenId(lobby.address)}
            </div>
            <div className="mb-2">
                <span className="font-semibold">Participants:</span>{" "}
                {peersOnline.length}
            </div>
            <ul className="space-y-1">
                {peers.map((pk) => (
                    <li
                        key={pk.hashcode()}
                        className="flex items-center justify-between border-b border-gray-200 pb-1"
                    >
                        <div className="flex items-center space-x-1">
                            <FaUser className="text-gray-600" />
                            <span>{shortenId(pk.hashcode())}</span>
                            {isOnline(pk) ? (
                                <FaCheckCircle className="text-green-500" />
                            ) : (
                                <FaTimesCircle className="text-red-500" />
                            )}
                        </div>
                        {isHost && !peer.identity.publicKey.equals(pk) && (
                            <button
                                onClick={() => handleSelectOpponent(pk)}
                                className="flex items-center space-x-1 bg-blue-500 text-white px-2 py-1 rounded text-xs"
                            >
                                <FaHandPointer />
                                <span>Select</span>
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            <p className="mt-2 font-medium">{messageToRender()}</p>
        </div>
    );
};

export default ChessLobby;
