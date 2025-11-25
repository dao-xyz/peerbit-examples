import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useLocal } from "@peerbit/document-react";
import { usePeer, useProgram } from "@peerbit/react";
import { ChessGame, Move } from "./chessGame";
import InteractiveChessBoard from "./InteractiveChessBoard";
import { FaCircle } from "react-icons/fa";

const ChessGamePage = () => {
    const { address } = useParams<{ address: string }>();
    const { peer } = usePeer();
    const [isSpectator, setIsSpectator] = useState(false);
    const [isOpponentOnline, setIsOpponentOnline] = useState(false);
    const gameInstance = useProgram<ChessGame>(peer, address, {
        existing: "reuse",
    });

    useEffect(() => {
        if (gameInstance.program == null || gameInstance.program?.closed) {
            return;
        }
        // Check if the peer is a participant (either white or black)
        if (
            peer.identity.publicKey.equals(gameInstance.program.white) ||
            peer.identity.publicKey.equals(gameInstance.program.black)
        ) {
            setIsSpectator(false);
        } else {
            setIsSpectator(true);
        }
    }, [
        gameInstance.id,
        gameInstance.program?.closed,
        peer?.identity.publicKey.hashcode(),
    ]);

    useEffect(() => {
        if (!gameInstance.program) {
            return;
        }
        // Determine the opponent's public key.
        let opponent = gameInstance.program.white.equals(
            peer.identity.publicKey
        )
            ? gameInstance.program.black
            : gameInstance.program.white;

        let isOnline = false;
        for (const peer of gameInstance?.peers ?? []) {
            if (peer.equals(opponent)) {
                console.log("opponent online");
                isOnline = true;
                break;
            }
        }
        setIsOpponentOnline(isOnline);
    }, [gameInstance.peers?.length]);

    // Subscribe to moves from the document.
    const moves = useLocal(
        gameInstance.program ? gameInstance.program?.moves : null,
        { id: gameInstance.program?.id ?? "_", query: { sort: "timestamp" } }
    );

    const handleMove = async (moveSan: string) => {
        if (!gameInstance.program || !peer) return;
        // Create a new Move and add it to the document.
        let lastMove = moves?.[moves.length - 1];
        const newMove = new Move({
            move: moveSan,
            from: peer.identity.publicKey,
        });
        const prev = lastMove
            ? await gameInstance.program.moves.log.log.get(
                  lastMove?.__context.head
              )
            : undefined;
        console.log("new move", { newMove, prev });
        await gameInstance.program.moves.put(newMove, {
            meta: {
                next: prev ? [prev] : undefined,
            },
        });
    };

    if (gameInstance?.loading || !gameInstance.program) {
        return <div className="p-4">Loading game...</div>;
    }

    // Determine if the current player is white.
    const isWhite = gameInstance.program.white.equals(peer.identity.publicKey);
    // White moves when moves.length is even; black when it’s odd.
    const isMyTurn =
        !isSpectator &&
        moves &&
        (isWhite ? moves.length % 2 === 0 : moves.length % 2 === 1);

    // If you want to wait for an opponent, use isWhite (white starts)
    const isWaiting = isWhite && !gameInstance.program.black;

    return (
        <div className="p-4">
            {isWaiting && (
                <p className="text-xl mb-2">
                    Waiting for an opponent to join...
                </p>
            )}
            {isSpectator && (
                <p className="text-xl mb-2">
                    You are a spectator in this game.
                </p>
            )}
            {!isSpectator && (
                <p className="mb-2 flex items-center">
                    {isOpponentOnline ? (
                        <>
                            <FaCircle className="text-green-500 mr-2" />
                            <span>Opponent is online</span>
                        </>
                    ) : (
                        <>
                            <FaCircle className="text-red-500 mr-2" />
                            <span>Opponent is offline</span>
                        </>
                    )}
                </p>
            )}

            {!isSpectator && (
                /* Show a text indicating if its my turn or not  */
                <p className="mb-2 flex items-center">
                    {isMyTurn ? (
                        <>
                            <span>Your turn</span>
                        </>
                    ) : (
                        <>
                            <span>Waiting opponent to move</span>
                        </>
                    )}
                </p>
            )}
            <InteractiveChessBoard
                isPlayer={!isSpectator}
                moves={moves}
                onMove={handleMove}
                isMyTurn={isMyTurn} // Pass turn info here
                isWhite={isWhite}
            />
        </div>
    );
};

export default ChessGamePage;
