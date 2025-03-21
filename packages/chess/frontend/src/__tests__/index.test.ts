import { Peerbit } from "peerbit";
import { expect } from "chai";
import { ChessGame } from "../chessGame";
import { waitFor } from "@peerbit/time";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeEach(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterEach(async () => {
        await peer.stop();
        await peer2.stop();
    });

    describe("moves", () => {
        it("can move", async () => {
            // Peer 1 is subscribing to a replication topic (to start helping the network)
            const gameFrom1 = await peer.open(
                new ChessGame({
                    creator: peer.identity.publicKey,
                    opponent: peer2.identity.publicKey,
                })
            );
            const gameFrom2 = await peer2.open(gameFrom1.clone());
            await gameFrom1.moves.waitFor(peer2.identity.publicKey);
            await gameFrom2.moves.waitFor(peer.identity.publicKey);

            await gameFrom1.move({
                from: peer.identity.publicKey,
                moveSan: "e4",
            });
            const movesFrom2 = await waitFor(async () => {
                const movesFrom2 = await gameFrom2.moves.index
                    .iterate(
                        { sort: "timestamp" },
                        { local: true, remote: false }
                    )
                    .all();
                if (movesFrom2.length === 1) return movesFrom2;
            });

            await gameFrom2.move({
                from: peer.identity.publicKey,
                moveSan: "e5",
                lastMove: movesFrom2![movesFrom2!.length - 1],
            });

            const movesFrom1 = await waitFor(async () => {
                const movesFrom1 = await gameFrom1.moves.index
                    .iterate(
                        { sort: "timestamp" },
                        { local: true, remote: false }
                    )
                    .all();
                if (movesFrom1.length === 2) return movesFrom1;
            });

            expect(movesFrom1).to.have.length(2);
        });
    });
});
