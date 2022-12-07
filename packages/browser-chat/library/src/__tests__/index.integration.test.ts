import { Peerbit } from "@dao-xyz/peerbit";
import { LSession } from "@dao-xyz/peerbit-test-utils";
import { waitFor } from "@dao-xyz/peerbit-time";
import { jest } from "@jest/globals";
import { Post, Room, Rooms } from "..";
import { serialize } from "@dao-xyz/borsh";
import { toBase64 } from "@dao-xyz/peerbit-crypto";

import {
    DocumentQueryRequest,
    FieldStringMatchQuery,
    Results,
} from "@dao-xyz/peerbit-document";
import { delay } from "@dao-xyz/peerbit-time";
import { DEFAULT_BLOCK_TRANSPORT_TOPIC } from "@dao-xyz/peerbit-block";

describe("index", () => {
    let session: LSession, peer: Peerbit, peer2: Peerbit;
    jest.setTimeout(60 * 1000);

    beforeAll(async () => {
        session = await LSession.connected(2, [DEFAULT_BLOCK_TRANSPORT_TOPIC]);
        peer = await Peerbit.create(session.peers[0]);
        peer2 = await Peerbit.create(session.peers[1]);
    });

    afterAll(async () => {
        await session.stop();
    });

    it("can post", async () => {
        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const topic = "world";
        await peer.subscribeToTopic(topic, true);
        const rooms1 = await peer.open(new Rooms({}), {
            topic,
            replicate: true,
        });

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const rooms2 = await peer2.open<Rooms>(rooms1.address!, {
            topic,
            replicate: true,
        });

        // Put 1 Room in Rooms
        const room = new Room({ name: "new room" });
        await rooms2.rooms.put(room);

        // Another room
        const room2 = new Room({ name: "another room" });
        await rooms2.rooms.put(room2);

        // Peer2 can "query" for rooms if peer2 does not have anything replicated locally
        const results: Results<Room>[] = [];
        await rooms1.rooms.index.query(
            new DocumentQueryRequest({
                queries: [
                    new FieldStringMatchQuery({
                        key: "name",
                        value: "another",
                    }),
                ],
            }),
            (result) => {
                results.push(result);
            },
            {
                remote: {
                    timeout: 3000,
                },
            }
        );

        expect(results).toHaveLength(1);
        expect(
            results[0].results.map((result) => result.value.id)
        ).toContainAllValues([room2.id]);

        // Open the room so we can write things inside
        await peer2.open(room, { topic: topic });

        // Put a message
        await room.messages.put(
            new Post({
                message: "hello world",
            })
        );

        await waitFor(() => peer.programs.get("world")?.size === 2); // 1 program controls the rooms, 1 program is a room, and the message controller inside of that
        await waitFor(
            () =>
                (
                    peer.programs.get("world")?.get(room.address.toString()!)
                        ?.program as Room
                ).messages.index.size === 1
        ); // The "hello world" message has now arrived to the first peer
    });

    it("can create genisis", async () => {
        // This does not really test anything but it generates a serialized version of Rooms that one can hardcode in the frontend, so you dont need to load the Room manifest from IPFS on startup
        const genesis = await peer.open(new Rooms({}));
        const base64 = toBase64(serialize(genesis));
        console.log(base64);
    });
});
