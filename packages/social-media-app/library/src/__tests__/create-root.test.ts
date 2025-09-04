import { TestSession } from "@peerbit/test-utils";
import { expect } from "chai";
import { delay, waitForResolved } from "@peerbit/time";

// These are already in your repo (used by your replicator scripts)
import { createRoot } from "../root.js";
import { Peerbit } from "peerbit";

describe("createRoot", () => {
    let session: TestSession;
    let extraClients: Peerbit[] = [];

    beforeEach(async () => {
        // 2 peers gives us: client1, replicator
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await Promise.all(extraClients.map((c) => c.stop()));
        await session.stop();
    });

    it("createRoot is idempotent", async () => {
        // Client 1 creates root (this succeeds today)
        const { scope: scopeClient1, canvas: root1 } = await createRoot(
            session.peers[0],
            { persisted: true, sections: ["section1", "section2"] }
        );

        expect(scopeClient1.visualizations.log.log.length).to.eq(2);
        expect(scopeClient1.links.log.log.length).to.eq(2);

        const anotherClient = await Peerbit.create();
        await anotherClient.dial(session.peers[0]);

        extraClients.push(anotherClient);
        const { scope: scopeClient2, canvas: root2 } = await createRoot(
            anotherClient,
            { persisted: true, sections: ["section1", "section2"] }
        );

        expect(root2.idString).to.equal(root1.idString);
        expect(scopeClient2.address).to.equal(scopeClient1.address);

        await delay(5e3);
        await waitForResolved(() => {
            expect(root2.visualizations.log.log.length).to.eq(2);
            expect(root2.links.log.log.length).to.eq(2);
        });
    });
});
