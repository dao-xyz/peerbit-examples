import { Peerbit } from "peerbit";
import { waitFor, waitForAsync } from "@peerbit/time";
import { Post, Room, Lobby } from "..";
import {
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";

describe("index", () => {
    let peer: Peerbit, peer2: Peerbit;

    beforeAll(async () => {
        peer = await Peerbit.create();
        peer2 = await Peerbit.create();
        await peer.dial(peer2);
    });

    afterAll(async () => {
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
        await waitFor(() => lobbyFrom1.rooms.index.size === 2);
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

        expect(results.length).toEqual(1);
        expect(results[0].id).toEqual(roomBFrom2.id);

        expect(results[0].closed).toBeFalse(); // because peer1 is also a replicator (will open automatically)

        // Put a message
        const helloWorldPostFrom2 = new Post({
            message: "hello world",
            from: peer2.identity.publicKey,
        });
        await roomAFrom2.messages.put(helloWorldPostFrom2);

        const roomAfrom1 = (await lobbyFrom1.rooms.index.get(roomAFrom2.id))!;

        const helloWorldPostFrom1 = await waitForAsync(
            async () =>
                await roomAfrom1.messages.index.get(helloWorldPostFrom2.id, {
                    local: true,
                    remote: false,
                })
        );
        expect(helloWorldPostFrom1!.message).toEqual("hello world");
    });
});
