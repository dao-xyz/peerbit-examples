import { TestSession } from "@peerbit/test-utils";
import { Canvas } from "../content.js";
import { expect } from "chai";
import { Profiles } from "../profile.js";

describe("profile", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });
    it("same address by default", async () => {
        const profiles1 = await session.peers[0].open(new Profiles());
        const address1 = profiles1.address;
        await profiles1.close();

        const profiles2 = await session.peers[0].open(new Profiles());
        const address2 = profiles2.address;
        expect(address1).to.eq(address2);
    });

    it("can get", async () => {
        const root = await session.peers[0].open(
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                seed: new Uint8Array(),
            })
        );
        const abc = await root.getCreateRoomByPath(["a", "b", "c"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({ profile: abc[abc.length - 1] });

        const profile = await profiles.get(profiles.node.identity.publicKey);
        expect(profile).to.not.be.undefined;
    });
});
