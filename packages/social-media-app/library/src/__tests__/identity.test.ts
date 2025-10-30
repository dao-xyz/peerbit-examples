import { TestSession } from "@peerbit/test-utils";
import { Identities } from "../identity.js";
import { waitForResolved } from "@peerbit/time";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("identity", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("address fixed etc", async () => {
        const identities = await session.peers[0].open(
            new Identities({ baseUrl: "url" })
        );
        const address1 = identities.address;
        await identities.close();

        const identities2 = await session.peers[0].open(
            new Identities({ baseUrl: "url" })
        );
        const address2 = identities2.address;
        expect(address1).to.eq(address2);
    });

    describe("connect", () => {
        it("can connect", async () => {
            const baseUrl = "http://test.com?data=";
            const identities1 = await session.peers[0].open(
                new Identities({ baseUrl }),
                {
                    args: {
                        deviceName: "device 1",
                    },
                }
            );

            let deepLink: string | undefined = undefined;
            const connectPromise = identities1.connectDevicesFlow({
                onCode(result) {
                    deepLink = result.deepLinkUrl;
                },
            });
            await waitForResolved(() => expect(deepLink).to.exist);
            expect((deepLink! as string).startsWith(baseUrl)).to.be.true;

            const identities2 = await session.peers[1].open(
                new Identities({ baseUrl }),
                {
                    args: {
                        deviceName: "device 2",
                    },
                }
            );
            const result = await identities2.connectDevicesFlow({
                deepLinkOrCode: deepLink!,
            });
            expect(result.verified).to.be.true;
            await connectPromise;

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

    describe("broadcast channel sync", () => {
        it("should automatically sync connection updates when a connection is put", async () => {
            const baseUrl = "http://test.com?data=";
            const identities1 = await session.peers[0].open(
                new Identities({ baseUrl }),
                { args: { deviceName: "a", connectTabs: { id: 1 } } }
            );
            const identities2 = await session.peers[1].open(
                new Identities({ baseUrl }),
                { args: { deviceName: "b", connectTabs: { id: 0 } } }
            );

            // No manual put is needed. The auto‑registration (self connection) in identities1’s open() method
            // will insert a verified connection with identities1.node.identity.publicKey, which should be broadcast.
            // Wait until identities2 picks up that broadcast.
            await waitForResolved(async () => {
                const results = await identities2.connections.index.search(
                    {
                        query: identities2.getLinkedDevicesQuery(
                            identities1.node.identity.publicKey
                        ),
                    },
                    { local: true, remote: false }
                );
                expect(results.length).to.be.greaterThan(0);
            });
        });
    });
});
