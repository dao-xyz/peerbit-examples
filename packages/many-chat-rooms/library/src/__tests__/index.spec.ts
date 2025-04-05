import { Peerbit } from "peerbit";
import { waitFor, waitForResolved } from "@peerbit/time";
import { Lobby, Post, Room } from "..";
import { expect } from "chai";

const loobyConfig = {
    id: new Uint8Array([
        30, 222, 227, 78, 164, 10, 61, 8, 21, 176, 122, 5, 79, 110, 115, 255,
        233, 253, 92, 76, 146, 158, 46, 212, 14, 162, 30, 94, 1, 134, 99, 174,
    ]),
};

describe("many-chat-rooms", () => {
    let globalPeer: Peerbit;
    let user1: Peerbit | undefined;
    let user2: Peerbit | undefined;

    beforeEach(async () => {
        globalPeer = await Peerbit.create();
    });

    afterEach(async () => {
        await user1?.stop();
        await user2?.stop();
        await globalPeer.stop();
    });

    const createLobby = async (user: Peerbit) => {
        const lobby = await user.open<Lobby>(new Lobby(loobyConfig), {
            args: { replicate: true },
            existing: "reuse",
        });
        await lobby.waitFor(user.peerId);
        return lobby;
    };

    it("should create lobby", async () => {
        user1 = await Peerbit.create();
        const lobby = await createLobby(user1);

        const room1 = new Room({
            name: "1",
        });

        // Add room to registry
        await lobby.rooms.put(room1, { replicas: 10 });

        // Check registry size
        expect(await lobby.rooms.index.getSize()).to.eq(1);
    });

    it("should peer get same rooms", async () => {
        // user 1 starts their client
        user1 = await Peerbit.create();
        await user1.dial(globalPeer.getMultiaddrs());

        // initialise a lobby
        const lobbyFromUser1 = await createLobby(user1);
        const lobbyAddress = lobbyFromUser1.address;
        expect(lobbyAddress).to.exist;

        // add 1 room
        const room1 = new Room({
            name: "1",
        });
        await lobbyFromUser1.rooms.put(room1);

        // another users joins
        user2 = await Peerbit.create();
        await user2.dial(globalPeer.getMultiaddrs());

        // and loads the lobby using the string address
        const lobbyFromUser2 = await user2.open<Lobby>(lobbyAddress, {
            args: { replicate: true },
            existing: "reuse",
        });

        // user 2 should be able to observe that user1 is also a replicator
        await lobbyFromUser2.rooms.log.waitForReplicator(
            user1.identity.publicKey
        );

        // sence both are replicating with a factor of 1 it means that user2 will also have a room in the lobby
        await waitForResolved(async () =>
            expect(await lobbyFromUser1.rooms.index.getSize()).to.eq(1)
        );

        // user2 can now add a new room to the lobby and user1 should also be able to see it
        const room2 = new Room({
            name: "2",
        });
        await lobbyFromUser2.rooms.put(room2);
        await waitForResolved(async () =>
            expect(await lobbyFromUser1.rooms.index.getSize()).to.eq(2)
        );
        await waitForResolved(async () =>
            expect(await lobbyFromUser2.rooms.index.getSize()).to.eq(2)
        );
    });

    it("can post in room", async () => {
        // user 1 starts their client
        user1 = await Peerbit.create();
        await user1.dial(globalPeer.getMultiaddrs());

        // Peer 1 is subscribing to a replication topic (to start helping the network)
        const lobbyFrom1 = await user1.open(new Lobby({}));

        // user 2 starts their client
        user2 = await Peerbit.create();
        await user2.dial(globalPeer.getMultiaddrs());

        // Peer 2 is creating "Rooms" which is a container of "Room"
        const lobbyFrom2 = await user2.open<Lobby>(lobbyFrom1.address!);

        // Put 1 Room in Rooms
        const roomAFrom2 = new Room({ name: "new room" });
        await lobbyFrom2.rooms.put(roomAFrom2);

        // Another room
        const roomBFrom2 = new Room({ name: "another room" });
        await lobbyFrom2.rooms.put(roomBFrom2);

        // peer 1 will eventually also replicate the room, since both have opened the Lobby as replicators
        await waitForResolved(async () =>
            expect(await lobbyFrom1.rooms.index.getSize()).to.eq(2)
        );
        const results: Room[] = await lobbyFrom1.rooms.index.search({
            query: {
                name: "another room",
            },
        });

        expect(results.length).to.eq(1);
        expect(results[0].id).to.eq(roomBFrom2.id);

        // Put a message
        const helloWorldPostFrom2 = new Post({
            message: "hello world",
            from: user2.identity.publicKey,
        });

        await user2.open(roomAFrom2); // TODO auto open on put
        await roomAFrom2.messages.put(helloWorldPostFrom2);

        const roomAfrom1 = (await lobbyFrom1.rooms.index.get(roomAFrom2.id))!;

        await user1.open(roomAfrom1); // TODO auto open on synhronization

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
