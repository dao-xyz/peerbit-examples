import React, { useState, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { PublicSignKey } from "@peerbit/crypto";

interface InteractiveChessBoardProps {
    moves: { id: string; move: string; from: PublicSignKey }[] | null;
    onMove: (move: string) => void;
    isPlayer: boolean;
    isMyTurn: boolean; // New prop to control turn
    isWhite: boolean;
}

const InteractiveChessBoard = ({
    moves,
    isPlayer,
    isMyTurn,
    onMove,
    isWhite,
}: InteractiveChessBoardProps) => {
    const [game, setGame] = useState(new Chess());

    // Replay external moves when the moves array changes.
    useEffect(() => {
        const newGame = new Chess();
        if (moves) {
            for (const m of moves) {
                try {
                    newGame.move(m.move);
                } catch (error) {
                    console.error("Illegal move in history", m.move);
                    break;
                }
            }
        }
        setGame(newGame);
    }, [moves]);

    const onDrop = (sourceSquare: string, targetSquare: string) => {
        // Prevent moves if it's not your turn.
        if (!isMyTurn) return false;

        const move = game.move({
            from: sourceSquare,
            to: targetSquare,
            promotion: "q",
        });
        if (move === null) return false;

        // Pass the move in standard algebraic notation (e.g. "e2e4" or SAN)
        onMove(move.san);

        // Update the game state with the new position.
        setGame(new Chess(game.fen()));
        return true;
    };

    return (
        <div className="flex flex-col items-center chess-parent">
            <Chessboard
                isDraggablePiece={() => isPlayer && isMyTurn}
                position={game.fen()}
                onPieceDrop={onDrop}
                boardWidth={400}
                boardOrientation={isWhite ? "white" : "black"}
            />
        </div>
    );
};

export default InteractiveChessBoard;
