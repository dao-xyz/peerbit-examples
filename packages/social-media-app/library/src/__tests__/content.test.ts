import { TestSession } from "@peerbit/test-utils";
import { Room, RoomContent } from "../content.js";
import { SearchRequest } from "@peerbit/document";
import { Peerbit } from "peerbit";

describe("content", () => {
    describe("room", () => {
        let session: TestSession;

        beforeEach(async () => {
            session = await TestSession.connected(2);
        });

        afterEach(async () => {
            await session.stop();
        });
        it("can make path", async () => {
            const root = await session.peers[0].open(
                new Room({
                    rootTrust: session.peers[0].identity.publicKey,
                    seed: new Uint8Array(),
                })
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

        it("determinstic with seed", async () => {
            let seed = new Uint8Array([0, 1, 2]);
            const rootA = await session.peers[0].open(
                new Room({
                    seed,
                    rootTrust: session.peers[0].identity.publicKey,
                })
            );
            const pathA = await rootA.getCreateRoomByPath(["a", "b", "c"]);

            await session.peers[0].stop();
            await session.peers[0].start();

            const rootB = await session.peers[0].open(
                new Room({
                    seed,
                    rootTrust: session.peers[0].identity.publicKey,
                })
            );

            expect(rootA.address).toEqual(rootB.address);

            const pathB = await rootB.getCreateRoomByPath(["a", "b", "c"]);
            for (const room of pathB) {
                await session.peers[0].open(room);
            }

            expect(typeof pathA[pathA.length - 1].address).toEqual("string");
            expect(pathA[pathA.length - 1].address).toEqual(
                pathB[pathB.length - 1].address
            );
        });
    });
});
