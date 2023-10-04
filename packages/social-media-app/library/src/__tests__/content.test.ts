import { TestSession } from "@peerbit/test-utils";
import { Element, IFrameContent, Replies, Navigation } from "../content.js";
import { SearchRequest } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { ChatView } from "../chat.js";
import { waitForResolved } from '@peerbit/time'
import { delay } from '@peerbit/time'
describe("content", () => {
    describe("room", () => {
        let session: TestSession;

        beforeEach(async () => {
            session = await TestSession.connected(2);
        });

        afterEach(async () => {
            await session.stop();
        });

        it("iframe content", async () => {
            const root = await session.peers[0].open(
                new Element({
                    content: new IFrameContent()
                })
            );

            await root.content?.history.put(new Navigation("a"))
            await root.content?.history.put(new Navigation("b"))

            const rootB = await session.peers[1].open<Element>(root.address);
            await waitForResolved(async () => expect(await (rootB.content as IFrameContent).getLatest()).toEqual("b"))
        })



        it("can post path", async () => {
            const root = await session.peers[0].open(
                new Element({
                    content: new IFrameContent()
                })
            );


            //   const view = await session.peers[0].open(chatView, { existing: 'reuse' })
            await root.replies.elements.put(new Element({ content: new IFrameContent() }))


            const root2 = await session.peers[1].open<Element>(root.address);
            await waitForResolved(() => expect(root2.replies.elements.index.size).toEqual(1));

            const element = (await root2.replies.elements.index.search(new SearchRequest({ query: [] })))[0]
            expect(element.closed).toBeFalse(); // since both are 

        })

        describe('path', () => {
            let p1: Element<IFrameContent>
            let p2: Element<IFrameContent>;
            let p3: Element<IFrameContent>
            beforeEach(async () => {
                p1 = await session.peers[0].open(
                    new Element({
                        content: new IFrameContent()
                    })
                );
                p2 = new Element({ content: new IFrameContent(), parentElement: p1.address });
                await p1.replies.elements.put(p2)

                p3 = new Element({ content: new IFrameContent(), parentElement: p2.address });
                await p2.replies.elements.put(p3)

            })

            it('fetches parents', async () => {

                const p3b = await session.peers[1].open<Element>(p3.address)
                const p2b = await p3b.getParentElement();
                expect(p2.address).toEqual(p2b!.address)
                const p1b = await p2b!.getParentElement();
                expect(p1.address).toEqual(p1b!.address)

            })

            it("gets path", async () => {
                const p3b = await session.peers[1].open<Element>(p3.address)
                const path = await p3b.getPath()
                expect(path.map(x => x.address)).toEqual([p1.address, p2.address, p3.address])
            })
        })






        /* it("can make path", async () => {
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
        }); */
    });
});
