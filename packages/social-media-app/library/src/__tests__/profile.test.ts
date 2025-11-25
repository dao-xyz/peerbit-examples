import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Profiles } from "../profile.js";
import { Connection, Device, Identities } from "../identity.js";
import { equals, randomBytes } from "@peerbit/crypto";
import { waitForResolved } from "@peerbit/time";
import { ensurePath } from "./utils.js";

describe("profile", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    const createOpenRootScope = (args?: {
        seed?: Uint8Array | number[] | Scope;
        replicate?: boolean;
        replicas?: { min?: number };
    }) => {
        return session.peers[0].open(
            args?.seed instanceof Scope
                ? args?.seed
                : new Scope({
                      seed: args?.seed ? new Uint8Array(args?.seed) : undefined,
                      publicKey: session.peers[0].identity.publicKey,
                  }),
            {
                args: {
                    replicate: args?.replicate ?? true,
                    replicas: args?.replicas ?? undefined,
                },
            }
        );
    };

    it("same address by default", async () => {
        const profiles1 = await session.peers[0].open(new Profiles());
        const address1 = profiles1.address;
        await profiles1.close();

        const profiles2 = await session.peers[0].open(new Profiles());
        const address2 = profiles2.address;
        expect(address1).to.eq(address2);
    });

    it("get", async () => {
        let identities = await session.peers[0].open(
            new Identities({ baseUrl: "root://" })
        );

        const rootScope = await createOpenRootScope();
        const [_, root] = await rootScope.getOrCreateReply(
            null,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const [_a, _b, c] = await ensurePath(root, ["a", "b", "c"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({
            publicKey: session.peers[0].identity.publicKey,
            profile: c,
        });

        const profile = await profiles.get(
            profiles.node.identity.publicKey,
            identities
        );
        expect(profile).to.not.be.undefined;
    });

    it("update get", async () => {
        let identities = await session.peers[0].open(
            new Identities({ baseUrl: "root://" })
        );

        const rootScope = await createOpenRootScope();
        const [_, root] = await rootScope.getOrCreateReply(
            null,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const [_a, _b, c] = await ensurePath(root, ["a", "b", "c"]);
        const [__a, __b, d] = await ensurePath(root, ["a", "b", "d"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({
            publicKey: session.peers[0].identity.publicKey,
            profile: c,
        });

        const profile = await profiles.get(
            profiles.node.identity.publicKey,
            identities
        );
        expect(equals(profile?.profile.id, c.id)).to.be.true;

        await profiles.create({
            publicKey: session.peers[0].identity.publicKey,
            profile: d,
        });
        const updatedProfile = await profiles.get(
            profiles.node.identity.publicKey,
            identities
        );
        expect(equals(updatedProfile?.profile.id, d.id)).to.be.true;

        // expect profiles db to only have 1 profile entry
        expect(await profiles.profiles.index.getSize()).to.eq(1);
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

        const rootScope = await createOpenRootScope();
        const [_, root] = await rootScope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: session.peers[0].identity.publicKey,
                selfScope: rootScope,
            })
        );

        const [_a, _b, c] = await ensurePath(root, ["a", "b", "c"]);

        const profiles = await session.peers[0].open(new Profiles());
        await profiles.create({
            publicKey: session.peers[0].identity.publicKey,
            profile: c,
        });

        const profiles2 = await session.peers[1].open(new Profiles());
        await waitForResolved(async () =>
            expect(await profiles2.profiles.index.getSize()).to.eq(1)
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
