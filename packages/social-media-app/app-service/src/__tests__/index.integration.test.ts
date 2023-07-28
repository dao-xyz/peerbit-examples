import { LSession } from "@peerbit/test-utils";
import { AppPreview } from "..";

describe("index", () => {
    let session: LSession;

    beforeEach(async () => {
        session = await LSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });
    it("can fetch", async () => {
        await session.peers[0].open(new AppPreview(), {
            args: {
                server: true,
            },
        });
        const client = await session.peers[1].open(new AppPreview());

        const resposne = await client.resolve("https://twitch.tv");
        expect(resposne?.title).toEqual("Twitch");
    });
});
