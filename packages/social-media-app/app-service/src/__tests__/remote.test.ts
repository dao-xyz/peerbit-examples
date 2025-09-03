import { TestSession } from "@peerbit/test-utils";
import { AppPreview, resolveAppFromUrl } from "../remote.js";
import { v4 as uuid } from "uuid";
import { expect } from "chai";
describe("resolveAppFromUrl", () => {
    it("Twitch xqc", async () => {
        const resolved = await resolveAppFromUrl("https://www.twitch.tv/xqc");
        expect(resolved.icon!.length > 0).to.be.true;
    });

    /* not working  
    it('kick maki95', async () => {
         const resolved = await resolveAppFromUrl("https://kick.com/maki95")
         expect(resolved.icon!.length > 0).to.be.true
     }) */
});

describe("service", () => {
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
        await client.waitFor(db.node.identity.publicKey);
        const response = await client.resolve("https://twitch.tv/ppy");
        expect(response?.title).to.eq("Twitch");

        /* const peer = await Peerbit.create();
        await peer.bootstrap()
        const _imp = AppPreview // else we don't seem to import the program
        const client = await peer.open<AppPreview>("zb2rhXREnAbm5Twtm2ahJM7QKT6FoQGNksWv5jp7o5W6BQ7au");
        const resposne = await client.resolve("https://twitch.tv");
        expect(resposne?.title).to.eq("Twitch"); */
    });

    it("has reasonable timeout", async () => {
        const db = await session.peers[0].open(new AppPreview(), {
            args: {
                server: true,
            },
        });
        let t0 = +new Date();
        const client = await session.peers[1].open<AppPreview>(db.address);
        await client.waitFor(db.node.identity.publicKey);
        await client.resolve(`https://thissitedoesnotexist${uuid()}.com`);
        expect(+new Date() - t0).to.be.lessThan(5000);
    });
});
