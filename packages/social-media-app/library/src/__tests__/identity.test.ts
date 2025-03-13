import { TestSession } from "@peerbit/test-utils";
import { BrowsingHistory } from "../activity.js";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { expect } from "chai";
import { Identities } from "../identity.js";
import { delay, waitForResolved } from "@peerbit/time";

describe("identity", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("address fixed ect", async () => {
        const identities = await session.peers[0].open(
            new Identities({ baseUrl: "url" })
        );
        const address1 = identities.address;
        await identities.close();

        const profiles2 = await session.peers[0].open(
            new Identities({ baseUrl: "url" })
        );
        const address2 = profiles2.address;
        expect(address1).to.eq(address2);
    });

    describe("connect", () => {
        it("can connect", async () => {
            const baseUrl = "http://test.com?data=";
            const identities1 = await session.peers[0].open(
                new Identities({ baseUrl })
            );

            let deepLink: string | undefined = undefined;
            const connectPromise = identities1.connectDevicesFlow({
                deviceName: "device 1",
                onCode(result) {
                    deepLink = result.deepLinkUrl;
                },
            });

            await waitForResolved(() => expect(deepLink).to.exist);
            expect((deepLink! as string).startsWith(baseUrl)).to.be.true;

            const identities2 = await session.peers[1].open<Identities>(
                new Identities({ baseUrl })
            );

            const result = await identities2.connectDevicesFlow({
                deepLinkOrCode: deepLink!,
                deviceName: "device 2",
            });
            expect(result.verified).to.be.true;

            await connectPromise;

            // query linked devices frmo both perspectives
            const linkedDevicesFrom1 =
                await identities1.connections.index.search(
                    { query: identities1.getLinkedDevicesQuery() },
                    { local: true, remote: false }
                );
            expect(linkedDevicesFrom1).to.have.length(1);
            const device1 = linkedDevicesFrom1[0];
            expect(device1.device1.name).to.eq("device 1");

            await waitForResolved(async () => {
                const linkedDevicesFrom2 =
                    await identities2.connections.index.search(
                        { query: identities2.getLinkedDevicesQuery() },
                        { local: true, remote: false }
                    );
                expect(linkedDevicesFrom2).to.have.length(1);
                const device2 = linkedDevicesFrom2[0];
                expect(device2.device2!.name).to.eq("device 2");
            });
        });
    });
});
