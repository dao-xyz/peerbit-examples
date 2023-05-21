import { Peerbit } from "@dao-xyz/peerbit";
import { LSession } from "@dao-xyz/peerbit-test-utils";
import { waitFor } from "@dao-xyz/peerbit-time";
import { jest } from "@jest/globals";
import { Post, Room, Lobby } from "..";
import { waitForSubscribers } from "@dao-xyz/libp2p-direct-sub";
import {
    DocumentQuery,
    StringMatch,
    Results,
    StringMatchMethod,
} from "@dao-xyz/peerbit-document";
import { ReplicatorType } from "@dao-xyz/peerbit-program";

describe("index", () => {
    let session: LSession, peer: Peerbit, peer2: Peerbit;
    jest.setTimeout(60 * 1000);

    beforeAll(async () => {
        session = await LSession.connected(2);
        peer = await Peerbit.create({ libp2p: session.peers[0] });
        peer2 = await Peerbit.create({ libp2p: session.peers[1] });
    });

    afterAll(async () => {
        await session.stop();
    });

    it("can post", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const lobby1 = await peer.open(new Lobby({}), {
            role: new ReplicatorType(),
        });

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const lobby2 = await peer2.open<Lobby>(lobby1.address!, {
            role: new ReplicatorType(),
        });

        // Put 1 Room in Rooms
        const room = new Room({ name: "new room" });
        await lobby2.rooms.put(room);

        // Another room
        const room2 = new Room({ name: "another room" });
        await lobby2.rooms.put(room2);

        await waitForSubscribers(
            peer.libp2p,
            peer2.libp2p,
            lobby2.address.toString()
        );

        // Peer2 can "query" for rooms if peer2 does not have anything replicated locally
        const results: Room[] = await lobby1.rooms.index.query(
            new DocumentQuery({
                queries: [
                    new StringMatch({
                        key: "name",
                        value: "another",
                        caseInsensitive: true,
                        method: StringMatchMethod.contains,
                    }),
                ],
            }),
            {
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
