// src/chessGame.ts
import { field, fixedArray, option, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { Documents, id, WithContext } from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { v4 as uuid } from "uuid";
import { Chess } from "chess.js"; // chess.js for move validation

/** A chess move (in algebraic notation, e.g. "e2e4") */
@variant("move")
export class Move {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    move: string;

    @field({ type: PublicSignKey })
    from: PublicSignKey;

    constructor(properties: { move: string; from: PublicSignKey }) {
        this.id = uuid();
        this.move = properties.move;
        this.from = properties.from;
    }
}

class IndexableMove {
    @field({ type: "string" })
    id: string;

    @field({ type: Uint8Array })
    from: Uint8Array;

    @field({ type: "string" })
    move: string;

    @field({ type: "u64" })
    timestamp: bigint;

    constructor(move: Move, timestamp: bigint) {
        this.id = move.id;
        this.from = move.from.bytes;
        this.move = move.move;
        this.timestamp = timestamp;
    }
}

/** The chess game document, which stores moves and the players’ identities. */
@variant("chessgame")
export class ChessGame extends Program {
    @field({ type: PublicSignKey })
    white: PublicSignKey;

    @field({ type: PublicSignKey })
    black: PublicSignKey;

    @field({ type: Documents })
    moves: Documents<Move, IndexableMove>;

    constructor(properties: {
        creator: PublicSignKey;
        opponent: PublicSignKey;
        moves?: Documents<Move, IndexableMove>;
    }) {
        super();
        this.white = properties.creator;
        this.black = properties.opponent;
        this.moves = properties.moves || new Documents<Move, IndexableMove>();
    }

    get id(): string {
        return this.white.hashcode();
    }

    async move(properties: {
        moveSan: string;
        lastMove?: WithContext<Move>;
        from: PublicSignKey;
    }) {
        const newMove = new Move({
            move: properties.moveSan,
            from: properties.from,
        });

        const prev = properties.lastMove
            ? await this.moves.log.log.get(properties.lastMove?.__context.head)
            : undefined;
        console.log("new move", { newMove, prev });
        await this.moves.put(newMove, {
            meta: {
                next: prev ? [prev] : undefined,
            },
        });
        return newMove;
    }
    // Open the moves document with a canPerform validator.
    async open(args?: any): Promise<void> {
        await this.moves.open({
            type: Move,
            strictHistory: true,

            canPerform: async (properties) => {
                if (properties.type === "put") {
                    // Get all previous moves sorted by timestamp.
                    // TODO dont do it this way but re-use an existing board?
                    const allMoves: WithContext<Move>[] = await this.moves.index
                        .iterate(
                            { sort: "timestamp" },
                            { local: true, remote: false }
                        )
                        .all();

                    // Check that the same player is not moving twice in a row.
                    if (allMoves.length > 0) {
                        // TODO make this better
                        const lastMove = allMoves[allMoves.length - 1];
                        const entry = await this.moves.log.log.get(
                            lastMove.__context.head
                        );
                        if (!entry) {
                            console.error("Msiing entry for last move");
                            return false;
                        }
                        const lastSigner = entry.signatures[0].publicKey;
                        const currentSigner =
                            properties.entry.signatures[0].publicKey;
                        if (lastSigner.equals(currentSigner)) {
                            console.error("Same player moving twice in a row");
                            return false; // same player cannot move twice in a row
                        }
                    }

                    // Validate board state using chess.js
                    const chess = new Chess();
                    // Replay all previous moves.
                    for (const m of allMoves) {
                        try {
                            chess.move(m.move);
                        } catch (error) {
                            console.error(
                                "Invalid move from history: " +
                                    m.move +
                                    " history length: " +
                                    allMoves.length
                            );
                            return false;
                        }
                    }

                    // Validate the new move.
                    const newMove = properties.value as Move;
                    try {
                        chess.move(newMove.move);
                    } catch (error) {
                        console.error(
                            "Invalid new move:",
                            newMove.move + " history length: " + allMoves.length
                        );
                        return false; // new move is illegal
                    }
                    return true;
                }
                // Disallow delete operations.
                return false;
            },
            index: {
                type: IndexableMove,
                idProperty: "id",
                transform: (obj, context) =>
                    new IndexableMove(obj, context.created),
            },
            replicate: {
                factor: 1,
            },
        });
    }
}
abstract class LobbyMessage {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    constructor() {
        this.id = randomBytes(32);
    }
}

@variant(0)
export class GamesStartMessage extends LobbyMessage {
    @field({ type: "string" })
    private message: string;

    constructor(properties: { game: string }) {
        super();
        this.message = properties.game;
    }

    get game(): string {
        return this.message;
    }
}

@variant(1)
export class IsReadyMessage extends LobbyMessage {
    @field({ type: "string" })
    private message: string;

    constructor(properties: { message: string }) {
        super();
        this.message = properties.message;
    }

    get game(): string {
        return this.message;
    }
}

@variant("lobby")
export class Lobby extends Program {
    @field({ type: PublicSignKey })
    creator: PublicSignKey;

    @field({ type: Documents })
    messages: Documents<LobbyMessage, LobbyMessage>;

    constructor(properties: { creator: PublicSignKey }) {
        super();
        this.creator = properties.creator;
        this.messages = new Documents();
    }

    async open(): Promise<void> {
        // we open a dummy message class just so that peers will announce their presence in a database so we can call .getReady() to fetch online peers
        await this.messages.open({
            type: LobbyMessage,
            replicate: {
                factor: 1,
            },
            canPerform: () => {
                return true;
            },
        });
    }
}
