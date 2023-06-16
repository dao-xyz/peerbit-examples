import { Peerbit } from "@dao-xyz/peerbit";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Post, Room, Lobby } from "..";
import {
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@dao-xyz/peerbit-document";
import { Replicator } from "@dao-xyz/peerbit-program";

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
        const lobby1 = await peer.open(new Lobby({}), {
            role: new Replicator(),
        });

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const lobby2 = await peer2.open<Lobby>(lobby1.address!, {
            role: new Replicator(),
        });

        // Put 1 Room in Rooms
        const room = new Room({ name: "new room" });
        await lobby2.rooms.put(room);

        // Another room
        const room2 = new Room({ name: "another room" });
        await lobby2.rooms.put(room2);
        await lobby2.rooms.waitFor(peer.libp2p);

        // Peer2 can "query" for rooms if peer2 does not have anything replicated locally
        const results: Room[] = await lobby1.rooms.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: "name",
                        value: "another",
                        caseInsensitive: true,
                        method: StringMatchMethod.contains,
                    }),
                ],
            }),
            {
                local: true,
                remote: {
                    timeout: 3000,
                },
            }
        );

        expect(results.map((result) => result.id)).toContainAllValues([
            room2.id,
        ]);

        // Open the room so we can write things inside
        await peer2.open(room);

        // Put a message
        await room.messages.put(
            new Post({
                message: "hello world",
                from: peer2.identity.publicKey,
            })
        );

        await waitFor(() => peer.programs.size === 3); // 2 lobbys + 1 room
        await waitFor(
            () =>
                (peer.programs.get(room.address.toString()!)?.program as Room)
                    .messages.index.size === 1
        ); // The "hello world" message has now arrived to the first peer
    });
});
