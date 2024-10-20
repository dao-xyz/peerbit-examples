import { Peerbit } from "peerbit";
import { Post, Room } from "../database";
import { delay } from "@peerbit/time";
import { expect } from "chai";

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
    it("earlier", async () => {
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
            args: {
                replicate: false,
            },
        });

        await roomObserve.messages.log.waitForReplicator(
            peer.identity.publicKey
        );

        let earlier = await roomObserve.loadEarlier();

        expect(earlier).to.have.length(2);

        earlier = await roomObserve.loadEarlier();
        expect(earlier).to.have.length(0);

        await room.messages.put(
            new Post({ from: peer.identity.publicKey, message: "third" })
        );
        earlier = await roomObserve.loadLater();
        expect(earlier).to.have.length(1);
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
            args: {
                replicate: false,
            },
        });
        await roomObserve.messages.log.waitForReplicator(
            peer.identity.publicKey
        );
        let later = await roomObserve.loadLater();
        expect(later).to.have.length(2);

        later = await roomObserve.loadLater();
        expect(later).to.have.length(0);

        await room.messages.put(
            new Post({ from: peer.identity.publicKey, message: "third" })
        );
        later = await roomObserve.loadLater();
        expect(later).to.have.length(1);
    });
});
