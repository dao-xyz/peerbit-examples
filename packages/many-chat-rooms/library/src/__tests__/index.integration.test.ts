import { Peerbit } from "peerbit";
import { waitFor } from "@peerbit/time";
import { Post, Room, Lobby } from "..";
import {
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { expect } from "chai";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    before(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    after(async () => {
        await peer.stop();
        await peer2.stop();
    });

    it("can post", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const lobbyFrom1 = await peer.open(new Lobby({}));

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const lobbyFrom2 = await peer2.open<Lobby>(lobbyFrom1.address!);

        // Put 1 Room in Rooms
        const roomAFrom2 = new Room({ name: "new room" });
        await lobbyFrom2.rooms.put(roomAFrom2);

        // Another room
        const roomBFrom2 = new Room({ name: "another room" });
        await lobbyFrom2.rooms.put(roomBFrom2);

        // peer 1 will eventually also replicate the room, since both have opened the Lobby as replicators
        await waitFor(
            async () => (await lobbyFrom1.rooms.index.getSize()) === 2
        );
        const results: Room[] = await lobbyFrom1.rooms.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: "another",
                        caseInsensitive: true,
                        method: StringMatchMethod.contains,
                    }),
                ],
            })
        );

        expect(results.length).to.eq(1);
        expect(results[0].id).to.eq(roomBFrom2.id);

        // TODO auto open (?)
        // await waitForResolved(() => expect(results[0].closed).to.be.false); // because peer1 is also a replicator (will open automatically)

        // Put a message
        const helloWorldPostFrom2 = new Post({
            message: "hello world",
            from: peer2.identity.publicKey,
        });

        await peer2.open(roomAFrom2); // TODO auto open on put
        await roomAFrom2.messages.put(helloWorldPostFrom2);

        const roomAfrom1 = (await lobbyFrom1.rooms.index.get(roomAFrom2.id))!;

        await peer.open(roomAfrom1); // TODO auto open on syn

        const helloWorldPostFrom1 = await waitFor(
            async () =>
                await roomAfrom1.messages.index.get(helloWorldPostFrom2.id, {
                    local: true,
                    remote: false,
                })
        );
        expect(helloWorldPostFrom1!.message).to.eq("hello world");
    });
});
