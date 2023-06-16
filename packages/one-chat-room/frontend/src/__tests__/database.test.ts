import { Peerbit } from "@dao-xyz/peerbit";
import { Post, Room } from "../database";
import { Observer } from "@dao-xyz/peerbit-program";
import { SearchRequest } from "@dao-xyz/peerbit-document";
import { delay } from "@dao-xyz/peerbit-time";

describe("Room", () => {
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
    it("later", async () => {
        const room = await peer.open(
            new Room({ creator: peer.identity.publicKey })
        );
        await room.messages.put(
            new Post({ from: peer.identity.publicKey, message: "first" })
        );
        await room.messages.put(
            new Post({ from: peer.identity.publicKey, message: "second" })
        );

        const roomObserve = await peer2.open<Room>(room.address, {
            role: new Observer(),
        });
        await roomObserve.waitFor(peer.libp2p);
        let later = await roomObserve.loadLater();
        expect(later).toHaveLength(2);
        later = await roomObserve.loadLater();
        expect(later).toHaveLength(0);
        await room.messages.put(
            new Post({ from: peer.identity.publicKey, message: "third" })
        );
        later = await roomObserve.loadLater();
        expect(later).toHaveLength(1);
    });
});
