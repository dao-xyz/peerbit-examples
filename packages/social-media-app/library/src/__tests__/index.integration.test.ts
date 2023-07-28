import { LSession } from "@peerbit/test-utils";
import { Room, RoomContent } from "..";
import { SearchRequest } from "@peerbit/document";

describe("index", () => {
    describe("room", () => {
        let session: LSession;

        beforeEach(async () => {
            session = await LSession.connected(2);
        });

        afterEach(async () => {
            await session.stop();
        });
        it("can make path", async () => {
            const root = await session.peers[0].open(
                new Room({ rootTrust: session.peers[0].identity.publicKey })
            );
            const abc = await root.getCreateRoomByPath(["a", "b", "c"]);
            expect(abc).toHaveLength(1);
            expect(abc[0].name).toEqual("c");

            const abd = await root.getCreateRoomByPath(["a", "b", "d"]);
            expect(abd).toHaveLength(1);
            expect(abd[0].name).toEqual("d");

            const ab = await root.findRoomsByPath(["a", "b"]);
            expect(ab.rooms.map((x) => x.name)).toEqual(["b"]);

            const elementsInB = await ab.rooms[0].elements.index.search(
                new SearchRequest()
            );
            expect(
                elementsInB.map((x) => (x.content as RoomContent).room.name)
            ).toEqual(["c", "d"]);
        });
    });
});
