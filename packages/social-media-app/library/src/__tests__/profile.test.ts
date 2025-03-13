import { TestSession } from "@peerbit/test-utils";
import { Canvas } from "../content.js";
import { expect } from "chai";
import { Profiles } from "../profile.js";
import { Connection, Device, Identities } from "../identity.js";
import { randomBytes } from "@peerbit/crypto";
import { delay, waitForResolved } from "@peerbit/time";

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
        let identities = await session.peers[0].open(
            new Identities({ baseUrl: "root://" })
        );
        const root = await session.peers[0].open(
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                seed: new Uint8Array(),
            })
        );
        const abc = await root.getCreateRoomByPath(["a", "b", "c"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({ profile: abc[abc.length - 1] });

        const profile = await profiles.get(
            profiles.node.identity.publicKey,
            identities
        );
        expect(profile).to.not.be.undefined;
    });

    it("can get through linked device", async () => {
        let identities1 = await session.peers[0].open(
            new Identities({ baseUrl: "root://" })
        );

        let identities2 = await session.peers[1].open(
            new Identities({ baseUrl: "root://" })
        );

        const connection = new Connection({
            device1: new Device(session.peers[0].identity.publicKey, "a"),
            device2: new Device(session.peers[1].identity.publicKey, "b"),
            verified: true,
            nonce: randomBytes(32),
        });
        await identities1.connections.put(connection);

        await waitForResolved(() =>
            expect(identities2.connections.log.log.length).to.eq(1)
        );

        expect(await identities1.getAllLinkedDevices()).to.have.length(1);
        expect(await identities2.getAllLinkedDevices()).to.have.length(1);

        const root = await session.peers[0].open(
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                seed: new Uint8Array(),
            })
        );
        const abc = await root.getCreateRoomByPath(["a", "b", "c"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({ profile: abc[abc.length - 1] });

        const profiles2 = await session.peers[1].open(new Profiles());

        await waitForResolved(() =>
            expect(profiles2.profiles.log.log.length).to.eq(1)
        );

        const profileFromDevice1 = await profiles.get(
            session.peers[0].identity.publicKey,
            identities1
        );
        expect(profileFromDevice1).to.not.be.undefined;

        const profileFromDevice2 = await profiles2.get(
            session.peers[1].identity.publicKey,
            identities2
        );
        expect(profileFromDevice2).to.not.be.undefined;
    });
});
