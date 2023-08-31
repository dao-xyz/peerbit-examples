import { LSession } from "@peerbit/test-utils";
import { BrowsingHistory } from "../user.js";
import { SimpleWebManifest } from "@dao-xyz/app-service";

describe("user", () => {
    let session: LSession;

    beforeEach(async () => {
        session = await LSession.connected(1);
    });

    afterEach(async () => {
        await session.stop();
    });
    describe("history", () => {
        it("can store history", async () => {
            const history = new BrowsingHistory({
                rootTrust: session.peers[0].identity.publicKey,
            });
            await session.peers[0].open(history);
            await history.insert(
                new SimpleWebManifest({ url: "https://example.com" })
            );
            expect(history.visits.index.size).toEqual(1);

            // close and reload
            await history.close();

            const historyAgain = new BrowsingHistory({
                rootTrust: session.peers[0].identity.publicKey,
            });
            await session.peers[0].open(historyAgain);
            expect(historyAgain.visits.index.size).toEqual(1);
        });
    });
});
