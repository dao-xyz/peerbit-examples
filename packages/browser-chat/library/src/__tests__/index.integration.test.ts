import { Peerbit } from "@dao-xyz/peerbit";
import { Session } from '@dao-xyz/peerbit-test-utils';
import { waitFor } from '@dao-xyz/peerbit-time';
import { jest } from '@jest/globals';
import { Post, Room, Rooms } from '..';
import { delay } from '@dao-xyz/peerbit-time';
import { serialize } from '@dao-xyz/borsh';

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
        const replicationTopic = 'world';
        await peer.subscribeToReplicationTopic(replicationTopic);
        const rooms = await peer2.open(new Rooms({}), { replicationTopic });
        const room = new Room({ name: 'new room' });
        await rooms.rooms.put(room);
        await peer2.open(room, { replicationTopic });
        room.messages.put(new Post({
            message: 'hello world'
        }))
        await delay(10000);
        await waitFor(() => peer.programs.get('world')?.size === 2); // 1 program controls the rooms, 1 program is a room, and the message controller inside of that 

        expect((peer.programs.get('world')?.get(room.address.toString()!)?.program as Room).messages.index.size).toEqual(1); // The "hello world message"
    })


    it('can create genisis', async () => {
        const genesis = await peer.open(new Rooms({}));
        const base64 = Buffer.from(serialize(genesis)).toString("base64")
        console.log(base64);
    })

})