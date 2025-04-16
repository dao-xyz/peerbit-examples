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
    FaChess,
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

    // Track the screen size to conditionally render background styling.
    const [isSmallScreen, setIsSmallScreen] = useState(false);
    useEffect(() => {
        const handleResize = () => {
            // Adjust thresholds as needed.
            if (window.innerWidth < 301 || window.innerHeight < 201) {
                setIsSmallScreen(true);
            } else {
                setIsSmallScreen(false);
            }
        };
        // Initialize the state and attach the listener.
        handleResize();
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

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

    if (loading)
        return (
            <div className="p-4 text-center text-lg text-gray-700 dark:text-gray-300">
                Loading lobby...
            </div>
        );
    if (!lobby)
        return (
            <div className="p-4 text-center text-lg text-red-500">
                Error loading lobby.
            </div>
        );

    const handleSelectOpponent = async (opponentPublicKey: PublicSignKey) => {
        if (!isHost) return;
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
        if (gameStarted)
            return "The battle is about to begin – sharpen your strategy!";
        if (isHost) {
            if (peers.length <= 1)
                return "Waiting for challengers to join the fray...";
            return "Choose your worthy opponent and let the game commence!";
        }
        return "Awaiting the host's call for battle...";
    };

    // Conditionally apply container styling.
    const containerClass = isSmallScreen
        ? "w-full p-4" // No background or margins on small screens.
        : "max-w-xl mx-auto my-8 p-6 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-gray-800 dark:to-gray-700 rounded-lg shadow-lg";

    return (
        <div className={containerClass}>
            <div className="flex items-center justify-between gap-2 mb-4">
                <h1 className="text-2xl font-extrabold tracking-wide text-gray-800 dark:text-white flex items-center gap-2">
                    <FaChess className="text-3xl" />
                    Chess Lobby
                </h1>
            </div>
            <div className="mb-4 space-y-2">
                <div>
                    <span className="font-semibold text-gray-700 dark:text-gray-300">
                        Lobby:
                    </span>{" "}
                    <span className="font-mono text-indigo-600">
                        {shortenId(lobby.address)}
                    </span>
                </div>
                <div>
                    <span className="font-semibold text-gray-700 dark:text-gray-300">
                        Participants Online:
                    </span>{" "}
                    <span className="font-bold text-green-600">
                        {peersOnline.length}
                    </span>
                </div>
            </div>
            <ul className="space-y-3">
                {peers.map((pk) => (
                    <li
                        key={pk.hashcode()}
                        className="flex items-center justify-between p-3 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow duration-200"
                    >
                        <div className="flex items-center space-x-2">
                            <FaUser className="text-gray-600" />
                            <span className="font-mono text-sm text-gray-800 dark:text-gray-200">
                                {shortenId(pk.hashcode())}
                            </span>
                            {isOnline(pk) ? (
                                <FaCheckCircle
                                    className="text-green-500"
                                    title="Online"
                                />
                            ) : (
                                <FaTimesCircle
                                    className="text-red-500"
                                    title="Offline"
                                />
                            )}
                        </div>
                        {isHost && !peer.identity.publicKey.equals(pk) && (
                            <button
                                onClick={() => handleSelectOpponent(pk)}
                                className="flex items-center space-x-1 bg-blue-500 hover:bg-blue-600 transition-colors duration-200 text-white px-3 py-1 rounded-full text-xs font-semibold shadow"
                            >
                                <FaHandPointer />
                                <span>Select</span>
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            <p className="mt-6 text-center text-lg font-medium text-gray-700 dark:text-gray-200">
                {messageToRender()}
            </p>
        </div>
    );
};

export default ChessLobby;
