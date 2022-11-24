import { Peerbit } from "@dao-xyz/peerbit";
import { Session } from '@dao-xyz/peerbit-test-utils';
import { waitFor } from '@dao-xyz/peerbit-time';
import { jest } from '@jest/globals';
import { Post, Room, Rooms } from '..';
import { delay } from '@dao-xyz/peerbit-time';
import { serialize } from '@dao-xyz/borsh';
import { DocumentQueryRequest, FieldStringMatchQuery, Results } from '@dao-xyz/peerbit-document';

describe('index', () => {
    let session: Session, peer: Peerbit, peer2: Peerbit
    jest.setTimeout(60 * 1000)

    beforeAll(async () => {

        session = await Session.connected(2);
        peer = await Peerbit.create(session.peers[0].ipfs, { directory: './peerbit/' + (+new Date) })
        peer2 = await Peerbit.create(session.peers[1].ipfs, { directory: './peerbit/' + (+new Date) })
    })

    afterAll(async () => {
        await session.stop();
    })

    it('can post', async () => {

        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const replicationTopic = 'world';
        await peer.subscribeToReplicationTopic(replicationTopic);

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const rooms = await peer2.open(new Rooms({}), { replicationTopic });

        // Put 1 Room in Rooms
        const room = new Room({ name: 'new room' });
        await rooms.rooms.put(room);

        // Another room
        const room2 = new Room({ name: 'another room' });
        await rooms.rooms.put(room2);

        // Peer2 can "query" for rooms if peer2 does not have anything replicated locally
        const results: Results<Room>[] = [];
        await rooms.rooms.index.query(new DocumentQueryRequest({
            queries: [new FieldStringMatchQuery({
                key: 'name',
                value: 'another'
            })]
        }), (result) => {
            results.push(result)
        }, {
            maxAggregationTime: 3000
        })

        expect(results).toHaveLength(1);
        expect(results[0].results.map(result => result.value.id)).toContainAllValues([room2.id])


        // Open the room so we can write things inside
        await peer2.open(room, { replicationTopic });

        // Put a message
        await room.messages.put(new Post({
            message: 'hello world'
        }))

        await waitFor(() => peer.programs.get('world')?.size === 2); // 1 program controls the rooms, 1 program is a room, and the message controller inside of that 
        await waitFor(() => (peer.programs.get('world')?.get(room.address.toString()!)?.program as Room).messages.index.size === 1) // The "hello world" message has now arrived to the first peer
    })


    it('can create genisis', async () => {
        // This does not really test anything but it generates a serialized version of Rooms that one can hardcode in the frontend, so you dont need to load the Room manifest from IPFS on startup
        const genesis = await peer.open(new Rooms({}));
        const base64 = Buffer.from(serialize(genesis)).toString("base64")
        console.log(base64);
    })

})