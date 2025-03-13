import { TestSession } from "@peerbit/test-utils";
import { BrowsingHistory } from "../activity.js";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { expect } from "chai";

describe("user", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
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
            expect(await history.visits.index.getSize()).to.eq(1);

            // close and reload
            await history.close();

            const historyAgain = new BrowsingHistory({
                rootTrust: session.peers[0].identity.publicKey,
            });
            await session.peers[0].open(historyAgain);
            expect(await historyAgain.visits.index.getSize()).to.eq(1);
        });
    });
});
