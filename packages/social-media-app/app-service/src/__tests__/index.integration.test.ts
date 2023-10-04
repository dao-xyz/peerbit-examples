import { TestSession } from "@peerbit/test-utils";
import { AppPreview } from "..";
import { Peerbit } from "peerbit";
import { delay } from "@peerbit/time";
describe("index", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });
    let browser: any;
    afterEach(async () => {
        await session.stop();
        await browser?.close();
    });

    it("can fetch", async () => {
        /* const client = await session.peers[1].open(new AppPreview()); */

        const db = await session.peers[0].open(new AppPreview(), {
            args: {
                server: true,
            },
        });
        const client = await session.peers[1].open<AppPreview>(db.address);
        const resposne = await client.resolve("https://twitch.tv/ppy");
        expect(resposne?.title).toEqual("Twitch");


    });

    it("can fetch remote", async () => {
        const peer = await Peerbit.create();
        await peer.bootstrap()
        const _imp = AppPreview // else we don't seem to import the program
        const client = await peer.open<AppPreview>("zb2rhXREnAbm5Twtm2ahJM7QKT6FoQGNksWv5jp7o5W6BQ7au");
        const resposne = await client.resolve("https://twitch.tv");
        expect(resposne?.title).toEqual("Twitch");
    })

    it("has reasonable timeout", async () => {
        const db = await session.peers[0].open(new AppPreview(), {
            args: {
                server: true,
            },
        });
        let t0 = +new Date();
        const client = await session.peers[1].open<AppPreview>(db.address);
        await client.resolve("https://thissitedoesnotexist1239043534.com");
        expect(+new Date() - t0).toBeLessThan(5000);
    });
});
